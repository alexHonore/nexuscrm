import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireMicrophone } from "@/lib/telephony/microphone";

function stream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], track };
}
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("microphone acquisition", () => {
  it("requests mono speech with echo cancellation, noise suppression and gain control", async () => {
    const mic = stream();
    getUserMedia.mockResolvedValue(mic);
    expect(await acquireMicrophone({ deviceId: "headset", signal: new AbortController().signal })).toBe(mic);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: {
      deviceId: { exact: "headset" }, channelCount: { ideal: 1 },
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }, video: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels immediately, stops a late stream and does not show stale prompts", async () => {
    let resolve!: (s: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const abort = new AbortController();
    const onHint = vi.fn();
    const pending = acquireMicrophone({ signal: abort.signal, onHint }).catch((e) => e.message);
    abort.abort();
    expect(await pending).toBe("canceled");
    const late = stream();
    resolve(late);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(onHint).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unanswered prompt and releases a stream obtained after timeout", async () => {
    let resolve!: (s: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const onHint = vi.fn();
    const pending = acquireMicrophone({ signal: new AbortController().signal, onHint }).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toBe("mic_timeout");
    expect(onHint).toHaveBeenCalledOnce();
    const late = stream();
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.track.stop).toHaveBeenCalledOnce();
  });

  it("falls back only for a missing selected device and reports the actual fallback", async () => {
    const mic = stream();
    getUserMedia.mockRejectedValueOnce({ name: "OverconstrainedError" }).mockResolvedValueOnce(mic);
    const onFallback = vi.fn();
    expect(await acquireMicrophone({ deviceId: "unplugged", signal: new AbortController().signal, onFallback })).toBe(mic);
    expect(getUserMedia.mock.calls[1][0].audio).not.toHaveProperty("deviceId");
    expect(onFallback).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a denied permission with another microphone", async () => {
    getUserMedia.mockRejectedValue({ name: "NotAllowedError" });
    await expect(acquireMicrophone({ deviceId: "headset", signal: new AbortController().signal })).rejects.toThrow("mic_denied");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
