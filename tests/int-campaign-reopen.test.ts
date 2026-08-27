/**
 * Intégration — RELANCER les inscriptions terminées d'une campagne.
 *
 * Le trou que ça bouche : rallonger une échelle ne rattrape personne. Les
 * fiches qui ont fini l'ancienne sont closes, l'inscription de l'audience
 * exclut les déjà-inscrits et l'index unique refuse une deuxième entrée — les
 * barreaux ajoutés ne profitaient qu'aux nouveaux venus, en silence.
 *
 * Ce que ces tests prouvent, dans l'ordre d'importance :
 *  · un barreau DÉJÀ envoyé ne repart jamais ;
 *  · un refus exprimé (désabonnement, ne pas appeler) n'est jamais repêché, et
 *    surtout : le refuser n'ÉCRIT RIEN — sans quoi un vieux « non » se
 *    recompterait comme un arrêt d'aujourd'hui et gonflerait le taux d'arrêts ;
 *  · relancée, l'inscription redevient visible à la file et envoie la SUITE.
 *
 * Vrais handlers de route + vrai garde RBAC (JWT signé) + vraie base.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  campaignTouches,
  campaigns,
  conversations,
  promptCores,
  suppressions,
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
const { POST: reopenRoute } = await import("@/app/api/campaigns/[id]/reopen/route");
const { queueDueTouches } = await import("@/lib/campaigns-server/match");
const { runTouch } = await import("@/lib/campaigns-server/touch");
const { countReopenCandidates } = await import("@/lib/campaigns-server/reopen");
const { NextRequest } = await import("next/server");

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({
    uid: user.id,
    role: user.role,
    tv: user.tokenVersion,
    remember: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

function req(body: unknown, method: "POST" | "PATCH" = "PATCH") {
  return new NextRequest("http://x", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = (id: string, enrollmentId: string) => ({
  params: Promise.resolve({ id, enrollmentId }),
});
const ctx1 = (id: string) => ({ params: Promise.resolve({ id }) });

/** Envoi du barreau 0, il y a deux mois. */
const SENT = new Date("2026-06-18T14:00:00.000Z");

/**
 * Une campagne dont l'échelle a GRANDI (2 barreaux), et une inscription qui a
 * fini l'ancienne (1 seul barreau) : `step` = 1, close « échelle terminée »,
 * avec la trace du barreau 0 déjà parti.
 */
async function scene(
  opts: {
    ladder?: unknown[];
    campaign?: Record<string, unknown>;
    client?: Record<string, unknown>;
    enrollment?: Record<string, unknown>;
  } = {},
) {
  const number = await makeSmsNumber();
  const [campaign] = await testDb
    .insert(campaigns)
    .values({
      name: "Réactivation (test)",
      status: "active",
      trigger: { kind: "manual" },
      ladder: opts.ladder ?? [
        { delayHours: 0, body: "Bonjour, ici Groupe Nexus.", label: "ouverture" },
        { delayHours: 48, body: "Toujours un projet ?", label: "j+2" },
      ],
      smsNumberId: number.id,
      ...opts.campaign,
    })
    .returning();
  const client = await makeClient({
    fullName: "Marie Tremblay",
    phone: "+15145550142",
    ...opts.client,
  });
  const [enrollment] = await testDb
    .insert(campaignEnrollments)
    .values({
      campaignId: campaign.id,
      clientId: client.id,
      status: "completed",
      step: 1,
      endReason: "ladder_exhausted",
      endedAt: SENT,
      enrolledAt: SENT,
      lastTouchAt: SENT,
      nextTouchAt: null,
      ...opts.enrollment,
    })
    .returning();
  // Le barreau 0 est TRACÉ : c'est lui qui garantit qu'il ne repartira pas.
  await testDb
    .insert(campaignTouches)
    .values({ enrollmentId: enrollment.id, step: 0, plannedAt: SENT, sentAt: SENT, status: "sent" });
  return { campaign, client, enrollment, number };
}

/**
 * Un assistant, actif ou non. Un assistant ACTIF doit être compilé et adossé à
 * un noyau : un déclencheur en base le refuse autrement (« stale_compile »).
 */
async function makeAssistant(name: string, status: "active" | "archived") {
  await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE" }).onConflictDoNothing();
  const [row] = await testDb
    .insert(assistants)
    .values({
      name,
      status,
      identity: {},
      goal: { primary: { type: "qualify_only", requiredFields: [] } },
      approach: {},
      model: {},
      compiledPrompt: "# RÔLE\ncompilé",
      compiledCoreVersion: 1,
      compiledAt: new Date(),
      needsRecompile: false,
      suitePassed: true,
    })
    .returning();
  return row;
}

const reload = (id: string) =>
  testDb.query.campaignEnrollments.findFirst({ where: eq(campaignEnrollments.id, id) });

afterAll(closeDb);

beforeEach(async () => {
  await resetDb();
  CTX.jar.clear();
});

describe("PATCH …/enrollments/:id { action: \"reopen\" }", () => {
  it("§ l'inscription repart au barreau suivant, jamais au premier", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, enrollment } = await scene();

    // Avant : close, invisible à la file.
    expect(await queueDueTouches(50, new Date())).toBe(0);

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(200);

    const e = await reload(enrollment.id);
    expect(e!.status).toBe("active");
    // Le `step` n'est PAS rembobiné : le barreau 0 est derrière nous.
    expect(e!.step).toBe(1);
    // La colonne « Terminé » de l'écran mentirait si le motif restait.
    expect(e!.endReason).toBeNull();
    expect(e!.endedAt).toBeNull();
    expect(e!.nextTouchAt).not.toBeNull();
    // Jamais dans le passé : ce serait la rafale devant les campagnes vivantes.
    expect(e!.nextTouchAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("§ le barreau déjà envoyé ne repart pas — c'est la SUITE qui part", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, enrollment } = await scene();
    await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));

    // On force l'échéance pour jouer le barreau tout de suite, dans la fenêtre.
    const due = new Date("2026-08-20T14:00:00.000Z"); // 10 h à Toronto
    await testDb
      .update(campaignEnrollments)
      .set({ nextTouchAt: due })
      .where(eq(campaignEnrollments.id, enrollment.id));

    expect(await queueDueTouches(50, new Date())).toBeGreaterThanOrEqual(1);
    const result = await runTouch(enrollment.id, due);
    expect(result).toMatchObject({ sent: true, step: 1 });

    const touches = await testDb.select().from(campaignTouches);
    expect(touches).toHaveLength(2);
    expect(touches.map((t) => t.step).sort()).toEqual([0, 1]);

    // L'échelle est repartie ET terminée pour de bon : deux barreaux, deux traces.
    const e = await reload(enrollment.id);
    expect(e!.step).toBe(2);
    expect(e!.status).toBe("completed");
  });

  it("une inscription que l'échelle ne dépasse pas est refusée sans être touchée", async () => {
    await login(await makeUser({ role: "admin" }));
    // Une seule marche : l'inscription en a déjà consommé une.
    const { campaign, enrollment } = await scene({
      ladder: [{ delayHours: 0, body: "Bonjour", label: "ouverture" }],
    });

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nothing_new" });

    const e = await reload(enrollment.id);
    expect(e!.status).toBe("completed");
    expect(e!.endedAt).toEqual(SENT); // l'histoire est intacte
  });

  it("§ un désabonnement postérieur à la clôture bloque la relance SANS rien réécrire", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, client, enrollment } = await scene();
    // Le STOP est arrivé APRÈS la clôture : `markEnrollmentsStopped` ne ferme
    // que les inscriptions en vol, celle-ci est donc restée « Terminée ».
    await testDb.insert(suppressions).values({ phoneE164: client.phone, reason: "stop" });

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "suppressed" });

    // LE point : le statut n'a pas bougé. Rouvrir puis laisser le moteur
    // refuser aurait réécrit « arrêtée », daté d'aujourd'hui, et fait grimper
    // le taux d'arrêts pour un refus vieux de trois mois.
    const e = await reload(enrollment.id);
    expect(e!.status).toBe("completed");
    expect(e!.endReason).toBe("ladder_exhausted");
    expect(e!.endedAt).toEqual(SENT);
    expect(e!.nextTouchAt).toBeNull();
  });

  it("« ne pas appeler » bloque même quand la campagne ne l'exclut pas de son audience", async () => {
    await login(await makeUser({ role: "admin" }));
    // Volontairement plus strict que le moteur : relancer est une décision
    // prise AUJOURD'HUI, et « ne pas appeler » est absolu.
    const { campaign, enrollment } = await scene({
      campaign: { audience: { excludeDoNotCall: false } },
      client: { doNotCall: true },
    });

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "do_not_call" });
  });

  it("une réponse arrivée depuis rend la main à l'assistant — pas de barreau par-dessus", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, client, enrollment, number } = await scene();
    // Réponse APRÈS le dernier barreau, mais hors fenêtre d'attribution (30 j) :
    // l'inscription est restée « Terminée » avec un entrant plus récent.
    const [thread] = await testDb
      .insert(conversations)
      .values({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: number.id,
        lastInboundAt: new Date("2026-07-25T14:00:00.000Z"),
      })
      .returning();
    await testDb
      .update(campaignEnrollments)
      .set({ conversationId: thread.id })
      .where(eq(campaignEnrollments.id, enrollment.id));

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "replied_since" });
  });

  it("un fil repris par un humain n'est pas relancé", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, client, enrollment, number } = await scene();
    const [thread] = await testDb
      .insert(conversations)
      .values({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: number.id,
        aiEnabled: false,
      })
      .returning();
    await testDb
      .update(campaignEnrollments)
      .set({ conversationId: thread.id })
      .where(eq(campaignEnrollments.id, enrollment.id));

    const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ai_paused" });
  });

  it("un arrêt ou un rendez-vous ne se repêche jamais", async () => {
    await login(await makeUser({ role: "admin" }));
    for (const [status, endReason] of [
      ["stopped", "opted_out"],
      ["booked", "booked"],
      ["excluded", "removed_by_admin"],
    ] as const) {
      await resetDb();
      const { campaign, enrollment } = await scene({ enrollment: { status, endReason } });
      await login(await makeUser({ role: "admin" }));
      const res = await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id));
      expect(res.status, `${status}/${endReason}`).toBe(409);
      expect(await res.json()).toEqual({ error: "not_ladder_end" });
    }
  });

  it("un téléphoniste ne relance pas, et une inscription d'une AUTRE campagne est introuvable", async () => {
    const { campaign, enrollment } = await scene();

    await login(await makeUser({ role: "caller" }));
    expect((await PATCH(req({ action: "reopen" }), ctx(campaign.id, enrollment.id))).status).toBe(403);

    await login(await makeUser({ role: "admin" }));
    const [other] = await testDb
      .insert(campaigns)
      .values({ name: "Autre", status: "active", trigger: { kind: "manual" }, ladder: [{ delayHours: 0, body: "x", label: "" }] })
      .returning();
    // Anti-IDOR : l'identifiant existe, mais pas dans CETTE campagne.
    const res = await PATCH(req({ action: "reopen" }), ctx(other.id, enrollment.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /api/campaigns/:id/reopen", () => {
  it("l'aperçu compte et date SANS rien écrire", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, enrollment } = await scene();

    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dryRun: true, candidates: 1, reopened: 0, remaining: 0 });
    expect(body.firstAt).not.toBeNull();

    // Rien n'a bougé : c'était un aperçu.
    const e = await reload(enrollment.id);
    expect(e!.status).toBe("completed");
    expect(e!.nextTouchAt).toBeNull();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("§ relance TOUTE la campagne, y compris ce que l'écran n'affiche pas", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, number } = await scene();
    // Neuf autres inscriptions terminées, plus une désabonnée qui doit rester close.
    for (let i = 0; i < 9; i += 1) {
      const c = await makeClient({ phone: `+1514555${2000 + i}` });
      await testDb.insert(campaignEnrollments).values({
        campaignId: campaign.id,
        clientId: c.id,
        status: "completed",
        step: 1,
        endReason: "ladder_exhausted",
        endedAt: SENT,
        enrolledAt: SENT,
        lastTouchAt: SENT,
      });
    }
    const stopped = await makeClient({ phone: "+15145559999" });
    await testDb.insert(suppressions).values({ phoneE164: stopped.phone, reason: "stop" });
    const [stoppedEnrollment] = await testDb
      .insert(campaignEnrollments)
      .values({
        campaignId: campaign.id,
        clientId: stopped.id,
        status: "completed",
        step: 1,
        endReason: "ladder_exhausted",
        endedAt: SENT,
        enrolledAt: SENT,
        lastTouchAt: SENT,
      })
      .returning();

    expect(await countReopenCandidates(campaign.id, 2)).toBe(11);

    const res = await reopenRoute(req({}, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reopened).toBe(10);
    expect(body.refused).toEqual({ suppressed: 1 });

    const rows = await testDb.select().from(campaignEnrollments);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(10);
    // Les départs sont ÉTALÉS : aucune date en double, aucune dans le passé.
    const dates = rows
      .filter((r) => r.nextTouchAt !== null)
      .map((r) => r.nextTouchAt!.getTime());
    expect(new Set(dates).size).toBe(10);
    expect(Math.min(...dates)).toBeGreaterThan(Date.now());

    // La désabonnée n'a pas bougé d'un octet.
    const kept = await reload(stoppedEnrollment.id);
    expect(kept!.status).toBe("completed");
    expect(kept!.endedAt).toEqual(SENT);

    const audit = await testDb.select().from(auditLogs);
    expect(audit.map((a) => a.action)).toContain("campaign.enrollment.reopen_all");
    expect(number.dailyCap).toBeGreaterThan(0);
  });

  it("une campagne en pause refuse le geste entier, avec le mot juste", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign } = await scene({ campaign: { status: "paused" } });
    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "campaign_not_active" });
  });

  it("sans numéro d'envoi actif, on refuse au lieu de fabriquer des barreaux qui attendent", async () => {
    await login(await makeUser({ role: "admin" }));
    const { campaign, number } = await scene();
    await testDb.update(campaigns).set({ smsNumberId: null }).where(eq(campaigns.id, campaign.id));
    const { smsNumbers } = await import("@/db/schema-sms");
    await testDb.update(smsNumbers).set({ active: false }).where(eq(smsNumbers.id, number.id));

    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_sender" });
  });

  it("une campagne dont la fenêtre est fermée ne relance rien", async () => {
    await login(await makeUser({ role: "admin" }));
    // `endsAt` n'est lu nulle part au moment d'envoyer un barreau : la relance
    // est le geste qui déterre les vieilles campagnes, elle doit le vérifier.
    const { campaign } = await scene({ campaign: { endsAt: new Date("2026-07-01T00:00:00.000Z") } });
    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "outside_window" });
  });

  it("un barreau « l'assistant rédige » sans assistant désigné est écarté", async () => {
    await login(await makeUser({ role: "admin" }));
    // Sans ce refus, l'inscription relancée se ferait repousser d'une heure,
    // indéfiniment, sans qu'un seul message ne parte ni qu'un écran le dise.
    const { campaign } = await scene({
      ladder: [
        { delayHours: 0, body: "Bonjour", label: "ouverture" },
        { delayHours: 48, body: null, label: "l'assistant relance" },
      ],
    });
    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      candidates: 0,
      refused: { assistant_inactive: 1 },
    });
  });

  it("§ c'est l'assistant DU FIL qui décide, pas celui de la campagne", async () => {
    await login(await makeUser({ role: "admin" }));
    // Le fil a été transféré (ou attribué à la main) à un assistant depuis
    // archivé. La campagne, elle, en a un tout à fait valide — et c'est
    // pourtant celui du fil que l'envoi ira chercher. Gater sur la campagne
    // laissait passer exactement ce cas, et chaque ligne tournait ensuite en
    // rond, une fois par heure, pour toujours.
    const live = await makeAssistant("Vivant", "active");
    const archived = await makeAssistant("Archivé", "archived");
    const { campaign, client, enrollment, number } = await scene({
      ladder: [
        { delayHours: 0, body: "Bonjour", label: "ouverture" },
        { delayHours: 48, body: null, label: "l'assistant relance" },
      ],
      campaign: { assistantId: live.id },
    });
    const [thread] = await testDb
      .insert(conversations)
      .values({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: number.id,
        activeAssistantId: archived.id,
      })
      .returning();
    await testDb
      .update(campaignEnrollments)
      .set({ conversationId: thread.id })
      .where(eq(campaignEnrollments.id, enrollment.id));

    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      candidates: 0,
      refused: { assistant_inactive: 1 },
    });
  });

  it("§ un mur de refus permanents ne bloque pas la relance des suivants", async () => {
    await login(await makeUser({ role: "admin" }));
    // Les refus définitifs — désabonnés, « ne pas appeler » — gardent leur
    // statut, donc leur place en tête du tri, pour toujours. Si le plafond du
    // geste comptait les CANDIDATS et non les relançables, ils mangeraient
    // tout le lot et la campagne finirait par ne plus rien pouvoir relancer.
    const { campaign } = await scene({ enrollment: { status: "stopped", endReason: "opted_out" } });
    const old = new Date("2026-05-01T14:00:00.000Z"); // plus VIEUX : trie en tête
    for (let i = 0; i < 4; i += 1) {
      const c = await makeClient({ phone: `+1514555${3000 + i}`, doNotCall: true });
      await testDb.insert(campaignEnrollments).values({
        campaignId: campaign.id,
        clientId: c.id,
        status: "completed",
        step: 1,
        endReason: "ladder_exhausted",
        endedAt: old,
        enrolledAt: old,
        lastTouchAt: old,
      });
    }
    const good = await makeClient({ phone: "+15145553999" });
    await testDb.insert(campaignEnrollments).values({
      campaignId: campaign.id,
      clientId: good.id,
      status: "completed",
      step: 1,
      endReason: "ladder_exhausted",
      endedAt: SENT,
      enrolledAt: SENT,
      lastTouchAt: SENT,
    });

    // Un lot de 2 : les quatre « ne pas appeler » passent devant, et pourtant
    // le balayage doit aller chercher la bonne ligne derrière eux.
    const res = await reopenRoute(req({ dryRun: true }, "POST"), ctx1(campaign.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toBe(1);
    expect(body.refused).toMatchObject({ do_not_call: 4 });
  });

  it("un téléphoniste ne relance pas une campagne", async () => {
    const { campaign } = await scene();
    await login(await makeUser({ role: "caller" }));
    expect((await reopenRoute(req({}, "POST"), ctx1(campaign.id))).status).toBe(403);
  });
});
