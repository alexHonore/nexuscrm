/**
 * Intégration — actions manuelles sur UNE inscription de campagne
 * (PATCH /api/campaigns/:id/enrollments/:enrollmentId).
 *
 *  · pause  : l'inscription reste inscrite mais sort de la file (invisible à
 *    `queueDueTouches`), et son réveil en attente est annulé.
 *  · resume : elle repart — reprogrammée, de nouveau visible à la file.
 *  · remove : le client est retiré (inscription « écartée »), travail annulé.
 *
 * Vrai handler de route + vrai garde RBAC (JWT signé) + vraie base.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs } from "@/db/schema";
import {
  campaignEnrollments,
  campaignTouches,
  campaigns,
  messages,
  scheduledJobs,
} from "@/db/schema-sms";

const CTX = vi.hoisted(() => ({ jar: new Map<string, string>(), hdrs: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (CTX.jar.has(n) ? { name: n, value: CTX.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void CTX.jar.set(n, v),
    delete: (n: string) => void CTX.jar.delete(n),
  }),
  headers: async () => CTX.hdrs,
}));

const { PATCH } = await import("@/app/api/campaigns/[id]/enrollments/[enrollmentId]/route");
const { POST: addClients, PATCH: bulkPatch } = await import(
  "@/app/api/campaigns/[id]/enrollments/route"
);
const { queueDueTouches } = await import("@/lib/campaigns-server/match");
const { runTouch } = await import("@/lib/campaigns-server/touch");
const { NextRequest } = await import("next/server");

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = (id: string, enrollmentId: string) => ({
  params: Promise.resolve({ id, enrollmentId }),
});
const ctx2 = (id: string) => ({ params: Promise.resolve({ id }) });
function req2(url: string, body: unknown, method: "POST" | "PATCH") {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const DUE = new Date("2026-08-20T14:00:00.000Z"); // passé : due maintenant

/** Une campagne active + un client + une inscription active DUE + son réveil en file. */
async function scene() {
  const [campaign] = await testDb
    .insert(campaigns)
    .values({
      name: "Relance (test)",
      status: "active",
      trigger: { kind: "manual" },
      ladder: [
        { delayHours: 0, body: "Bonjour", label: "ouverture" },
        { delayHours: 48, body: "Relance", label: "j+2" },
      ],
    })
    .returning();
  const client = await makeClient({ fullName: "Marie Tremblay", phone: "+15145550142" });
  const [enrollment] = await testDb
    .insert(campaignEnrollments)
    .values({
      campaignId: campaign.id,
      clientId: client.id,
      status: "active",
      step: 1,
      enrolledAt: new Date("2026-08-18T14:00:00.000Z"),
      lastTouchAt: new Date("2026-08-18T14:00:00.000Z"),
      nextTouchAt: DUE,
    })
    .returning();
  // Un réveil de barreau encore EN ATTENTE, comme la file en pose.
  const [job] = await testDb
    .insert(scheduledJobs)
    .values({
      type: "campaign_touch",
      runAt: DUE,
      payload: { enrollmentId: enrollment.id },
      status: "pending",
      dedupeKey: `ctouch:${enrollment.id}:1`,
    })
    .returning();
  await testDb
    .insert(campaignTouches)
    .values({ enrollmentId: enrollment.id, step: 1, plannedAt: DUE, status: "queued" });
  return { campaign, client, enrollment, job };
}

const reload = (id: string) =>
  testDb.query.campaignEnrollments.findFirst({ where: eq(campaignEnrollments.id, id) });

afterAll(closeDb);

describe("PATCH /api/campaigns/:id/enrollments/:enrollmentId", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  it("pause : sort de la file, annule le réveil, marque la pause — sans clore", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment, job } = await scene();

    // Avant : la file voit l'inscription due (un barreau à envoyer).
    expect(await queueDueTouches(50, new Date())).toBeGreaterThanOrEqual(1);

    const res = await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(200);

    const e = await reload(enrollment.id);
    expect(e!.status).toBe("active"); // toujours inscrite
    expect(e!.nextTouchAt).toBeNull(); // hors file
    expect(e!.endReason).toBe("paused_by_admin");
    expect(e!.endedAt).toBeNull(); // PAS close

    // Le réveil en attente est annulé.
    const j = await testDb.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, job.id) });
    expect(j!.status).toBe("cancelled");
    const [touch] = await testDb.select().from(campaignTouches);
    expect(touch.status).toBe("cancelled");

    // Après : la file ne la sélectionne plus (next_touch_at null).
    expect(await queueDueTouches(50, new Date())).toBe(0);

    // Auditée.
    const audit = await testDb.select().from(auditLogs);
    expect(audit.map((a) => a.action)).toContain("campaign.enrollment.pause");
  });

  it("pause deux fois : la seconde est refusée (409 already_paused)", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment } = await scene();
    await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    const res = await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_paused");
  });

  it("resume : reprogramme et redevient visible à la file", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment } = await scene();
    await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));

    const res = await PATCH(req("http://x", { action: "resume" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(200);
    const e = await reload(enrollment.id);
    expect(e!.status).toBe("active");
    expect(e!.nextTouchAt).not.toBeNull();
    expect(e!.endReason).toBeNull();
    expect(await queueDueTouches(50, new Date())).toBeGreaterThanOrEqual(1);
  });

  it("resume sur une inscription non en pause → 409 not_paused", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment } = await scene();
    const res = await PATCH(req("http://x", { action: "resume" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_paused");
  });

  it("remove : clôt en « écartée » (pas « arrêtée »), annule le travail", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment, job } = await scene();

    const res = await PATCH(req("http://x", { action: "remove" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(200);
    const e = await reload(enrollment.id);
    expect(e!.status).toBe("excluded");
    expect(e!.endReason).toBe("removed_by_admin");
    expect(e!.endedAt).not.toBeNull();
    expect(e!.nextTouchAt).toBeNull();
    const j = await testDb.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, job.id) });
    expect(j!.status).toBe("cancelled");

    // Retirer deux fois : la seconde est refusée (déjà close).
    const again = await PATCH(req("http://x", { action: "remove" }), ctx(campaign.id, enrollment.id));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("not_in_flight");
  });

  it("remove fonctionne AUSSI sur une inscription en pause", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment } = await scene();
    await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    const res = await PATCH(req("http://x", { action: "remove" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(200);
    expect((await reload(enrollment.id))!.status).toBe("excluded");
  });

  it("RBAC : téléphoniste 403, anonyme 401", async () => {
    const { campaign, enrollment } = await scene();
    // Anonyme
    const anon = await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    expect(anon.status).toBe(401);
    // Téléphoniste
    const caller = await makeUser({ role: "caller" });
    await login(caller);
    const denied = await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    expect(denied.status).toBe(403);
    // Rien n'a bougé.
    expect((await reload(enrollment.id))!.endReason).toBeNull();
  });

  it("anti-IDOR : une inscription d'une AUTRE campagne → 404", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const a = await scene();
    const b = await scene();
    // L'inscription de b, sous l'id de campagne de a.
    const res = await PATCH(req("http://x", { action: "pause" }), ctx(a.campaign.id, b.enrollment.id));
    expect(res.status).toBe(404);
    expect((await reload(b.enrollment.id))!.endReason).toBeNull();
  });

  it("garde-fous d'entrée : action inconnue → 422, id non-uuid → 400", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const { campaign, enrollment } = await scene();
    const bad = await PATCH(req("http://x", { action: "delete_all" }), ctx(campaign.id, enrollment.id));
    expect(bad.status).toBe(422);
    const badId = await PATCH(req("http://x", { action: "pause" }), ctx("not-a-uuid", enrollment.id));
    expect(badId.status).toBe(400);
  });
});

// ── Backstop d'exécution : une pause tient MÊME contre un job déjà en vol ─────

describe("runTouch respecte la pause manuelle (backstop d'exécution)", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  it("un barreau dû, mis en pause juste avant l'exécution, N'ENVOIE PAS et ne dé-pause pas", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    // Un numéro d'envoi ACTIF : sans lui, le refus serait « no_sender » avant
    // même le garde de pause — on veut prouver que c'est bien la pause qui bloque.
    await makeSmsNumber({ active: true });
    const { campaign, enrollment } = await scene();

    // L'admin met en pause (next_touch_at → null) ; un job déjà réclamé
    // atteindrait quand même runTouch. On le simule en appelant runTouch
    // directement, dans la fenêtre d'envoi (10 h Toronto).
    await PATCH(req("http://x", { action: "pause" }), ctx(campaign.id, enrollment.id));
    // La trace du barreau 1 n'existe pas encore quand le job « sur le point
    // d'envoyer » s'exécute (elle est écrite DANS l'envoi) : on l'enlève pour
    // que le garde testé soit bien celui de la pause (next_touch_at null), et
    // non « already_sent ».
    await testDb.delete(campaignTouches).where(eq(campaignTouches.enrollmentId, enrollment.id));

    const result = await runTouch(enrollment.id, new Date("2026-08-20T14:00:00.000Z"));
    expect(result.sent).toBe(false);
    expect(result.refusal).toBe("not_due");

    // Rien n'est parti, l'échelle n'a pas avancé, la pause tient.
    expect(await testDb.select().from(messages)).toHaveLength(0);
    const e = await reload(enrollment.id);
    expect(e!.step).toBe(1); // pas avancé
    expect(e!.nextTouchAt).toBeNull(); // toujours hors file
    expect(e!.endReason).toBe("paused_by_admin"); // toujours en pause
  });
});

// ── Ajout de fiches (individuel ou en lot) + actions en lot ──────────────────

describe("POST/PATCH /api/campaigns/:id/enrollments (ajout et lot)", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  async function bareCampaign() {
    const [campaign] = await testDb
      .insert(campaigns)
      .values({
        name: "Ajout (test)",
        status: "active",
        trigger: { kind: "manual" },
        ladder: [{ delayHours: 0, body: "Bonjour", label: "ouverture" }],
      })
      .returning();
    return campaign;
  }

  it("POST ajoute des fiches précises ; une déjà inscrite est écartée, pas dupliquée", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const campaign = await bareCampaign();
    const c1 = await makeClient({ fullName: "Un", phone: "+15145550001" });
    const c2 = await makeClient({ fullName: "Deux", phone: "+15145550002" });

    const res = await addClients(
      req2("http://x", { clientIds: [c1.id, c2.id] }, "POST"),
      ctx2(campaign.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(2);
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(2);

    // Ré-ajouter c1 : écartée (déjà inscrite), aucune inscription en double.
    const again = await addClients(
      req2("http://x", { clientIds: [c1.id] }, "POST"),
      ctx2(campaign.id),
    );
    expect((await again.json()).added).toBe(0);
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(2);

    const audit = await testDb.select().from(auditLogs);
    expect(audit.map((a) => a.action)).toContain("campaign.enrollment.add");
  });

  it("POST : téléphoniste 403, corps invalide 422", async () => {
    const campaign = await bareCampaign();
    const caller = await makeUser({ role: "caller" });
    await login(caller);
    const denied = await addClients(req2("http://x", { clientIds: [] }, "POST"), ctx2(campaign.id));
    expect(denied.status).toBe(403);
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const bad = await addClients(req2("http://x", { clientIds: [] }, "POST"), ctx2(campaign.id));
    expect(bad.status).toBe(422); // min(1)
  });

  it("PATCH en lot retire plusieurs inscriptions ; un id étranger compte comme un échec", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const a = await scene();
    const b = await scene(); // autre campagne + inscription

    const res = await bulkPatch(
      req2("http://x", { action: "remove", enrollmentIds: [a.enrollment.id, b.enrollment.id] }, "PATCH"),
      ctx2(a.campaign.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // a retiré (appartient à a.campaign) ; b refusé (anti-IDOR → not_found).
    expect(body.done).toBe(1);
    expect(body.failed).toBe(1);
    expect((await reload(a.enrollment.id))!.status).toBe("excluded");
    expect((await reload(b.enrollment.id))!.status).toBe("active"); // intacte

    const audit = await testDb.select().from(auditLogs);
    expect(audit.map((x) => x.action)).toContain("campaign.enrollment.bulk_remove");
  });
});
