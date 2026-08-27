import { eq } from "drizzle-orm";
import { db } from "@/db";
import { comments } from "@/db/schema";
import { callTranscripts } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import type { LLMResult } from "@/lib/llm/types";
import { getSetting, type TranscriptsSettings } from "@/lib/settings";
import {
  buildNoteBody,
  buildTranscriptSystem,
  buildTranscriptUserText,
  parseTranscriptOutput,
  SUMMARY_MAX_CHARS,
  TRANSCRIPT_MAX_CHARS,
  type TranscriptCallFacts,
} from "./prompt";

/**
 * Cœur du traitement d'UN appel : gardes, téléchargement, modèle, rangée
 * `call_transcripts`, commentaire sur la fiche. Le réseau (audio, modèle) est
 * INJECTÉ : les tests d'intégration passent des doublures et la vraie
 * plomberie vit dans le handler de job.
 *
 * Chaque sortie non transitoire écrit une rangée — c'est elle qui dit au
 * balayage « cet appel est réglé ». Les fautes TRANSITOIRES (transport,
 * 5xx) remontent en exception : le job les réessaie avec recul.
 */

export interface TranscriptDeps {
  /** Octets de l'enregistrement, ou null si voip.ms renvoie un format inconnu. */
  fetchAudio: (recordingUrl: string) => Promise<{ base64: string; format: "mp3" | "wav" } | null>;
  generate: (input: {
    model: string;
    system: string;
    userText: string;
    audio: { base64: string; format: "mp3" | "wav" };
    maxTokens: number;
    temperature: number;
  }) => Promise<LLMResult>;
}

export type TranscriptRunOutcome =
  | { status: "done"; transcriptId: string }
  /** Une rangée existe déjà (autre passage, course) : rien à refaire. */
  | { status: "already" }
  | { status: "disabled" }
  /** L'appel n'existe plus — le job ne reviendra jamais utile. */
  | { status: "gone" }
  /** Écarté par une garde ; `recorded` dit si une rangée `skipped` le fige. */
  | { status: "skipped"; reason: string; recorded: boolean }
  /** Le modèle a répondu inutilisable : rangée `failed`, pas de nouvel essai. */
  | { status: "failed"; reason: string };

/**
 * Plafond de sortie : un PLAFOND, pas une dépense — on ne paie que ce qui
 * sort. Avec verbatim, il doit contenir la transcription d'un appel de 30-45
 * minutes (~2 jetons/mot en français) : trop bas, la réponse est coupée en
 * pleine chaîne JSON et l'appel payé ne donne rien.
 */
function maxTokensFor(cfg: TranscriptsSettings): number {
  if (cfg.keepTranscript) return 20_000;
  switch (cfg.detail) {
    case "brief":
      return 500;
    case "standard":
      return 1200;
    case "detailed":
      return 2500;
    case "exhaustive":
      return 4000;
  }
}

/**
 * Fige une rangée (skipped/failed) — au plus une par appel, la course est
 * absorbée. `billed` : ce que le modèle a facturé AVANT l'échec (réponse vide,
 * tronquée) — sans lui, la page de consommation perdrait ces dollars-là.
 */
async function recordRow(entry: {
  callId: string;
  clientId: string | null;
  status: "skipped" | "failed";
  reason: string;
  billed?: { model: string | null; result: LLMResult };
}): Promise<boolean> {
  const usage = entry.billed?.result.usage;
  const inserted = await db
    .insert(callTranscripts)
    .values({
      callId: entry.callId,
      clientId: entry.clientId,
      status: entry.status,
      reason: entry.reason.slice(0, 500),
      ...(entry.billed
        ? {
            provider: "openrouter",
            modelRequested: entry.billed.model,
            modelServed: entry.billed.result.modelServed,
            tokensIn: usage?.inputTokens,
            tokensOut: usage?.outputTokens,
            costUsd: usage?.costUsd === undefined ? null : usage.costUsd.toFixed(5),
            latencyMs: entry.billed.result.latencyMs,
          }
        : {}),
    })
    .onConflictDoNothing({ target: callTranscripts.callId })
    .returning({ id: callTranscripts.id });
  return inserted.length > 0;
}

/**
 * Fige un échec PERMANENT depuis le handler (erreur non transitoire du modèle,
 * ou dernière tentative épuisée) : sans cette rangée, le balayage horaire
 * remettrait l'appel en file pour toujours — et re-paierait chaque échec.
 */
export async function recordTranscriptFailure(callId: string, reason: string): Promise<void> {
  const call = await db.query.calls.findFirst({ where: (c, { eq: eqOp }) => eqOp(c.id, callId) });
  await recordRow({
    callId,
    clientId: call?.clientId ?? null,
    status: "failed",
    reason,
  });
  await logAudit({
    action: "recording.transcribe",
    entity: "call",
    entityId: callId,
    detail: { status: "failed", reason: reason.slice(0, 300) },
  });
}

export async function runCallTranscript(
  callId: string,
  deps: TranscriptDeps,
): Promise<TranscriptRunOutcome> {
  const cfg = await getSetting("transcripts");
  // Réglage relu à l'EXÉCUTION : couper le réglage arrête aussi les jobs déjà
  // en file. Pas de rangée — réactiver reprendra ces appels via le balayage.
  if (!cfg.enabled) return { status: "disabled" };

  // Le bouton d'arrêt d'urgence stoppe TOUTE dépense IA, pas seulement les
  // SMS : personne n'appuie dessus en voulant que les notes d'appel, elles,
  // continuent de facturer. Pas de rangée — c'est une pause, pas un verdict.
  const { killSwitch } = await getSetting("sms");
  if (killSwitch) return { status: "skipped", reason: "kill_switch", recorded: false };

  const call = await db.query.calls.findFirst({
    where: (c, { eq: eqOp }) => eqOp(c.id, callId),
    with: { client: true, user: true },
  });
  if (!call) return { status: "gone" };

  const existing = await db.query.callTranscripts.findFirst({
    where: (t, { eq: eqOp }) => eqOp(t.callId, callId),
  });
  if (existing) return { status: "already" };

  if (!call.recordingUrl) return { status: "skipped", reason: "no_recording", recorded: false };
  const clientId = call.clientId;
  if (!clientId) {
    // Pas de fiche → pas d'endroit où pousser la note. Rangée : une fiche
    // rattachée plus tard ne rejouera pas un appel déjà écarté.
    await recordRow({ callId, clientId: null, status: "skipped", reason: "no_client" });
    return { status: "skipped", reason: "no_client", recorded: true };
  }
  // durationSec = 0 est le plus souvent PROVISOIRE (rangée du téléphone web
  // jamais complétée, CDR pas encore rapproché) : figer « too_short » ici
  // condamnerait un vrai appel. Pas de rangée — le balayage repassera quand
  // la synchronisation aura posé la vraie durée.
  if (call.durationSec <= 0) return { status: "skipped", reason: "no_duration", recorded: false };
  if (call.durationSec < cfg.minSeconds) {
    await recordRow({ callId, clientId: clientId, status: "skipped", reason: "too_short" });
    return { status: "skipped", reason: "too_short", recorded: true };
  }
  if (call.durationSec > cfg.maxMinutes * 60) {
    await recordRow({ callId, clientId: clientId, status: "skipped", reason: "too_long" });
    return { status: "skipped", reason: "too_long", recorded: true };
  }

  // Transport en panne → exception → le job réessaie. Format inconnu → figé.
  const audio = await deps.fetchAudio(call.recordingUrl);
  if (!audio) {
    await recordRow({ callId, clientId: clientId, status: "skipped", reason: "no_audio" });
    return { status: "skipped", reason: "no_audio", recorded: true };
  }

  const facts: TranscriptCallFacts = {
    direction: call.direction,
    durationSec: call.durationSec,
    startedAt: call.startedAt,
    agentName: call.user?.name ?? null,
    clientName: call.client?.fullName ?? null,
    // Repères d'orthographe pour l'oreille du modèle (voir prompt.ts) — les
    // noms propres de la fiche sont ce que l'audio téléphone abîme le plus.
    clientCity: call.client?.city ?? null,
    clientAddress: call.client?.address ?? null,
  };
  const promptInput = {
    language: cfg.language,
    detail: cfg.detail,
    keepTranscript: cfg.keepTranscript,
    call: facts,
  };

  const result = await deps.generate({
    model: cfg.model,
    system: buildTranscriptSystem(promptInput),
    userText: buildTranscriptUserText(promptInput),
    audio,
    maxTokens: maxTokensFor(cfg),
    temperature: 0.2,
  });

  // Réponse coupée par le plafond de jetons : la chaîne JSON s'arrête en
  // plein verbatim et le repli « tout le texte est la note » pousserait ce
  // débris sur la fiche, figé « done » pour toujours. Rangée `failed` (avec
  // ce qui a été facturé) — l'admin voit l'échec sur la page de consommation.
  if (result.truncated) {
    await recordRow({
      callId,
      clientId: clientId,
      status: "failed",
      reason: "truncated",
      billed: { model: cfg.model, result },
    });
    return { status: "failed", reason: "truncated" };
  }

  const output = parseTranscriptOutput(result.text);
  if (output.summary === "") {
    await recordRow({
      callId,
      clientId: clientId,
      status: "failed",
      reason: "empty_output",
      billed: { model: cfg.model, result },
    });
    return { status: "failed", reason: "empty_output" };
  }

  const summary = output.summary.slice(0, SUMMARY_MAX_CHARS);
  const body = buildNoteBody({ language: cfg.language, call: facts, summary });

  const transcriptId = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(callTranscripts)
      .values({
        callId,
        clientId,
        status: "done",
        transcript: cfg.keepTranscript
          ? (output.transcript?.slice(0, TRANSCRIPT_MAX_CHARS) ?? null)
          : null,
        summary,
        language: cfg.language,
        detail: cfg.detail,
        provider: "openrouter",
        modelRequested: cfg.model,
        modelServed: result.modelServed,
        audioSeconds: call.durationSec,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd === undefined ? null : result.usage.costUsd.toFixed(5),
        latencyMs: result.latencyMs,
      })
      .onConflictDoNothing({ target: callTranscripts.callId })
      .returning({ id: callTranscripts.id });
    if (inserted.length === 0) return null; // course perdue : l'autre a tout fait

    // L'auteur porté est le téléphoniste de l'appel (userId NOT NULL) ; le
    // corps, lui, signe la machine — même convention que add_client_comment.
    const [comment] = await tx
      .insert(comments)
      .values({ clientId, userId: call.userId, body })
      .returning({ id: comments.id });
    await tx
      .update(callTranscripts)
      .set({ commentId: comment.id })
      .where(eq(callTranscripts.id, inserted[0].id));
    return inserted[0].id;
  });
  if (transcriptId === null) return { status: "already" };

  await logAudit({
    action: "recording.transcribe",
    entity: "call",
    entityId: callId,
    detail: {
      status: "done",
      model: result.modelServed,
      audioSeconds: call.durationSec,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      ...(result.usage.costUsd === undefined ? {} : { costUsd: result.usage.costUsd }),
    },
  });
  return { status: "done", transcriptId };
}
