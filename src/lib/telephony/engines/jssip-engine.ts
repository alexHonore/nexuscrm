"use client";

/**
 * Moteur voip.ms — JsSIP au-dessus de la passerelle SIP-WSS.
 *
 * Priorités : qualité audio (echoCancellation / noiseSuppression / autoGainControl,
 * un seul élément <audio> persistant) et robustesse (re-connexion WS avec backoff
 * 2 s → 30 s, exigences voip.ms : session_timers désactivés).
 *
 * Robustesse d'appel sortant — trois pièges connus qui laissaient l'interface
 * bloquée sur « Connexion… » sans erreur :
 *   1. Collecte ICE : JsSIP attend la fin de la collecte avant d'envoyer
 *      l'INVITE ; si le STUN est bloqué par le réseau, elle traîne ou n'aboutit
 *      jamais. Or rtpengine (IP publique) apprend l'adresse réelle du fureteur
 *      via ses propres vérifications STUN — les candidats host suffisent. On
 *      envoie donc l'INVITE dès qu'un candidat srflx apparaît, ou 500 ms après
 *      le dernier candidat (3 s au plus).
 *   2. Micro : getUserMedia() peut rester en attente (invite du navigateur non
 *      traitée, micro bloqué au niveau de l'OS). On acquiert le flux AVANT de
 *      créer la session SIP, avec un rappel à l'usager après 2,5 s et des
 *      erreurs distinctes (refusé / introuvable / expiré).
 *   3. Socket WS à moitié mort (veille, changement de réseau) : l'INVITE part
 *      dans le vide. Un chien de garde échoue l'appel après 20 s sans AUCUNE
 *      réponse SIP et recycle la connexion.
 * Et une tonalité de retour d'appel locale (440+480 Hz) sonne pendant le
 * « ringing » tant que voip.ms n'envoie pas de pré-réponse audio (early media).
 */

import JsSIP from "jssip";
import type {
  EndEvent,
  IceCandidateEvent,
  PeerConnectionEvent,
  RTCSession,
} from "jssip/lib/RTCSession";
import type {
  IncomingRTCSessionEvent,
  RTCSessionEvent,
  UnRegisteredEvent,
} from "jssip/lib/UA";
import {
  getInputChoice,
  refreshDevices,
  registerSink,
  sinkForElement,
} from "@/lib/telephony/audio-devices";
import { startRingback, stopRingback } from "@/lib/telephony/tones";
import type {
  ActiveCall,
  EngineConfig,
  RegistrationState,
  TelephonyEngine,
  TelephonyEvents,
} from "@/lib/telephony/types";

const PC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "balanced",
};

/**
 * Contraintes audio « qualité d'abord » — identiques en sortant et en entrant.
 * `deviceId: { exact }` quand un micro est choisi : « ce casque-là », pas « à
 * peu près ». Le repli sur le défaut si l'appareil a disparu est dans
 * acquireMic — sans lui, débrancher un casque USB empêcherait d'appeler.
 */
function mediaConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

/** Cadence de lecture des statistiques RTP pendant la sonnerie. */
const RTP_POLL_MS = 250;

/** Fins d'appel « normales » qui ne méritent pas de toast d'erreur. */
const NORMAL_END_CAUSES = new Set<string>([
  JsSIP.C.causes.BYE,
  JsSIP.C.causes.CANCELED,
  JsSIP.C.causes.NO_ANSWER,
  JsSIP.C.causes.EXPIRES,
]);

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Numéro à composer dans l'URI SIP. On stocke l'E.164 (« +14189065924 »)
 * partout dans le CRM, mais le plan de numérotation de voip.ms compare des
 * SUITES DE CHIFFRES : un « + » en tête ne correspond à aucun motif, si bien
 * que voip.ms accuse réception (100 Trying) puis abandonne l'appel en
 * silence — ni sonnerie, ni erreur. Diagnostiqué en production le 2026-08-07 :
 * `INVITE sip:+14189065924@montreal1.voip.ms` -> 100 Trying, puis plus rien.
 * On ne garde donc que les chiffres (et # / * pour les serveurs vocaux).
 */
export function toDialString(number: string): string {
  return number.replace(/[^\d#*]/g, "");
}

/**
 * Codecs réellement utilisables sur la ligne voip.ms (le sous-compte n'autorise
 * que « ulaw;g722;g729 ») + la télé-signalisation DTMF en 8 kHz.
 */
const PSTN_CODECS = new Set(["pcmu", "pcma", "g722", "g729", "telephone-event"]);

/**
 * Allège l'offre SDP avant l'envoi de l'INVITE.
 *
 * Chrome propose 8 codecs (opus, red, CN, telephone-event/48000…) plus des
 * en-têtes `a=extmap`, ce qui donne un INVITE d'environ 1 750 octets. Relayé
 * vers voip.ms en UDP, ce datagramme dépasse le MTU, part en fragments et se
 * perd : la passerelle répond « 100 Trying » puis PLUS RIEN, et l'appel
 * n'aboutit jamais. Mesuré le 2026-08-07 — 774 o : voip.ms répond ;
 * 1 755 o : silence total ; le même message en TCP : réponse immédiate.
 *
 * Aucun de ces codecs supplémentaires ne sert : la ligne est en 8 kHz de bout
 * en bout. On les retire donc, ce qui évite aussi un transcodage inutile.
 * En cas de doute (aucun codec reconnu), on renvoie le SDP intact.
 */
export function trimSdpForPstn(sdp: string): string {
  const lines = sdp.split(/\r\n|\n/);

  // 1. Payload types à conserver, d'après les a=rtpmap.
  const keep = new Set<string>();
  const drop = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+([^/]+)\/(\d+)/.exec(line);
    if (!m) continue;
    const [, pt, name, clock] = m;
    const usable =
      PSTN_CODECS.has(name.toLowerCase()) &&
      // telephone-event n'est utile qu'en 8 kHz côté RTC public.
      (name.toLowerCase() !== "telephone-event" || clock === "8000");
    (usable ? keep : drop).add(pt);
  }
  if (keep.size === 0) return sdp; // rien de reconnu : ne pas casser l'appel

  const out: string[] = [];
  for (const line of lines) {
    // 2. Liste des payloads de la ligne m=audio.
    const mAudio = /^m=audio (\d+) (\S+) (.+)$/.exec(line);
    if (mAudio) {
      const [, port, proto, pts] = mAudio;
      const kept = pts.split(/\s+/).filter((pt) => !drop.has(pt));
      out.push(`m=audio ${port} ${proto} ${(kept.length ? kept : pts.split(/\s+/)).join(" ")}`);
      continue;
    }
    // 3. Attributs rattachés à un payload supprimé.
    const attr = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/.exec(line);
    if (attr && drop.has(attr[1])) continue;
    // 4. Comptabilité propre à WebRTC, sans objet pour un appel téléphonique
    //    à un seul flux audio — et c'est là que partent les octets de trop
    //    (a=ssrc ×4, a=msid, a=msid-semantic… ≈ 400 o). rtpengine retire
    //    déjà ICE et DTLS en direction de voip.ms ; ce sont ces lignes-ci qui
    //    faisaient encore dépasser le MTU.
    if (
      line.startsWith("a=extmap:") ||
      line.startsWith("a=extmap-allow-mixed") ||
      line.startsWith("a=msid:") ||
      line.startsWith("a=msid-semantic") ||
      line.startsWith("a=ssrc:") ||
      line.startsWith("a=ssrc-group:") ||
      line.startsWith("a=group:BUNDLE") ||
      line.startsWith("a=rtcp-rsize")
    ) {
      continue;
    }
    out.push(line);
  }
  return out.join("\r\n");
}

/** Collecte ICE : envoi de l'INVITE 500 ms après le dernier candidat, 3 s max. */
const ICE_SETTLE_MS = 500;
const ICE_MAX_MS = 3_000;
/** Micro : rappel à l'usager après 2,5 s, abandon après 30 s. */
const MIC_HINT_MS = 2_500;
const MIC_MAX_MS = 30_000;
/** Sortant : échec si AUCUNE réponse SIP (180/183/2xx/4xx…) après 20 s. */
const DIAL_WATCHDOG_MS = 20_000;

export class JsSipEngine implements TelephonyEngine {
  readonly provider = "voipms" as const;

  private ua: JsSIP.UA | null = null;
  private session: RTCSession | null = null;
  private call: ActiveCall | null = null;
  private events: TelephonyEvents | null = null;
  private config: EngineConfig = {};
  private audio: HTMLAudioElement | null = null;
  private registration: RegistrationState = "unregistered";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private destroyed = false;
  /** Flux micro acquis par dial() — à libérer nous-mêmes (JsSIP ne stoppe pas
   *  les flux fournis via l'option mediaStream). */
  private localStream: MediaStream | null = null;
  /**
   * Génération d'appel sortant. Incrémentée à chaque dial() ET à chaque
   * raccroché en préflight micro : un dial() dont la génération n'est plus
   * courante n'émet pas l'INVITE. Un booléen partagé ne suffisait pas — un
   * second dial() le remettait à faux et « ressuscitait » le premier appel
   * annulé quand le micro était enfin accordé.
   */
  private dialGen = 0;
  private dialWatchdog: ReturnType<typeof setTimeout> | null = null;
  private iceSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private iceMaxTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Un candidat ICE a-t-il été vu pour l'appel en cours ? C'est la seule prise
   * que JsSIP nous donne pour débloquer l'INVITE (`ready()` n'existe QUE dans
   * l'événement). Si aucun candidat n'arrive, l'INVITE n'est jamais émis — un
   * échec très différent d'« INVITE envoyé, personne ne répond », et le chien
   * de garde doit le dire.
   */
  private sawIceCandidate = false;
  /** Tonalité de retour d'appel en cours (le son vit dans `tones.ts`). */
  private ringbackOn = false;
  /** Sondage des paquets RTP entrants — coupe la tonalité au vrai son. */
  private rtpPoll: ReturnType<typeof setInterval> | null = null;
  private releaseAudioSink: (() => void) | null = null;

  get registrationState(): RegistrationState {
    return this.registration;
  }

  async init(config: EngineConfig, events: TelephonyEvents): Promise<void> {
    this.config = config;
    this.events = events;

    if (!config.wssUrl || !config.sipUsername || !config.sipPassword) {
      this.setRegistration("failed", "not_configured");
      return;
    }

    // Un seul élément audio persistant pour tout le cycle de vie du moteur.
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "true");
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);
    // Le haut-parleur choisi s'applique DÈS MAINTENANT : le casque sélectionné
    // hier reçoit l'appel d'aujourd'hui sans que l'usager y retouche.
    this.releaseAudioSink = registerSink(sinkForElement(this.audio));

    const domain = config.sipDomain || "sip.voip.ms";
    const socket = new JsSIP.WebSocketInterface(config.wssUrl);

    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${config.sipUsername}@${domain}`,
      authorization_user: config.sipUsername,
      password: config.sipPassword,
      register: true,
      register_expires: 300,
      // Exigence voip.ms : pas de session timers (re-INVITE périodiques refusés).
      session_timers: false,
      user_agent: "GroupeNexus CRM",
    });

    this.ua.on("connecting", () => this.setRegistration("registering"));
    this.ua.on("connected", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.clearReconnectTimer();
      this.setRegistration("registering");
    });
    this.ua.on("registered", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.setRegistration("registered");
    });
    this.ua.on("unregistered", (e: UnRegisteredEvent) => {
      if (!this.destroyed) this.setRegistration("unregistered", e.cause ?? undefined);
    });
    this.ua.on("registrationFailed", (e: UnRegisteredEvent) => {
      this.setRegistration("failed", e.cause ?? undefined);
      this.scheduleReconnect();
    });
    this.ua.on("disconnected", () => {
      if (this.destroyed) return;
      this.setRegistration("registering", "socket_disconnected");
      this.scheduleReconnect();
    });

    this.ua.on("newRTCSession", (e: RTCSessionEvent) => {
      if ((e.originator as string) !== "remote") return; // le sortant est géré par dial()
      this.handleIncoming(e as IncomingRTCSessionEvent);
    });

    this.ua.start();
  }

  async dial(number: string): Promise<void> {
    if (!this.ua || !this.ua.isRegistered()) {
      this.events?.onError("not_registered");
      throw new Error("not_registered");
    }
    if (this.session) {
      this.events?.onError("already_in_call");
      throw new Error("already_in_call");
    }
    if (!this.ua.isConnected()) {
      // Socket WS mort sans événement « disconnected » (veille, changement de
      // réseau) : recycler la connexion tout de suite plutôt que d'émettre
      // l'INVITE dans le vide.
      this.events?.onError("not_registered");
      this.restartUA();
      throw new Error("not_registered");
    }

    const domain = this.config.sipDomain || "sip.voip.ms";
    const target = `sip:${toDialString(number)}@${domain}`;

    const gen = ++this.dialGen;
    this.call = { direction: "outbound", remoteNumber: number, startedAt: new Date() };
    this.events?.onCallStateChange("connecting", this.call);

    let stream: MediaStream;
    try {
      stream = await this.acquireMic();
    } catch (err) {
      // Si l'usager a raccroché pendant l'attente (génération périmée),
      // hangup() a déjà remis l'UI au repos — ne pas ré-émettre ended/idle.
      if (gen === this.dialGen && this.call) {
        const ended = this.call;
        this.call = null;
        this.events?.onCallStateChange("ended", ended);
        this.events?.onCallStateChange("idle", null);
      }
      throw err;
    }
    // L'état a pu changer pendant l'attente du micro : raccroché ou nouveau
    // dial() (génération périmée), ou une session apparue entre-temps.
    if (gen !== this.dialGen || this.session || this.call?.direction !== "outbound") {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("canceled");
    }
    this.localStream = stream;

    let session: RTCSession;
    try {
      session = this.ua.call(target, {
        mediaConstraints: mediaConstraints(getInputChoice()),
        mediaStream: stream,
        pcConfig: PC_CONFIG,
        // Forme legacy attendue par la pile WebRTC de JsSIP (1 = true).
        rtcOfferConstraints: { offerToReceiveAudio: 1 } as unknown as RTCOfferOptions,
      });
    } catch (err) {
      // Échec local immédiat (cible invalide, UA arrêté…) : libérer le micro
      // et remettre l'UI au repos au lieu de rester sur « Connexion… ».
      this.releaseLocalStream();
      const ended = this.call;
      this.call = null;
      this.events?.onError("call_failed");
      this.events?.onCallStateChange("ended", ended);
      this.events?.onCallStateChange("idle", null);
      throw err;
    }

    this.attachSession(session);
    this.armDialWatchdog();
  }

  answer(): void {
    if (!this.session || this.call?.direction !== "inbound") return;
    this.session.answer({
      mediaConstraints: mediaConstraints(getInputChoice()),
      pcConfig: PC_CONFIG,
    });
  }

  hangup(): void {
    if (!this.session && this.call?.direction === "outbound") {
      // Appel encore en préflight micro (aucune session SIP) : périmer la
      // génération — dial() s'arrêtera au retour de getUserMedia sans émettre
      // l'INVITE — et remettre l'UI au repos tout de suite.
      this.dialGen++;
      const ended = this.call;
      this.call = null;
      this.events?.onCallStateChange("ended", ended);
      this.events?.onCallStateChange("idle", null);
      return;
    }
    try {
      this.session?.terminate();
    } catch {
      // déjà terminée
    }
  }

  reject(): void {
    try {
      this.session?.terminate({ status_code: 486, reason_phrase: "Busy Here" });
    } catch {
      // déjà terminée
    }
  }

  mute(muted: boolean): void {
    if (!this.session) return;
    if (muted) this.session.mute({ audio: true });
    else this.session.unmute({ audio: true });
  }

  hold(held: boolean): void {
    if (!this.session) return;
    if (held) this.session.hold();
    else this.session.unhold();
  }

  sendDTMF(digit: string): void {
    if (!this.session || !/^[\d#*A-D]$/i.test(digit)) return;
    try {
      // RFC 2833 (RTP) — attendu par voip.ms.
      this.session.sendDTMF(digit, { transportType: JsSIP.C.DTMF_TRANSPORT.RFC2833 });
    } catch {
      // session pas encore confirmée — on ignore
    }
  }

  /**
   * Le registre de `audio-devices` route déjà l'élément <audio> et le contexte
   * des tonalités. Rien à faire ici de plus que d'honorer le contrat commun
   * aux deux moteurs — Twilio, lui, a sa propre plomberie de sortie.
   */
  async setOutputDevice(): Promise<void> {
    // Volontairement vide : voir le commentaire ci-dessus.
  }

  /**
   * Changer de micro EN PLEIN APPEL : on remplace la piste envoyée. Pas de
   * re-négociation SDP — voip.ms refuse les session timers et une nouvelle
   * offre repasserait par trimSdpForPstn, avec le risque de MTU que l'on sait.
   */
  async setInputDevice(deviceId: string): Promise<void> {
    const pc = this.session?.connection;
    if (!pc) return; // hors appel : le choix est déjà mémorisé par le magasin
    const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (!sender) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(deviceId));
    } catch {
      this.events?.onError("mic_unavailable");
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    // La sourdine en cours doit survivre au changement d'appareil : sinon
    // l'agent se croit muet et parle dans le vide (ou l'inverse, bien pire).
    track.enabled = sender.track?.enabled ?? true;
    try {
      await sender.replaceTrack(track);
    } catch {
      for (const t of stream.getTracks()) t.stop();
      this.events?.onError("mic_unavailable");
      return;
    }
    this.releaseLocalStream();
    this.localStream = stream;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.clearDialWatchdog();
    this.clearIceTimers();
    this.stopRingback();
    this.releaseLocalStream();
    try {
      this.session?.terminate();
    } catch {
      // rien
    }
    this.session = null;
    this.call = null;
    try {
      this.ua?.stop();
    } catch {
      // rien
    }
    this.ua = null;
    if (this.audio) {
      this.releaseAudioSink?.();
      this.releaseAudioSink = null;
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  /**
   * Acquiert le micro AVANT la session SIP : erreurs attribuables (refusé /
   * introuvable / expiré) et rappel si l'invite du navigateur reste sans
   * réponse — au lieu d'un « Connexion… » silencieux.
   */
  private async acquireMic(deviceId: string = getInputChoice()): Promise<MediaStream> {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.getUserMedia) {
      this.events?.onError("mic_unavailable");
      throw new Error("mic_unavailable");
    }
    const hintTimer = setTimeout(() => this.events?.onError("mic_prompt"), MIC_HINT_MS);
    let timedOut = false;
    try {
      const stream = await Promise.race([
        media.getUserMedia(mediaConstraints(deviceId)).then((s) => {
          if (!timedOut) return s;
          // Permission accordée après l'abandon : libérer ce flux orphelin.
          for (const track of s.getTracks()) track.stop();
          throw new Error("mic_timeout");
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            reject(new Error("mic_timeout"));
          }, MIC_MAX_MS),
        ),
      ]);
      // Le micro accordé, enumerateDevices() livre enfin les LIBELLÉS : c'est
      // le seul moment où le sélecteur peut afficher « Casque Jabra » plutôt
      // que « Périphérique 2 ».
      void refreshDevices();
      return stream;
    } catch (err) {
      // `instanceof DOMException` est faux d'un realm à l'autre (iframe) et
      // avec certains polyfills : on lit `name`/`message` sans contrainte de
      // type, sinon un refus de micro serait annoncé « aucun micro » et
      // l'agent chercherait un problème de matériel au lieu d'autoriser.
      const { name = "", message = "" } = (err ?? {}) as { name?: string; message?: string };
      // Micro choisi mais débranché depuis le dernier appel : reprendre sur le
      // défaut plutôt que de refuser l'appel. Le choix reste mémorisé — il
      // reprendra effet au rebranchement.
      if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
        clearTimeout(hintTimer);
        return this.acquireMic("");
      }
      const denied =
        name === "NotAllowedError" ||
        name === "SecurityError" ||
        name === "PermissionDeniedError";
      const code = denied
        ? "mic_denied"
        : name === "mic_timeout" || message === "mic_timeout"
          ? "mic_timeout"
          : "mic_unavailable";
      this.events?.onError(code);
      throw new Error(code);
    } finally {
      clearTimeout(hintTimer);
    }
  }

  private handleIncoming(e: IncomingRTCSessionEvent): void {
    const user = e.request.from.uri.user || "";
    const display = e.request.from.display_name || "";
    // Brut (10 chiffres, 11 chiffres ou déjà E.164) — normalisé côté contexte.
    const remoteNumber = user || display;

    // Déjà en ligne — ou un sortant en préflight micro (this.call sans
    // session) → 486 Busy pour le second appel.
    if (this.session || this.call) {
      try {
        e.session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      } catch {
        // rien
      }
      this.events?.onMissedWhileBusy?.(remoteNumber);
      return;
    }

    this.call = { direction: "inbound", remoteNumber, startedAt: new Date() };
    this.attachSession(e.session);
    this.events?.onIncoming(remoteNumber);
    this.events?.onCallStateChange("ringing", this.call);
  }

  private attachSession(session: RTCSession): void {
    this.session = session;
    this.wireAudio(session);

    // Allège l'offre SDP avant l'envoi (voir trimSdpForPstn). JsSIP réutilise
    // la valeur de `e.sdp` après l'événement : la muter suffit.
    session.on("sdp", (e: { originator: string; type: string; sdp: string }) => {
      if (e.originator === "local" && e.type === "offer") {
        e.sdp = trimSdpForPstn(e.sdp);
      }
    });

    // Ne pas attendre la collecte ICE complète (voir l'en-tête du fichier).
    session.on("icecandidate", (e: IceCandidateEvent) => {
      this.sawIceCandidate = true;
      const line = e.candidate?.candidate ?? "";
      if (e.candidate?.type === "srflx" || line.includes(" typ srflx")) {
        e.ready();
        return;
      }
      if (this.iceSettleTimer) clearTimeout(this.iceSettleTimer);
      this.iceSettleTimer = setTimeout(e.ready, ICE_SETTLE_MS);
      if (!this.iceMaxTimer) this.iceMaxTimer = setTimeout(e.ready, ICE_MAX_MS);
    });

    session.on("progress", () => {
      if (this.call?.direction !== "outbound") return;
      this.clearDialWatchdog();
      // TOUJOURS sonner. L'ancienne version se taisait dès qu'un 183 portait du
      // SDP, en supposant que l'opérateur enverrait sa propre tonalité — mais
      // un 183 annonce seulement qu'un flux EXISTE, pas qu'il PORTE du son, et
      // le choix entre 180 et 183 appartient au transporteur du numéro appelé.
      // D'où le « des fois ça ne sonne pas » : même ligne, même CRM, un numéro
      // sonne et le suivant reste muet. Notre tonalité se tait maintenant sur
      // du VRAI son (paquets RTP reçus), pas sur une promesse de signalisation.
      this.startRingback();
      this.events?.onCallStateChange("ringing", this.call);
    });

    const onAnswered = () => {
      this.clearDialWatchdog();
      this.stopRingback();
      if (!this.call) return;
      if (!this.call.answeredAt) this.call = { ...this.call, answeredAt: new Date() };
      this.events?.onCallStateChange("active", this.call);
    };
    session.on("accepted", onAnswered);
    session.on("confirmed", onAnswered);

    session.on("hold", () => this.events?.onCallStateChange("held", this.call));
    session.on("unhold", () => this.events?.onCallStateChange("active", this.call));

    session.on("getusermediafailed", () => {
      // Micro refusé — message clair côté UI, l'appel ne peut pas continuer.
      this.events?.onError("mic_denied");
    });

    const onEnd = (e: EndEvent) => {
      const ended = this.call;
      this.session = null;
      this.call = null;
      this.clearDialWatchdog();
      this.clearIceTimers();
      this.stopRingback();
      this.releaseLocalStream();
      if (this.audio) this.audio.srcObject = null;
      // Refus local d'un entrant (reject() → 486) : fin normale, pas d'erreur.
      // Un REJECTED distant (ex. 603 sur notre sortant) reste signalé.
      const locallyRejected =
        (e.originator as string) === "local" && e.cause === JsSIP.C.causes.REJECTED;
      if (ended && e.cause && !locallyRejected && !NORMAL_END_CAUSES.has(e.cause)) {
        if (e.cause === JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS) {
          this.events?.onError("mic_denied");
        } else if (e.cause === JsSIP.C.causes.BUSY) {
          this.events?.onError("busy");
        } else {
          this.events?.onError("call_failed");
        }
      }
      this.events?.onCallStateChange("ended", ended);
      this.events?.onCallStateChange("idle", null);
    };
    session.on("ended", onEnd);
    session.on("failed", onEnd);
  }

  /** Route le flux audio distant vers l'unique élément <audio>. */
  private wireAudio(session: RTCSession): void {
    const attach = (pc: RTCPeerConnection) => {
      pc.addEventListener("track", (e: RTCTrackEvent) => {
        if (e.track.kind !== "audio") return;
        // NE PAS couper la tonalité ici. Cet événement se déclenche quand la
        // description distante est POSÉE, pas quand du son arrive : couper là
        // laissait l'agent dans le silence pendant toute la sonnerie. C'est le
        // sondage RTP ci-dessous qui tranche, sur des paquets réellement reçus.
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        if (this.audio) {
          this.audio.srcObject = stream;
          this.playRemoteAudio();
        }
        this.watchInboundRtp(pc);
      });
    };
    if (session.connection) attach(session.connection);
    session.on("peerconnection", (e: PeerConnectionEvent) => attach(e.peerconnection));
  }

  /**
   * Lance la voix distante, et REÉSSAIE au prochain geste si le fureteur la
   * refuse. Un ancien commentaire promettait ce rattrapage sans l'implémenter :
   * l'appel restait alors muet du début à la fin, sans le moindre message —
   * l'agent parlait dans le vide en croyant que la ligne était mauvaise.
   */
  private playRemoteAudio(): void {
    const audio = this.audio;
    if (!audio) return;
    void audio.play().catch(() => {
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      const retry = () => {
        document.removeEventListener("pointerdown", retry, true);
        document.removeEventListener("keydown", retry, true);
        // L'appel a pu se terminer entre-temps : ne pas ressusciter un flux mort.
        if (this.audio === audio && audio.srcObject) void audio.play().catch(() => {});
      };
      document.addEventListener("pointerdown", retry, true);
      document.addEventListener("keydown", retry, true);
    });
  }

  /**
   * Coupe la tonalité locale à la PREMIÈRE preuve de son distant — un paquet
   * RTP entrant compté par le navigateur. Tant qu'aucun n'arrive (pré-réponse
   * muette, media bloqué par le réseau), l'agent continue d'entendre sonner
   * plutôt que d'écouter un silence qu'il ne sait pas interpréter.
   */
  private watchInboundRtp(pc: RTCPeerConnection): void {
    if (this.rtpPoll || !this.ringbackOn) return;
    this.rtpPoll = setInterval(() => {
      if (!this.ringbackOn) {
        this.clearRtpPoll();
        return;
      }
      void pc
        .getStats()
        .then((stats) => {
          let received = 0;
          stats.forEach((report) => {
            const r = report as { type?: string; kind?: string; packetsReceived?: number };
            if (r.type === "inbound-rtp" && r.kind === "audio") received += r.packetsReceived ?? 0;
          });
          if (received > 0) this.stopRingback();
        })
        .catch(() => {
          // getStats indisponible : la tonalité s'arrêtera au décroché.
        });
    }, RTP_POLL_MS);
  }

  private clearRtpPoll(): void {
    if (this.rtpPoll) {
      clearInterval(this.rtpPoll);
      this.rtpPoll = null;
    }
  }

  /** Tonalité de retour d'appel nord-américaine — voir `tones.ts`. */
  private startRingback(): void {
    if (this.ringbackOn) return;
    this.ringbackOn = true;
    startRingback();
  }

  private stopRingback(): void {
    this.clearRtpPoll();
    if (!this.ringbackOn) return;
    this.ringbackOn = false;
    stopRingback();
  }

  private releaseLocalStream(): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) track.stop();
    this.localStream = null;
  }

  /**
   * Chien de garde du sortant : si AUCUNE réponse SIP (pas même un 4xx) n'est
   * revenue, échouer clairement et recycler la connexion WS — le cas typique
   * est un socket à moitié mort que JsSIP croit encore ouvert.
   */
  private armDialWatchdog(): void {
    this.clearDialWatchdog();
    this.sawIceCandidate = false;
    this.dialWatchdog = setTimeout(() => {
      this.dialWatchdog = null;
      if (!this.session || this.call?.direction !== "outbound" || this.call.answeredAt) return;
      // Aucun candidat ICE => l'INVITE n'a jamais pu partir (le fureteur n'a
      // produit aucune adresse). Distinguer les deux cas évite de faire
      // chercher une panne réseau là où il n'y en a pas.
      this.events?.onError(this.sawIceCandidate ? "dial_timeout" : "ice_failed");
      try {
        this.session.terminate();
      } catch {
        // déjà terminée
      }
      // NE PAS recycler l'UA ici : ua.stop() désenregistre la ligne et ferme
      // le WebSocket, si bien que la tentative suivante échoue en
      // « ligne non enregistrée ». L'enregistrement n'est pas en cause —
      // l'INVITE partait sur une connexion vivante.
    }, DIAL_WATCHDOG_MS);
  }

  private clearDialWatchdog(): void {
    if (this.dialWatchdog) {
      clearTimeout(this.dialWatchdog);
      this.dialWatchdog = null;
    }
  }

  private clearIceTimers(): void {
    if (this.iceSettleTimer) {
      clearTimeout(this.iceSettleTimer);
      this.iceSettleTimer = null;
    }
    if (this.iceMaxTimer) {
      clearTimeout(this.iceMaxTimer);
      this.iceMaxTimer = null;
    }
  }

  /** Recycle immédiatement la connexion WS + l'enregistrement SIP. */
  private restartUA(): void {
    if (this.destroyed || !this.ua) return;
    this.clearReconnectTimer();
    this.reconnectDelay = RECONNECT_MIN_MS;
    try {
      this.ua.stop();
      this.ua.start();
    } catch {
      this.scheduleReconnect();
    }
  }

  private setRegistration(state: RegistrationState, error?: string): void {
    this.registration = state;
    this.events?.onRegistrationChange(state, error);
  }

  /** Re-connexion WS : backoff exponentiel 2 s → 30 s. */
  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || !this.ua) return;
      if (this.ua.isConnected() && this.ua.isRegistered()) return;
      // Appel en cours : UA.stop() terminerait la session active — on
      // repousse le cycle stop/start après la fin de l'appel (même backoff).
      if (this.session) {
        this.scheduleReconnect();
        return;
      }
      try {
        this.ua.stop();
        this.ua.start();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
