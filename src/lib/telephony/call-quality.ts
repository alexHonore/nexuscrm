/** Browser ↔ media service measurements. These do not measure the recipient's carrier. */
export type QualityLevel = "unknown" | "good" | "fair" | "poor";
export type DirectionQuality = { lossPercent: number | null; jitterMs: number | null };
export type CallQuality = {
  at: number;
  level: QualityLevel;
  connection: string;
  codec: string | null;
  outbound: DirectionQuality;
  inbound: DirectionQuality;
  roundTripMs: number | null;
  microphone: {
    name: string | null;
    state: "live" | "muted" | "interrupted" | "unknown";
    level: number | null;
    echoCancellation: boolean | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
  };
};

type Report = Record<string, unknown> & { id: string; type: string; timestamp: number };
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const milliseconds = (value: unknown) => {
  const n = number(value);
  return n === null || n < 0 ? null : n * 1_000;
};

export function qualityLevel(sample: Pick<CallQuality, "inbound" | "outbound" | "roundTripMs" | "connection">): QualityLevel {
  if (["failed", "disconnected", "closed"].includes(sample.connection)) return "poor";
  const losses = [sample.outbound.lossPercent, sample.inbound.lossPercent];
  const jitter = [sample.outbound.jitterMs, sample.inbound.jitterMs];
  if (losses.some((v) => v !== null && v >= 3) || jitter.some((v) => v !== null && v >= 50) || (sample.roundTripMs ?? 0) >= 500) return "poor";
  if (losses.some((v) => v !== null && v >= 1) || jitter.some((v) => v !== null && v >= 30) || (sample.roundTripMs ?? 0) >= 300) return "fair";
  // Missing uplink RTCP is not proof that the recipient is hearing clean audio.
  if (losses.some((v) => v === null) || jitter.some((v) => v === null) || sample.roundTripMs === null) return "unknown";
  return "good";
}

/** One reader per call; interval deltas prevent old packet loss from hiding a new problem. */
export class CallQualityReader {
  private previous = new Map<string, Report>();
  private remoteSample: { id: string; timestamp: number; at: number; lossPercent: number | null; jitterMs: number | null; roundTripMs: number | null } | null = null;

  read(stats: RTCStatsReport, pc: RTCPeerConnection): CallQuality {
    const reports = new Map<string, Report>();
    stats.forEach((raw) => reports.set(raw.id, raw as Report));
    const all = [...reports.values()];
    const audio = (r: Report) => r.kind === "audio" || r.mediaType === "audio";
    const outbound = all.find((r) => r.type === "outbound-rtp" && audio(r));
    const inbound = all.find((r) => r.type === "inbound-rtp" && audio(r));
    const remote = outbound && (reports.get(String(outbound.remoteId)) ?? all.find((r) => r.type === "remote-inbound-rtp" && r.localId === outbound.id));
    const fresh = (r: Report | undefined) => r && (!this.previous.has(r.id) || r.timestamp > this.previous.get(r.id)!.timestamp);
    const loss = (r: Report | undefined): number | null => {
      if (!r || !fresh(r)) return null;
      const prev = this.previous.get(r.id);
      const received = number(r.packetsReceived);
      const lost = number(r.packetsLost);
      const prevReceived = number(prev?.packetsReceived);
      const prevLost = number(prev?.packetsLost);
      if (received === null || lost === null || prevReceived === null || prevLost === null) return null;
      const deltaReceived = received - prevReceived;
      // packetsLost may decrease when late packets arrive. It is a signed counter.
      const deltaLost = Math.max(0, lost - prevLost);
      if (deltaReceived < 0 || deltaReceived + deltaLost <= 0) return null;
      return 100 * deltaLost / (deltaReceived + deltaLost);
    };
    const fraction = fresh(remote) ? number(remote?.fractionLost) : null;
    // RTCP arrives less often than our poll. Retain the latest report briefly,
    // then mark it unavailable if reports stop (never keep a stale green state).
    if (remote && fresh(remote)) {
      this.remoteSample = {
        id: remote.id, timestamp: remote.timestamp, at: Date.now(),
        lossPercent: fraction !== null && fraction >= 0 && fraction <= 1 ? fraction * 100 : loss(remote),
        jitterMs: milliseconds(remote.jitter), roundTripMs: milliseconds(remote.roundTripTime),
      };
    }
    const uplink = this.remoteSample && remote && this.remoteSample.id === remote.id && Date.now() - this.remoteSample.at <= 10_000 ? this.remoteSample : null;
    const transport = outbound && reports.get(String(outbound.transportId));
    const pair = transport && reports.get(String(transport.selectedCandidatePairId));
    const codec = outbound && reports.get(String(outbound.codecId));
    const source = outbound && reports.get(String(outbound.mediaSourceId));
    const track = (pc.getSenders?.() ?? []).find((s) => s.track?.kind === "audio")?.track;
    const settings = track?.getSettings?.();
    const sample: CallQuality = {
      at: Date.now(),
      level: "unknown",
      connection: pc.connectionState || pc.iceConnectionState || "unknown",
      codec: typeof codec?.mimeType === "string" ? codec.mimeType.replace(/^audio\//, "") : null,
      outbound: {
        lossPercent: uplink?.lossPercent ?? null,
        jitterMs: uplink?.jitterMs ?? null,
      },
      inbound: { lossPercent: loss(inbound), jitterMs: fresh(inbound) ? milliseconds(inbound?.jitter) : null },
      roundTripMs: uplink?.roundTripMs ?? milliseconds(pair?.currentRoundTripTime),
      microphone: {
        name: track?.label || null,
        state: !track ? "unknown" : track.readyState === "ended" || track.muted ? "interrupted" : !track.enabled ? "muted" : "live",
        level: number(source?.audioLevel),
        echoCancellation: typeof settings?.echoCancellation === "boolean" ? settings.echoCancellation : null,
        noiseSuppression: typeof settings?.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
        autoGainControl: typeof settings?.autoGainControl === "boolean" ? settings.autoGainControl : null,
      },
    };
    sample.level = qualityLevel(sample);
    this.previous = reports;
    return sample;
  }
}

/** Serialized polls and explicit disposal: a slow getStats cannot update the next call. */
export function monitorCallQuality(pc: RTCPeerConnection, emit: (sample: CallQuality) => void): () => void {
  const reader = new CallQualityReader();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const stats = await pc.getStats();
      if (!stopped) emit(reader.read(stats, pc));
    } catch {
      // Do not leave a stale healthy sample on screen if statistics stop working.
      if (!stopped) emit(reader.read(new Map() as RTCStatsReport, pc));
    } finally {
      if (!stopped) timer = setTimeout(() => void poll(), 2_000);
    }
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
