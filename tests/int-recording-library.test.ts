/**
 * Intégration — la bibliothèque d'écoute : marquer, ranger, et ne rien laisser
 * fuir au passage.
 *
 * Ce que ces tests tiennent, dans l'ordre où ça casse en production :
 *
 *  1. Un dossier est PARTAGÉ. Y ranger un appel le rend audible à quiconque
 *     ouvre le dossier — il faut donc que le rangement soit gardé deux fois :
 *     par le droit de ranger, et par l'accès à CET appel-là.
 *  2. Un décompte doit dire la vérité du regard qui le lit. « 40 appels » au
 *     dessus d'une liste de six annonce à la ligne près ce qu'on cache.
 *  3. Une étoile n'appartient qu'à celui qui la pose. Voir celle d'un collègue
 *     transformerait un signet privé en jugement public.
 *  4. Une fiche qu'on n'a pas le droit de voir se comporte comme une fiche
 *     ABSENTE : 404, jamais 403 — un refus confirmerait son existence.
 */
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string }>(),
  headers: new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()];
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string) {
      ctx.cookies.set(name, { name, value });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const starRoute = await import("@/app/api/admin/recordings/star/route");
const collectionsRoute = await import("@/app/api/admin/recordings/collections/route");
const collectionRoute = await import("@/app/api/admin/recordings/collections/[id]/route");
const itemsRoute = await import("@/app/api/admin/recordings/collections/[id]/items/route");

const { auditLogs, calls } = await import("@/db/schema");
const { callStars, recordingCollectionItems, recordingCollections } =
  await import("@/db/schema-library");
const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session");
const { ADMIN_ROLE_ID, CALLER_ROLE_ID, OBSERVER_ROLE_ID, SUPERVISOR_ROLE_ID, defaultPermissionsConfig } =
  await import("@/lib/permissions/defaults");
const { setSetting } = await import("@/lib/settings");
const { currentActor } = await import("@/lib/permissions/server");
const library = await import("@/lib/recordings/library");
type PermissionsConfig = import("@/lib/permissions/types").PermissionsConfig;

const base = "http://localhost/api/admin/recordings";

function json(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Account = { id: string; role: "admin" | "caller"; tokenVersion: number };

async function loginAs(user: Account | null): Promise<void> {
  ctx.cookies.clear();
  if (!user) return;
  const token = await new SignJWT({
    uid: user.id,
    role: user.role,
    tv: user.tokenVersion,
    remember: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
}

async function actor() {
  const a = await currentActor();
  if (!a) throw new Error("pas de session");
  return a;
}

async function makeCall(overrides: Partial<typeof calls.$inferInsert> & { userId: string }) {
  const [row] = await testDb
    .insert(calls)
    .values({
      direction: overrides.direction ?? "outbound",
      startedAt: overrides.startedAt ?? new Date("2026-09-01T14:00:00Z"),
      answeredAt: overrides.answeredAt ?? new Date("2026-09-01T14:00:05Z"),
      durationSec: overrides.durationSec ?? 240,
      recordingUrl: overrides.recordingUrl ?? "voipms:551013_alex:4242",
      ...overrides,
    })
    .returning();
  return row;
}

const createCollection = (body: unknown) => collectionsRoute.POST(json(`${base}/collections`, "POST", body));
const patchCollection = (id: string, body: unknown) =>
  collectionRoute.PATCH(json(`${base}/collections/${id}`, "PATCH", body), {
    params: Promise.resolve({ id }),
  });
const deleteCollection = (id: string) =>
  collectionRoute.DELETE(json(`${base}/collections/${id}`, "DELETE"), {
    params: Promise.resolve({ id }),
  });
const addItem = (id: string, body: unknown) =>
  itemsRoute.POST(json(`${base}/collections/${id}/items`, "POST", body), {
    params: Promise.resolve({ id }),
  });
const removeItem = (id: string, body: unknown) =>
  itemsRoute.DELETE(json(`${base}/collections/${id}/items`, "DELETE", body), {
    params: Promise.resolve({ id }),
  });

let patron: Awaited<ReturnType<typeof makeUser>>;
let chef: Awaited<ReturnType<typeof makeUser>>;
let luc: Awaited<ReturnType<typeof makeUser>>;
let stagiaire: Awaited<ReturnType<typeof makeUser>>;

/**
 * Le téléphoniste reçoit ici le droit d'ÉCOUTER mais pas celui de ranger :
 * c'est la configuration qui sépare le lecteur du bibliothécaire, et c'est
 * elle qu'on veut voir refuser.
 */
async function writeConfig(patch?: (cfg: PermissionsConfig) => PermissionsConfig): Promise<void> {
  const base = defaultPermissionsConfig();
  const cfg: PermissionsConfig = {
    ...base,
    roles: base.roles.map((r) =>
      r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.recordings": true } } : r,
    ),
    userRoles: {
      [chef.id]: SUPERVISOR_ROLE_ID,
      [luc.id]: CALLER_ROLE_ID,
      [stagiaire.id]: OBSERVER_ROLE_ID,
    },
  };
  await setSetting("permissions", patch ? patch(cfg) : cfg);
}

beforeEach(async () => {
  await resetDb();
  patron = await makeUser({ name: "Alex-Honoré", role: "admin" });
  chef = await makeUser({ name: "Chef", role: "caller" });
  luc = await makeUser({ name: "Luc", role: "caller" });
  stagiaire = await makeUser({ name: "Stagiaire", role: "caller" });
  await writeConfig();
  await loginAs(chef);
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("l'étoile", () => {
  it("se pose, se retire, et se repose sans se dédoubler", async () => {
    const call = await makeCall({ userId: chef.id });

    expect((await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }))).status).toBe(200);
    expect((await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }))).status).toBe(200);

    const rows = await testDb.select().from(callStars).where(eq(callStars.callId, call.id));
    expect(rows).toHaveLength(1);

    expect((await starRoute.DELETE(json(`${base}/star`, "DELETE", { callId: call.id }))).status).toBe(200);
    expect(await testDb.select().from(callStars)).toHaveLength(0);
  });

  it("n'appartient qu'à celui qui la pose", async () => {
    const call = await makeCall({ userId: chef.id });
    await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));

    await loginAs(luc);
    const marks = await library.markersFor(await actor(), [call.id]);
    expect(marks.get(call.id)?.starred).toBe(false);

    await loginAs(chef);
    const mine = await library.markersFor(await actor(), [call.id]);
    expect(mine.get(call.id)?.starred).toBe(true);
  });

  it("est refusée à qui n'a pas le droit d'écouter", async () => {
    const call = await makeCall({ userId: chef.id });
    await loginAs(stagiaire);
    const res = await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("sur une fiche invisible : INTROUVABLE, pas « interdit »", async () => {
    // Une fiche tenue par le patron est invisible au téléphoniste (bucket
    // `role:admin` = INVISIBLE dans la configuration livrée).
    const fiche = await makeClient({ fullName: "Client du patron", assignedToId: patron.id });
    const call = await makeCall({ userId: patron.id, clientId: fiche.id });

    await loginAs(luc);
    const res = await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await testDb.select().from(callStars)).toHaveLength(0);
  });

  it("sur un appel inexistant : 404, pas 500", async () => {
    const res = await starRoute.POST(
      json(`${base}/star`, "POST", { callId: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });

  it("laisse une trace nominative", async () => {
    const call = await makeCall({ userId: chef.id });
    await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));
    await starRoute.DELETE(json(`${base}/star`, "DELETE", { callId: call.id }));
    const logs = await testDb.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(["recording.star", "recording.unstar"]);
    expect(logs.every((l) => l.userId === chef.id)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("les recueils", () => {
  it("se créent, se renomment et se suppriment", async () => {
    const created = await createCollection({ kind: "folder", name: "Objections — le prix" });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as { collection: { id: string } };

    expect((await patchCollection(collection.id, { name: "Objections prix" })).status).toBe(200);
    const [row] = await testDb
      .select()
      .from(recordingCollections)
      .where(eq(recordingCollections.id, collection.id));
    expect(row.name).toBe("Objections prix");

    expect((await deleteCollection(collection.id)).status).toBe(200);
    expect(await testDb.select().from(recordingCollections)).toHaveLength(0);
  });

  it("refuse deux noms identiques à la casse et aux espaces près", async () => {
    await createCollection({ kind: "folder", name: "Objections prix" });
    const dup = await createCollection({ kind: "folder", name: "  objections   prix" });
    // Seuls la casse et les espaces de BORD sont normalisés : « objections
    // prix » avec trois espaces au milieu reste un autre nom.
    expect(dup.status).toBe(201);

    const same = await createCollection({ kind: "folder", name: "  OBJECTIONS PRIX  " });
    expect(same.status).toBe(409);
    expect(await same.json()).toEqual({ error: "name_taken" });
  });

  it("laisse un dossier et une étiquette porter le même nom", async () => {
    expect((await createCollection({ kind: "folder", name: "Bon ton" })).status).toBe(201);
    expect((await createCollection({ kind: "tag", name: "Bon ton" })).status).toBe(201);
  });

  it("sont LISIBLES par qui peut écouter, MODIFIABLES par qui peut ranger", async () => {
    await createCollection({ kind: "folder", name: "Formation" });

    await loginAs(luc);
    const list = await collectionsRoute.GET();
    expect(list.status).toBe(200);
    expect(((await list.json()) as { collections: unknown[] }).collections).toHaveLength(1);

    const refused = await createCollection({ kind: "folder", name: "Le mien" });
    expect(refused.status).toBe(403);
  });

  it("restent fermés à qui ne peut pas écouter", async () => {
    await loginAs(stagiaire);
    expect((await collectionsRoute.GET()).status).toBe(403);
  });

  it("ne changent jamais de genre", async () => {
    const created = await createCollection({ kind: "folder", name: "Formation" });
    const { collection } = (await created.json()) as { collection: { id: string } };
    const res = await patchCollection(collection.id, { kind: "tag" });
    // `.strict()` : un champ inconnu est un refus, pas un silence.
    expect(res.status).toBe(422);
  });

  it("inconnu : 404, pas 500", async () => {
    expect((await patchCollection("00000000-0000-4000-8000-000000000000", { name: "x" })).status).toBe(404);
    expect((await deleteCollection("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("ranger un appel", () => {
  it("écrit le motif, et le corrige sans doubler la ligne", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };

    expect((await addItem(collection.id, { callId: call.id, note: "Bon rebond" })).status).toBe(201);
    expect((await addItem(collection.id, { callId: call.id, note: "Bon rebond, 4e minute" })).status).toBe(201);

    const items = await testDb.select().from(recordingCollectionItems);
    expect(items).toHaveLength(1);
    expect(items[0].note).toBe("Bon rebond, 4e minute");
    expect(items[0].addedById).toBe(chef.id);
  });

  it("garde un motif par recueil", async () => {
    const call = await makeCall({ userId: chef.id });
    const a = (await (await createCollection({ kind: "folder", name: "Bons rebonds" })).json()) as {
      collection: { id: string };
    };
    const b = (await (await createCollection({ kind: "folder", name: "À revoir" })).json()) as {
      collection: { id: string };
    };
    await addItem(a.collection.id, { callId: call.id, note: "Le rebond" });
    await addItem(b.collection.id, { callId: call.id, note: "Le silence de 12 s" });

    const notes = (await testDb.select().from(recordingCollectionItems)).map((i) => i.note).sort();
    expect(notes).toEqual(["Le rebond", "Le silence de 12 s"]);
  });

  it("refuse un appel que le classeur n'a pas le droit d'entendre", async () => {
    const fiche = await makeClient({ fullName: "Client du patron", assignedToId: patron.id });
    const call = await makeCall({ userId: patron.id, clientId: fiche.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };

    // Le chef voit tout ; on donne le droit de ranger à Luc, qui ne voit pas
    // les fiches du patron — le droit ne doit pas suffire.
    await writeConfig((cfg) => ({
      ...cfg,
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID
          ? { ...r, perms: { ...r.perms, "clients.recordingsCurate": true } }
          : r,
      ),
    }));
    await loginAs(luc);

    const res = await addItem(collection.id, { callId: call.id, note: "tenté" });
    expect(res.status).toBe(404);
    expect(await testDb.select().from(recordingCollectionItems)).toHaveLength(0);
  });

  it("se retire, et retirer deux fois répond 404", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id });

    expect((await removeItem(collection.id, { callId: call.id })).status).toBe(200);
    expect((await removeItem(collection.id, { callId: call.id })).status).toBe(404);
  });

  it("supprimer le recueil efface le classement, jamais les appels", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id });

    const res = await deleteCollection(collection.id);
    expect(await res.json()).toEqual({ ok: true, filed: 1 });
    expect(await testDb.select().from(recordingCollectionItems)).toHaveLength(0);
    expect(await testDb.select().from(calls)).toHaveLength(1);
  });

  it("supprimer l'appel emporte son étoile et son classement", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id });
    await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));

    await testDb.delete(calls).where(eq(calls.id, call.id));
    expect(await testDb.select().from(recordingCollectionItems)).toHaveLength(0);
    expect(await testDb.select().from(callStars)).toHaveLength(0);
    expect(await testDb.select().from(recordingCollections)).toHaveLength(1);
  });

  it("laisse une trace, sans y recopier le motif", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id, note: "Jugement sur le travail de Luc" });

    const logs = await testDb.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toContain("recording_collection.add");
    expect(JSON.stringify(logs)).not.toContain("Jugement sur le travail de Luc");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("les décomptes disent la vérité du regard qui les lit", () => {
  it("un dossier ne compte que les appels atteignables", async () => {
    const cache = await makeClient({ fullName: "Fiche du patron", assignedToId: patron.id });
    const libre = await makeClient({ fullName: "Fiche du bassin", assignedToId: null });
    const cachéCall = await makeCall({ userId: patron.id, clientId: cache.id });
    const libreCall = await makeCall({ userId: patron.id, clientId: libre.id });
    const sansFiche = await makeCall({ userId: patron.id, clientId: null });

    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    for (const id of [cachéCall.id, libreCall.id, sansFiche.id]) {
      await addItem(collection.id, { callId: id });
    }

    // Le chef voit tout : trois.
    const chefCollections = await library.loadCollections(await actor());
    expect(chefCollections[0].count).toBe(3);

    await loginAs(luc);
    const lucActor = await actor();
    const lucCollections = await library.loadCollections(lucActor);
    const { rows, total } = await library.loadLibraryPage(
      lucActor,
      { kind: "collection", id: collection.id },
      1,
    );

    // Luc ne voit pas la fiche du patron : deux. Et le décompte du rayonnage
    // est le MÊME nombre que les lignes servies — c'est tout l'enjeu.
    expect(lucCollections[0].count).toBe(2);
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([libreCall.id, sansFiche.id].sort());
  });

  it("« Mes marqués » ne compte que les siens, et que ce qu'on peut atteindre", async () => {
    const cache = await makeClient({ fullName: "Fiche du patron", assignedToId: patron.id });
    const cachéCall = await makeCall({ userId: patron.id, clientId: cache.id });
    const libreCall = await makeCall({ userId: chef.id, clientId: null });

    // Le chef marque les deux.
    for (const id of [cachéCall.id, libreCall.id]) {
      await starRoute.POST(json(`${base}/star`, "POST", { callId: id }));
    }
    expect(await library.starredCount(await actor())).toBe(2);

    // Luc n'a rien marqué : zéro, même si les appels existent.
    await loginAs(luc);
    expect(await library.starredCount(await actor())).toBe(0);

    // Et s'il marque le sien, il voit un — jamais ceux du chef.
    await starRoute.POST(json(`${base}/star`, "POST", { callId: libreCall.id }));
    const lucActor = await actor();
    expect(await library.starredCount(lucActor)).toBe(1);
    const { rows, total } = await library.loadLibraryPage(lucActor, { kind: "starred" }, 1);
    expect(total).toBe(1);
    expect(rows[0].id).toBe(libreCall.id);
  });

  it("le motif du classement voyage avec la ligne", async () => {
    const call = await makeCall({ userId: chef.id });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id, note: "Bon rebond, 4e minute" });

    const { rows } = await library.loadLibraryPage(
      await actor(),
      { kind: "collection", id: collection.id },
      1,
    );
    expect(rows[0].filingNote).toBe("Bon rebond, 4e minute");

    // Hors d'un recueil, il n'y a pas de motif : un appel marqué n'est rangé
    // nulle part.
    await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));
    const starred = await library.loadLibraryPage(await actor(), { kind: "starred" }, 1);
    expect(starred.rows[0].filingNote).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la garde d'un appel, vue de la bibliothèque", () => {
  it("un appel sans fiche reste atteignable — il ne protège personne", async () => {
    const call = await makeCall({ userId: patron.id, clientId: null });
    await loginAs(luc);
    expect(await library.reachableCall(await actor(), call.id)).not.toBeNull();
  });

  it("une fiche visible mais à l'historique fermé reste introuvable", async () => {
    const fiche = await makeClient({ fullName: "Fiche du chef", assignedToId: chef.id });
    const call = await makeCall({ userId: chef.id, clientId: fiche.id });

    // Un rôle SUR MESURE, et pas un rôle livré : pour un rôle livré, une case
    // absente de la configuration enregistrée reprend ce que le rôle livré en
    // dit (`repairConfig`, « une case ajoutée au catalogue après coup »), et
    // « Historique » se rouvrirait toute seule. Sur mesure, une case fermée
    // reste fermée — c'est là qu'on peut vérifier la garde.
    const LECTEUR = "role-lecteur";
    await writeConfig((cfg) => ({
      ...cfg,
      roles: [
        ...cfg.roles,
        {
          id: LECTEUR,
          nameFr: "Lecteur",
          nameEn: "Reader",
          builtin: false,
          superAdmin: false,
          look: "observer",
          perms: { "clients.recordings": true },
          relations: {
            own: { visible: true, history: true },
            unassigned: { visible: true, history: true },
            [`role:${SUPERVISOR_ROLE_ID}`]: { visible: true },
          },
          assignment: {
            claimPool: false,
            release: false,
            assignToOthers: false,
            takeFromOthers: false,
            maxOwned: 0,
          },
          sortOrder: 9,
        },
      ],
      userRoles: { ...cfg.userRoles, [stagiaire.id]: LECTEUR },
    }));
    await loginAs(stagiaire);

    // La fiche EST visible pour lui — c'est bien l'historique, et lui seul,
    // qui referme l'appel.
    const { grantsOnClient, clientRef } = await import("@/lib/permissions/server");
    const ref = await clientRef(fiche.id);
    expect((await grantsOnClient(await actor(), ref!)).visible).toBe(true);
    expect(await library.reachableCall(await actor(), call.id)).toBeNull();
  });

  it("l'administrateur atteint tout", async () => {
    const fiche = await makeClient({ fullName: "Fiche de Luc", assignedToId: luc.id });
    const call = await makeCall({ userId: luc.id, clientId: fiche.id });
    await loginAs(patron);
    expect(await library.reachableCall(await actor(), call.id)).not.toBeNull();
    expect(ADMIN_ROLE_ID).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("corps de requête", () => {
  it("un identifiant qui n'est pas un uuid est refusé avant la base", async () => {
    const res = await starRoute.POST(json(`${base}/star`, "POST", { callId: "pas-un-uuid" }));
    expect(res.status).toBe(422);
  });

  it("un JSON illisible ne devient pas un 500", async () => {
    const bad = new Request(`${base}/star`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await starRoute.POST(bad)).status).toBe(400);
  });

  it("un nom vide est refusé", async () => {
    expect((await createCollection({ kind: "folder", name: "   " })).status).toBe(422);
  });

  it("sans session : 401", async () => {
    await loginAs(null);
    expect((await collectionsRoute.GET()).status).toBe(401);
    const res = await starRoute.POST(json(`${base}/star`, "POST", { callId: crypto.randomUUID() }));
    expect(res.status).toBe(401);
  });
});

// Le rangement d'un appel ne touche jamais la ligne d'appel elle-même.
describe("l'appel lui-même", () => {
  it("ne bouge pas d'un champ quand on le range", async () => {
    const call = await makeCall({ userId: chef.id, note: "note d'après-appel" });
    const { collection } = (await (
      await createCollection({ kind: "folder", name: "Formation" })
    ).json()) as { collection: { id: string } };
    await addItem(collection.id, { callId: call.id, note: "motif" });
    await starRoute.POST(json(`${base}/star`, "POST", { callId: call.id }));

    const [after] = await testDb.select().from(calls).where(eq(calls.id, call.id));
    expect(after.note).toBe("note d'après-appel");
    expect(after.disposition).toBe(call.disposition);
    expect(after.recordingUrl).toBe(call.recordingUrl);
    expect(
      await testDb
        .select()
        .from(recordingCollectionItems)
        .where(
          and(
            eq(recordingCollectionItems.collectionId, collection.id),
            eq(recordingCollectionItems.callId, call.id),
          ),
        ),
    ).toHaveLength(1);
  });
});
