import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, fn: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: unknown[]) { this.handlers.get(event)?.forEach((fn) => fn(...args)); }
  }
  class FakeCall extends Emitter {
    static Codec = { Opus: "opus", PCMU: "pcmu" };
    static State = { Pending: "pending", Open: "open" };
    parameters = { From: "+15145550142" };
    state = "pending";
    status = () => this.state;
    mute = vi.fn();
    sendDigits = vi.fn();
    accept = vi.fn(() => { this.state = "open"; this.emit("accept"); });
    disconnect = vi.fn(() => this.emit("disconnect"));
    reject = vi.fn(() => this.emit("reject"));
    getLocalStream = () => undefined;
  }
  const state = { device: null as FakeDevice | null };
  class FakeDevice extends Emitter {
    audio = {
      isOutputSelectionSupported: true,
      speakerDevices: { set: vi.fn().mockResolvedValue(undefined) },
      ringtoneDevices: { set: vi.fn().mockResolvedValue(undefined) },
      setInputDevice: vi.fn().mockResolvedValue(undefined),
      unsetInputDevice: vi.fn().mockResolvedValue(undefined),
      setAudioConstraints: vi.fn().mockResolvedValue(undefined),
    };
    constructor() { super(); state.device = this; }
    register = vi.fn(async () => this.emit("registered"));
    connect = vi.fn().mockImplementation(async () => new FakeCall());
    disconnectAll = vi.fn();
    destroy = vi.fn();
    updateToken = vi.fn();
  }
  return { FakeCall, FakeDevice, device: () => state.device! };
});
vi.mock("@twilio/voice-sdk", () => ({ Device: h.FakeDevice, Call: h.FakeCall }));

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [] } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function boot() {
  const { TwilioEngine } = await import("@/lib/telephony/engines/twilio-engine");
  const engine = new TwilioEngine();
  const events = { onRegistrationChange: vi.fn(), onCallStateChange: vi.fn(), onIncoming: vi.fn(), onError: vi.fn(), onQuality: vi.fn() };
  await engine.init({ twilioToken: "local-test-token" }, events);
  return { engine, events, device: h.device() };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("Twilio phone lifecycle", () => {
  it("does not acquire the microphone while idle; uses speech processing on calls", async () => {
    const { engine, device } = await boot();
    expect(device.audio.setInputDevice).not.toHaveBeenCalled();
    expect(device.audio.setAudioConstraints).toHaveBeenCalledWith(expect.objectContaining({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }));
    await engine.dial("+15145550142");
    expect(device.connect).toHaveBeenCalledWith(expect.objectContaining({ rtcConstraints: expect.objectContaining({ video: false }) }));
    engine.destroy();
  });

  it("disconnects an outgoing call returned after hangup and rejects double dial", async () => {
    const { engine, events, device } = await boot();
    let resolve!: (call: InstanceType<typeof h.FakeCall>) => void;
    device.connect.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = engine.dial("+15145550142").catch((e) => e.message);
    await flush();
    await expect(engine.dial("+15145550143")).rejects.toThrow("already_in_call");
    engine.hangup();
    const call = new h.FakeCall();
    resolve(call);
    expect(await pending).toBe("canceled");
    expect(call.disconnect).toHaveBeenCalledOnce();
    expect(events.onCallStateChange.mock.calls.map(([state]) => state)).toEqual(["connecting", "ended", "idle"]);
  });

  it("resets a failed connect and permits the next call", async () => {
    const { engine, events, device } = await boot();
    device.connect.mockRejectedValueOnce(new Error("offline"));
    await expect(engine.dial("+15145550142")).rejects.toThrow("offline");
    expect(events.onCallStateChange).toHaveBeenLastCalledWith("idle", null);
    await engine.dial("+15145550143");
    expect(device.connect).toHaveBeenCalledTimes(2);
    engine.destroy();
  });

  it("switches to default during a live call without using the forbidden unset operation", async () => {
    const { engine, device } = await boot();
    await engine.dial("+15145550142");
    device.audio.setInputDevice.mockClear();
    await engine.setInputDevice("");
    expect(device.audio.setInputDevice).toHaveBeenCalledWith("default");
    expect(device.audio.unsetInputDevice).not.toHaveBeenCalled();
    engine.hangup();
    await flush();
    expect(device.audio.unsetInputDevice).toHaveBeenCalledOnce();
  });

  it("mute toggles cannot unmute an on-hold call; resuming restores the user's mute", async () => {
    const { engine, device } = await boot();
    const call = new h.FakeCall();
    device.connect.mockResolvedValue(call);
    await engine.dial("+15145550142");
    call.emit("accept");
    engine.hold(true);
    engine.mute(false);
    expect(call.mute).toHaveBeenLastCalledWith(true);
    engine.mute(true);
    engine.hold(false);
    expect(call.mute).toHaveBeenLastCalledWith(true);
    engine.mute(false);
    expect(call.mute).toHaveBeenLastCalledWith(false);
    engine.destroy();
  });

  it("ignores end and error events from an old call", async () => {
    const { engine, events, device } = await boot();
    const first = new h.FakeCall();
    device.connect.mockResolvedValueOnce(first);
    await engine.dial("+15145550142");
    first.emit("disconnect");
    await engine.dial("+15145550143");
    events.onCallStateChange.mockClear();
    events.onError.mockClear();
    first.emit("error");
    first.emit("cancel");
    expect(events.onCallStateChange).not.toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
    engine.destroy();
  });

  it("rejects a pending incoming call on hangup and never answers it after microphone setup finishes", async () => {
    const { engine, device } = await boot();
    const incoming = new h.FakeCall();
    device.emit("incoming", incoming);
    let resolve!: () => void;
    device.audio.setInputDevice.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    engine.answer();
    engine.answer();
    await flush();
    engine.hangup();
    resolve();
    await flush();
    expect(incoming.reject).toHaveBeenCalledOnce();
    expect(incoming.accept).not.toHaveBeenCalled();
  });

  it("never reports received RTP loss as loss of the caller's outgoing voice", async () => {
    const { engine, events, device } = await boot();
    const call = new h.FakeCall();
    device.connect.mockResolvedValue(call);
    await engine.dial("+15145550142");
    call.emit("accept");
    call.emit("sample", { codecName: "opus", jitter: 10, rtt: 50, packetsLost: 10, packetsReceived: 90 });
    const sample = events.onQuality.mock.calls[0][0];
    expect(sample.inbound.lossPercent).toBe(10);
    expect(sample.outbound.lossPercent).toBeNull();
    expect(sample.level).toBe("poor");
    engine.destroy();
  });
});
