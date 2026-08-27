import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hissés au-dessus des imports) ─────────────────────────────────────
vi.mock("server-only", () => ({}));
// `logAudit` lit les en-têtes de la requête pour l'IP — un job n'en a pas.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls, comments } from "@/db/schema";
import { callTranscripts, scheduledJobs } from "@/db/schema-sms";
import { runDispatchCycle, runTranscriptCycle } from "@/lib/jobs/dispatch";
import { handleCallTranscript } from "@/lib/jobs/handlers/call-transcript";
import { enqueueJob } from "@/lib/jobs/queue";
import { MAX_ATTEMPTS, type ScheduledJob } from "@/lib/jobs/types";
import { LLMProviderError, type LLMResult } from "@/lib/llm/types";
import { setSetting } from "@/lib/settings";
import { queueTranscriptJobs, transcriptDedupeKey } from "@/lib/transcripts/sweep";
import type { TranscriptDeps } from "@/lib/transcripts/run";
import { makeClient, makeUser, resetDb } from "./helpers/db";

/**
 * Job `call_transcript` de bout en bout sur la base de test : gardes, rangée
 * `call_transcripts`, commentaire sur la fiche, et balayage de mise en file.
 * Le réseau (audio voip.ms, modèle OpenRouter) est doublé via TranscriptDeps.
 */

const RECORDING = "voipms:100000_poste1:987654";

function fakeJob(payload: unknown, attempts = 1): ScheduledJob {
  return {
    id: crypto.randomUUID(),
    type: "call_transcript",
    runAt: new Date(),
    payload,
    dedupeKey: null,
    status: "running",
    attempts,
    lockedAt: new Date(),
    lastError: null,
    createdAt: new Date(),
  };
}

function llmResult(text: string, extra: Partial<LLMResult> = {}): LLMResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 900, outputTokens: 80, costUsd: 0.0123 },
    latencyMs: 1500,
    modelServed: "google/gemini-2.5-flash",
    raw: {},
    ...extra,
  };
}

const okDeps: TranscriptDeps = {
  fetchAudio: async () => ({ base64: "QUJD", format: "mp3" }),
  generate: async () =>
    llmResult(JSON.stringify({ transcript: "Téléphoniste : allo", summary: "Client intéressé." })),
};

async function makeCall(overrides: Partial<typeof calls.$inferInsert> = {}) {
  const user = await makeUser();
  const client = await makeClient();
  const [row] = await db
    .insert(calls)
    .values({
      userId: user.id,
      clientId: client.id,
      direction: "outbound",
      startedAt: new Date(),
      durationSec: 180,
      recordingUrl: RECORDING,
      provider: "voipms",
      ...overrides,
    })
    .returning();
  return row;
}

async function enable(overrides: Record<string, unknown> = {}) {
  await setSetting("transcripts", {
    enabled: true,
    detail: "standard",
    language: "fr",
    model: "google/gemini-2.5-flash",
    minSeconds: 20,
    maxMinutes: 45,
    keepTranscript: true,
    ...overrides,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("handleCallTranscript", () => {
  it("saute sans rangée quand le réglage est éteint (défaut)", async () => {
    const call = await makeCall();
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "skipped", reason: "disabled" });
    expect(await db.query.callTranscripts.findFirst()).toBeUndefined();
  });

  it("fige un appel trop court en rangée skipped, sans commentaire ni coût", async () => {
    await enable();
    const call = await makeCall({ durationSec: 8 });
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "skipped", reason: "too_short" });
    const row = await db.query.callTranscripts.findFirst();
    expect(row).toMatchObject({ callId: call.id, status: "skipped", reason: "too_short" });
    expect(await db.query.comments.findFirst()).toBeUndefined();
  });

  it("fige un appel sans fiche en rangée skipped no_client", async () => {
    await enable();
    const call = await makeCall({ clientId: null });
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "skipped", reason: "no_client" });
    const row = await db.query.callTranscripts.findFirst();
    expect(row).toMatchObject({ status: "skipped", reason: "no_client", clientId: null });
  });

  it("résume l'appel, garde la rangée complète et pousse la note en commentaire", async () => {
    await enable();
    const call = await makeCall();
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "done" });

    const row = await db.query.callTranscripts.findFirst();
    expect(row).toMatchObject({
      callId: call.id,
      clientId: call.clientId,
      status: "done",
      summary: "Client intéressé.",
      transcript: "Téléphoniste : allo",
      language: "fr",
      detail: "standard",
      provider: "openrouter",
      modelRequested: "google/gemini-2.5-flash",
      modelServed: "google/gemini-2.5-flash",
      audioSeconds: 180,
      tokensIn: 900,
      tokensOut: 80,
      costUsd: "0.01230",
    });

    // La note atterrit sur la fiche, signée machine, attribuée au téléphoniste
    // de l'appel (comments.user_id est NOT NULL — même convention que
    // add_client_comment : le corps signe, la rangée porte un humain).
    const comment = await db.query.comments.findFirst({
      where: eq(comments.clientId, call.clientId as string),
    });
    expect(comment).toBeDefined();
    expect(comment?.userId).toBe(call.userId);
    expect(comment?.body).toMatch(/^🤖 Notes d'appel \(IA\)/);
    expect(comment?.body).toContain("Client intéressé.");
    expect(row?.commentId).toBe(comment?.id);
  });

  it("ne conserve pas le verbatim quand keepTranscript est faux", async () => {
    await enable({ keepTranscript: false });
    const call = await makeCall();
    await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    const row = await db.query.callTranscripts.findFirst();
    expect(row?.status).toBe("done");
    expect(row?.transcript).toBeNull();
    expect(row?.summary).toBe("Client intéressé.");
  });

  it("est idempotent : un second passage ne crée ni rangée ni commentaire", async () => {
    await enable();
    const call = await makeCall();
    await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "done", note: "already_transcribed" });
    const rows = await db.select().from(callTranscripts);
    const notes = await db.select().from(comments);
    expect(rows).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("fige une erreur NON transitoire du modèle en rangée failed (pas de nouvel essai)", async () => {
    await enable();
    const call = await makeCall();
    const deps: TranscriptDeps = {
      ...okDeps,
      generate: async () => {
        throw new LLMProviderError("llm_http_400: bad model", "openrouter", 400, false);
      },
    };
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), deps);
    expect(out.outcome).toBe("failed_permanent");
    const row = await db.query.callTranscripts.findFirst();
    expect(row?.status).toBe("failed");
    expect(row?.reason).toContain("llm_http_400");
  });

  it("laisse remonter une erreur transitoire (le job réessaie), mais fige la DERNIÈRE tentative", async () => {
    await enable();
    const call = await makeCall();
    const deps: TranscriptDeps = {
      ...okDeps,
      generate: async () => {
        throw new LLMProviderError("llm_http_503", "openrouter", 503, true);
      },
    };
    await expect(handleCallTranscript(fakeJob({ callId: call.id }, 1), deps)).rejects.toThrow(
      "llm_http_503",
    );
    expect(await db.query.callTranscripts.findFirst()).toBeUndefined();

    // Dernière tentative : la rangée failed empêche le balayage de recréer le
    // job (et de re-payer l'échec) pour toujours.
    await expect(
      handleCallTranscript(fakeJob({ callId: call.id }, MAX_ATTEMPTS), deps),
    ).rejects.toThrow("llm_http_503");
    const row = await db.query.callTranscripts.findFirst();
    expect(row?.status).toBe("failed");
  });

  it("classe une réponse vide en échec définitif, en gardant ce qui a été facturé", async () => {
    await enable();
    const call = await makeCall();
    const deps: TranscriptDeps = { ...okDeps, generate: async () => llmResult("") };
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), deps);
    expect(out).toEqual({ outcome: "failed_permanent", error: "empty_output" });
    const row = await db.query.callTranscripts.findFirst();
    expect(row).toMatchObject({
      status: "failed",
      reason: "empty_output",
      // L'échec a quand même été facturé : la consommation doit le voir.
      tokensIn: 900,
      tokensOut: 80,
      costUsd: "0.01230",
    });
  });

  it("classe une réponse TRONQUÉE en échec — jamais un débris de JSON sur la fiche", async () => {
    await enable();
    const call = await makeCall();
    const deps: TranscriptDeps = {
      ...okDeps,
      generate: async () =>
        llmResult('{"transcript": "Téléphoniste : allo, je vous appelle au sujet', {
          truncated: true,
          finishReason: "length",
        }),
    };
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), deps);
    expect(out).toEqual({ outcome: "failed_permanent", error: "truncated" });
    const row = await db.query.callTranscripts.findFirst();
    expect(row).toMatchObject({ status: "failed", reason: "truncated", costUsd: "0.01230" });
    expect(await db.query.comments.findFirst()).toBeUndefined();
  });

  it("s'arrête net quand l'interrupteur d'arrêt SMS est enclenché — pause, pas de rangée", async () => {
    await enable();
    await setSetting("sms", { killSwitch: true });
    const call = await makeCall();
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "skipped", reason: "kill_switch" });
    expect(await db.query.callTranscripts.findFirst()).toBeUndefined();
  });

  it("ne fige pas une durée PROVISOIRE (0 s) en too_short", async () => {
    await enable();
    const call = await makeCall({ durationSec: 0 });
    const out = await handleCallTranscript(fakeJob({ callId: call.id }), okDeps);
    expect(out).toEqual({ outcome: "skipped", reason: "no_duration" });
    // Pas de rangée : le balayage repassera quand le CDR aura posé la durée.
    expect(await db.query.callTranscripts.findFirst()).toBeUndefined();
  });
});

describe("queueTranscriptJobs (balayage cdr-sync)", () => {
  it("ne fait rien quand le réglage est éteint", async () => {
    await makeCall();
    expect(await queueTranscriptJobs()).toBe(0);
    expect(await db.select().from(scheduledJobs)).toHaveLength(0);
  });

  it("met en file les enregistrements sans rangée, une seule fois", async () => {
    await enable();
    const withRecording = await makeCall();
    await makeCall({ recordingUrl: null }); // pas d'enregistrement → jamais en file
    const settled = await makeCall();
    await db
      .insert(callTranscripts)
      .values({ callId: settled.id, clientId: settled.clientId, status: "skipped", reason: "too_short" });

    expect(await queueTranscriptJobs()).toBe(1);
    const jobs = await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.type, "call_transcript"), eq(scheduledJobs.status, "pending")));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupeKey).toBe(transcriptDedupeKey(withRecording.id));
    expect(jobs[0].payload).toEqual({ callId: withRecording.id });

    // Une resynchronisation ne double pas un job encore vivant.
    expect(await queueTranscriptJobs()).toBe(0);
    expect(await db.select().from(scheduledJobs)).toHaveLength(1);
  });

  it("ignore les appels plus vieux que la fenêtre de rattrapage", async () => {
    await enable();
    await makeCall({ startedAt: new Date(Date.now() - 96 * 3600_000) });
    expect(await queueTranscriptJobs()).toBe(0);
  });

  it("ne recrée JAMAIS un job réglé « failed » sans rangée (mort en plein vol) — le coût est borné", async () => {
    await enable();
    const call = await makeCall();
    await db.insert(scheduledJobs).values({
      type: "call_transcript",
      runAt: new Date(),
      payload: { callId: call.id },
      dedupeKey: transcriptDedupeKey(call.id),
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "stale_requeue_limit",
    });
    expect(await queueTranscriptJobs()).toBe(0);
    const jobs = await db.select().from(scheduledJobs);
    expect(jobs).toHaveLength(1); // rien de neuf
  });

  it("laisse intact le recul de réessai d'un job en attente (runAt non rafraîchi)", async () => {
    await enable();
    const call = await makeCall();
    const parked = new Date(Date.now() + 30 * 60_000); // recul de 30 min posé par failJob
    await enqueueJob({
      type: "call_transcript",
      runAt: parked,
      payload: { callId: call.id },
      dedupeKey: transcriptDedupeKey(call.id),
    });
    expect(await queueTranscriptJobs()).toBe(0);
    const [job] = await db.select().from(scheduledJobs);
    expect(job.runAt.getTime()).toBe(parked.getTime());
  });
});

describe("couloirs d'exécution (SMS vs notes d'appel)", () => {
  it("le cycle SMS ne réclame jamais un job call_transcript ; son cycle dédié, oui", async () => {
    await enable();
    const call = await makeCall();
    await enqueueJob({
      type: "call_transcript",
      runAt: new Date(),
      payload: { callId: call.id },
      dedupeKey: transcriptDedupeKey(call.id),
    });

    // Cycle SMS : le job audio reste en attente — il ne bloque aucun envoi.
    await runDispatchCycle({ reconcile: false });
    let [job] = await db.select().from(scheduledJobs);
    expect(job.status).toBe("pending");

    // Cycle dédié (handler injecté — pas de réseau) : réclamé et réglé.
    const counts = await runTranscriptCycle({
      handler: (j) => handleCallTranscript(j, okDeps),
    });
    expect(counts.claimed).toBe(1);
    expect(counts.done).toBe(1);
    [job] = await db.select().from(scheduledJobs);
    expect(job.status).toBe("done");
    expect(await db.query.callTranscripts.findFirst()).toMatchObject({ status: "done" });
  });
});
