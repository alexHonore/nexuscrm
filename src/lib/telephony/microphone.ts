/** Speech capture shared by incoming calls, outgoing calls and device changes. */
export function speechConstraints(deviceId = ""): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** getUserMedia cannot be aborted: dispose of any stream returned after cancellation. */
export async function acquireMicrophone({
  deviceId = "",
  signal,
  onHint,
  onFallback,
}: {
  deviceId?: string;
  signal: AbortSignal;
  onHint?: () => void;
  onFallback?: () => void;
}): Promise<MediaStream> {
  if (signal.aborted) throw new Error("canceled");
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media?.getUserMedia) throw new Error("mic_unavailable");
  let finished = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const hint = setTimeout(() => onHint?.(), 2_500);
  try {
    return await Promise.race([
      media.getUserMedia(speechConstraints(deviceId)).then((stream) => {
        if (finished || signal.aborted) {
          stopStream(stream);
          throw new Error("canceled");
        }
        return stream;
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("mic_timeout")), 30_000);
        abort = () => reject(new Error("canceled"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } catch (err) {
    const { name = "", message = "" } = (err ?? {}) as { name?: string; message?: string };
    if (signal.aborted || message === "canceled") throw new Error("canceled");
    if (deviceId && (name === "NotFoundError" || name === "OverconstrainedError")) {
      // Clear this attempt's timers before requesting the system microphone.
      clearTimeout(hint);
      clearTimeout(timeout);
      const stream = await acquireMicrophone({ signal, onHint });
      onFallback?.();
      return stream;
    }
    if (["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(name)) {
      throw new Error("mic_denied");
    }
    throw new Error(message === "mic_timeout" ? "mic_timeout" : "mic_unavailable");
  } finally {
    finished = true;
    clearTimeout(hint);
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
