/**
 * Intégration — heures de travail PAR ASSISTANT (fenêtre d'envoi).
 *
 *  · `resolveQuietHours(assistantId)` rend la fenêtre de l'assistant (rangée
 *    dans son `approach`), ou le défaut de politesse pour null/inconnu.
 *  · Le dernier verrou d'envoi (`handleSendSms`) lit la fenêtre de l'assistant
 *    QUI ÉCRIT : un envoi hors de SA fenêtre est reporté — même à une heure
 *    qu'un autre assistant, ou le défaut, aurait permise. « Pas de texto à 3 h »
 *    dépend donc de l'assistant.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { closeDb, makeClient, makeConversation, makeSmsNumber, resetDb, testDb } from "./helpers/db";
import { assistants, scheduledJobs } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));

const { handleSendSms } = await import("@/lib/jobs/handlers/send-sms");
const { resolveQuietHours } = await import("@/lib/assistants/quiet-hours");
const { approachSchema } = await import("@/lib/assistants/schema");
const { DEFAULT_QUIET_HOURS } = await import("@/lib/sms/quiet-hours");

const TZ = "America/Toronto";
const toronto = (local: string) => fromZonedTime(local, TZ);
const MORNING_ONLY = { tz: TZ, weekday: [6, 8], saturday: [6, 8], sunday: [6, 8] } as const;

/** Un assistant (brouillon) dont on fixe la fenêtre d'envoi. */
async function makeAssistantWithWindow(window: unknown) {
  const approach = approachSchema.parse({ quietHours: window });
  const [row] = await testDb
    .insert(assistants)
    .values({
      name: "Relance (test)",
      identity: {},
      goal: {},
      approach,
      model: {},
    })
    .returning();
  return row;
}

async function automatedSendJob(assistantId: string | null) {
  const client = await makeClient();
  const number = await makeSmsNumber({ active: true });
  const conv = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
    aiEnabled: true,
  });
  const [job] = await testDb
    .insert(scheduledJobs)
    .values({
      type: "send_sms",
      runAt: new Date(),
      status: "running",
      payload: {
        conversationId: conv.id,
        to: client.phone,
        body: "Bonjour, ici Groupe Nexus.",
        source: "agent",
        automated: true,
        aiGenerated: true,
        sentById: null,
        assistantId,
      },
    })
    .returning();
  return job;
}

afterAll(closeDb);

describe("resolveQuietHours", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rend la fenêtre de l'assistant", async () => {
    const a = await makeAssistantWithWindow(MORNING_ONLY);
    expect((await resolveQuietHours(a.id)).weekday).toEqual([6, 8]);
  });

  it("null ou assistant inconnu → défaut de politesse", async () => {
    expect(await resolveQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(await resolveQuietHours("11111111-1111-4111-8111-111111111111")).toEqual(
      DEFAULT_QUIET_HOURS,
    );
  });
});

describe("handleSendSms respecte la fenêtre de l'ASSISTANT qui écrit", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.SMS_MODE; // dry_run — aucun vrai SMS
  });

  it("14 h avec un assistant en fenêtre 6 h–8 h : REPORTÉ (le défaut aurait permis)", async () => {
    const assistant = await makeAssistantWithWindow(MORNING_ONLY);
    const job = await automatedSendJob(assistant.id);
    const result = await handleSendSms(job, () => toronto("2026-08-19T14:00:00"));
    expect(result.outcome).toBe("reschedule");
  });

  it("7 h avec le même assistant : PAS reporté par la fenêtre", async () => {
    const assistant = await makeAssistantWithWindow(MORNING_ONLY);
    const job = await automatedSendJob(assistant.id);
    const result = await handleSendSms(job, () => toronto("2026-08-19T07:00:00"));
    expect(result.outcome).not.toBe("reschedule");
  });

  it("sans assistant : le défaut s'applique (14 h permis, 3 h reporté)", async () => {
    const day = await automatedSendJob(null);
    expect((await handleSendSms(day, () => toronto("2026-08-19T14:00:00"))).outcome).not.toBe(
      "reschedule",
    );
    const night = await automatedSendJob(null);
    expect((await handleSendSms(night, () => toronto("2026-08-19T03:00:00"))).outcome).toBe(
      "reschedule",
    );
  });
});
