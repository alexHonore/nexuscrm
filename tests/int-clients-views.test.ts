/**
 * Intégration — filtres/tris avancés de GET /api/clients/list et changement de
 * source (unitaire + en masse) réservé à l'admin.
 *
 * Vrais handlers + vrai garde RBAC (JWT nexus_session) : un téléphoniste doit
 * être refusé PAR LE SERVEUR, pas seulement privé du menu.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeSource,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { auditLogs, clients } from "@/db/schema";

// ── Stubs de contexte Next + réseau externe ─────────────────────────────────

const CTX = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  hdrs: new Headers(),
}));

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
vi.mock("@/lib/google", () => ({
  cancelEvent: vi.fn(async () => {}),
  GoogleNotConnectedError: class GoogleNotConnectedError extends Error {},
}));

const actions = await import("@/app/(app)/clients/actions");
const { GET: listGET } = await import("@/app/api/clients/list/route");
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

async function listItems(query: string) {
  const res = await listGET(
    new NextRequest(new URL(`http://localhost/api/clients/list?${query}`)),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{
      id: string;
      fullName: string;
      city: string | null;
      sourceId: number | null;
      assignedToId: string | null;
      nextFollowupAt: string | null;
      lastContactedAt: string | null;
      doNotCall: boolean;
    }>;
    total: number;
  };
}

async function names(query: string) {
  return (await listItems(query)).items.map((i) => i.fullName);
}

// Connexion partagée entre les deux blocs : on ne la ferme qu'une fois.
afterAll(closeDb);
beforeEach(async () => {
  await resetDb();
  CTX.jar.clear();
});

describe("filtres et tris avancés de /api/clients/list", () => {
  it("q trouve aussi la ville", async () => {
    const admin = await makeUser({ role: "admin" });
    await makeClient({ fullName: "Alice", city: "Trois-Rivières" });
    await makeClient({ fullName: "Bruno", city: "Québec" });
    await login(admin);

    expect(await names("q=rivi")).toEqual(["Alice"]);
  });

  it("categoryId / sourceId / assignedToId acceptent « none »", async () => {
    const admin = await makeUser({ role: "admin" });
    const caller = await makeUser({ role: "caller" });
    const cat = await makeCategory();
    const src = await makeSource();
    await makeClient({
      fullName: "Classée",
      categoryId: cat.id,
      sourceId: src.id,
      assignedToId: caller.id,
    });
    await makeClient({ fullName: "Vierge" });
    await login(admin);

    expect(await names("categoryId=none")).toEqual(["Vierge"]);
    expect(await names("sourceId=none")).toEqual(["Vierge"]);
    expect(await names("assignedToId=none")).toEqual(["Vierge"]);
    expect(await names(`categoryId=${cat.id}`)).toEqual(["Classée"]);
    expect(await names(`sourceId=${src.id}`)).toEqual(["Classée"]);
  });

  it("états de suivi : overdue, upcoming, none, never, dnc", async () => {
    const admin = await makeUser({ role: "admin" });
    const past = new Date(Date.now() - 24 * 3600_000);
    const future = new Date(Date.now() + 48 * 3600_000);
    await makeClient({ fullName: "Retard", nextFollowupAt: past, lastContactedAt: past });
    await makeClient({ fullName: "Bientôt", nextFollowupAt: future, lastContactedAt: past });
    await makeClient({ fullName: "SansSuivi", lastContactedAt: past });
    await makeClient({ fullName: "JamaisAppelé" });
    await makeClient({ fullName: "ListeRouge", doNotCall: true, lastContactedAt: past });
    await login(admin);

    expect(await names("filter=overdue")).toEqual(["Retard"]);
    expect(await names("filter=upcoming")).toEqual(["Bientôt"]);
    expect(new Set(await names("filter=none"))).toEqual(
      new Set(["SansSuivi", "JamaisAppelé", "ListeRouge"]),
    );
    expect(await names("filter=never")).toEqual(["JamaisAppelé"]);
    expect(await names("filter=dnc")).toEqual(["ListeRouge"]);
    // Valeur inconnue : ignorée sans erreur.
    expect((await listItems("filter=drop")).total).toBe(5);
  });

  it("filtre par langue du client", async () => {
    const admin = await makeUser({ role: "admin" });
    await makeClient({ fullName: "Franco", language: "fr" });
    await makeClient({ fullName: "Anglo", language: "en" });
    await login(admin);

    expect(await names("language=en")).toEqual(["Anglo"]);
    expect(await names("language=fr")).toEqual(["Franco"]);
    expect((await listItems("language=es")).total).toBe(2);
  });

  it("multi-sélection : plusieurs catégories, « none » mélangé aux ids", async () => {
    const admin = await makeUser({ role: "admin" });
    const catA = await makeCategory({ nameFr: "A" });
    const catB = await makeCategory({ nameFr: "B" });
    await makeClient({ fullName: "DansA", categoryId: catA.id });
    await makeClient({ fullName: "DansB", categoryId: catB.id });
    await makeClient({ fullName: "SansCat" });
    await login(admin);

    expect(new Set(await names(`categoryId=${catA.id},${catB.id}`))).toEqual(
      new Set(["DansA", "DansB"]),
    );
    expect(new Set(await names(`categoryId=${catA.id},none`))).toEqual(
      new Set(["DansA", "SansCat"]),
    );
    // Jetons invalides ignorés sans erreur, valeur unique toujours acceptée.
    expect(new Set(await names(`categoryId=abc,${catA.id},`))).toEqual(new Set(["DansA"]));
    expect(await names(`categoryId=${catB.id}`)).toEqual(["DansB"]);
  });

  it("multi-sélection : sources, assignations et langues", async () => {
    const admin = await makeUser({ role: "admin" });
    const caller1 = await makeUser({ role: "caller" });
    const caller2 = await makeUser({ role: "caller" });
    const srcA = await makeSource({ name: "Facebook" });
    const srcB = await makeSource({ name: "Kijiji" });
    await makeClient({ fullName: "FbFr", sourceId: srcA.id, assignedToId: caller1.id, language: "fr" });
    await makeClient({ fullName: "KjEn", sourceId: srcB.id, assignedToId: caller2.id, language: "en" });
    await makeClient({ fullName: "Vierge", language: "en" });
    await login(admin);

    expect(new Set(await names(`sourceId=${srcA.id},${srcB.id}`))).toEqual(
      new Set(["FbFr", "KjEn"]),
    );
    expect(new Set(await names(`sourceId=${srcB.id},none`))).toEqual(
      new Set(["KjEn", "Vierge"]),
    );
    expect(new Set(await names(`assignedToId=${caller1.id},${caller2.id}`))).toEqual(
      new Set(["FbFr", "KjEn"]),
    );
    expect(new Set(await names(`assignedToId=${caller1.id},none`))).toEqual(
      new Set(["FbFr", "Vierge"]),
    );
    // Les deux langues cochées = tout le monde.
    expect((await listItems("language=fr,en")).total).toBe(3);
  });

  it("multi-sélection : états de suivi cumulés en OU, ET entre paramètres", async () => {
    const admin = await makeUser({ role: "admin" });
    const cat = await makeCategory();
    const past = new Date(Date.now() - 24 * 3600_000);
    const future = new Date(Date.now() + 48 * 3600_000);
    await makeClient({ fullName: "Retard", nextFollowupAt: past, categoryId: cat.id });
    await makeClient({ fullName: "Bientôt", nextFollowupAt: future });
    await makeClient({ fullName: "ListeRouge", doNotCall: true });
    await login(admin);

    expect(new Set(await names("filter=overdue,upcoming"))).toEqual(
      new Set(["Retard", "Bientôt"]),
    );
    expect(new Set(await names("filter=overdue,dnc"))).toEqual(
      new Set(["Retard", "ListeRouge"]),
    );
    // ET entre paramètres : états de suivi × catégorie.
    expect(await names(`filter=overdue,upcoming&categoryId=${cat.id}`)).toEqual(["Retard"]);
  });

  it("tri followupAt / lastContact / city : NULLS LAST dans les deux sens", async () => {
    const admin = await makeUser({ role: "admin" });
    const t1 = new Date("2026-01-05T12:00:00Z");
    const t2 = new Date("2026-02-05T12:00:00Z");
    await makeClient({
      fullName: "Proche",
      city: "Alma",
      nextFollowupAt: t1,
      lastContactedAt: t2,
    });
    await makeClient({
      fullName: "Loin",
      city: "Chicoutimi",
      nextFollowupAt: t2,
      lastContactedAt: t1,
    });
    await makeClient({ fullName: "Vide" });
    await login(admin);

    expect(await names("sort=followupAt&dir=asc")).toEqual(["Proche", "Loin", "Vide"]);
    expect(await names("sort=followupAt&dir=desc")).toEqual(["Loin", "Proche", "Vide"]);
    expect(await names("sort=lastContact&dir=desc")).toEqual(["Proche", "Loin", "Vide"]);
    expect(await names("sort=city&dir=asc")).toEqual(["Proche", "Loin", "Vide"]);

    const items = (await listItems("sort=followupAt&dir=asc")).items;
    expect(items[0].nextFollowupAt).toBe(t1.toISOString());
    expect(items[0].lastContactedAt).toBe(t2.toISOString());
  });

  it("filtres de dates : createdFrom/To et updatedFrom/To en jour civil de Toronto", async () => {
    const admin = await makeUser({ role: "admin" });
    // 03:59 UTC le 5 janvier = 22:59 le 4 janvier à Toronto (UTC-5) — la borne
    // createdFrom=2026-01-05 doit donc l'EXCLURE (jour civil de Toronto).
    await makeClient({
      fullName: "VeilleTard",
      createdAt: new Date("2026-01-05T03:59:00Z"),
      updatedAt: new Date("2026-01-10T12:00:00Z"),
    });
    await makeClient({
      fullName: "LeCinq",
      createdAt: new Date("2026-01-05T15:00:00Z"),
      updatedAt: new Date("2026-02-01T12:00:00Z"),
    });
    await makeClient({
      fullName: "EnFévrier",
      createdAt: new Date("2026-02-10T15:00:00Z"),
      updatedAt: new Date("2026-02-20T12:00:00Z"),
    });
    await login(admin);

    expect(new Set(await names("createdFrom=2026-01-05"))).toEqual(
      new Set(["LeCinq", "EnFévrier"]),
    );
    expect(await names("createdFrom=2026-01-05&createdTo=2026-01-31")).toEqual(["LeCinq"]);
    expect(await names("createdTo=2026-01-04")).toEqual(["VeilleTard"]);
    expect(new Set(await names("updatedFrom=2026-02-01"))).toEqual(
      new Set(["LeCinq", "EnFévrier"]),
    );
    expect(await names("updatedFrom=2026-02-01&updatedTo=2026-02-15")).toEqual(["LeCinq"]);
    // ET entre paramètres : création × modification.
    expect(await names("createdFrom=2026-01-01&updatedTo=2026-01-31")).toEqual(["VeilleTard"]);
    // Valeur invalide : filtre ignoré sans erreur.
    expect((await listItems("createdFrom=pas-une-date")).total).toBe(3);
    // Date impossible au calendrier (bonne forme, Invalid Date) : ignorée
    // aussi — elle ferait autrement planter la sérialisation Postgres (500).
    expect((await listItems("createdFrom=2026-02-30")).total).toBe(3);
    expect((await listItems("updatedTo=2026-13-01")).total).toBe(3);
  });

  it("fenêtres nommées : createdWithin / updatedWithin résolues à la requête", async () => {
    // Horloge épinglée (Date seulement) : « un jour = 24 h » devient exact et
    // le test ne peut plus basculer autour de minuit ni des changements
    // d'heure de Toronto — la route lit la même Date factice que la fixture.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-08T19:00:00Z") });
    try {
      const admin = await makeUser({ role: "admin" });
      const now = new Date();
      const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600_000);
      await makeClient({ fullName: "Maintenant", createdAt: now, updatedAt: now });
      await makeClient({ fullName: "HierMême", createdAt: daysAgo(1), updatedAt: daysAgo(1) });
      await makeClient({ fullName: "IlYa8Jours", createdAt: daysAgo(8), updatedAt: daysAgo(8) });
      await makeClient({
        fullName: "IlYa40Jours",
        createdAt: daysAgo(40),
        updatedAt: daysAgo(40),
      });
      await login(admin);

      expect(await names("createdWithin=today")).toEqual(["Maintenant"]);
      expect(await names("createdWithin=yesterday")).toEqual(["HierMême"]);
      // « Cette semaine » contient toujours aujourd'hui, jamais il y a 8 jours
      // (et hier peut en faire partie ou non selon le jour — non testé).
      const week = await names("createdWithin=week");
      expect(week).toContain("Maintenant");
      expect(week).not.toContain("IlYa8Jours");
      const month = await names("updatedWithin=month");
      expect(month).toContain("Maintenant");
      expect(month).not.toContain("IlYa40Jours");
      // Jeton inconnu : ignoré sans erreur.
      expect((await listItems("createdWithin=lastyear")).total).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bornes strictes : createdBefore / createdAfter excluent le jour choisi", async () => {
    const admin = await makeUser({ role: "admin" });
    await makeClient({ fullName: "Avant", createdAt: new Date("2026-01-04T15:00:00Z") });
    await makeClient({ fullName: "LeJour", createdAt: new Date("2026-01-05T15:00:00Z") });
    // 03:59 UTC le 6 janvier = 22:59 le 5 janvier à Toronto : encore « le jour ».
    await makeClient({ fullName: "FinDuJour", createdAt: new Date("2026-01-06T03:59:00Z") });
    await makeClient({ fullName: "Après", createdAt: new Date("2026-01-06T15:00:00Z") });
    await login(admin);

    expect(await names("createdBefore=2026-01-05")).toEqual(["Avant"]);
    expect(await names("createdAfter=2026-01-05")).toEqual(["Après"]);
    // Date impossible : ignorée.
    expect((await listItems("createdBefore=2026-02-30")).total).toBe(4);
    expect((await listItems("updatedAfter=2026-02-30")).total).toBe(4);
  });

  it("page et ids hors plage ne font pas planter la requête (200, pas 500)", async () => {
    // Un OFFSET de 5e21 sort en « 5e+21 » du pilote (bigint invalide) et un id
    // à 11 chiffres déborde l'int4 : Postgres refusait et la route répondait
    // 500. On borne la page et on ignore les ids impossibles, comme les autres
    // jetons inconnus.
    const admin = await makeUser({ role: "admin" });
    const cat = await makeCategory();
    const src = await makeSource();
    await makeClient({ fullName: "Classée", categoryId: cat.id, sourceId: src.id });
    await makeClient({ fullName: "Vierge" });
    await login(admin);

    const far = await listItems("page=100000000000000000000");
    expect(far.items).toEqual([]);
    expect(far.total).toBe(2);

    // Jetons impossibles ignorés ; le jeton valide à côté s'applique toujours.
    expect((await listItems("categoryId=99999999999")).total).toBe(2);
    expect((await listItems("sourceId=99999999999,2147483648")).total).toBe(2);
    expect(await names(`categoryId=99999999999,${cat.id}`)).toEqual(["Classée"]);
    expect(await names(`sourceId=0,${src.id}`)).toEqual(["Classée"]);
  });
});

describe("changement de source", () => {
  async function sourceAuditRows() {
    return testDb
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "client.update"), eq(auditLogs.entity, "client")));
  }

  describe("setClientSourceAction", () => {
    it("suit le droit de MODIFIER la fiche, comme n'importe quel champ", async () => {
      // La source était « admin seulement » par ce seul raccourci : le
      // formulaire de la fiche, lui, l'écrivait déjà pour tout le monde
      // (`sourceId` était dans le patch de `updateClientAction`). Garder la
      // porte fermée pendant que la fenêtre est ouverte ne protégeait rien.
      // Elle suit donc `clients.edit` et le compartiment de la fiche.
      const caller = await makeUser({ role: "caller" });
      const collegue = await makeUser({ role: "caller" });
      const src = await makeSource();
      const sienne = await makeClient({ assignedToId: caller.id });
      const celleDuCollegue = await makeClient({ assignedToId: collegue.id });
      await login(caller);

      expect(await actions.setClientSourceAction(sienne.id, src.id)).toEqual({
        ok: true,
        id: sienne.id,
      });

      // Celle d'un collègue : visible, pas modifiable — et le refus ne
      // distingue pas « interdit » de « inexistant ».
      expect((await actions.setClientSourceAction(celleDuCollegue.id, src.id)).ok).toBe(false);
      const [intacte] = await testDb
        .select()
        .from(clients)
        .where(eq(clients.id, celleDuCollegue.id));
      expect(intacte.sourceId).toBeNull();
    });

    it("change la source, journalise le avant → après, puis remet à null", async () => {
      const admin = await makeUser({ role: "admin" });
      const src = await makeSource({ name: "Facebook Ads" });
      const c = await makeClient();
      await login(admin);

      expect(await actions.setClientSourceAction(c.id, src.id)).toEqual({ ok: true, id: c.id });
      let [row] = await testDb.select().from(clients).where(eq(clients.id, c.id));
      expect(row.sourceId).toBe(src.id);

      const audits = await sourceAuditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0].userId).toBe(admin.id);
      expect(audits[0].detail).toMatchObject({
        from: null,
        to: src.id,
        changes: { sourceId: { from: null, to: src.id } },
      });

      expect(await actions.setClientSourceAction(c.id, null)).toEqual({ ok: true, id: c.id });
      [row] = await testDb.select().from(clients).where(eq(clients.id, c.id));
      expect(row.sourceId).toBeNull();
    });

    it("valide les entrées : source inconnue, client inconnu, id non-UUID", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeClient();
      await login(admin);

      expect(await actions.setClientSourceAction(c.id, 99_999)).toEqual({
        ok: false,
        error: "notFound",
      });
      expect(
        await actions.setClientSourceAction("00000000-0000-4000-8000-000000000000", null),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await actions.setClientSourceAction("pas-un-uuid", null)).toEqual({
        ok: false,
        error: "invalid",
      });
    });
  });

  describe("bulkSetClientsSourceAction", () => {
    it("refuse un téléphoniste", async () => {
      const caller = await makeUser({ role: "caller" });
      const c = await makeClient();
      await login(caller);
      expect(await actions.bulkSetClientsSourceAction([c.id], null)).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    it("change la source en masse, audit par fiche, ignore les fiches déjà à jour", async () => {
      const admin = await makeUser({ role: "admin" });
      const src = await makeSource({ name: "Site web" });
      const a = await makeClient();
      const b = await makeClient();
      const untouched = await makeClient({ sourceId: src.id });
      await login(admin);

      expect(await actions.bulkSetClientsSourceAction([a.id, b.id, untouched.id], src.id)).toEqual(
        { ok: true, count: 2 },
      );
      const rows = await testDb
        .select()
        .from(clients)
        .where(inArray(clients.id, [a.id, b.id, untouched.id]));
      expect(rows.every((r) => r.sourceId === src.id)).toBe(true);

      const audits = await sourceAuditRows();
      expect(audits).toHaveLength(2);
      expect(new Set(audits.map((x) => x.entityId))).toEqual(new Set([a.id, b.id]));
      for (const entry of audits) {
        expect(entry.detail).toMatchObject({ bulk: true, to: src.id });
      }

      expect(await actions.bulkSetClientsSourceAction([a.id], 99_999)).toEqual({
        ok: false,
        error: "notFound",
      });
    });
  });
});
