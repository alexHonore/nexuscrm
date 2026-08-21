/**
 * Intégration — inscription, échelle, A/B, arrêts.
 *
 * Le test central du cahier : **tout chemin qui envoie un message est
 * idempotent, et on le prouve.** Ici cela veut dire deux choses distinctes —
 * un client n'entre qu'une fois dans une campagne (index unique), et un barreau
 * ne part qu'une fois (index unique sur (inscription, barreau)).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDb,
  makeClient,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { clients, webhookKeys } from "@/db/schema";
import { encryptSecret, sha256Hex } from "@/lib/crypto";
import {
  campaignEnrollments,
  campaignTouches,
  campaigns,
  consents,
  conversations,
  messages,
  scheduledJobs,
  suppressions,
} from "@/db/schema-sms";
import { campaignConfigSchema } from "@/lib/campaigns/schema";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { enrollClients, audienceCount, enrollmentCounts } = await import(
  "@/lib/campaigns-server/enroll"
);
const { runTouch } = await import("@/lib/campaigns-server/touch");
const { matchCampaigns, sweepCampaign, queueDueTouches } = await import(
  "@/lib/campaigns-server/match"
);
const { flushAfterResponse } = await import("@/lib/after-response");
const leadsWebhook = await import("@/app/api/webhooks/leads/route");

const NOW = new Date("2026-08-21T15:00:00.000Z");

let numberId: string;

async function makeCampaign(overrides: Record<string, unknown> = {}) {
  const config = campaignConfigSchema.parse({
    name: "Réactivation 90 j",
    trigger: { kind: "manual" },
    ladder: [
      { delayHours: 0, body: "Bonjour, ici Groupe Nexus. Avez-vous encore un projet?", label: "ouverture" },
      { delayHours: 48, body: "Petit rappel — toujours intéressé?", label: "j+2" },
    ],
    ...overrides,
  });

  const [row] = await testDb
    .insert(campaigns)
    .values({
      name: config.name,
      description: config.description,
      status: (overrides.status as "draft" | "active" | "paused" | "archived") ?? "active",
      assistantId: null,
      smsNumberId: numberId,
      trigger: config.trigger,
      audience: config.audience,
      ladder: config.ladder,
      variants: config.variants,
      dailyEnrollmentCap: config.dailyEnrollmentCap,
      totalEnrollmentCap: config.totalEnrollmentCap,
      startsAt: config.startsAt,
      endsAt: config.endsAt,
      requireConsent: config.requireConsent,
    })
    .returning();
  return row;
}

/** Un client joignable : téléphone + consentement SMS valide. */
async function makeReachableClient(overrides: Record<string, unknown> = {}) {
  const client = await makeClient(overrides);
  await testDb.insert(consents).values({
    clientId: client.id,
    channel: "sms",
    kind: "express",
    source: "test",
    grantedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
  });
  return client;
}

beforeEach(async () => {
  await resetDb();
  await makeUser({ role: "admin" });
  numberId = (await makeSmsNumber()).id;
});

afterAll(async () => {
  await closeDb();
});

describe("inscription — idempotence", () => {
  it("§ un client n'entre qu'UNE fois, même sur deux appels simultanés", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();

    // Deux déclencheurs en vol au même instant : le webhook et un balayage.
    const [a, b] = await Promise.all([
      enrollClients(campaign.id, [client.id], { now: NOW }),
      enrollClients(campaign.id, [client.id], { now: NOW }),
    ]);

    const rows = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(rows).toHaveLength(1);

    // Exactement un gagnant, et le perdant sait POURQUOI il a perdu.
    const outcomes = [a[0], b[0]];
    expect(outcomes.filter((o) => o.enrolled)).toHaveLength(1);
    expect(outcomes.find((o) => !o.enrolled)?.refusal).toBe("already_enrolled");
  });

  it("réinscrire séquentiellement ne crée pas de deuxième échelle", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();

    await enrollClients(campaign.id, [client.id], { now: NOW });
    const second = await enrollClients(campaign.id, [client.id], { now: NOW });

    expect(second[0]).toMatchObject({ enrolled: false, refusal: "already_enrolled" });
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(1);
  });

  it("chaque refus porte SON motif, pas un « inéligible » global", async () => {
    const campaign = await makeCampaign();

    const noConsent = await makeClient();
    const suppressed = await makeReachableClient();
    await testDb
      .insert(suppressions)
      .values({ phoneE164: suppressed.phone, reason: "sms_stop" });
    const dnc = await makeReachableClient({ doNotCall: true });
    const ok = await makeReachableClient();

    const results = await enrollClients(
      campaign.id,
      [noConsent.id, suppressed.id, dnc.id, ok.id],
      { now: NOW },
    );
    const byClient = new Map(results.map((r) => [r.clientId, r]));

    expect(byClient.get(noConsent.id)?.refusal).toBe("no_consent");
    expect(byClient.get(suppressed.id)?.refusal).toBe("suppressed");
    expect(byClient.get(dnc.id)?.refusal).toBe("do_not_call");
    expect(byClient.get(ok.id)?.enrolled).toBe(true);
  });

  it("le plafond quotidien tient DANS un même lot", async () => {
    // Le piège : lire le compteur une seule fois avant la boucle ferait entrer
    // les 10 personnes malgré un plafond de 3.
    const campaign = await makeCampaign({ dailyEnrollmentCap: 3 });
    const list = [];
    for (let i = 0; i < 10; i += 1) list.push(await makeReachableClient());

    const results = await enrollClients(
      campaign.id,
      list.map((c) => c.id),
      { now: NOW },
    );

    expect(results.filter((r) => r.enrolled)).toHaveLength(3);
    expect(results.filter((r) => r.refusal === "daily_cap_reached")).toHaveLength(7);
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(3);
  });

  it("une campagne en brouillon n'inscrit personne", async () => {
    const campaign = await makeCampaign({ status: "draft" });
    const client = await makeReachableClient();
    const [result] = await enrollClients(campaign.id, [client.id], { now: NOW });
    expect(result).toMatchObject({ enrolled: false, refusal: "campaign_not_active" });
  });

  it("le compteur du jour se lit sur la journée de Toronto", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    await enrollClients(campaign.id, [client.id], { now: NOW });

    // 21 août 15 h UTC = 11 h à Toronto : même journée locale.
    const counts = await enrollmentCounts(campaign.id, NOW);
    expect(counts).toEqual({ today: 1, total: 1 });

    // 22 août 03 h UTC = 21 août 23 h à Toronto — toujours la même journée.
    const sameDay = await enrollmentCounts(campaign.id, new Date("2026-08-22T03:00:00Z"));
    expect(sameDay.today).toBe(1);

    // 22 août 15 h UTC = 11 h le 22 à Toronto : nouvelle journée.
    const nextDay = await enrollmentCounts(campaign.id, new Date("2026-08-22T15:00:00Z"));
    expect(nextDay.today).toBe(0);
    expect(nextDay.total).toBe(1);
  });
});

describe("échelle de relances", () => {
  it("le premier barreau crée le fil, met l'envoi en file et avance d'un cran", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    const result = await runTouch(enrolled.enrollmentId!, NOW);
    expect(result.sent).toBe(true);
    expect(result.step).toBe(0);

    const [job] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "send_sms"));
    expect(job).toBeDefined();
    expect((job.payload as { body: string }).body).toContain("Groupe Nexus");
    expect((job.payload as { source: string }).source).toBe("ladder");

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(row!.step).toBe(1);
    expect(row!.status).toBe("active");
    expect(row!.conversationId).not.toBeNull();
    // 48 h après l'ENVOI réel, pas après l'inscription.
    expect(row!.nextTouchAt!.toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });

  it("§ un barreau ne part qu'UNE fois, même rejoué", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    await runTouch(enrolled.enrollmentId!, NOW);
    // Le job est rejoué : panne entre la mise en file et le règlement.
    const replay = await runTouch(enrolled.enrollmentId!, NOW);

    // Le rejeu ne renvoie pas l'ouverture ET n'expédie pas non plus le barreau
    // suivant en avance : il n'est pas dû.
    expect(replay).toMatchObject({ sent: false, refusal: "not_due" });

    const touches = await testDb.select().from(campaignTouches);
    expect(touches).toHaveLength(1);
    expect(touches[0].step).toBe(0);

    const sendJobs = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "send_sms"));
    expect(sendJobs).toHaveLength(1);
  });

  it("le dernier barreau CLÔT l'inscription au lieu de la laisser invisible", async () => {
    const campaign = await makeCampaign({
      ladder: [{ delayHours: 0, body: "Un seul message.", label: "" }],
    });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    await runTouch(enrolled.enrollmentId!, NOW);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    // Sans clôture ici, `next_touch_at` à null la rendrait invisible pour
    // toujours : la file ne sélectionne que les barreaux dus.
    expect(row!.status).toBe("completed");
    expect(row!.endReason).toBe("ladder_exhausted");
    expect(row!.endedAt).not.toBeNull();
    expect(row!.nextTouchAt).toBeNull();
  });

  it("un barreau SANS texte réveille l'assistant au lieu d'inventer une phrase", async () => {
    const campaign = await makeCampaign({
      ladder: [{ delayHours: 0, body: null, label: "l'assistant rédige" }],
    });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    await runTouch(enrolled.enrollmentId!, NOW);

    const jobs = await testDb.select().from(scheduledJobs);
    expect(jobs.map((j) => j.type)).toEqual(["agent_turn"]);
  });
});

describe("arrêts en cours d'échelle", () => {
  it("un désabonnement APRÈS l'inscription arrête tout", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    // La personne répond STOP entre deux barreaux.
    await testDb.insert(suppressions).values({ phoneE164: client.phone, reason: "sms_stop" });

    const later = new Date("2026-08-23T15:00:00.000Z");
    const result = await runTouch(enrolled.enrollmentId!, later);

    expect(result).toMatchObject({ sent: false, refusal: "suppressed" });
    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(row!.status).toBe("stopped");
    // Et surtout : aucun deuxième envoi n'a été mis en file.
    const sends = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "send_sms"));
    expect(sends).toHaveLength(1);
  });

  it("une réponse rend la main à l'assistant", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    await testDb
      .update(conversations)
      .set({ lastInboundAt: new Date("2026-08-22T10:00:00Z") })
      .where(eq(conversations.id, row!.conversationId!));

    const result = await runTouch(enrolled.enrollmentId!, new Date("2026-08-23T15:00:00Z"));
    expect(result).toMatchObject({ sent: false, refusal: "replied" });

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("replied");
  });

  it("un humain qui reprend la main coupe l'échelle sans la clore", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    await testDb
      .update(conversations)
      .set({ aiEnabled: false })
      .where(eq(conversations.id, row!.conversationId!));

    const result = await runTouch(enrolled.enrollmentId!, new Date("2026-08-23T15:00:00Z"));
    expect(result).toMatchObject({ sent: false, refusal: "ai_paused" });

    // Pas clôturée : si l'humain rend la main, l'échelle peut reprendre.
    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("active");
  });

  it("mettre la campagne en pause suspend les barreaux sans clore les inscriptions", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    await testDb.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, campaign.id));
    const result = await runTouch(enrolled.enrollmentId!, new Date("2026-08-23T15:00:00Z"));
    expect(result).toMatchObject({ sent: false, refusal: "campaign_not_active" });

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("active");
  });
});

describe("A/B", () => {
  it("la variante est figée à l'inscription et se retrouve sur la trace", async () => {
    const campaign = await makeCampaign({
      variants: [
        { key: "direct", weight: 50, body: "Bonjour, avez-vous 15 minutes cette semaine?" },
        { key: "doux", weight: 50, body: "Bonjour! Toujours un projet immobilier en tête?" },
      ],
    });
    const list = [];
    for (let i = 0; i < 20; i += 1) list.push(await makeReachableClient());
    const results = await enrollClients(campaign.id, list.map((c) => c.id), { now: NOW });

    const variants = new Set(results.map((r) => r.variant));
    expect(variants.size).toBe(2);

    // Le message envoyé est bien celui de LA variante tirée.
    const first = results[0];
    await runTouch(first.enrollmentId!, NOW);
    const [touch] = await testDb
      .select()
      .from(campaignTouches)
      .where(eq(campaignTouches.enrollmentId, first.enrollmentId!));
    expect(touch.variant).toBe(first.variant);

    const [job] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "send_sms"));
    const body = (job.payload as { body: string }).body;
    expect(body).toBe(
      first.variant === "direct"
        ? "Bonjour, avez-vous 15 minutes cette semaine?"
        : "Bonjour! Toujours un projet immobilier en tête?",
    );
  });

  it("la variante ne remplace QUE l'ouverture", async () => {
    const campaign = await makeCampaign({
      ladder: [
        { delayHours: 0, body: "ouverture par défaut", label: "" },
        { delayHours: 48, body: "relance commune", label: "" },
      ],
      variants: [{ key: "a", weight: 100, body: "ouverture variante A" }],
    });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    await runTouch(enrolled.enrollmentId!, NOW);
    await runTouch(enrolled.enrollmentId!, new Date("2026-08-23T15:00:00Z"));

    const jobs = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "send_sms"));
    const bodies = jobs.map((j) => (j.payload as { body: string }).body).sort();
    // Faire varier toute l'échelle rendrait le résultat inattribuable.
    expect(bodies).toEqual(["ouverture variante A", "relance commune"]);
  });
});

describe("audience et déclencheurs", () => {
  it("l'aperçu compte ce que le balayage inscrira", async () => {
    const campaign = await makeCampaign({
      audience: { notContactedForDays: 90 },
      dailyEnrollmentCap: 100,
    });

    const cold = await makeReachableClient();
    await testDb
      .update(clients)
      .set({ lastContactedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(clients.id, cold.id));
    const never = await makeReachableClient(); // jamais contacté
    const recent = await makeReachableClient();
    await testDb
      .update(clients)
      .set({ lastContactedAt: new Date("2026-08-20T00:00:00Z") })
      .where(eq(clients.id, recent.id));

    const previewed = await audienceCount(campaign.id, NOW);
    // « jamais contacté » compte : sinon la réactivation rate les plus froids.
    expect(previewed).toBe(2);

    const swept = await sweepCampaign(campaign.id, { now: NOW });
    expect(swept.enrolled).toBe(2);
    void never;
  });

  it("un numéro supprimé ne gonfle même pas l'aperçu", async () => {
    const campaign = await makeCampaign();
    const ok = await makeReachableClient();
    const gone = await makeReachableClient();
    await testDb.insert(suppressions).values({ phoneE164: gone.phone, reason: "sms_stop" });

    expect(await audienceCount(campaign.id, NOW)).toBe(1);
    void ok;
  });

  it("un balayage relancé n'inscrit pas deux fois", async () => {
    const campaign = await makeCampaign({ dailyEnrollmentCap: 100 });
    for (let i = 0; i < 5; i += 1) await makeReachableClient();

    const first = await sweepCampaign(campaign.id, { now: NOW });
    const second = await sweepCampaign(campaign.id, { now: NOW });

    expect(first.enrolled).toBe(5);
    expect(second.enrolled).toBe(0);
    // L'audience les exclut déjà : ils ne sont même pas considérés.
    expect(second.considered).toBe(0);
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(5);
  });

  it("un lead entrant est inscrit par le déclencheur lead_created", async () => {
    const campaign = await makeCampaign({ trigger: { kind: "lead_created", sourceIds: [] } });
    const client = await makeReachableClient();

    const matches = await matchCampaigns(client.id, { now: NOW });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ campaignId: campaign.id, enrolled: true });

    // Et le barreau d'ouverture est en file.
    const jobs = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "campaign_touch"));
    expect(jobs).toHaveLength(1);
  });

  it("une campagne manuelle ignore les leads entrants", async () => {
    await makeCampaign({ trigger: { kind: "manual" } });
    const client = await makeReachableClient();
    expect(await matchCampaigns(client.id, { now: NOW })).toEqual([]);
  });

  it("les barreaux dus deviennent des jobs, une fois chacun", async () => {
    const campaign = await makeCampaign({ dailyEnrollmentCap: 100 });
    for (let i = 0; i < 3; i += 1) await makeReachableClient();
    await sweepCampaign(campaign.id, { now: NOW });

    // Le balayage a déjà mis en file ; un deuxième passage ne double pas.
    const queued = await queueDueTouches(50, NOW);
    expect(queued).toBe(3);

    const jobs = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "campaign_touch"));
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.dedupeKey)).size).toBe(3);
  });
});

describe("le webhook de leads inscrit sans faire attendre n8n", () => {
  it("un lead accepté déclenche l'inscription APRÈS la réponse", async () => {
    const campaign = await makeCampaign({
      trigger: { kind: "lead_created", sourceIds: [] },
      // Le lead arrive sans consentement enregistré par nos soins : c'est le
      // webhook lui-même qui l'inscrit au registre.
      requireConsent: true,
    });

    const rawKey = "cle-webhook-campagne-0123456789";
    await testDb.insert(webhookKeys).values({
      name: "n8n",
      keyEnc: encryptSecret(rawKey),
      keyHash: sha256Hex(rawKey),
      keyLast4: rawKey.slice(-4),
    });

    const res = await leadsWebhook.POST(
      new Request("http://localhost:3000/api/webhooks/leads", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": rawKey },
        body: JSON.stringify({ fullName: "Nouveau Lead", phone: "4185551234" }),
      }),
    );
    // La réponse part AVANT le travail de campagne : c'est tout l'intérêt.
    expect(res.status).toBe(200);

    await flushAfterResponse();

    const rows = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("une campagne en échec ne fait pas échouer l'entrée du lead", async () => {
    // Campagne active dont l'assistant a disparu : le moteur lèvera. Le lead
    // doit quand même entrer — perdre un lead à cause d'une campagne mal
    // configurée serait le pire compromis possible.
    await makeCampaign({ trigger: { kind: "lead_created", sourceIds: [] } });
    await testDb.update(campaigns).set({ ladder: "pas une échelle" }).where(sql`true`);

    const rawKey = "cle-webhook-campagne-9876543210";
    await testDb.insert(webhookKeys).values({
      name: "n8n",
      keyEnc: encryptSecret(rawKey),
      keyHash: sha256Hex(rawKey),
      keyLast4: rawKey.slice(-4),
    });

    const res = await leadsWebhook.POST(
      new Request("http://localhost:3000/api/webhooks/leads", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": rawKey },
        body: JSON.stringify({ fullName: "Lead Résilient", phone: "4185559876" }),
      }),
    );
    expect(res.status).toBe(200);
    await flushAfterResponse();

    const saved = await testDb.select().from(clients);
    expect(saved.some((c) => c.fullName === "Lead Résilient")).toBe(true);
  });
});

void and;
void messages;
