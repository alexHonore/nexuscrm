"use client";

/**
 * Les deux tonalités du téléphone : la sonnerie d'appel entrant et le retour
 * d'appel du sortant (440 + 480 Hz, 2 s / 4 s — la cadence nord-américaine).
 *
 * Un SEUL AudioContext pour les deux, et trois raisons qui ne sont pas de la
 * cosmétique :
 *
 * 1. **Le déverrouillage.** Chrome crée un AudioContext SUSPENDU tant que la
 *    page n'a pas reçu de geste. Une sonnerie fabriquée au moment où l'appel
 *    arrive — un événement réseau, jamais un clic — naît donc muette, et
 *    `resume()` échoue en silence. Le contexte est ici créé au montage du
 *    téléphone et réveillé au PREMIER geste de l'usager, bien avant le premier
 *    appel : le téléphoniste qui travaille dans le CRM depuis dix minutes a
 *    cliqué cent fois.
 * 2. **Le haut-parleur.** Le contexte s'inscrit au registre des sorties
 *    (audio-devices) : le casque choisi reçoit AUSSI les tonalités, pas
 *    seulement la voix. Sinon l'appel est au casque et la sonnerie dans les
 *    haut-parleurs du portable.
 * 3. **L'onglet en arrière-plan.** Chrome bride les `setInterval` d'un onglet
 *    caché (jusqu'à une fois par minute). Une cadence pilotée par minuterie
 *    s'étire donc exactement quand elle compte le plus. Ici tout est programmé
 *    à l'avance sur l'horloge audio, qui, elle, n'est pas bridée.
 */

import { registerSink, sinkForContext } from "./audio-devices";

const RING_HZ = [440, 480];
const RING_ON_S = 2;
const CYCLE_S = 6;
/** Cadence programmée d'avance (60 s) : survit à un onglet bridé à 1 tic/min. */
const AHEAD_CYCLES = 10;

type Tone = {
  gain: GainNode;
  oscillators: OscillatorNode[];
  /** Prochain début de sonnerie, sur l'horloge du contexte. */
  nextAt: number;
  level: number;
  timer: ReturnType<typeof setInterval> | null;
  vibrate: ReturnType<typeof setInterval> | null;
};

let ctx: AudioContext | null = null;
let releaseSink: (() => void) | null = null;
let unlockBound = false;
const stateListeners = new Set<() => void>();

function AudioContextCtor(): typeof AudioContext | null {
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function notifyState(): void {
  for (const fn of stateListeners) fn();
}

/**
 * Réveille le contexte au premier geste. On n'utilise PAS `{ once: true }` :
 * un contexte peut retomber en `suspended` (changement de sortie, mise en
 * veille), et le geste suivant doit le relever.
 */
function bindUnlock(): void {
  if (unlockBound || typeof document === "undefined") return;
  if (typeof document.addEventListener !== "function") return;
  unlockBound = true;
  const resume = () => {
    if (!ctx || ctx.state === "running") return;
    void ctx.resume().then(notifyState).catch(() => {});
  };
  for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
    document.addEventListener(type, resume, { capture: true, passive: true });
  }
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = AudioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  releaseSink = registerSink(sinkForContext(ctx));
  bindUnlock();
  void ctx.resume().then(notifyState).catch(() => {});
  return ctx;
}

/**
 * À appeler au montage du téléphone. Crée le contexte et arme le
 * déverrouillage bien avant qu'un appel n'arrive.
 */
export function primeTones(): void {
  context();
}

/** Le son sortira-t-il vraiment ? `false` = il faut un geste de l'usager. */
export function tonesAudible(): boolean {
  return ctx?.state === "running";
}

/** Abonnement à l'état du contexte (pour proposer « Activer le son »). */
export function subscribeToneState(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => {
    stateListeners.delete(fn);
  };
}

/** Réveil explicite — appelé depuis un vrai clic (bouton « Activer le son »). */
export function unlockTones(): void {
  const c = context();
  if (!c) return;
  void c.resume().then(notifyState).catch(() => {});
}

// ── Fabrication d'une tonalité ───────────────────────────────────────────────

/**
 * Programme la cadence jusqu'à l'horizon. Rejouable : chaque appel repart de
 * `nextAt`, donc rien n'est programmé deux fois.
 */
function schedule(c: AudioContext, tone: Tone): void {
  const horizon = c.currentTime + AHEAD_CYCLES * CYCLE_S;
  // Une cadence en retard (contexte suspendu puis réveillé) repart de maintenant
  // au lieu de rattraper vingt cycles d'un coup.
  if (tone.nextAt < c.currentTime) tone.nextAt = c.currentTime + 0.05;
  while (tone.nextAt < horizon) {
    tone.gain.gain.setValueAtTime(tone.level, tone.nextAt);
    tone.gain.gain.setValueAtTime(0, tone.nextAt + RING_ON_S);
    tone.nextAt += CYCLE_S;
  }
}

function startTone(level: number, vibrate: boolean): Tone | null {
  const c = context();
  if (!c) return null;
  if (c.state !== "running") void c.resume().then(notifyState).catch(() => {});

  const gain = c.createGain();
  gain.gain.value = 0;
  gain.connect(c.destination);

  const oscillators = RING_HZ.map((freq) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start();
    return osc;
  });

  const tone: Tone = { gain, oscillators, nextAt: c.currentTime + 0.05, level, timer: null, vibrate: null };
  schedule(c, tone);
  // Ré-alimente la programmation à mi-horizon : même bridé à un tic par
  // minute, l'onglet caché garde toujours au moins 30 s de cadence devant lui.
  tone.timer = setInterval(() => schedule(c, tone), (AHEAD_CYCLES * CYCLE_S * 1000) / 2);

  if (vibrate && typeof navigator !== "undefined" && "vibrate" in navigator) {
    const buzz = () => navigator.vibrate?.([400, 200, 400]);
    buzz();
    tone.vibrate = setInterval(buzz, CYCLE_S * 1000);
  }
  return tone;
}

function stopTone(tone: Tone | null): void {
  if (!tone) return;
  if (tone.timer) clearInterval(tone.timer);
  if (tone.vibrate) {
    clearInterval(tone.vibrate);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(0);
  }
  try {
    tone.gain.gain.cancelScheduledValues(0);
    tone.gain.gain.value = 0;
  } catch {
    // contexte déjà fermé
  }
  for (const osc of tone.oscillators) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      // déjà arrêté
    }
  }
  try {
    tone.gain.disconnect();
  } catch {
    // déjà détaché
  }
}

// ── Les deux tonalités ───────────────────────────────────────────────────────

let ringtone: Tone | null = null;
let ringback: Tone | null = null;

/** Sonnerie d'appel entrant (avec vibration sur mobile). */
export function startRingtone(): void {
  if (ringtone) return;
  ringtone = startTone(0.12, true);
}

export function stopRingtone(): void {
  stopTone(ringtone);
  ringtone = null;
}

/** Retour d'appel du sortant — plus discret : il joue dans l'oreille de l'agent. */
export function startRingback(): void {
  if (ringback) return;
  ringback = startTone(0.08, false);
}

export function stopRingback(): void {
  stopTone(ringback);
  ringback = null;
}

/** Uniquement pour les tests — remet le module à neuf. */
export function resetTonesForTests(): void {
  stopRingtone();
  stopRingback();
  releaseSink?.();
  releaseSink = null;
  void ctx?.close().catch(() => {});
  ctx = null;
}
