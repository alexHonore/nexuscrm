/**
 * Moteur JsSIP — comportements qui empêchent l'appel de rester bloqué sur
 * « Connexion… ».
 *
 * Le bug d'origine, reproduit dans Chrome sur le poste du courtier : la
 * collecte ICE ne se TERMINE jamais (iceGatheringState reste « gathering »,
 * aucun candidat null n'est émis) alors que des candidats utilisables
 * arrivent en 13 ms et 134 ms. JsSIP attend la fin de la collecte avant
 * d'émettre l'INVITE : sans court-circuit, l'appel n'est jamais composé.
 *
 * Ces tests tournent sans navigateur : JsSIP est simulé et les rares API DOM
 * utilisées par le moteur sont bouchonnées.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Simulacre de JsSIP ───────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  type Handler = (arg?: unknown) => void;

  class Emitter {
    private handlers = new Map<string, Handler[]>();
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, arg?: unknown) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(arg);
    }
    has(event: string) {
      return (this.handlers.get(event) ?? []).length > 0;
    }
  }

  class FakeSession extends Emitter {
    connection: unknown = null;
    terminate = vi.fn();
    answer = vi.fn();
    mute = vi.fn();
    unmute = vi.fn();
    hold = vi.fn();
    unhold = vi.fn();
    sendDTMF = vi.fn();
  }

  const state: {
    ua: FakeUA | null;
    session: FakeSession | null;
    callOptions: Record<string, unknown> | null;
  } = { ua: null, session: null, callOptions: null };

  class FakeUA extends Emitter {
    registered = true;
    connected = true;
    start = vi.fn();
    stop = vi.fn();
    constructor(config: unknown) {
      super();
      void config;
      state.ua = this;
    }
    isRegistered() {
      return this.registered;
    }
    isConnected() {
      return this.connected;
    }
    call = vi.fn((_target: string, options: Record<string, unknown>) => {
      const session = new FakeSession();
      state.session = session;
      state.callOptions = options;
      return session;
    });
  }

  const causes = {
    BYE: "Terminated",
    CANCELED: "Canceled",
    NO_ANSWER: "No Answer",
    EXPIRES: "Expires",
    REJECTED: "Rejected",
    USER_DENIED_MEDIA_ACCESS: "User Denied Media Access",
    BUSY: "Busy",
  };

  return { Emitter, FakeSession, FakeUA, state, causes };
});

vi.mock("jssip", () => ({
  default: {
    UA: h.FakeUA,
    WebSocketInterface: class {
      constructor(public url: string) {}
    },
    C: { causes: h.causes, DTMF_TRANSPORT: { RFC2833: "RFC2833" } },
  },
}));

// ── Bouchons DOM / WebRTC ────────────────────────────────────────────────────

let gumResolve: ((stream: unknown) => void) | null = null;
let gumReject: ((err: unknown) => void) | null = null;
let stoppedTracks = 0;

function fakeStream() {
  return {
    getTracks: () => [
      {
        kind: "audio",
        stop: () => {
          stoppedTracks += 1;
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.state.ua = null;
  h.state.session = null;
  h.state.callOptions = null;
  gumResolve = null;
  gumReject = null;
  stoppedTracks = 0;

  const audioEl = {
    autoplay: false,
    style: {} as Record<string, string>,
    srcObject: null as unknown,
    setAttribute: vi.fn(),
    remove: vi.fn(),
    play: () => Promise.resolve(),
  };
  vi.stubGlobal("document", {
    createElement: () => audioEl,
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            gumResolve = resolve;
            gumReject = reject;
          }),
      ),
    },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      close = () => Promise.resolve();
      createGain = () => ({
        gain: { value: 0, setValueAtTime: vi.fn() },
        connect: vi.fn(),
      });
      createOscillator = () => ({
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
      });
    },
  );
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[] = []) {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── Utilitaires ──────────────────────────────────────────────────────────────

type Events = {
  onRegistrationChange: ReturnType<typeof vi.fn>;
  onCallStateChange: ReturnType<typeof vi.fn>;
  onIncoming: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

async function bootEngine() {
  const { JsSipEngine } = await import("@/lib/telephony/engines/jssip-engine");
  const events = {
    onRegistrationChange: vi.fn(),
    onCallStateChange: vi.fn(),
    onIncoming: vi.fn(),
    onError: vi.fn(),
  } satisfies Record<string, ReturnType<typeof vi.fn>> as unknown as Events &
    import("@/lib/telephony/types").TelephonyEvents;
  const engine = new JsSipEngine();
  await engine.init(
    {
      wssUrl: "wss://passerelle.test/ws",
      sipUsername: "551013_alex",
      sipPassword: "secret",
      sipDomain: "montreal1.voip.ms",
    },
    events,
  );
  return { engine, events };
}

/** Lance dial() et laisse le micro se résoudre — l'INVITE part alors. */
async function dialWithMic(engine: { dial: (n: string) => Promise<void> }) {
  const pending = engine.dial("+15145550142");
  await vi.advanceTimersByTimeAsync(0);
  gumResolve?.(fakeStream());
  await vi.advanceTimersByTimeAsync(0);
  await pending;
}

function states(events: Events): string[] {
  return events.onCallStateChange.mock.calls.map((c) => c[0] as string);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("numéro composé dans l'URI SIP", () => {
  it("retire le « + » de l'E.164 — voip.ms n'apparie que des chiffres", async () => {
    const { toDialString } = await import("@/lib/telephony/engines/jssip-engine");
    expect(toDialString("+14189065924")).toBe("14189065924");
    expect(toDialString("+1 (418) 906-5924")).toBe("14189065924");
    expect(toDialString("4189065924")).toBe("4189065924");
    // Serveurs vocaux : # et * doivent survivre.
    expect(toDialString("*97")).toBe("*97");
    expect(toDialString("1234#")).toBe("1234#");
  });

  it("compose une URI SIP sans « + » (régression : 100 Trying puis silence)", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    const target = h.state.ua?.call.mock.calls[0]?.[0] as string;
    expect(target).toBe("sip:15145550142@montreal1.voip.ms");
    expect(target).not.toContain("+");
  });
});

describe("allègement du SDP (INVITE sous le MTU)", () => {
  // Offre Chrome représentative : 8 codecs + extensions d'en-tête.
  const chromeOffer = [
    "v=0", "o=- 461173 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
    "a=group:BUNDLE 0", "a=msid-semantic: WMS s0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
    "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:abcd", "a=ice-pwd:0123456789012345678901",
    "a=fingerprint:sha-256 8F:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8:09:1A:2B:3C:4D:5E:6F:70:81:92:A3:B4:C5:D6:E7:F8",
    "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
    "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
    "a=setup:actpass", "a=mid:0", "a=sendrecv", "a=rtcp-mux",
    "a=rtpmap:111 opus/48000/2", "a=rtcp-fb:111 transport-cc",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2", "a=fmtp:63 111/111",
    "a=rtpmap:9 G722/8000", "a=rtpmap:0 PCMU/8000", "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:13 CN/8000",
    "a=rtpmap:110 telephone-event/48000", "a=rtpmap:126 telephone-event/8000",
  ].join("\r\n");

  it("ne garde que les codecs utilisables par voip.ms", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const out = trimSdpForPstn(chromeOffer);

    expect(out).toContain("a=rtpmap:0 PCMU/8000");
    expect(out).toContain("a=rtpmap:8 PCMA/8000");
    expect(out).toContain("a=rtpmap:9 G722/8000");
    expect(out).toContain("a=rtpmap:126 telephone-event/8000"); // DTMF conservé
    expect(out).not.toContain("opus");
    expect(out).not.toContain("red/48000");
    expect(out).not.toContain("CN/8000");
    expect(out).not.toContain("telephone-event/48000");
  });

  it("retire les payloads supprimés de la ligne m=audio", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const m = trimSdpForPstn(chromeOffer).split("\r\n").find((l) => l.startsWith("m=audio"));
    expect(m).toBe("m=audio 9 UDP/TLS/RTP/SAVPF 9 0 8 126");
  });

  it("supprime aussi les fmtp/rtcp-fb orphelins et les extmap", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const out = trimSdpForPstn(chromeOffer);
    expect(out).not.toContain("a=fmtp:111");
    expect(out).not.toContain("a=rtcp-fb:111");
    expect(out).not.toContain("a=fmtp:63");
    expect(out).not.toContain("a=extmap:");
  });

  it("retire la comptabilité WebRTC inutile (a=ssrc, a=msid, BUNDLE…)", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const withWebrtcCruft = [
      chromeOffer,
      "a=msid:s0 a0",
      "a=rtcp-rsize",
      "a=ssrc:1234567890 cname:abcdefghijklmnop",
      "a=ssrc:1234567890 msid:s0 a0",
      "a=ssrc-group:FID 1234567890",
    ].join("\r\n");
    const out = trimSdpForPstn(withWebrtcCruft);
    for (const gone of ["a=ssrc:", "a=ssrc-group:", "a=msid:", "a=msid-semantic", "a=group:BUNDLE", "a=rtcp-rsize", "a=extmap-allow-mixed"]) {
      expect(out).not.toContain(gone);
    }
    // La négociation média elle-même reste intacte.
    expect(out).toContain("a=fingerprint:");
    expect(out).toContain("a=ice-ufrag:abcd");
    expect(out).toContain("a=rtcp-mux");
  });

  it("ramène une offre Chrome réaliste bien sous le MTU", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    // Offre proche du réel mesuré en production (1419 o, 4 candidats ICE).
    const realistic = [
      chromeOffer,
      "a=msid:stream0 audio0",
      "a=rtcp-rsize",
      "a=ssrc:1111111111 cname:aaaaaaaaaaaaaaaa",
      "a=ssrc:1111111111 msid:stream0 audio0",
      "a=ssrc:1111111111 mslabel:stream0",
      "a=ssrc:1111111111 label:audio0",
    ].join("\r\n");
    // rtpengine retire ICE/DTLS vers voip.ms : on mesure ce qui SUBSISTE.
    const relayed = trimSdpForPstn(realistic)
      .split("\r\n")
      .filter((l) => !/^a=(candidate|ice-|fingerprint|setup)/.test(l))
      .join("\r\n");
    expect(relayed.length).toBeLessThan(700);
  });

  it("préserve ICE, DTLS et le reste de la négociation", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const out = trimSdpForPstn(chromeOffer);
    for (const keep of ["a=ice-ufrag:abcd", "a=ice-pwd:", "a=setup:actpass", "a=mid:0", "a=rtcp-mux", "a=sendrecv"]) {
      expect(out).toContain(keep);
    }
  });

  it("raccourcit nettement l'offre — c'est tout l'objet du correctif", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    expect(trimSdpForPstn(chromeOffer).length).toBeLessThan(chromeOffer.length * 0.8);
  });

  it("renvoie le SDP intact si aucun codec connu (sécurité)", async () => {
    const { trimSdpForPstn } = await import("@/lib/telephony/engines/jssip-engine");
    const exotic = "v=0\r\nm=audio 9 RTP/AVP 97\r\na=rtpmap:97 SPEEX/16000";
    expect(trimSdpForPstn(exotic)).toBe(exotic);
  });

  it("applique l'allègement à l'offre sortante réelle", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    const e = { originator: "local", type: "offer", sdp: chromeOffer };
    h.state.session?.emit("sdp", e);
    expect(e.sdp).not.toContain("opus");           // muté sur place
    expect(e.sdp.length).toBeLessThan(chromeOffer.length);
  });

  it("ne touche pas au SDP distant", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    const e = { originator: "remote", type: "answer", sdp: chromeOffer };
    h.state.session?.emit("sdp", e);
    expect(e.sdp).toBe(chromeOffer);
  });
});

describe("collecte ICE — court-circuit (cause racine du blocage)", () => {
  it("émet l'INVITE dès le premier candidat srflx, sans attendre la fin de la collecte", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);

    const ready = vi.fn();
    // Reproduit la trace réelle : host à 13 ms, srflx à 134 ms, puis plus rien.
    h.state.session?.emit("icecandidate", {
      candidate: { type: "host", candidate: "candidate:1 1 UDP 2122 192.168.1.10 54321 typ host" },
      ready,
    });
    expect(ready).not.toHaveBeenCalled(); // un candidat host seul ne suffit pas

    h.state.session?.emit("icecandidate", {
      candidate: { type: "srflx", candidate: "candidate:2 1 UDP 1686 1.2.3.4 54321 typ srflx" },
      ready,
    });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("reconnaît un srflx même si le champ `type` est absent (repli sur la ligne SDP)", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);

    const ready = vi.fn();
    h.state.session?.emit("icecandidate", {
      candidate: { candidate: "candidate:2 1 UDP 1686 1.2.3.4 54321 typ srflx" },
      ready,
    });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("sans srflx, part quand même 500 ms après le dernier candidat", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);

    const ready = vi.fn();
    h.state.session?.emit("icecandidate", {
      candidate: { type: "host", candidate: "candidate:1 1 UDP 2122 10.0.0.2 4444 typ host" },
      ready,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("plafonne l'attente à 3 s même si les candidats continuent d'arriver", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);

    const ready = vi.fn();
    // Un candidat host toutes les 400 ms : le minuteur de repos est sans cesse
    // repoussé — seul le plafond garantit l'envoi de l'INVITE.
    for (let i = 0; i < 10; i++) {
      h.state.session?.emit("icecandidate", {
        candidate: { type: "host", candidate: `candidate:${i} 1 UDP 2122 10.0.0.2 444${i} typ host` },
        ready,
      });
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(ready).toHaveBeenCalled();
    expect(ready.mock.invocationCallOrder.length).toBeGreaterThan(0);
  });
});

describe("préflight micro", () => {
  it("acquiert le micro AVANT de créer la session SIP", async () => {
    const { engine } = await bootEngine();
    const pending = engine.dial("+15145550142");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.state.ua?.call).not.toHaveBeenCalled();
    gumResolve?.(fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(h.state.ua?.call).toHaveBeenCalledTimes(1);
    expect(h.state.callOptions?.mediaStream).toBeDefined();
  });

  it("signale l'attente de l'invite navigateur après 2,5 s", async () => {
    const { engine, events } = await bootEngine();
    const pending = engine.dial("+15145550142").catch(() => {});
    await vi.advanceTimersByTimeAsync(2_600);
    expect(events.onError).toHaveBeenCalledWith("mic_prompt");

    gumResolve?.(fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    await pending;
  });

  it("traduit un refus du micro en erreur mic_denied et remet l'UI au repos", async () => {
    const { engine, events } = await bootEngine();
    const pending = engine.dial("+15145550142");
    await vi.advanceTimersByTimeAsync(0);

    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    gumReject?.(denied);
    await expect(pending).rejects.toThrow();

    expect(events.onError).toHaveBeenCalledWith("mic_denied");
    expect(states(events)).toEqual(["connecting", "ended", "idle"]);
    expect(h.state.ua?.call).not.toHaveBeenCalled();
  });

  it("abandonne après 30 s sans réponse à l'invite micro", async () => {
    const { engine, events } = await bootEngine();
    const pending = engine.dial("+15145550142").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(30_100);
    await pending;

    expect(events.onError).toHaveBeenCalledWith("mic_timeout");
    expect(h.state.ua?.call).not.toHaveBeenCalled();
  });
});

describe("raccrocher pendant le préflight micro", () => {
  it("n'émet PAS l'INVITE si l'agent a raccroché avant l'accès au micro", async () => {
    const { engine, events } = await bootEngine();
    const pending = engine.dial("+15145550142").catch(() => "annulé");
    await vi.advanceTimersByTimeAsync(0);

    engine.hangup(); // aucune session SIP encore : doit tout de même annuler
    expect(states(events)).toEqual(["connecting", "ended", "idle"]);

    gumResolve?.(fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe("annulé");

    expect(h.state.ua?.call).not.toHaveBeenCalled();
    expect(stoppedTracks).toBe(1); // le flux micro tardif est bien libéré
  });
});

describe("appel entrant pendant le préflight micro", () => {
  it("répond 486 Busy au lieu d'écraser l'appel sortant en cours de composition", async () => {
    const { engine, events } = await bootEngine();
    const pending = engine.dial("+15145550142");
    await vi.advanceTimersByTimeAsync(0);

    const incoming = new h.FakeSession();
    h.state.ua?.emit("newRTCSession", {
      originator: "remote",
      session: incoming,
      request: { from: { uri: { user: "4185551234" }, display_name: "" } },
    });

    expect(incoming.terminate).toHaveBeenCalledWith({
      status_code: 486,
      reason_phrase: "Busy Here",
    });
    expect(events.onIncoming).not.toHaveBeenCalled();

    gumResolve?.(fakeStream());
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(h.state.ua?.call).toHaveBeenCalledTimes(1);
  });
});

describe("chien de garde de composition", () => {
  /** Simule une collecte ICE normale : l'INVITE a donc bien pu partir. */
  const emitCandidate = () =>
    h.state.session?.emit("icecandidate", {
      candidate: { type: "srflx", candidate: "candidate:2 1 UDP 1686 1.2.3.4 5 typ srflx" },
      ready: vi.fn(),
    });

  it("échoue l'appel après 20 s sans aucune réponse SIP", async () => {
    const { engine, events } = await bootEngine();
    await dialWithMic(engine);
    emitCandidate();
    const session = h.state.session;

    await vi.advanceTimersByTimeAsync(19_000);
    expect(events.onError).not.toHaveBeenCalledWith("dial_timeout");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.onError).toHaveBeenCalledWith("dial_timeout");
    expect(session?.terminate).toHaveBeenCalled();
  });

  it("ne désenregistre PAS la ligne en expirant (sinon l'essai suivant échoue)", async () => {
    const { engine } = await bootEngine();
    const startsAfterBoot = h.state.ua!.start.mock.calls.length;
    await dialWithMic(engine);
    emitCandidate();

    await vi.advanceTimersByTimeAsync(21_000);

    expect(h.state.ua?.stop).not.toHaveBeenCalled();
    expect(h.state.ua?.start.mock.calls.length).toBe(startsAfterBoot);
  });

  it("distingue « aucun candidat ICE » d'un silence du réseau", async () => {
    const { engine, events } = await bootEngine();
    await dialWithMic(engine);
    // Aucun événement icecandidate : l'INVITE n'a jamais pu être émis.
    await vi.advanceTimersByTimeAsync(21_000);

    expect(events.onError).toHaveBeenCalledWith("ice_failed");
    expect(events.onError).not.toHaveBeenCalledWith("dial_timeout");
  });

  it("est désarmé dès qu'une réponse provisoire arrive", async () => {
    const { engine, events } = await bootEngine();
    await dialWithMic(engine);

    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    await vi.advanceTimersByTimeAsync(25_000);

    expect(events.onError).not.toHaveBeenCalledWith("dial_timeout");
    expect(states(events)).toContain("ringing");
  });
});

/**
 * La tonalité de retour d'appel — le « des fois, ça ne sonne pas » du courtier.
 *
 * L'ancienne règle inférait l'audibilité de la SIGNALISATION : un 183 portant
 * du SDP se voyait refuser la tonalité locale, au motif que l'opérateur allait
 * envoyer la sienne. Mais un 183 annonce qu'un flux EXISTE, pas qu'il PORTE du
 * son, et c'est le transporteur du numéro appelé — pas notre ligne — qui
 * choisit entre 180 et 183. D'où un silence qui frappait un numéro sur deux,
 * sans rien de reproductible à montrer.
 *
 * La règle est maintenant : on sonne toujours, et on ne se tait que sur du
 * VRAI son — un paquet RTP entrant compté par le navigateur.
 */
describe("tonalité de retour d'appel", () => {
  /** Piste audio distante + statistiques RTP pilotables depuis le test. */
  function stubPeerConnection(packetsReceived: () => number) {
    const listeners = new Map<string, (e: unknown) => void>();
    const pc = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      getStats: () =>
        Promise.resolve({
          forEach: (fn: (r: unknown) => void) =>
            fn({ type: "inbound-rtp", kind: "audio", packetsReceived: packetsReceived() }),
        }),
    };
    const emitTrack = () =>
      listeners.get("track")?.({ track: { kind: "audio" }, streams: [{}] });
    return { pc, emitTrack };
  }

  it("sonne sur un 180 sans SDP", async () => {
    const { engine } = await bootEngine();
    const tones = await import("@/lib/telephony/tones");
    const start = vi.spyOn(tones, "startRingback");
    await dialWithMic(engine);

    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    expect(start).toHaveBeenCalled();
  });

  it("sonne AUSSI sur un 183 avec SDP — un flux annoncé n'est pas un flux audible", async () => {
    const { engine } = await bootEngine();
    const tones = await import("@/lib/telephony/tones");
    const start = vi.spyOn(tones, "startRingback");
    await dialWithMic(engine);

    h.state.session?.emit("progress", {
      originator: "remote",
      response: { body: "v=0\r\no=- 1 1 IN IP4 1.2.3.4\r\n" },
    });
    expect(start).toHaveBeenCalled();
  });

  it("ne se tait PAS à la seule arrivée de la piste distante", async () => {
    const { engine } = await bootEngine();
    const tones = await import("@/lib/telephony/tones");
    const stop = vi.spyOn(tones, "stopRingback");
    await dialWithMic(engine);

    // La piste apparaît quand la description distante est posée — bien avant
    // le moindre paquet. C'est précisément là que l'ancienne version coupait.
    const { pc, emitTrack } = stubPeerConnection(() => 0);
    h.state.session?.emit("peerconnection", { peerconnection: pc });
    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    emitTrack();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(stop).not.toHaveBeenCalled();
  });

  it("se tait dès le premier paquet RTP reçu", async () => {
    const { engine } = await bootEngine();
    const tones = await import("@/lib/telephony/tones");
    const stop = vi.spyOn(tones, "stopRingback");
    await dialWithMic(engine);

    let packets = 0;
    const { pc, emitTrack } = stubPeerConnection(() => packets);
    h.state.session?.emit("peerconnection", { peerconnection: pc });
    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    emitTrack();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop).not.toHaveBeenCalled();

    packets = 3; // l'opérateur pousse enfin sa tonalité
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop).toHaveBeenCalled();
  });

  it("se tait au décroché même si aucun paquet n'a jamais été compté", async () => {
    const { engine } = await bootEngine();
    const tones = await import("@/lib/telephony/tones");
    const stop = vi.spyOn(tones, "stopRingback");
    await dialWithMic(engine);

    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    h.state.session?.emit("accepted", {});

    expect(stop).toHaveBeenCalled();
  });
});

describe("nettoyage de fin d'appel", () => {
  it("libère le micro et remet l'état au repos", async () => {
    const { engine, events } = await bootEngine();
    await dialWithMic(engine);

    h.state.session?.emit("ended", { originator: "local", cause: h.causes.BYE });

    expect(stoppedTracks).toBe(1);
    expect(states(events).slice(-2)).toEqual(["ended", "idle"]);
    expect(events.onError).not.toHaveBeenCalled(); // fin normale : pas d'erreur
  });

  it("permet un second appel après le premier", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    h.state.session?.emit("ended", { originator: "local", cause: h.causes.BYE });

    await dialWithMic(engine);
    expect(h.state.ua?.call).toHaveBeenCalledTimes(2);
  });
});

describe("garde-fous de composition", () => {
  it("refuse de composer si la ligne n'est pas enregistrée", async () => {
    const { engine, events } = await bootEngine();
    h.state.ua!.registered = false;

    await expect(engine.dial("+15145550142")).rejects.toThrow("not_registered");
    expect(events.onError).toHaveBeenCalledWith("not_registered");
  });

  it("recycle la connexion si le socket est mort malgré un enregistrement valide", async () => {
    const { engine, events } = await bootEngine();
    h.state.ua!.connected = false;

    await expect(engine.dial("+15145550142")).rejects.toThrow("not_registered");
    expect(events.onError).toHaveBeenCalledWith("not_registered");
    expect(h.state.ua?.stop).toHaveBeenCalled();
  });
});
