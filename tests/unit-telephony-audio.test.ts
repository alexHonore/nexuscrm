/**
 * Unitaire — le choix du haut-parleur et les tonalités du téléphone.
 *
 * Ce que ces tests protègent : un téléphoniste branche un casque en pleine
 * journée. Si UNE des trois sorties audio de l'app reste sur le défaut du
 * système, il entend l'appel mais pas la sonnerie (ou l'inverse), et il
 * rapporte « des fois ça ne sonne pas » — sans rien de reproductible.
 *
 * D'où la règle vérifiée ici : un seul choix, TOUTES les sorties suivent, y
 * compris celles inscrites après coup et celles qui survivent à un
 * débranchement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Bouchons ─────────────────────────────────────────────────────────────────

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

/** Élément média façon Chrome : il a setSinkId. */
function fakeMediaElement() {
  const calls: string[] = [];
  return {
    calls,
    el: {
      setSinkId: (id: string) => {
        calls.push(id);
        return Promise.resolve();
      },
    } as unknown as HTMLMediaElement,
  };
}

let deviceChangeHandler: (() => void) | null = null;

function stubMediaDevices(devices: Partial<MediaDeviceInfo>[]) {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: () => Promise.resolve(devices),
      addEventListener: (type: string, fn: () => void) => {
        if (type === "devicechange") deviceChangeHandler = fn;
      },
    },
  });
}

beforeEach(() => {
  deviceChangeHandler = null;
  vi.stubGlobal("localStorage", fakeStorage());
  stubMediaDevices([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ── Registre des sorties ─────────────────────────────────────────────────────

describe("choix du haut-parleur", () => {
  it("applique le choix mémorisé à une sortie inscrite APRÈS coup", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    store.setOutputChoice("casque-123");

    // Le moteur naît plus tard (« Réessayer », changement de fournisseur) :
    // son élément <audio> doit hériter du choix sans que l'usager y retouche.
    const { el, calls } = fakeMediaElement();
    store.registerSink(store.sinkForElement(el));

    expect(calls).toEqual(["casque-123"]);
  });

  it("re-route TOUTES les sorties vivantes d'un seul choix", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    const a = fakeMediaElement();
    const b = fakeMediaElement();
    store.registerSink(store.sinkForElement(a.el));
    store.registerSink(store.sinkForElement(b.el));

    store.setOutputChoice("casque-123");

    // "" à l'inscription (aucun choix), puis le casque : les deux ont suivi.
    expect(a.calls).toEqual(["default", "casque-123"]);
    expect(b.calls).toEqual(["default", "casque-123"]);
  });

  it("traduit « aucun choix » en \"default\" — setSinkId refuse la chaîne vide", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    const { el, calls } = fakeMediaElement();
    store.registerSink(store.sinkForElement(el));

    store.setOutputChoice("casque-123");
    store.setOutputChoice("");

    expect(calls).toEqual(["default", "casque-123", "default"]);
  });

  it("ne touche pas à une sortie désinscrite (moteur détruit)", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    const { el, calls } = fakeMediaElement();
    const release = store.registerSink(store.sinkForElement(el));
    release();

    store.setOutputChoice("casque-123");
    expect(calls).toEqual(["default"]);
  });

  it("ne lève pas sur un navigateur sans setSinkId (Safari, Firefox)", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    const el = {} as HTMLMediaElement; // aucun setSinkId
    expect(() => store.registerSink(store.sinkForElement(el))).not.toThrow();
    expect(() => store.setOutputChoice("casque-123")).not.toThrow();
  });

  it("survit à un stockage bloqué (navigation privée) sans perdre le choix", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    const store = await import("@/lib/telephony/audio-devices");
    const { el, calls } = fakeMediaElement();
    store.registerSink(store.sinkForElement(el));

    expect(() => store.setOutputChoice("casque-123")).not.toThrow();
    // Perdu au rechargement, mais vivant pour cette session.
    expect(store.getOutputChoice()).toBe("casque-123");
    expect(calls).toContain("casque-123");
  });

  it("persiste le choix — un rechargement retrouve le casque", async () => {
    const storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
    const first = await import("@/lib/telephony/audio-devices");
    first.setOutputChoice("casque-123");

    vi.resetModules();
    const second = await import("@/lib/telephony/audio-devices");
    expect(second.getOutputChoice()).toBe("casque-123");
  });
});

// ── Branchements à chaud ─────────────────────────────────────────────────────

describe("branchement d'un appareil en cours de journée", () => {
  it("ré-applique le choix quand la liste des appareils change", async () => {
    stubMediaDevices([
      { kind: "audiooutput", deviceId: "casque-123", label: "Jabra" },
    ] as Partial<MediaDeviceInfo>[]);
    const store = await import("@/lib/telephony/audio-devices");
    const { el, calls } = fakeMediaElement();
    store.registerSink(store.sinkForElement(el));
    store.setOutputChoice("casque-123");
    store.primeAudioDevices();
    await vi.waitFor(() => expect(deviceChangeHandler).not.toBeNull());

    calls.length = 0;
    // Chrome bascule les sorties vivantes sur le défaut au rebranchement :
    // sans cette relance, le son resterait dans le portable.
    deviceChangeHandler?.();
    await vi.waitFor(() => expect(calls).toEqual(["casque-123"]));
  });

  it("signale un appareil choisi mais absent, sans effacer le choix", async () => {
    stubMediaDevices([
      { kind: "audiooutput", deviceId: "hp-portable", label: "Haut-parleurs" },
    ] as Partial<MediaDeviceInfo>[]);
    const store = await import("@/lib/telephony/audio-devices");
    store.setOutputChoice("casque-debranche");
    await store.refreshDevices();

    expect(store.choiceMissing("audiooutput", "casque-debranche")).toBe(true);
    expect(store.getOutputChoice()).toBe("casque-debranche"); // le rebrancher suffira
  });

  it("n'affirme rien tant que la liste des appareils est inconnue", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    expect(store.choiceMissing("audiooutput", "casque-123")).toBe(false);
  });

  it("dit si les libellés sont lisibles — sinon l'UI doit demander le micro", async () => {
    stubMediaDevices([
      { kind: "audiooutput", deviceId: "a", label: "" },
      { kind: "audioinput", deviceId: "b", label: "" },
    ] as Partial<MediaDeviceInfo>[]);
    const store = await import("@/lib/telephony/audio-devices");
    await store.refreshDevices();
    expect(store.getSnapshot().labelled).toBe(false);

    stubMediaDevices([
      { kind: "audiooutput", deviceId: "a", label: "Jabra Evolve" },
    ] as Partial<MediaDeviceInfo>[]);
    await store.refreshDevices();
    expect(store.getSnapshot().labelled).toBe(true);
  });

  it("rend TOUJOURS le même objet côté serveur (useSyncExternalStore)", async () => {
    const store = await import("@/lib/telephony/audio-devices");
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });
});

// ── Tonalités ────────────────────────────────────────────────────────────────

type GainStub = {
  gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: () => void };
  connect: () => void;
  disconnect: () => void;
};

function stubAudioContext() {
  const gains: GainStub[] = [];
  const sinkIds: string[] = [];
  class Ctx {
    static instances = 0;
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      Ctx.instances += 1;
    }
    resume = () => Promise.resolve();
    close = () => Promise.resolve();
    setSinkId = (id: string) => {
      sinkIds.push(id);
      return Promise.resolve();
    };
    createGain = () => {
      const g: GainStub = {
        gain: { value: 0, setValueAtTime: vi.fn(), cancelScheduledValues: () => {} },
        connect: () => {},
        disconnect: () => {},
      };
      gains.push(g);
      return g;
    };
    createOscillator = () => ({
      type: "sine",
      frequency: { value: 0 },
      connect: () => {},
      start: () => {},
      stop: () => {},
      disconnect: () => {},
    });
  }
  vi.stubGlobal("AudioContext", Ctx);
  return { Ctx, gains, sinkIds };
}

describe("tonalités", () => {
  it("n'ouvre QU'UN contexte audio pour la sonnerie et le retour d'appel", async () => {
    const { Ctx } = stubAudioContext();
    const tones = await import("@/lib/telephony/tones");

    tones.primeTones();
    tones.startRingback();
    tones.stopRingback();
    tones.startRingtone();
    tones.stopRingtone();

    // Chrome plafonne à six contextes par page : en ouvrir un par sonnerie
    // finit par rendre le téléphone muet pour le reste de la session.
    expect(Ctx.instances).toBe(1);
  });

  it("suit le haut-parleur choisi — la sonnerie ne reste pas dans le portable", async () => {
    const { sinkIds } = stubAudioContext();
    const store = await import("@/lib/telephony/audio-devices");
    const tones = await import("@/lib/telephony/tones");
    store.setOutputChoice("casque-123");

    tones.primeTones();

    expect(sinkIds).toContain("casque-123");
  });

  it("programme la cadence d'avance sur l'horloge audio, pas au fil des minuteries", async () => {
    const { gains } = stubAudioContext();
    const tones = await import("@/lib/telephony/tones");
    tones.startRingtone();

    // Un onglet en arrière-plan voit ses setInterval bridés à un tic par
    // minute : une cadence pilotée à la minuterie s'étirerait exactement quand
    // elle compte. Ici la minute qui vient est déjà écrite.
    const scheduled = gains[0]?.gain.setValueAtTime.mock.calls.length ?? 0;
    expect(scheduled).toBeGreaterThanOrEqual(20); // 10 cycles × (début + fin)
    tones.stopRingtone();
  });

  it("dit que le son ne sortira pas tant que le contexte est suspendu", async () => {
    class Suspended {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      close = () => Promise.resolve();
      createGain = () => ({
        gain: { value: 0, setValueAtTime: vi.fn(), cancelScheduledValues: () => {} },
        connect: () => {},
        disconnect: () => {},
      });
      createOscillator = () => ({
        type: "sine",
        frequency: { value: 0 },
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
      });
    }
    vi.stubGlobal("AudioContext", Suspended);
    const tones = await import("@/lib/telephony/tones");
    tones.primeTones();

    // Un appel entrant est un événement RÉSEAU : sans geste préalable, Chrome
    // garde le contexte suspendu et la sonnerie naît muette. L'UI doit le
    // savoir pour proposer « Activer le son » au lieu de sonner dans le vide.
    expect(tones.tonesAudible()).toBe(false);
  });

  it("ne lève pas quand WebAudio est absent", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const tones = await import("@/lib/telephony/tones");
    expect(() => tones.primeTones()).not.toThrow();
    expect(() => tones.startRingtone()).not.toThrow();
    expect(() => tones.stopRingtone()).not.toThrow();
    expect(tones.tonesAudible()).toBe(false);
  });
});
