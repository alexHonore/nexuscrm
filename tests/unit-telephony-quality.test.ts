import { afterEach, describe, expect, it, vi } from "vitest";
import { CallQualityReader, monitorCallQuality, qualityLevel } from "@/lib/telephony/call-quality";

function reports(t: number, received: number, lost: number, remote: Record<string, unknown> = {}) {
  return new Map([
    ["out", { id: "out", type: "outbound-rtp", kind: "audio", timestamp: t, remoteId: "remote", transportId: "transport", codecId: "codec", mediaSourceId: "source" }],
    ["in", { id: "in", type: "inbound-rtp", kind: "audio", timestamp: t, packetsReceived: received, packetsLost: lost, jitter: .008 }],
    ["remote", { id: "remote", type: "remote-inbound-rtp", kind: "audio", timestamp: t, fractionLost: 0, jitter: .01, roundTripTime: .04, ...remote }],
    ["transport", { id: "transport", type: "transport", timestamp: t, selectedCandidatePairId: "pair" }],
    ["pair", { id: "pair", type: "candidate-pair", timestamp: t, currentRoundTripTime: .05 }],
    ["codec", { id: "codec", type: "codec", timestamp: t, mimeType: "audio/PCMU" }],
    ["source", { id: "source", type: "media-source", timestamp: t, audioLevel: .25 }],
  ]) as unknown as RTCStatsReport;
}
const track = { kind: "audio", enabled: true, muted: false, readyState: "live", label: "Headset", getSettings: () => ({ echoCancellation: true }) };
const pc = { connectionState: "connected", getSenders: () => [{ track }] } as unknown as RTCPeerConnection;
afterEach(() => vi.useRealTimers());

describe("call quality measurements", () => {
  it("measures remote-reported uplink loss separately from the local receiver", () => {
    const reader = new CallQualityReader();
    reader.read(reports(1, 500, 50), pc);
    const sample = reader.read(reports(2, 600, 50, { fractionLost: .08, jitter: .06 }), pc);
    expect(sample.outbound).toEqual({ lossPercent: 8, jitterMs: 60 });
    expect(sample.inbound).toEqual({ lossPercent: 0, jitterMs: 8 });
    expect(sample.level).toBe("poor");
    expect(sample.roundTripMs).toBe(40);
    expect(sample.codec).toBe("PCMU");
    expect(sample.microphone.name).toBe("Headset");
  });

  it("uses interval loss, recovers after a burst and handles late packets", () => {
    const reader = new CallQualityReader();
    reader.read(reports(1, 100, 0), pc);
    expect(reader.read(reports(2, 190, 10), pc).inbound.lossPercent).toBe(10);
    expect(reader.read(reports(3, 290, 10), pc).level).toBe("good");
    expect(reader.read(reports(4, 391, 9), pc).inbound.lossPercent).toBe(0);
    expect(reader.read(reports(5, 1, 0), pc).inbound.lossPercent).toBeNull();
  });

  it("does not turn missing RTCP, a baseline or zero received packets into a good score", () => {
    const reader = new CallQualityReader();
    const first = reports(1, 10, 0);
    expect(reader.read(first, pc).level).toBe("unknown");
    const next = reports(2, 10, 0);
    (next as unknown as Map<string, unknown>).delete("remote");
    const sample = reader.read(next, pc);
    expect(sample.outbound.lossPercent).toBeNull();
    expect(sample.inbound.lossPercent).toBeNull();
    expect(sample.level).toBe("unknown");
  });

  it("keeps RTCP between reports but expires measurements after ten seconds", () => {
    vi.useFakeTimers();
    const reader = new CallQualityReader();
    reader.read(reports(1, 10, 0), pc);
    vi.advanceTimersByTime(2_000);
    expect(reader.read(reports(2, 20, 0, { timestamp: 1 }), pc).outbound.lossPercent).toBe(0);
    vi.advanceTimersByTime(10_001);
    expect(reader.read(reports(3, 30, 0, { timestamp: 1 }), pc).outbound.lossPercent).toBeNull();
  });

  it("flags network failures even without RTCP and reports microphone interruption", () => {
    expect(qualityLevel({ inbound: { lossPercent: null, jitterMs: null }, outbound: { lossPercent: null, jitterMs: null }, roundTripMs: null, connection: "disconnected" })).toBe("poor");
    const mutedPc = { ...pc, getSenders: () => [{ track: { ...track, muted: true } }] } as unknown as RTCPeerConnection;
    expect(new CallQualityReader().read(reports(1, 10, 0), mutedPc).microphone.state).toBe("interrupted");
  });

  it("does not deliver a late getStats result after hangup", async () => {
    vi.useFakeTimers();
    let resolve!: (stats: RTCStatsReport) => void;
    const emit = vi.fn();
    const getStats = vi.fn(() => new Promise<RTCStatsReport>((r) => { resolve = r; }));
    const stop = monitorCallQuality({ ...pc, getStats } as unknown as RTCPeerConnection, emit);
    stop();
    resolve(reports(1, 10, 0));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).not.toHaveBeenCalled();
    expect(getStats).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces old quality feedback with unknown when statistics fail", async () => {
    vi.useFakeTimers();
    const getStats = vi.fn().mockResolvedValueOnce(reports(1, 100, 0)).mockResolvedValueOnce(reports(2, 200, 0)).mockRejectedValue(new Error("unavailable"));
    const emit = vi.fn();
    const stop = monitorCallQuality({ ...pc, getStats } as unknown as RTCPeerConnection, emit);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(emit.mock.calls.at(-1)![0].level).toBe("good");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emit.mock.calls.at(-1)![0].level).toBe("unknown");
    stop();
  });
});
