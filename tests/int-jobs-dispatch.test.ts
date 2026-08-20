/**
 * Intégration — dispatcher de la file durable : runDispatchCycle
 * (src/lib/jobs/dispatch.ts) + GET /api/cron/dispatch.
 *
 * On exerce le vrai handler de route et le vrai cycle sur la base de test
 * locale. SMS_MODE reste absent ⇒ le fournisseur est en dry_run : aucun SMS
 * réel, mais chaque « envoi » est consigné dans `messages` (statut dry_run).
 * Les instants sont gelés (fausse horloge Date uniquement — les timers réels
 * restent en place pour le driver Postgres).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { NextRequest } from "next/server";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import { conversations, messages, scheduledJobs, suppressions } from "@/db/schema-sms";
import { RETRY_BACKOFF_MS, type SendSmsPayload } from "@/lib/jobs/types";
import type { SendInput, SendResult } from "@/lib/sms/types";

// ── Stubs d'environnement Next (aucune logique produit n'est simulée) ────────
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

/**
 * Couture de test sur le fournisseur : délègue au VRAI fournisseur (dry_run,
 * suppressions et interrupteur réels) sauf quand un test injecte une panne de
 * transport via `sendOverride` — le seul cas impossible à provoquer autrement
 * sans réseau.
 */
const providerMock = vi.hoisted(() => ({
  sendOverride: undefined as ((input: SendInput) => Promise<SendResult>) | undefined,
}));

vi.mock("@/lib/sms-server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/sms-server")>();
  const getSmsProvider: typeof mod.getSmsProvider = () => {
    const real = mod.getSmsProvider();
    return {
      send: (input) =>
        providerMock.sendOverride ? providerMock.sendOverride(input) : real.send(input),
    };
  };
  return { ...mod, getSmsProvider };
});

const { GET } = await import("@/app/api/cron/dispatch/route");
const { runDispatchCycle } = await import("@/lib/jobs/dispatch");
const { enqueueJob } = await import("@/lib/jobs/queue");

// ── Horloge ──────────────────────────────────────────────────────────────────

const TZ = "America/Toronto";
/** Mercredi 19 août 2026, 14 h à Toronto — en pleine fenêtre d'envoi. */
const IN_WINDOW = fromZonedTime("2026-08-19T14:00:00", TZ);
/** Le même mercredi, 3 h du matin à Toronto — hors fenêtre. */
const NIGHT = fromZonedTime("2026-08-19T03:00:00", TZ);

/** Gèle Date uniquement — les timers réels restent actifs (driver Postgres). */
function freezeAt(instant: Date): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

// ── Fabriques de scénario ────────────────────────────────────────────────────

async function seedThread(conv: { aiEnabled?: boolean } = {}) {
  const client = await makeClient();
  const number = await makeSmsNumber();
  const conversation = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
    ...conv,
  });
  return { client, number, conversation };
}

function sendPayload(
  conversation: { id: string; clientPhone: string },
  overrides: Partial<SendSmsPayload> = {},
): SendSmsPayload {
  return {
    conversationId: conversation.id,
    to: conversation.clientPhone,
    body: "Bonjour, ici Groupe Nexus. Avez-vous deux minutes ?",
    source: "opener",
    automated: true,
    aiGenerated: false,
    sentById: null,
    ...overrides,
  };
}

/** Job send_sms dû immédiatement (à l'horloge courante, gelée ou non). */
async function enqueueDue(payload: unknown) {
  return enqueueJob({ type: "send_sms", runAt: new Date(), payload });
}

async function getJob(id: string) {
  const [row] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  return row;
}

// ── Route ────────────────────────────────────────────────────────────────────

const URL_DISPATCH = "http://localhost/api/cron/dispatch";

function cronRequest(authorization?: string): NextRequest {
  return new NextRequest(URL_DISPATCH, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("dispatcher de la file (runDispatchCycle + /api/cron/dispatch)", () => {
  beforeEach(async () => {
    await resetDb();
    // SMS_MODE absent ⇒ dry_run — jamais de SMS réel dans les tests.
    delete process.env.SMS_MODE;
  });
  afterEach(() => {
    vi.useRealTimers();
    providerMock.sendOverride = undefined;
  });
  afterAll(closeDb);

  // ── Auth de la route ───────────────────────────────────────────────────────

  it("refuse (401) une requête sans en-tête Authorization", async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("refuse (401) un mauvais bearer", async () => {
    const res = await GET(cronRequest("Bearer pas-le-bon-secret"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("répond 200 avec les compteurs sous Bearer CRON_SECRET", async () => {
    const res = await GET(cronRequest(`Bearer ${process.env.CRON_SECRET}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      claimed: 0,
      done: 0,
      skipped: 0,
      rescheduled: 0,
      failed: 0,
      requeued: 0,
    });
  });

  // ── Chemin heureux ─────────────────────────────────────────────────────────

  it("exécute un job dû : done, UNE rangée messages dry_run, lastOutboundAt posé", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread();
    const { id } = await enqueueDue(sendPayload(conversation, { aiGenerated: true }));

    const counts = await runDispatchCycle();
    expect(counts).toEqual({
      claimed: 1,
      done: 1,
      skipped: 0,
      rescheduled: 0,
      failed: 0,
      requeued: 0,
    });

    expect((await getJob(id)).status).toBe("done");

    const rows = await testDb.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: conversation.id,
      direction: "out",
      body: "Bonjour, ici Groupe Nexus. Avez-vous deux minutes ?",
      // dry_run : rien n'est parti chez Twilio, mais le fil montre ce qui
      // SERAIT parti — clairement étiqueté.
      status: "dry_run",
      twilioSid: null,
      source: "opener",
      aiGenerated: true,
      sentById: null,
    });
    expect(rows[0].segments).toBeGreaterThanOrEqual(1);
    expect(rows[0].encoding).toBe("GSM-7");
    // La rangée porte le job qui l'a produite — la garde anti-double-envoi.
    expect(rows[0].jobId).toBe(id);

    const [conv] = await testDb
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(conv.lastOutboundAt?.getTime()).toBe(IN_WINDOW.getTime());
  });

  // ── Heures de politesse ────────────────────────────────────────────────────

  it("DÉMO point de contrôle — 3 h du matin : AUCUN envoi, report à 9 h 0x le même matin, tentative remboursée", async () => {
    freezeAt(NIGHT);
    const { conversation } = await seedThread();
    const { id } = await enqueueDue(sendPayload(conversation));

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, rescheduled: 1, done: 0, skipped: 0, failed: 0 });

    // Jamais d'envoi hors fenêtre : pas même une rangée dry_run.
    expect(await testDb.select().from(messages)).toHaveLength(0);

    const job = await getJob(id);
    expect(job.status).toBe("pending");
    // Un report n'est pas un échec : la tentative comptée au claim est remboursée.
    expect(job.attempts).toBe(0);
    // Réouverture le MÊME matin local : mercredi 09:0x heure de Toronto
    // (jitter de 0–9 min pour étaler le lot différé pendant la nuit).
    expect(formatInTimeZone(job.runAt, TZ, "yyyy-MM-dd")).toBe("2026-08-19");
    expect(Number(formatInTimeZone(job.runAt, TZ, "H"))).toBe(9);
    expect(Number(formatInTimeZone(job.runAt, TZ, "m"))).toBeLessThanOrEqual(9);
  });

  it("garde anti-double-envoi : la rangée-intention d'un job re-réclamé bloque tout second appel Twilio", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread();
    const { id } = await enqueueDue(sendPayload(conversation));
    // Simule un claim précédent mort ENTRE le transport et le règlement : la
    // rangée-intention existe déjà pour ce job.
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "out",
      body: "déjà parti",
      jobId: id,
      status: "sending",
      source: "opener",
    });
    providerMock.sendOverride = async () => {
      throw new Error("le transport ne doit JAMAIS être rappelé");
    };

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, done: 1, failed: 0 });

    const job = await getJob(id);
    expect(job.status).toBe("done");
    expect(job.lastError).toBe("already_recorded");
    // Toujours UNE seule rangée — rien n'a été renvoyé ni ré-inséré.
    expect(await testDb.select().from(messages)).toHaveLength(1);
  });

  it("un envoi humain (automated:false) part même à 3 h du matin — exempt des heures de politesse", async () => {
    freezeAt(NIGHT);
    const { conversation } = await seedThread();
    const { id } = await enqueueDue(
      sendPayload(conversation, { automated: false, source: "human" }),
    );

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, done: 1, rescheduled: 0 });

    expect((await getJob(id)).status).toBe("done");
    expect(await testDb.select().from(messages)).toHaveLength(1);
  });

  // ── Pause humaine (aiEnabled) ──────────────────────────────────────────────

  it("aiEnabled=false bloque tout envoi automatisé : skipped ai_paused, aucune rangée", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread({ aiEnabled: false });
    const { id } = await enqueueDue(sendPayload(conversation, { automated: true }));

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, skipped: 1, done: 0 });

    const job = await getJob(id);
    expect(job.status).toBe("skipped");
    expect(job.lastError).toBe("ai_paused");
    expect(await testDb.select().from(messages)).toHaveLength(0);
  });

  it("un envoi humain (automated:false) part malgré aiEnabled=false", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread({ aiEnabled: false });
    const { id } = await enqueueDue(
      sendPayload(conversation, { automated: false, source: "human" }),
    );

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, done: 1, skipped: 0 });

    expect((await getJob(id)).status).toBe("done");
    const rows = await testDb.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("human");
  });

  // ── Suppressions ───────────────────────────────────────────────────────────

  it("numéro supprimé : skipped suppressed, aucune rangée messages", async () => {
    freezeAt(IN_WINDOW);
    const { client, conversation } = await seedThread();
    await testDb.insert(suppressions).values({ phoneE164: client.phone, reason: "sms_stop" });
    const { id } = await enqueueDue(sendPayload(conversation));

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, skipped: 1, done: 0 });

    const job = await getJob(id);
    expect(job.status).toBe("skipped");
    expect(job.lastError).toBe("suppressed");
    expect(await testDb.select().from(messages)).toHaveLength(0);
  });

  // ── Chemins d'échec ────────────────────────────────────────────────────────

  it("type de job inconnu : failed définitif (unknown_job_type), jamais retenté", async () => {
    const [seeded] = await testDb
      .insert(scheduledJobs)
      .values({ type: "make_coffee", runAt: new Date(Date.now() - 1000), payload: {} })
      .returning();

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, failed: 1 });

    const job = await getJob(seeded.id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toBe("unknown_job_type: make_coffee");

    expect((await runDispatchCycle()).claimed).toBe(0);
  });

  it("payload malformé : failed_permanent invalid_payload, aucun retry", async () => {
    freezeAt(IN_WINDOW);
    const { id } = await enqueueDue({ oups: "pas-un-payload-send_sms" });

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, failed: 1 });

    const job = await getJob(id);
    expect(job.status).toBe("failed");
    expect(job.lastError).toBe("invalid_payload");
    expect(job.attempts).toBe(1);

    expect((await runDispatchCycle()).claimed).toBe(0);
  });

  it("panne du fournisseur : failJob avec backoff — pending, +1 min, aucune rangée", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread();
    const { id } = await enqueueDue(sendPayload(conversation));
    providerMock.sendOverride = async () => {
      throw new Error("twilio_send_failed: http 500");
    };

    const counts = await runDispatchCycle();
    expect(counts).toMatchObject({ claimed: 1, failed: 1, done: 0 });

    const job = await getJob(id);
    expect(job.status).toBe("pending"); // retenté au prochain cycle, pas définitif
    expect(job.attempts).toBe(1);
    expect(job.lastError).toBe("twilio_send_failed: http 500");
    expect(job.runAt.getTime()).toBe(IN_WINDOW.getTime() + RETRY_BACKOFF_MS[0]);
    expect(await testDb.select().from(messages)).toHaveLength(0);
  });

  // ── Concurrence (§21) ──────────────────────────────────────────────────────

  it("§21 — DEUX dispatchers concurrents, 1 job dû : exactement UNE rangée messages", async () => {
    freezeAt(IN_WINDOW);
    const { conversation } = await seedThread();
    await enqueueDue(sendPayload(conversation));

    const [a, b] = await Promise.all([runDispatchCycle(), runDispatchCycle()]);

    // SKIP LOCKED : un seul des deux cycles a réclamé (et exécuté) le job.
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.done + b.done).toBe(1);
    expect(await testDb.select().from(messages)).toHaveLength(1);
  });
});
