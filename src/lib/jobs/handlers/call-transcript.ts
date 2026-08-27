import { z } from "zod";
import { LLMProviderError } from "@/lib/llm/types";
import { MAX_ATTEMPTS, type JobOutcome, type ScheduledJob } from "@/lib/jobs/types";
import { AUDIO_LLM_TIMEOUT_MS, generateFromAudio } from "@/lib/transcripts/audio-llm";
import {
  recordTranscriptFailure,
  runCallTranscript,
  type TranscriptDeps,
} from "@/lib/transcripts/run";
import {
  extractRecordingAudio,
  getCallRecordingFile,
  parseRecordingRef,
  sniffAudioType,
} from "@/lib/voipms";

/**
 * Job `call_transcript` — écoute l'enregistrement d'UN appel, en tire une note
 * IA et la pousse en commentaire sur la fiche (cœur : src/lib/transcripts).
 *
 * Sémantique d'échec : transitoire (transport, 5xx, délai) → exception → recul
 * et nouvel essai ; définitif (4xx du modèle, réponse vide) → rangée `failed`
 * qui dit au balayage de ne PAS remettre l'appel en file. À la dernière
 * tentative, même une faute transitoire est figée : sans rangée, le balayage
 * recréerait le job pour toujours — et chaque tour repaierait le modèle.
 */

export const callTranscriptPayloadSchema = z.object({ callId: z.uuid() });

/** Octets de l'enregistrement — référence voip.ms ou URL directe voip.ms. */
async function fetchRecordingAudio(
  recordingUrl: string,
): Promise<{ base64: string; format: "mp3" | "wav" } | null> {
  let buf: Buffer;
  const ref = parseRecordingRef(recordingUrl);
  if (ref) {
    const payload = await getCallRecordingFile(ref.account, ref.callrecording);
    const audio = extractRecordingAudio(payload);
    if ("base64" in audio) {
      buf = Buffer.from(audio.base64, "base64");
    } else if ("url" in audio) {
      buf = await downloadAudio(audio.url);
    } else {
      return null; // format inconnu — figé par le cœur, diagnostic via /api/admin/recordings
    }
  } else if (/^https:\/\//i.test(recordingUrl)) {
    buf = await downloadAudio(recordingUrl);
  } else {
    return null;
  }
  const type = sniffAudioType(buf);
  const format = type === "audio/mpeg" ? "mp3" : type === "audio/wav" ? "wav" : null;
  if (!format) return null;
  return { base64: buf.toString("base64"), format };
}

async function downloadAudio(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`recording_http_${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function realDeps(apiKey: string): TranscriptDeps {
  return {
    fetchAudio: fetchRecordingAudio,
    generate: (input) =>
      generateFromAudio({
        apiKey,
        baseUrl: process.env.OPENROUTER_BASE_URL,
        referer: process.env.OPENROUTER_SITE_URL,
        title: process.env.OPENROUTER_APP_NAME,
        timeoutMs: AUDIO_LLM_TIMEOUT_MS,
        ...input,
      }),
  };
}

export async function handleCallTranscript(
  job: ScheduledJob,
  deps?: TranscriptDeps,
): Promise<JobOutcome> {
  const parsed = callTranscriptPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { outcome: "failed_permanent", error: "invalid_payload" };
  const { callId } = parsed.data;

  let resolved = deps;
  if (!resolved) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    // Pas de clé : on saute SANS rangée — le balayage remettra l'appel en
    // file (72 h) et il sera traité dès que la clé existera. Aucun coût.
    if (!apiKey) return { outcome: "skipped", reason: "llm_unconfigured" };
    resolved = realDeps(apiKey);
  }

  let result;
  try {
    result = await runCallTranscript(callId, resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient = err instanceof LLMProviderError ? err.retryable : true;
    if (!transient || job.attempts >= MAX_ATTEMPTS) {
      await recordTranscriptFailure(callId, message);
      if (!transient) return { outcome: "failed_permanent", error: message };
    }
    throw err;
  }

  switch (result.status) {
    case "done":
      return { outcome: "done" };
    case "already":
      return { outcome: "done", note: "already_transcribed" };
    case "disabled":
      return { outcome: "skipped", reason: "disabled" };
    case "gone":
      return { outcome: "skipped", reason: "call_not_found" };
    case "skipped":
      return { outcome: "skipped", reason: result.reason };
    case "failed":
      return { outcome: "failed_permanent", error: result.reason };
  }
}
