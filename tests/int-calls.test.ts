/**
 * Intégration — pipeline d'appel : POST /api/calls, PATCH /api/calls/[id],
 * dispositions (cœur transactionnel), relances, idempotence.
 *
 * Tout passe par les vrais handlers de route + le vrai garde RBAC (JWT signé
 * avec AUTH_SECRET dans le cookie nexus_session). Aucun réseau externe.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import { auditLogs, calls, clients, followups, notifications } from "@/db/schema";
import { DISPOSITION_CONFIG, DISPOSITION_ORDER } from "@/lib/dispositions";

// ── Stubs de contexte Next (cookies/headers de requête) ─────────────────────

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

const { POST } = await import("@/app/api/calls/route");
const { PATCH } = await import("@/app/api/calls/[id]/route");
const { NextRequest } = await import("next/server");

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/calls", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/calls/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Ouvre un appel via le vrai POST et retourne son id. */
async function openCall(body: Record<string, unknown> = {}) {
  const res = await POST(postReq({ direction: "outbound", toNumber: "+14185550100", ...body }));
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return id;
}

async function getCall(id: string) {
  const row = await testDb.query.calls.findFirst({ where: eq(calls.id, id) });
  if (!row) throw new Error(`appel ${id} introuvable`);
  return row;
}

async function getClient(id: string) {
  const row = await testDb.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!row) throw new Error(`client ${id} introuvable`);
  return row;
}

describe("pipeline d'appel", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.hdrs = new Headers();
  });

  // ── POST /api/calls ───────────────────────────────────────────────────────

  describe("POST /api/calls", () => {
    it("refuse (401) sans session", async () => {
      const res = await POST(postReq({ direction: "outbound", toNumber: "+14185550100" }));
      expect(res.status).toBe(401);
      expect(await testDb.select().from(calls)).toHaveLength(0);
    });

    it("crée la ligne au nom de l'utilisateur de la session — userId du body ignoré", async () => {
      const me = await makeUser({ role: "caller", name: "Moi" });
      const other = await makeUser({ role: "admin", name: "Autre" });
      await login(me);

      const res = await POST(
        postReq({
          direction: "outbound",
          toNumber: "418-555-0100",
          // Tentative d'usurpation : ces champs doivent être ignorés.
          userId: other.id,
          disposition: "booked",
          durationSec: 9999,
        }),
      );
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const row = await getCall(id);
      expect(row.userId).toBe(me.id);
      expect(row.userId).not.toBe(other.id);
      expect(row.disposition).toBeNull();
      expect(row.durationSec).toBe(0);
    });

    it("stocke direction, numéros en E.164 et startedAt", async () => {
      const me = await makeUser();
      await login(me);
      const startedAt = new Date("2026-03-04T15:20:30.000Z");

      const id = await openCall({
        direction: "inbound",
        fromNumber: "(418) 476-1542",
        toNumber: "4185550199",
        startedAt: startedAt.toISOString(),
      });

      const row = await getCall(id);
      expect(row.direction).toBe("inbound");
      expect(row.fromNumber).toBe("+14184761542");
      expect(row.toNumber).toBe("+14185550199");
      expect(row.startedAt.toISOString()).toBe(startedAt.toISOString());
      expect(row.provider).toBe("voipms"); // défaut des réglages téléphonie
      expect(row.answeredAt).toBeNull();
      expect(row.endedAt).toBeNull();
    });

    it("rattache la fiche client quand elle existe", async () => {
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ fullName: "Jean Tremblay" });

      const id = await openCall({ clientId: client.id });
      expect((await getCall(id)).clientId).toBe(client.id);
    });

    it("journalise sans fiche quand le clientId n'existe pas (au lieu d'échouer)", async () => {
      const me = await makeUser();
      await login(me);

      const id = await openCall({ clientId: "11111111-1111-4111-8111-111111111111" });
      expect((await getCall(id)).clientId).toBeNull();
    });

    it("rejette (400) un corps invalide", async () => {
      const me = await makeUser();
      await login(me);
      const res = await POST(postReq({ direction: "sideways" }));
      expect(res.status).toBe(400);
      expect(await testDb.select().from(calls)).toHaveLength(0);
    });
  });

  // ── POST /api/calls : appel manqué (entrant jamais décroché) ──────────────

  describe("POST /api/calls — appel manqué", () => {
    it("journalise un manqué complet, rattache la fiche par numéro et notifie", async () => {
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ fullName: "Jean Tremblay", phone: "+14184761542" });

      const res = await POST(
        postReq({
          direction: "inbound",
          fromNumber: "(418) 476-1542",
          toNumber: "+14185550199",
          startedAt: "2026-08-09T14:00:00.000Z",
          endedAt: "2026-08-09T14:00:20.000Z",
        }),
      );
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const row = await getCall(id);
      // Fiche rattachée par numéro côté serveur — aucun clientId fourni.
      expect(row.clientId).toBe(client.id);
      expect(row.answeredAt).toBeNull();
      expect(row.endedAt?.toISOString()).toBe("2026-08-09T14:00:20.000Z");
      expect(row.durationSec).toBe(0);

      const notifs = await testDb.select().from(notifications);
      expect(notifs).toHaveLength(1);
      expect(notifs[0].userId).toBe(me.id);
      expect(notifs[0].type).toBe("missed_call");
      expect(notifs[0].title).toBe("Appel manqué");
      expect(notifs[0].body).toContain("Jean Tremblay");
      expect(notifs[0].body).toContain("(418) 476-1542");
      expect(notifs[0].link).toBe(`/clients/${client.id}`);
    });

    it("notifie dans la langue du destinataire et pointe vers le journal sans fiche", async () => {
      const me = await makeUser({ locale: "en" });
      await login(me);

      const res = await POST(
        postReq({
          direction: "inbound",
          fromNumber: "+14185550111",
          startedAt: "2026-08-09T14:00:00.000Z",
          endedAt: "2026-08-09T14:00:10.000Z",
        }),
      );
      expect(res.status).toBe(201);

      const [notif] = await testDb.select().from(notifications);
      expect(notif.title).toBe("Missed call");
      expect(notif.body).toBe("(418) 555-0111");
      expect(notif.link).toBe("/calls?direction=inbound&missed=1&period=30");
    });

    it("ne notifie ni un entrant répondu, ni un sortant terminé, ni un entrant encore ouvert", async () => {
      const me = await makeUser();
      await login(me);

      // Entrant complet et répondu — durée calculée de answeredAt à endedAt.
      const answered = await POST(
        postReq({
          direction: "inbound",
          fromNumber: "+14185550122",
          startedAt: "2026-08-09T14:00:00.000Z",
          answeredAt: "2026-08-09T14:00:05.000Z",
          endedAt: "2026-08-09T14:02:05.000Z",
        }),
      );
      expect(answered.status).toBe(201);
      const { id } = (await answered.json()) as { id: string };
      expect((await getCall(id)).durationSec).toBe(120);

      // Sortant sans réponse, terminé.
      const outbound = await POST(
        postReq({
          direction: "outbound",
          toNumber: "+14185550123",
          endedAt: "2026-08-09T14:00:30.000Z",
        }),
      );
      expect(outbound.status).toBe(201);
      // Entrant décroché en direct (complété plus tard via PATCH) — pas de endedAt.
      const open = await POST(postReq({ direction: "inbound", fromNumber: "+14185550124" }));
      expect(open.status).toBe(201);

      expect(await testDb.select().from(calls)).toHaveLength(3);
      expect(await testDb.select().from(notifications)).toHaveLength(0);
    });

    it("notifie via PATCH quand un entrant décroché-raccroché devient manqué — une seule fois", async () => {
      const me = await makeUser();
      await login(me);
      // Décroché : le webphone journalise avec answeredAt (appel « répondu »).
      const res = await POST(
        postReq({
          direction: "inbound",
          fromNumber: "+14185550166",
          startedAt: "2026-08-09T14:00:00.000Z",
          answeredAt: "2026-08-09T14:00:04.000Z",
        }),
      );
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      expect(await testDb.select().from(notifications)).toHaveLength(0);

      // L'appelant avait raccroché au même instant : finalisation SANS réponse.
      const patch = {
        answeredAt: null,
        endedAt: "2026-08-09T14:00:05.000Z",
        durationSec: 0,
      };
      expect((await PATCH(patchReq(id, patch), patchCtx(id))).status).toBe(200);

      const row = await getCall(id);
      expect(row.answeredAt).toBeNull();
      expect(row.endedAt).not.toBeNull();

      const notifs = await testDb.select().from(notifications);
      expect(notifs).toHaveLength(1);
      expect(notifs[0].type).toBe("missed_call");
      expect(notifs[0].userId).toBe(me.id);

      // Rejeu du même PATCH (réponse perdue) : pas de seconde notification.
      expect((await PATCH(patchReq(id, patch), patchCtx(id))).status).toBe(200);
      expect(await testDb.select().from(notifications)).toHaveLength(1);
    });

    it("ne notifie pas via PATCH quand la finalisation confirme un appel répondu", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall({ direction: "inbound", fromNumber: "+14185550177" });

      await PATCH(
        patchReq(id, {
          answeredAt: "2026-08-09T14:00:05.000Z",
          endedAt: "2026-08-09T14:02:05.000Z",
        }),
        patchCtx(id),
      );
      expect(await testDb.select().from(notifications)).toHaveLength(0);
    });
  });

  // ── PATCH /api/calls/[id] : finalisation ──────────────────────────────────

  describe("PATCH /api/calls/[id] — finalisation", () => {
    it("complète answeredAt/endedAt et calcule durationSec", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall({ startedAt: "2026-03-04T15:20:00.000Z" });

      const res = await PATCH(
        patchReq(id, {
          answeredAt: "2026-03-04T15:20:10.000Z",
          endedAt: "2026-03-04T15:22:30.000Z",
        }),
        patchCtx(id),
      );
      expect(res.status).toBe(200);

      const row = await getCall(id);
      expect(row.answeredAt?.toISOString()).toBe("2026-03-04T15:20:10.000Z");
      expect(row.endedAt?.toISOString()).toBe("2026-03-04T15:22:30.000Z");
      expect(row.durationSec).toBe(140);
    });

    it("respecte un durationSec explicite", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall();

      await PATCH(
        patchReq(id, {
          answeredAt: "2026-03-04T15:20:10.000Z",
          endedAt: "2026-03-04T15:22:30.000Z",
          durationSec: 12,
        }),
        patchCtx(id),
      );
      expect((await getCall(id)).durationSec).toBe(12);
    });

    it("laisse durationSec à 0 pour un appel sans réponse (endedAt seul)", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall();

      await PATCH(patchReq(id, { endedAt: "2026-03-04T15:22:30.000Z" }), patchCtx(id));
      const row = await getCall(id);
      expect(row.answeredAt).toBeNull();
      expect(row.durationSec).toBe(0);
    });

    it("interdit (404) de toucher l'appel d'un autre utilisateur", async () => {
      const owner = await makeUser({ name: "Propriétaire" });
      await login(owner);
      const id = await openCall();

      const intruder = await makeUser({ name: "Intrus", role: "admin" });
      await login(intruder);
      const res = await PATCH(patchReq(id, { disposition: "dncl" }), patchCtx(id));
      expect(res.status).toBe(404);

      const row = await getCall(id);
      expect(row.disposition).toBeNull();
    });

    it("répond 404 pour un id non-uuid et 401 sans session", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall();

      expect((await PATCH(patchReq("pas-un-uuid", {}), patchCtx("pas-un-uuid"))).status).toBe(404);

      CTX.jar.clear();
      expect((await PATCH(patchReq(id, { disposition: "booked" }), patchCtx(id))).status).toBe(401);
    });

    it("rejette (400) un corps invalide", async () => {
      const me = await makeUser();
      await login(me);
      const id = await openCall();
      const res = await PATCH(patchReq(id, { disposition: "peut_etre" }), patchCtx(id));
      expect(res.status).toBe(400);
    });
  });

  // ── Dispositions : cœur transactionnel ────────────────────────────────────

  describe("dispositions", () => {
    for (const disposition of DISPOSITION_ORDER) {
      const config = DISPOSITION_CONFIG[disposition];

      it(`« ${disposition} » applique la disposition, le dernier contact et la catégorie (${config.categoryKey ?? "inchangée"})`, async () => {
        const cats = await seedSystemCategories();
        const me = await makeUser();
        await login(me);
        const client = await makeClient({ categoryId: cats.new.id, doNotCall: false });
        const id = await openCall({ clientId: client.id });

        const before = Date.now();
        const res = await PATCH(
          patchReq(id, { disposition, note: `note ${disposition}` }),
          patchCtx(id),
        );
        expect(res.status).toBe(200);

        const call = await getCall(id);
        expect(call.disposition).toBe(disposition);
        expect(call.note).toBe(`note ${disposition}`);

        const updated = await getClient(client.id);
        expect(updated.lastDisposition).toBe(disposition);
        expect(updated.lastContactedAt).not.toBeNull();
        expect(updated.lastContactedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

        if (config.categoryKey) {
          expect(updated.categoryId).toBe(cats[config.categoryKey].id);
        } else {
          // no_answer : la catégorie du pipeline ne bouge pas.
          expect(updated.categoryId).toBe(cats.new.id);
        }

        expect(updated.doNotCall).toBe(disposition === "dncl");
      });
    }

    it("écrit une entrée d'audit call.disposition", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient();
      const id = await openCall({ clientId: client.id });

      await PATCH(patchReq(id, { disposition: "booked" }), patchCtx(id));

      const logs = await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "call.disposition"));
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(me.id);
      expect(logs[0].entityId).toBe(id);
      expect(logs[0].detail).toMatchObject({ disposition: "booked", clientId: client.id });
    });

    it("n'active jamais doNotCall en dehors de dncl", async () => {
      const cats = await seedSystemCategories();
      const me = await makeUser();
      await login(me);

      for (const disposition of DISPOSITION_ORDER.filter((d) => d !== "dncl")) {
        const client = await makeClient({ categoryId: cats.new.id });
        const id = await openCall({ clientId: client.id });
        await PATCH(patchReq(id, { disposition }), patchCtx(id));
        expect((await getClient(client.id)).doNotCall).toBe(false);
      }
    });

    it("applique une disposition sans fiche client sans planter", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const id = await openCall({ clientId: null });

      const res = await PATCH(patchReq(id, { disposition: "no_answer" }), patchCtx(id));
      expect(res.status).toBe(200);
      expect((await getCall(id)).disposition).toBe("no_answer");
    });

    it("réussit quand la catégorie système de la disposition n'existe pas (pas de 500)", async () => {
      // Aucune catégorie système : seulement une catégorie maison.
      const custom = await makeCategory({ key: null, nameFr: "Maison", nameEn: "Custom" });
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ categoryId: custom.id });
      const id = await openCall({ clientId: client.id });

      const res = await PATCH(
        patchReq(id, { disposition: "booked", note: "RDV pris" }),
        patchCtx(id),
      );
      expect(res.status).toBe(200);

      const call = await getCall(id);
      expect(call.disposition).toBe("booked");
      expect(call.note).toBe("RDV pris");

      const updated = await getClient(client.id);
      expect(updated.lastDisposition).toBe("booked");
      expect(updated.lastContactedAt).not.toBeNull();
      // Catégorie « booked » absente ⇒ la catégorie existante reste en place.
      expect(updated.categoryId).toBe(custom.id);
    });

    it("classe un appel dans un statut Notion (clé de catégorie non système)", async () => {
      const cats = await seedSystemCategories();
      const notion = await makeCategory({
        key: "recent_transaction",
        nameFr: "Transaction récente",
        nameEn: "Recent transaction",
        isSystem: false,
      });
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ categoryId: cats.new.id });
      const id = await openCall({ clientId: client.id });

      const res = await PATCH(patchReq(id, { disposition: "recent_transaction" }), patchCtx(id));
      expect(res.status).toBe(200);

      const updated = await getClient(client.id);
      expect(updated.categoryId).toBe(notion.id);
      expect(updated.lastDisposition).toBe("recent_transaction");
      expect(updated.doNotCall).toBe(false);
      expect((await getCall(id)).disposition).toBe("recent_transaction");
    });

    it("classe un appel dans une catégorie SANS clé via « cat:<id> »", async () => {
      const cats = await seedSystemCategories();
      const custom = await makeCategory({ key: null, nameFr: "Maison", nameEn: "Custom" });
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ categoryId: cats.new.id });
      const id = await openCall({ clientId: client.id });

      const res = await PATCH(patchReq(id, { disposition: `cat:${custom.id}` }), patchCtx(id));
      expect(res.status).toBe(200);

      const updated = await getClient(client.id);
      expect(updated.categoryId).toBe(custom.id);
      expect(updated.lastDisposition).toBe(`cat:${custom.id}`);
    });

    it("refuse (400) une disposition qui ne correspond à aucun statut", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient();
      const id = await openCall({ clientId: client.id });

      expect((await PATCH(patchReq(id, { disposition: "peut_etre" }), patchCtx(id))).status).toBe(
        400,
      );
      expect((await PATCH(patchReq(id, { disposition: "cat:99999" }), patchCtx(id))).status).toBe(
        400,
      );
      // Hors plage int4 : 400 propre, pas une erreur Postgres (500).
      expect(
        (await PATCH(patchReq(id, { disposition: "cat:2147483648" }), patchCtx(id))).status,
      ).toBe(400);
      // « Non contacté » après un appel terminé : refusé côté serveur aussi.
      expect((await PATCH(patchReq(id, { disposition: "new" }), patchCtx(id))).status).toBe(400);
      expect((await getCall(id)).disposition).toBeNull();
    });

    it("applique successivement deux dispositions différentes sur le même appel", async () => {
      const cats = await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ categoryId: cats.new.id });
      const id = await openCall({ clientId: client.id });

      await PATCH(patchReq(id, { disposition: "no_answer" }), patchCtx(id));
      expect((await getClient(client.id)).categoryId).toBe(cats.new.id);

      await PATCH(patchReq(id, { disposition: "booked" }), patchCtx(id));
      const updated = await getClient(client.id);
      expect(updated.categoryId).toBe(cats.booked.id);
      expect(updated.lastDisposition).toBe("booked");
      expect((await getCall(id)).disposition).toBe("booked");
    });
  });

  // ── Relances (callback) ───────────────────────────────────────────────────

  describe("relance de rappel", () => {
    it("crée la relance assignée à l'appelant et pose nextFollowupAt", async () => {
      const cats = await seedSystemCategories();
      // L'appelant est ici l'ADMINISTRATEUR : depuis que les droits sont
      // configurables, classer un appel écrit dans la fiche et exige donc la
      // case « catégorie » de SON compartiment — un téléphoniste ne l'a pas
      // sur la fiche d'un collègue (préréglage livré). Ce que le test prouve
      // reste le même : la relance échoit à qui a PROMIS de rappeler, pas au
      // titulaire de la fiche.
      const me = await makeUser({ name: "Appelant", role: "admin" });
      const owner = await makeUser({ name: "Titulaire" });
      await login(me);
      const client = await makeClient({ categoryId: cats.new.id, assignedToId: owner.id });
      const id = await openCall({ clientId: client.id });
      const dueAt = new Date("2026-09-15T18:00:00.000Z");

      const res = await PATCH(
        patchReq(id, {
          disposition: "callback",
          note: "rappeler après 17h",
          followupDueAt: dueAt.toISOString(),
        }),
        patchCtx(id),
      );
      expect(res.status).toBe(200);

      const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].assignedToId).toBe(me.id);
      expect(rows[0].createdById).toBe(me.id);
      expect(rows[0].dueAt.toISOString()).toBe(dueAt.toISOString());
      expect(rows[0].note).toBe("rappeler après 17h");
      expect(rows[0].doneAt).toBeNull();

      const updated = await getClient(client.id);
      expect(updated.nextFollowupAt?.toISOString()).toBe(dueAt.toISOString());
      expect(updated.categoryId).toBe(cats.callback.id);
    });

    it("avance nextFollowupAt quand la nouvelle relance est plus proche", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ nextFollowupAt: new Date("2026-12-01T12:00:00.000Z") });
      const id = await openCall({ clientId: client.id });

      await PATCH(
        patchReq(id, { disposition: "callback", followupDueAt: "2026-09-15T18:00:00.000Z" }),
        patchCtx(id),
      );

      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-15T18:00:00.000Z",
      );
    });

    it("ne repousse PAS nextFollowupAt quand une relance plus proche existe déjà", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const sooner = new Date("2026-08-20T13:00:00.000Z");
      const client = await makeClient({ nextFollowupAt: sooner });
      const id = await openCall({ clientId: client.id });

      await PATCH(
        patchReq(id, { disposition: "callback", followupDueAt: "2026-12-01T12:00:00.000Z" }),
        patchCtx(id),
      );

      const updated = await getClient(client.id);
      expect(updated.nextFollowupAt?.toISOString()).toBe(sooner.toISOString());
      // La relance plus lointaine est tout de même enregistrée.
      const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].dueAt.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    });

    it("ne crée pas de relance quand l'appel n'a pas de fiche client", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const id = await openCall({ clientId: null });

      const res = await PATCH(
        patchReq(id, { disposition: "callback", followupDueAt: "2026-09-15T18:00:00.000Z" }),
        patchCtx(id),
      );
      expect(res.status).toBe(200);
      expect(await testDb.select().from(followups)).toHaveLength(0);
    });
  });

  // ── Idempotence / rejeu ───────────────────────────────────────────────────

  describe("idempotence (rejeu client après réponse perdue)", () => {
    it("ne duplique pas la relance quand la même disposition est renvoyée", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient();
      const id = await openCall({ clientId: client.id });
      const body = {
        disposition: "callback",
        note: "rappel demain",
        followupDueAt: "2026-09-15T18:00:00.000Z",
      };

      const first = await PATCH(patchReq(id, body), patchCtx(id));
      const second = await PATCH(patchReq(id, body), patchCtx(id));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
      expect(rows).toHaveLength(1);
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-15T18:00:00.000Z",
      );
    });

    it("ne réapplique pas la catégorie sur un rejeu (choix manuel préservé)", async () => {
      const cats = await seedSystemCategories();
      const custom = await makeCategory({ key: null, nameFr: "Chaud", nameEn: "Hot" });
      const me = await makeUser();
      await login(me);
      const client = await makeClient({ categoryId: cats.new.id });
      const id = await openCall({ clientId: client.id });

      await PATCH(patchReq(id, { disposition: "booked" }), patchCtx(id));
      expect((await getClient(client.id)).categoryId).toBe(cats.booked.id);

      // L'admin reclasse la fiche à la main, puis le client web rejoue le PATCH.
      await testDb
        .update(clients)
        .set({ categoryId: custom.id })
        .where(eq(clients.id, client.id));

      const res = await PATCH(patchReq(id, { disposition: "booked" }), patchCtx(id));
      expect(res.status).toBe(200);
      expect((await getClient(client.id)).categoryId).toBe(custom.id);
    });

    it("laisse le rejeu mettre à jour les durées sans rejouer les effets pipeline", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient();
      const id = await openCall({ clientId: client.id });

      await PATCH(
        patchReq(id, { disposition: "voicemail", endedAt: "2026-03-04T15:22:00.000Z" }),
        patchCtx(id),
      );
      await PATCH(
        patchReq(id, {
          disposition: "voicemail",
          answeredAt: "2026-03-04T15:20:00.000Z",
          endedAt: "2026-03-04T15:22:00.000Z",
        }),
        patchCtx(id),
      );

      const call = await getCall(id);
      expect(call.durationSec).toBe(120);
      expect(call.disposition).toBe("voicemail");
      expect(await testDb.select().from(followups)).toHaveLength(0);
    });

    it("un second appel vers la même fiche crée bien une seconde relance", async () => {
      await seedSystemCategories();
      const me = await makeUser();
      await login(me);
      const client = await makeClient();

      const first = await openCall({ clientId: client.id });
      await PATCH(
        patchReq(first, { disposition: "callback", followupDueAt: "2026-09-15T18:00:00.000Z" }),
        patchCtx(first),
      );
      const second = await openCall({ clientId: client.id });
      await PATCH(
        patchReq(second, { disposition: "callback", followupDueAt: "2026-09-16T18:00:00.000Z" }),
        patchCtx(second),
      );

      const rows = await testDb
        .select()
        .from(followups)
        .where(and(eq(followups.clientId, client.id)));
      expect(rows).toHaveLength(2);
    });
  });
});
