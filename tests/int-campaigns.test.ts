/**
 * Intégration — inscription, échelle, A/B, arrêts.
 *
 * Le test central du cahier : **tout chemin qui envoie un message est
 * idempotent, et on le prouve.** Ici cela veut dire deux choses distinctes —
 * un client n'entre qu'une fois dans une campagne (index unique), et un barreau
 * ne part qu'une fois (index unique sur (inscription, barreau)).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { categories, clients, settings, webhookKeys } from "@/db/schema";
import { encryptSecret, sha256Hex } from "@/lib/crypto";
import {
  campaignEnrollments,
  campaignTouches,
  campaigns,
  conversations,
  messages,
  scheduledJobs,
  smsNumbers,
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
const { matchCampaigns, sweepCampaign, queueDueTouches, sweepDueCampaigns } = await import(
  "@/lib/campaigns-server/match"
);
const { markEnrollmentsBooked, markEnrollmentsReplied, markEnrollmentsStopped } = await import(
  "@/lib/campaigns-server/inbound"
);
const { closeCampaignEnrollments } = await import("@/lib/campaigns-server/lifecycle");
const { flushAfterResponse } = await import("@/lib/after-response");
const { runDispatchCycle } = await import("@/lib/jobs/dispatch");
const { enqueueJob } = await import("@/lib/jobs/queue");
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
    })
    .returning();
  return row;
}

/**
 * Un client joignable : un téléphone, et rien qui l'en empêche.
 *
 * Il fallait autrefois lui poser un consentement au registre. Depuis que toute
 * fiche entrée dans ce CRM est réputée joignable, « joignable » se réduit à
 * « a un numéro et n'a pas dit non ».
 */
async function makeReachableClient(overrides: Record<string, unknown> = {}) {
  return makeClient(overrides);
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

    const suppressed = await makeReachableClient();
    await testDb
      .insert(suppressions)
      .values({ phoneE164: suppressed.phone, reason: "sms_stop" });
    const dnc = await makeReachableClient({ doNotCall: true });
    const ok = await makeReachableClient();

    const results = await enrollClients(
      campaign.id,
      [suppressed.id, dnc.id, ok.id],
      { now: NOW },
    );
    const byClient = new Map(results.map((r) => [r.clientId, r]));

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

  it("§ un barreau ne part PAS à une fiche sortie de l'audience — il la clôt", async () => {
    // Le filet de sécurité, sous le déclencheur : même si personne n'a prévenu
    // le moteur (catégorie vidée par la base via `on delete set null`, chemin
    // oublié, inscription périmée d'avant le correctif), le barreau ne part pas.
    const visee = await makeCategory({ nameFr: "À rappeler", nameEn: "Callback" });
    const autre = await makeCategory({ nameFr: "Rendez-vous", nameEn: "Booked" });
    const campaign = await makeCampaign({ audience: { categoryIds: [visee.id] } });
    const client = await makeReachableClient({ categoryId: visee.id });
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });

    // La fiche change de catégorie SANS passer par le déclencheur.
    await testDb.update(clients).set({ categoryId: autre.id }).where(eq(clients.id, client.id));

    const result = await runTouch(enrolled.enrollmentId!, NOW);
    expect(result).toMatchObject({ sent: false, refusal: "left_audience" });
    // Aucun SMS mis en file.
    expect(await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "send_sms"))).toHaveLength(0);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    // Close, et non repoussée : une catégorie ne revient pas toute seule.
    expect(row!.status).toBe("excluded");
    expect(row!.endReason).toBe("left_audience");
    expect(row!.nextTouchAt).toBeNull();
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
    // Le CONTEXTE du barreau voyage avec le job : sans lui, le tour cherche un
    // entrant à traiter, n'en trouve pas, et se termine en « skipped » — rien
    // ne part, et rien ne le dit. Clé distincte de `turn:<conversation>` pour
    // qu'un tour de réponse en vol n'absorbe pas l'ouverture.
    expect(jobs[0].payload).toMatchObject({
      outreach: { enrollmentId: enrolled.enrollmentId, step: 0 },
    });
    expect(jobs[0].dedupeKey).toBe(`outreach:${enrolled.enrollmentId}:0`);
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

describe("chemin COMPLET : balayage → job de barreau → envoi", () => {
  it("RÉGRESSION : l'envoi n'est pas absorbé par le job qui l'a demandé", async () => {
    // Les tests qui appellent `runTouch` directement ne voyaient pas ce bogue :
    // il n'apparaît que si un job `campaign_touch` est encore VIVANT au moment
    // où le barreau met son envoi en file. Avec une clé de dédoublonnage
    // partagée, la mise en file était absorbée — l'échelle avançait, la trace
    // disait « envoyé », et aucun SMS ne partait jamais.
    const campaign = await makeCampaign({ dailyEnrollmentCap: 100 });
    const client = await makeReachableClient();

    await sweepCampaign(campaign.id, { now: NOW });

    const touchJobs = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "campaign_touch"));
    expect(touchJobs).toHaveLength(1);

    // Le job est réclamé et exécuté pendant qu'il est encore en file.
    const [enrollment] = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.clientId, client.id));
    const result = await runTouch(enrollment.id, NOW);
    expect(result.sent).toBe(true);

    const sends = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "send_sms"));
    expect(sends).toHaveLength(1);
    expect((sends[0].payload as { body: string }).body).toContain("Groupe Nexus");

    // Les deux jobs coexistent : espaces de noms distincts.
    expect(sends[0].dedupeKey).not.toBe(touchJobs[0].dedupeKey);
  });

  it("le job de barreau et son envoi vivent sous des préfixes différents", async () => {
    const campaign = await makeCampaign({ dailyEnrollmentCap: 100 });
    await makeReachableClient();
    await sweepCampaign(campaign.id, { now: NOW });
    const [enrollment] = await testDb.select().from(campaignEnrollments);
    await runTouch(enrollment.id, NOW);

    const keys = (await testDb.select().from(scheduledJobs)).map((j) => j.dedupeKey);
    expect(keys.some((k) => k?.startsWith("ctouch:"))).toBe(true);
    expect(keys.some((k) => k?.startsWith("csend:"))).toBe(true);
  });
});

describe("déclencheurs qui doivent VRAIMENT s'exécuter", () => {
  it("une campagne périodique balaie quand l'intervalle est écoulé", async () => {
    // Le piège fermé ici : un déclencheur sélectionnable à l'écran qui
    // n'inscrit jamais personne. Une campagne d'apparence vivante qui ne fait
    // rien, et rien pour le dire.
    const campaign = await makeCampaign({
      trigger: { kind: "scheduled", everyHours: 24 },
      dailyEnrollmentCap: 100,
    });
    for (let i = 0; i < 3; i += 1) await makeReachableClient();

    const first = await sweepDueCampaigns(NOW);
    expect(first).toEqual([{ campaignId: campaign.id, enrolled: 3 }]);

    // Une heure plus tard : l'intervalle n'est pas écoulé, on ne rebalaie pas.
    const tooSoon = await sweepDueCampaigns(new Date("2026-08-21T16:00:00Z"));
    expect(tooSoon).toEqual([]);

    // Le lendemain : on rebalaie (même si personne de neuf n'entre).
    await makeReachableClient();
    const nextDay = await sweepDueCampaigns(new Date("2026-08-22T16:00:00Z"));
    expect(nextDay).toEqual([{ campaignId: campaign.id, enrolled: 1 }]);
  });

  it("un balayage qui n'inscrit personne fait quand même avancer l'intervalle", async () => {
    // Sinon la campagne rebalaie à chaque cycle, pour rien.
    const campaign = await makeCampaign({ trigger: { kind: "scheduled", everyHours: 24 } });
    await sweepDueCampaigns(NOW);

    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(row!.lastSweptAt).not.toBeNull();
    expect(await sweepDueCampaigns(new Date("2026-08-21T16:00:00Z"))).toEqual([]);
  });

  it("une campagne manuelle n'est jamais balayée automatiquement", async () => {
    await makeCampaign({ trigger: { kind: "manual" } });
    await makeReachableClient();
    expect(await sweepDueCampaigns(NOW)).toEqual([]);
  });

  it("le déclencheur « changement de catégorie » filtre sur la catégorie d'arrivée", async () => {
    const [chaud] = await testDb
      .insert(categories)
      .values({ nameFr: "Chaud", nameEn: "Hot", color: "#f00" })
      .returning();
    const [froid] = await testDb
      .insert(categories)
      .values({ nameFr: "Froid", nameEn: "Cold", color: "#00f" })
      .returning();

    const campaign = await makeCampaign({
      trigger: { kind: "category_changed", toCategoryIds: [chaud.id] },
    });

    const wrong = await makeReachableClient();
    await testDb.update(clients).set({ categoryId: froid.id }).where(eq(clients.id, wrong.id));
    expect(await matchCampaigns(wrong.id, { now: NOW, kind: "category_changed" })).toEqual([
      { campaignId: campaign.id, enrolled: false, refusal: "audience_miss" },
    ]);

    const right = await makeReachableClient();
    await testDb.update(clients).set({ categoryId: chaud.id }).where(eq(clients.id, right.id));
    const matched = await matchCampaigns(right.id, { now: NOW, kind: "category_changed" });
    expect(matched[0]).toMatchObject({ campaignId: campaign.id, enrolled: true });
  });

  it("un lead entrant ne déclenche PAS une campagne « changement de catégorie »", async () => {
    await makeCampaign({ trigger: { kind: "category_changed", toCategoryIds: [] } });
    const client = await makeReachableClient();
    expect(await matchCampaigns(client.id, { now: NOW })).toEqual([]);
  });
});

describe("effet d'un message entrant sur les inscriptions", () => {
  it("une réponse APRÈS le dernier barreau compte quand même — c'est ce qu'un A/B mesure", async () => {
    // Le dernier barreau clôt l'inscription sur-le-champ. Un test A/B à un seul
    // barreau était donc « completed » avant la moindre réponse, et aucune
    // réponse ne comptait jamais : la comparaison donnait 0 contre 0.
    const campaign = await makeCampaign({
      ladder: [{ delayHours: 0, body: "Un seul message.", label: "" }],
      variants: [{ key: "a", weight: 100, body: "" }],
    });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    const done = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(done!.status).toBe("completed");

    // La personne répond quatre jours après la fin de l'échelle.
    await markEnrollmentsReplied(done!.conversationId!, new Date("2026-08-25T10:00:00Z"));

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("replied");
    expect(after!.endReason).toBe("replied");
  });

  it("une réponse des mois plus tard ne crédite plus le barreau", async () => {
    const campaign = await makeCampaign({
      ladder: [{ delayHours: 0, body: "Un seul message.", label: "" }],
    });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);
    const done = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });

    // Hors fenêtre d'attribution : le lien avec le barreau est trop ténu.
    await markEnrollmentsReplied(done!.conversationId!, new Date("2026-12-01T10:00:00Z"));
    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("completed");
  });

  it("un rendez-vous pris dans le fil marque l'inscription « booked » — même déjà « replied »", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);
    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });

    await markEnrollmentsReplied(row!.conversationId!, new Date("2026-08-22T10:00:00Z"));
    await markEnrollmentsBooked(row!.conversationId!, new Date("2026-08-22T10:30:00Z"));

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("booked");
    expect(after!.endReason).toBe("booked");
    expect(after!.nextTouchAt).toBeNull();
  });

  it("une réponse en cours d'échelle bascule l'inscription immédiatement", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    await markEnrollmentsReplied(row!.conversationId!, new Date("2026-08-22T10:00:00Z"));

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("replied");
    expect(after!.nextTouchAt).toBeNull();
  });

  it("un désabonnement arrête TOUTES les inscriptions du client", async () => {
    // Le refus porte sur le numéro, pas sur une campagne.
    const a = await makeCampaign({ name: "A", audience: { excludeActiveInOtherCampaign: false } });
    const b = await makeCampaign({ name: "B", audience: { excludeActiveInOtherCampaign: false } });
    const client = await makeReachableClient();

    await enrollClients(a.id, [client.id], { now: NOW });
    await enrollClients(b.id, [client.id], { now: NOW });

    await markEnrollmentsStopped(client.id, NOW);

    const rows = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.clientId, client.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "stopped")).toBe(true);
    expect(rows.every((r) => r.endReason === "opted_out")).toBe(true);
  });
});

describe("le barreau n'avance QUE si l'envoi peut vraiment partir", () => {
  it("sous interrupteur d'arrêt : pas de trace, pas d'avance, reprise à la levée", async () => {
    // Avancer d'abord et laisser l'envoi se faire refuser consommait le
    // barreau pour rien : après un incident d'une heure, des centaines
    // d'échelles disaient « envoyé » sans qu'un SMS ne soit parti.
    const campaign = await makeCampaign({ trigger: { kind: "scheduled", everyHours: 24 } });
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await testDb.insert(settings).values({ key: "sms", value: { killSwitch: true } });

    const result = await runTouch(enrolled.enrollmentId!, NOW);
    expect(result).toMatchObject({ sent: false, refusal: "kill_switch" });
    expect(await testDb.select().from(campaignTouches)).toHaveLength(0);
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(row!.step).toBe(0);
    expect(row!.status).toBe("pending");
    // Repoussée, pas laissée due : la file ne la représente pas chaque minute.
    expect(row!.nextTouchAt!.getTime()).toBeGreaterThan(NOW.getTime());

    // Et la file elle-même ne met rien en attente tant que l'arrêt dure.
    expect(await queueDueTouches(50, new Date(NOW.getTime() + 60 * 60 * 1000))).toBe(0);
    expect(await sweepDueCampaigns(NOW)).toEqual([]);

    // Levée de l'interrupteur : le barreau part, rien n'a été perdu.
    await testDb.update(settings).set({ value: { killSwitch: false } }).where(eq(settings.key, "sms"));
    const retry = await runTouch(enrolled.enrollmentId!, new Date(NOW.getTime() + 20 * 60 * 1000));
    expect(retry.sent).toBe(true);
    expect(await testDb.select().from(campaignTouches)).toHaveLength(1);
  });

  it("la nuit, le barreau ATTEND le matin — et l'espacement se mesure depuis l'envoi réel", async () => {
    // Reporter l'ENVOI (et non le barreau) aux heures de politesse faisait
    // partir deux barreaux la même matinée : l'espacement se comptait depuis la
    // mise en file du soir, pas depuis l'envoi réel du lendemain.
    const campaign = await makeCampaign(); // [0 h, 48 h]
    const client = await makeReachableClient();
    // Vendredi 20 h 30 à Toronto : hors fenêtre [9, 20).
    const evening = new Date("2026-08-22T00:30:00.000Z");
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: evening });

    const result = await runTouch(enrolled.enrollmentId!, evening);
    expect(result).toMatchObject({ sent: false, refusal: "quiet_hours" });
    expect(await testDb.select().from(campaignTouches)).toHaveLength(0);
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    // Samedi 10 h (la fenêtre du samedi), étalé sur dix minutes de jitter.
    expect(row!.nextTouchAt!.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-08-22T14:00:00Z"));
    expect(row!.nextTouchAt!.getTime()).toBeLessThan(Date.parse("2026-08-22T14:11:00Z"));

    const morning = new Date("2026-08-22T14:15:00.000Z");
    const sent = await runTouch(enrolled.enrollmentId!, morning);
    expect(sent.sent).toBe(true);

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    // 48 h après l'envoi du SAMEDI MATIN, pas après la mise en file du vendredi soir.
    expect(after!.nextTouchAt!.toISOString()).toBe("2026-08-24T14:15:00.000Z");
  });

  it("un fil mis en pause par un humain REPOUSSE le barreau au lieu de le représenter chaque minute", async () => {
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

    const due = new Date("2026-08-23T15:00:00Z");
    const result = await runTouch(enrolled.enrollmentId!, due);
    expect(result).toMatchObject({ sent: false, refusal: "ai_paused" });

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("active");
    expect(after!.nextTouchAt!.getTime()).toBeGreaterThan(due.getTime());
    // Une minute plus tard, la file ne la re-présente PAS — sinon 1 440 jobs
    // par jour et par inscription, jusqu'à ce qu'un humain y pense.
    expect(await queueDueTouches(50, new Date(due.getTime() + 60_000))).toBe(0);
    const touchJobs = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "campaign_touch"));
    expect(touchJobs).toHaveLength(0);
  });

  it("sans numéro expéditeur actif, le barreau est repoussé — pas une boucle, pas une clôture", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await testDb.update(smsNumbers).set({ active: false }).where(eq(smsNumbers.id, numberId));

    const result = await runTouch(enrolled.enrollmentId!, NOW);
    expect(result).toMatchObject({ sent: false, refusal: "no_sender" });

    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(row!.status).toBe("pending");
    expect(row!.nextTouchAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await queueDueTouches(50, new Date(NOW.getTime() + 60_000))).toBe(0);
  });

  it("« ne pas appeler » posé en cours d'échelle arrête les barreaux restants", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    // Jour 1 : « ne me recontactez plus » au téléphone → disposition DNCL.
    await testDb.update(clients).set({ doNotCall: true }).where(eq(clients.id, client.id));

    const result = await runTouch(enrolled.enrollmentId!, new Date("2026-08-23T15:00:00Z"));
    expect(result).toMatchObject({ sent: false, refusal: "do_not_call" });

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    expect(after!.status).toBe("stopped");
    expect(after!.endReason).toBe("do_not_call");
    const sends = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "send_sms"));
    expect(sends).toHaveLength(1);
  });
});

describe("un fil déjà vivant n'est pas ouvert à froid", () => {
  it("une personne en conversation n'est pas inscrite", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      lastInboundAt: new Date("2026-08-20T15:00:00Z"),
    });

    const [result] = await enrollClients(campaign.id, [client.id], { now: NOW });
    expect(result).toMatchObject({ enrolled: false, refusal: "live_conversation" });
  });

  it("si le fil s'anime ENTRE l'inscription et l'ouverture, l'ouverture ne part pas", async () => {
    // Avant le premier barreau, l'inscription ne connaît aucun fil ; le fil
    // réel (téléphone + numéro) existe pourtant, et l'assistant y répond déjà.
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      lastInboundAt: new Date("2026-08-22T10:00:00Z"),
    });

    const result = await runTouch(enrolled.enrollmentId!, new Date("2026-08-22T15:00:00Z"));
    expect(result).toMatchObject({ sent: false, refusal: "live_conversation" });

    const after = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrolled.enrollmentId!),
    });
    // Rien n'est parti : « écartée », pas « arrêtée ».
    expect(after!.status).toBe("excluded");
    expect(after!.endReason).toBe("live_conversation");
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);
  });

  it("un fil dormant depuis des mois n'empêche pas une réactivation", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      lastInboundAt: new Date("2026-02-01T10:00:00Z"),
    });

    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    expect(enrolled.enrolled).toBe(true);
    expect((await runTouch(enrolled.enrollmentId!, NOW)).sent).toBe(true);
  });

  it("un humain qui tient déjà le fil bloque l'ouverture, dès le barreau 0", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      aiEnabled: false,
    });

    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    const result = await runTouch(enrolled.enrollmentId!, NOW);
    expect(result).toMatchObject({ sent: false, refusal: "ai_paused" });
    expect(await testDb.select().from(campaignTouches)).toHaveLength(0);
  });
});

describe("audience et plafonds", () => {
  it("le balayage inscrit jusqu'au plafond, et l'aperçu annonce le même nombre", async () => {
    // L'aperçu et le balayage doivent compter la MÊME chose : un aperçu qui
    // annonce 70 pour une campagne qui en inscrit 50 fait chercher une panne
    // là où il n'y a qu'un plafond.
    const campaign = await makeCampaign({
      trigger: { kind: "scheduled", everyHours: 24 },
      dailyEnrollmentCap: 50,
    });
    for (let i = 0; i < 70; i += 1) await makeReachableClient();

    expect(await audienceCount(campaign.id, NOW)).toBe(70);
    const swept = await sweepCampaign(campaign.id, { now: NOW });
    expect(swept.enrolled).toBe(50);
  });

  it("une campagne EN PAUSE compte comme « ailleurs »", async () => {
    // Ses inscriptions reprendront : inscrire les mêmes gens ailleurs pendant
    // la pause, c'est deux échelles sur la même personne au retour.
    const a = await makeCampaign({ name: "A" });
    const b = await makeCampaign({ name: "B" });
    const client = await makeReachableClient();
    await enrollClients(a.id, [client.id], { now: NOW });
    await testDb.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, a.id));

    const [result] = await enrollClients(b.id, [client.id], { now: NOW });
    expect(result).toMatchObject({ enrolled: false, refusal: "active_elsewhere" });
    expect(await audienceCount(b.id, NOW)).toBe(0);
  });

  it("§ le plafond quotidien tient même sous dix inscriptions CONCURRENTES", async () => {
    // Dix leads Facebook dans la même minute, chacun dans sa propre fonction :
    // tous lisaient « 0 inscrit aujourd'hui » et entraient tous.
    const campaign = await makeCampaign({ dailyEnrollmentCap: 3 });
    const list = [];
    for (let i = 0; i < 10; i += 1) list.push(await makeReachableClient());

    const results = await Promise.all(
      list.map((c) => enrollClients(campaign.id, [c.id], { now: NOW })),
    );
    expect(results.flat().filter((r) => r.enrolled)).toHaveLength(3);
    expect(results.flat().filter((r) => r.refusal === "daily_cap_reached")).toHaveLength(7);
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(3);
  });
});

describe("fin de vie d'une campagne", () => {
  it("archiver clôt les inscriptions en vol et annule leurs jobs de barreau", async () => {
    const campaign = await makeCampaign({ dailyEnrollmentCap: 100 });
    for (let i = 0; i < 3; i += 1) await makeReachableClient();
    await sweepCampaign(campaign.id, { now: NOW }); // 3 inscriptions, 3 jobs `ctouch:`

    const result = await closeCampaignEnrollments(campaign.id, NOW);
    expect(result).toEqual({ closed: 3, cancelledJobs: 3 });

    const rows = await testDb.select().from(campaignEnrollments);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
    expect(rows.every((r) => r.endReason === "campaign_archived")).toBe(true);
    expect(rows.every((r) => r.nextTouchAt === null)).toBe(true);

    const jobs = await testDb.select().from(scheduledJobs);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);

    // Et la file n'y revient plus.
    expect(await queueDueTouches(50, new Date("2026-08-30T15:00:00Z"))).toBe(0);
  });

  it("archiver une campagne sans inscription en vol ne touche à rien", async () => {
    const campaign = await makeCampaign();
    expect(await closeCampaignEnrollments(campaign.id, NOW)).toEqual({ closed: 0, cancelledJobs: 0 });
  });
});

void and;
void messages;

/**
 * Régression — la trace d'un barreau pointe sur le message qu'il a produit.
 *
 * `campaign_touches.message_id` était déclarée et liée par clé étrangère depuis
 * l'origine, et AUCUN chemin de code ne l'écrivait. Conséquence pratique :
 * remonter d'un barreau au message réellement parti obligeait à reconstruire la
 * clé `csend:<inscription>:<barreau>` du job — une chaîne, pas une jointure — et
 * la branche où c'est l'assistant qui rédige n'a même pas cette clé. Le lien
 * était donc simplement introuvable pour la moitié du trafic.
 *
 * Le lien se referme dans `handleSendSms`, le seul endroit qui crée la rangée
 * `messages` : les deux chemins (texte fixe et rédaction par l'assistant)
 * passent par lui.
 */
describe("trace de barreau → message", () => {
  /**
   * Horloge FIGÉE dans la fenêtre d'envoi (14 h à Toronto, un vendredi).
   *
   * `handleSendSms` reporte tout envoi automatisé hors des heures de politesse,
   * et il le fait AVANT d'écrire la rangée `messages` : lancée le soir, cette
   * suite verrait le job repoussé au lendemain et conclurait à tort que le lien
   * n'est pas écrit. Seul `Date` est simulé — les minuteries réelles de
   * postgres.js doivent continuer de tourner.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-21T18:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("le barreau à texte fixe se relie au message produit", async () => {
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);

    // Le job d'envoi porte le barreau dont il vient.
    const [job] = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "send_sms"));
    expect((job.payload as { outreach: { step: number } | null }).outreach).toMatchObject({
      enrollmentId: enrolled.enrollmentId,
      step: 0,
    });

    // Le dispatcher exécute l'envoi (SMS_MODE absent ⇒ dry_run : rien ne part).
    await runDispatchCycle();

    const [touch] = await testDb
      .select()
      .from(campaignTouches)
      .where(eq(campaignTouches.enrollmentId, enrolled.enrollmentId!));
    expect(touch.messageId, "la trace doit pointer sur une rangée messages").not.toBeNull();

    const message = await testDb.query.messages.findFirst({
      where: eq(messages.id, touch.messageId!),
    });
    expect(message, "le message pointé existe vraiment").toBeDefined();
    expect(message!.source).toBe("ladder");
    expect(message!.body).toContain("Groupe Nexus");
  });

  it("un envoi hors campagne ne touche à aucune trace", async () => {
    // La garde qui empêche le lien de s'appliquer trop largement : un message
    // humain ou une réponse d'agent ne sont pas des barreaux.
    const campaign = await makeCampaign();
    const client = await makeReachableClient();
    const [enrolled] = await enrollClients(campaign.id, [client.id], { now: NOW });
    await runTouch(enrolled.enrollmentId!, NOW);
    await runDispatchCycle();

    const before = await testDb
      .select()
      .from(campaignTouches)
      .where(eq(campaignTouches.enrollmentId, enrolled.enrollmentId!));

    const conversation = await testDb.query.conversations.findFirst({
      where: eq(conversations.clientId, client.id),
    });
    await enqueueJob({
      type: "send_sms",
      runAt: NOW,
      payload: {
        conversationId: conversation!.id,
        to: client.phone!,
        body: "Bonjour, c'est le courtier qui vous écrit à la main.",
        source: "human",
        automated: false,
        aiGenerated: false,
        sentById: null,
      },
    });
    await runDispatchCycle();

    const after = await testDb
      .select()
      .from(campaignTouches)
      .where(eq(campaignTouches.enrollmentId, enrolled.enrollmentId!));
    expect(after.map((t) => t.messageId)).toEqual(before.map((t) => t.messageId));
  });
});
