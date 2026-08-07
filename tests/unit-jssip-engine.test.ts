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
  it("échoue l'appel après 20 s sans aucune réponse SIP", async () => {
    const { engine, events } = await bootEngine();
    await dialWithMic(engine);
    const session = h.state.session;

    await vi.advanceTimersByTimeAsync(19_000);
    expect(events.onError).not.toHaveBeenCalledWith("dial_timeout");

    await vi.advanceTimersByTimeAsync(1_500);
    expect(events.onError).toHaveBeenCalledWith("dial_timeout");
    expect(session?.terminate).toHaveBeenCalled();
    // La connexion est recyclée : un socket à moitié mort ne reste pas en place.
    expect(h.state.ua?.stop).toHaveBeenCalled();
    expect(h.state.ua?.start.mock.calls.length).toBeGreaterThan(1);
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

describe("tonalité de retour d'appel", () => {
  it("sonne sur un 180 sans SDP", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    const created = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        destination = {};
        constructor() {
          created();
        }
        resume = () => Promise.resolve();
        close = () => Promise.resolve();
        createGain = () => ({ gain: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn() });
        createOscillator = () => ({ frequency: { value: 0 }, connect: vi.fn(), start: vi.fn() });
      },
    );

    h.state.session?.emit("progress", { originator: "remote", response: { body: null } });
    expect(created).toHaveBeenCalled();
  });

  it("reste muette sur un 183 avec SDP (voip.ms envoie déjà l'audio)", async () => {
    const { engine } = await bootEngine();
    await dialWithMic(engine);
    const created = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        destination = {};
        constructor() {
          created();
        }
        resume = () => Promise.resolve();
        close = () => Promise.resolve();
        createGain = () => ({ gain: { value: 0, setValueAtTime: vi.fn() }, connect: vi.fn() });
        createOscillator = () => ({ frequency: { value: 0 }, connect: vi.fn(), start: vi.fn() });
      },
    );

    h.state.session?.emit("progress", {
      originator: "remote",
      response: { body: "v=0\r\no=- 1 1 IN IP4 1.2.3.4\r\n" },
    });
    expect(created).not.toHaveBeenCalled();
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
