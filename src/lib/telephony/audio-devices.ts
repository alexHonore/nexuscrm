"use client";

/**
 * Choix du haut-parleur et du microphone du téléphone navigateur.
 *
 * Pourquoi un magasin séparé plutôt qu'un état React : le son ne sort pas d'un
 * seul endroit. Il y a TROIS sorties audio dans l'app — l'élément <audio> de
 * l'appel, la tonalité de retour d'appel et la sonnerie d'appel entrant — et
 * Chrome les envoie chacune vers « l'appareil par défaut au moment où elle a
 * été créée ». Un casque branché en cours de journée, des AirPods qui se
 * connectent, un casque USB qui s'endort : le défaut change sous les pieds de
 * l'usager et la moitié du son part ailleurs. C'est le « des fois ça ne sonne
 * pas » du téléphoniste.
 *
 * Ce module tient donc un REGISTRE de toutes les sorties. Un seul choix les
 * re-route toutes, et le choix est ré-appliqué à chaque branchement/débranchement.
 *
 * Le choix vit dans localStorage, pas en base : il décrit CE poste de travail
 * (le casque branché sur CE portable), pas l'usager. Le même téléphoniste sur
 * un autre poste doit repartir du défaut du système.
 */

const OUTPUT_KEY = "nexus.phone.outputDeviceId";
const INPUT_KEY = "nexus.phone.inputDeviceId";

/** `""` = appareil par défaut du système — jamais `"default"` en dur. */
export type AudioDevicesSnapshot = {
  output: string;
  input: string;
  devices: MediaDeviceInfo[];
  /**
   * enumerateDevices() ne renvoie les LIBELLÉS qu'une fois le micro autorisé.
   * Avant, la liste existe mais chaque entrée est anonyme : l'UI doit demander
   * l'autorisation plutôt que d'afficher « Périphérique 1, 2, 3 ».
   */
  labelled: boolean;
};

/** Instance figée : `getServerSnapshot` doit rendre le MÊME objet à chaque appel. */
export const EMPTY_SNAPSHOT: AudioDevicesSnapshot = Object.freeze({
  output: "",
  input: "",
  devices: Object.freeze([]) as unknown as MediaDeviceInfo[],
  labelled: false,
});

// ── État du module ───────────────────────────────────────────────────────────

let choices: { output: string; input: string } | null = null;
let devices: MediaDeviceInfo[] = [];
let snapshot: AudioDevicesSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

/** Lecture paresseuse : jamais de localStorage au chargement du module (SSR, tests). */
function readChoices(): { output: string; input: string } {
  if (choices) return choices;
  try {
    choices = {
      output: localStorage.getItem(OUTPUT_KEY) ?? "",
      input: localStorage.getItem(INPUT_KEY) ?? "",
    };
  } catch {
    // Navigation privée ou stockage bloqué : le choix vaut pour cette session.
    choices = { output: "", input: "" };
  }
  return choices;
}

function persist(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // tant pis : le choix reste en mémoire jusqu'au rechargement
  }
}

function publish(): void {
  const { output, input } = readChoices();
  snapshot = {
    output,
    input,
    devices,
    labelled: devices.some((d) => d.label !== ""),
  };
  for (const fn of listeners) fn();
}

export function getOutputChoice(): string {
  return readChoices().output;
}

export function getInputChoice(): string {
  return readChoices().input;
}

// ── Registre des sorties audio ───────────────────────────────────────────────

export type AudioSink = { apply: (deviceId: string) => void };

const sinks = new Set<AudioSink>();

/**
 * Inscrit une sortie audio. Le choix mémorisé lui est appliqué TOUT DE SUITE —
 * un casque choisi hier doit recevoir l'appel d'aujourd'hui sans que
 * l'usager y retouche.
 */
export function registerSink(sink: AudioSink): () => void {
  sinks.add(sink);
  sink.apply(getOutputChoice());
  return () => {
    sinks.delete(sink);
  };
}

function applyToAllSinks(deviceId: string): void {
  for (const sink of sinks) sink.apply(deviceId);
}

/** `setSinkId` sur un élément média — Chrome/Edge seulement, sans jamais lever. */
export function sinkForElement(el: HTMLMediaElement): AudioSink {
  return {
    apply: (deviceId) => {
      const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof withSink.setSinkId !== "function") return;
      // "" n'est pas accepté par setSinkId : le défaut du système, c'est "default".
      void withSink.setSinkId(deviceId || "default").catch(() => {
        // Appareil débranché entre le choix et l'appel : Chrome garde le défaut.
      });
    },
  };
}

/** `setSinkId` sur un AudioContext — Chrome 110+. Ailleurs : sans effet. */
export function sinkForContext(ctx: AudioContext): AudioSink {
  return {
    apply: (deviceId) => {
      const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (typeof withSink.setSinkId !== "function") return;
      void Promise.resolve(withSink.setSinkId(deviceId || "")).catch(() => {});
    },
  };
}

/**
 * Le navigateur sait-il diriger le son vers un appareil précis ? Chrome et Edge
 * oui, Safari et Firefox non — et dans ce cas on ne montre AUCUN sélecteur
 * plutôt qu'un bouton qui ne fait rien.
 */
export function supportsOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function"
  );
}

// ── Écriture ─────────────────────────────────────────────────────────────────

export function setOutputChoice(deviceId: string): void {
  choices = { ...readChoices(), output: deviceId };
  persist(OUTPUT_KEY, deviceId);
  applyToAllSinks(deviceId);
  publish();
}

export function setInputChoice(deviceId: string): void {
  choices = { ...readChoices(), input: deviceId };
  persist(INPUT_KEY, deviceId);
  publish();
}

// ── Énumération et branchements à chaud ──────────────────────────────────────

export async function refreshDevices(): Promise<void> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media?.enumerateDevices) return;
  try {
    const all = await media.enumerateDevices();
    devices = all.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
  } catch {
    devices = [];
  }
  publish();
}

let deviceChangeBound = false;

/**
 * Un appareil apparaît ou disparaît : Chrome bascule les sorties vivantes sur
 * le défaut sans prévenir. On ré-applique le choix mémorisé — rebrancher le
 * casque suffit donc à y ramener le son, sans rouvrir le sélecteur.
 */
function bindDeviceChange(): void {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (deviceChangeBound || !media?.addEventListener) return;
  deviceChangeBound = true;
  media.addEventListener("devicechange", () => {
    void refreshDevices().then(() => applyToAllSinks(getOutputChoice()));
  });
}

/** À appeler au montage du téléphone : liste les appareils et suit les branchements. */
export function primeAudioDevices(): void {
  bindDeviceChange();
  void refreshDevices();
}

/** L'appareil choisi est-il encore là ? On le SIGNALE sans effacer le choix. */
export function choiceMissing(kind: MediaDeviceKind, deviceId: string): boolean {
  if (!deviceId) return false;
  if (devices.length === 0) return false; // liste inconnue : ne rien affirmer
  return !devices.some((d) => d.kind === kind && d.deviceId === deviceId);
}

// ── Abonnement (useSyncExternalStore) ────────────────────────────────────────

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  bindDeviceChange();
  return () => {
    listeners.delete(fn);
  };
}

export function getSnapshot(): AudioDevicesSnapshot {
  return snapshot;
}

export function getServerSnapshot(): AudioDevicesSnapshot {
  return EMPTY_SNAPSHOT;
}
