/**
 * Intégration — la RECHERCHE de clients (`GET /api/clients/list?q=…`).
 *
 * Ce que ce fichier protège, dans l'ordre de gravité :
 * 1. la recherche n'est jamais un ORACLE : une fiche invisible, un numéro ou
 *    un courriel masqués, un commentaire qu'on n'a pas le droit de lire ne
 *    font rien remonter, ne changent ni le total, ni les facettes, ni l'ordre ;
 * 2. le mode `identity` (défaut, dialogue « ajouter des clients » d'une
 *    campagne) garde exactement la portée d'avant : nom, ville, téléphone,
 *    courriel ;
 * 3. le classement, la pagination stable et la parité score SQL = TS.
 *
 * Vrais handlers, vraie base, vraie matrice de droits. Les cases à FERMER le
 * sont sur des rôles SUR MESURE : `repairConfig` rouvre une case fermée d'un
 * rôle livré quand le rôle livré l'ouvre (bogue connu, hors de ce chantier).
 */
import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeCategory, makeClient, makeConversation, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { calls, comments, followups } from "@/db/schema";
import { campaignEnrollments, campaigns, messages } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string }>(),
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
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { GET: listGET } = await import("@/app/api/clients/list/route");
const { NextRequest } = await import("next/server");
const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session");
const { CALLER_ROLE_ID, OBSERVER_ROLE_ID, SUPERVISOR_ROLE_ID, defaultPermissionsConfig } = await import(
  "@/lib/permissions/defaults"
);
const { setSetting } = await import("@/lib/settings");
const { currentActor } = await import("@/lib/permissions/server");
const { searchClients } = await import("@/lib/clients-search-server/search");
const { scoreFeatures } = await import("@/lib/clients-search/score");
const { foldSearch } = await import("@/lib/clients-search/fold");

import type { ClientMatch, SearchMeta } from "@/lib/clients-search/types";
import type { Grants } from "@/lib/permissions/catalog";
import type { PermissionsConfig, Role } from "@/lib/permissions/types";

// ── Session, réglage ────────────────────────────────────────────────────────

type Account = { id: string; role: "admin" | "caller"; tokenVersion: number };

async function loginAs(user: Account | null): Promise<void> {
  ctx.cookies.clear();
  if (!user) return;
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
}

async function writeConfig(patch: (cfg: PermissionsConfig) => PermissionsConfig): Promise<void> {
  await setSetting("permissions", patch(defaultPermissionsConfig()));
}

const READ_ALL: Array<keyof Grants> = ["visible", "contact", "history"];
function grants(...open: Array<keyof Grants>): Partial<Grants> {
  return Object.fromEntries(open.map((k) => [k, true]));
}

/**
 * Un rôle SUR MESURE : chaque compartiment écrit en clair (ceux qu'on ne
 * donne pas sont fermés), et ses droits.
 */
function customRole(
  id: string,
  perms: string[],
  relations: { own?: Array<keyof Grants>; unassigned?: Array<keyof Grants>; others?: Array<keyof Grants> },
): Role {
  const others = grants(...(relations.others ?? []));
  return {
    id,
    nameFr: `Rôle ${id}`,
    nameEn: `Role ${id}`,
    builtin: false,
    superAdmin: false,
    look: "caller",
    perms: Object.fromEntries(perms.map((p) => [p, true])),
    relations: {
      own: grants(...(relations.own ?? READ_ALL)),
      unassigned: grants(...(relations.unassigned ?? [])),
      "role:admin": {},
      "role:supervisor": others,
      "role:caller": others,
      "role:observer": others,
      [`role:${id}`]: others,
    },
    assignment: { claimPool: false, release: false, assignToOthers: false, takeFromOthers: false, maxOwned: 0 },
    sortOrder: 10,
  };
}

async function useCustomRole(user: Account, role: Role): Promise<void> {
  await writeConfig((cfg) => ({
    ...cfg,
    roles: [...cfg.roles, role],
    userRoles: {
      [luc.id]: CALLER_ROLE_ID,
      [marie.id]: CALLER_ROLE_ID,
      [chef.id]: SUPERVISOR_ROLE_ID,
      [stagiaire.id]: OBSERVER_ROLE_ID,
      [user.id]: role.id,
    },
  }));
}

// ── Appels de la route ──────────────────────────────────────────────────────

type Item = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  contactHidden: boolean;
  city: string | null;
  categoryColor: string | null;
  createdAt: string;
  updatedAt: string;
  match?: ClientMatch;
};
type Body = { items: Item[]; total: number; page: number; pageSize: number; search?: SearchMeta };

async function list(params: Record<string, string> = {}): Promise<Body> {
  const url = new URL("http://localhost/api/clients/list");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await listGET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

/** Comme le panneau et la palette : `match=all`, `sort=relevance`. */
function search(q: string, extra: Record<string, string> = {}): Promise<Body> {
  return list({ q, match: "all", sort: "relevance", ...extra });
}

const ids = (b: Body) => b.items.map((i) => i.id);

// ── Fabriques d'historique ──────────────────────────────────────────────────

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function addComment(clientId: string, userId: string, body: string, createdAt = new Date()) {
  const [row] = await testDb.insert(comments).values({ clientId, userId, body, createdAt }).returning();
  return row;
}
async function addCall(clientId: string, userId: string, note: string, startedAt = new Date()) {
  const [row] = await testDb
    .insert(calls)
    .values({ clientId, userId, note, startedAt, direction: "outbound" })
    .returning();
  return row;
}
async function addFollowup(clientId: string, assignedToId: string, note: string) {
  const [row] = await testDb
    .insert(followups)
    .values({ clientId, assignedToId, note, dueAt: new Date(Date.now() + DAY) })
    .returning();
  return row;
}
let smsNumberId: string | null = null;
async function addSms(clientId: string, direction: "in" | "out", source: string, body: string) {
  if (!smsNumberId) smsNumberId = (await makeSmsNumber()).id;
  const conv = await makeConversation({ clientId, smsNumberId });
  const [row] = await testDb
    .insert(messages)
    .values({ conversationId: conv.id, direction, source, body })
    .returning();
  return row;
}

// ── Monde de base ───────────────────────────────────────────────────────────

let patron: Awaited<ReturnType<typeof makeUser>>;
let luc: Awaited<ReturnType<typeof makeUser>>;
let marie: Awaited<ReturnType<typeof makeUser>>;
let chef: Awaited<ReturnType<typeof makeUser>>;
let stagiaire: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDb();
  smsNumberId = null;
  patron = await makeUser({ name: "Alex-Honoré", role: "admin" });
  luc = await makeUser({ name: "Luc", role: "caller" });
  marie = await makeUser({ name: "Marie", role: "caller" });
  chef = await makeUser({ name: "Chef", role: "caller" });
  stagiaire = await makeUser({ name: "Stagiaire", role: "caller" });
  await writeConfig((cfg) => ({
    ...cfg,
    userRoles: {
      [luc.id]: CALLER_ROLE_ID,
      [marie.id]: CALLER_ROLE_ID,
      [chef.id]: SUPERVISOR_ROLE_ID,
      [stagiaire.id]: OBSERVER_ROLE_ID,
    },
  }));
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("1 — bases", () => {
  it("401 sans session", async () => {
    await loginAs(null);
    const res = await listGET(new NextRequest(new URL("http://localhost/api/clients/list?q=tremblay")));
    expect(res.status).toBe(401);
  });

  it("le mode par défaut (identity) reproduit les recherches d'avant — pour les termes de 3 caractères et plus", async () => {
    await loginAs(luc);
    const emilie = await makeClient({ fullName: "Émilie Gagnon", email: "emilie@example.com", phone: "+14184761542" });
    const marc = await makeClient({
      fullName: "Marc Tremblay",
      email: "marc@test.qc",
      phone: "+15145550123",
      phoneAlt: "+14389990000",
    });

    expect(ids(await list({ q: "tremblay" }))).toEqual([marc.id]);
    expect(ids(await list({ q: "MARC" }))).toEqual([marc.id]);
    expect(ids(await list({ q: "emilie@example" }))).toEqual([emilie.id]);
    for (const q of ["(418) 476-1542", "418.476.1542", "+1 418 476 1542", "4761542"]) {
      expect(ids(await list({ q }))).toEqual([emilie.id]);
    }
    expect(ids(await list({ q: "438-999-0000" }))).toEqual([marc.id]);
    const one = await list({ q: "tremblay" });
    expect(one.total).toBe(1);
    expect(one.search?.match).toBe("identity");
    expect(one.search?.facets).toBeNull();
    expect((await list({ q: "zzzz" })).items).toHaveLength(0);
    // Bonus d'aujourd'hui : l'accent ne compte plus.
    expect(ids(await list({ q: "emilie" }))).toEqual([emilie.id]);
  });

  // Changement VOULU (§2.4, §2.2 étape 8), écrit ici pour qui se demandera
  // pourquoi « Tout sélectionner » du dialogue de campagne rend moins de
  // fiches sur une lettre ou deux : l'ancien `ilike '%tr%'` lisait l'intérieur
  // des mots et les courriels, et `%`, `_`, `@`, `-` y valaient « tout ».
  it("identity, termes de 1–2 caractères : début d'un mot du nom ou de la ville seulement ; `%` `_` `@` `-` seuls ne trouvent rien", async () => {
    await loginAs(patron);
    const marc = await makeClient({ fullName: "Marc Tremblay", email: "marc@test.qc", city: "Lévis" });
    // « tr » dans le nom (Lestrade), « jm » et « ex » dans le courriel : lus
    // par l'ancienne recherche, plus par celle-ci.
    const infix = await makeClient({ fullName: "Patricia Lestrade", email: "jm.obrien@exemple.com", city: "Montréal" });
    const pct = await makeClient({ fullName: "Condo 50% Inc", email: "a_b@x-y.ca" });

    expect(ids(await list({ q: "Tr" }))).toEqual([marc.id]);
    // « Lévis » (ville, accent plié) et « Lestrade » (début de mot).
    expect(new Set(ids(await list({ q: "le" })))).toEqual(new Set([marc.id, infix.id]));
    expect(ids(await list({ q: "pa" }))).toEqual([infix.id]);
    expect(ids(await list({ q: "mo" }))).toEqual([infix.id]); // Montréal
    for (const q of ["jm", "ex", "ca", "qc", "ob"]) {
      expect((await list({ q })).total, q).toBe(0);
    }
    for (const q of ["%", "_", "@", "-", "%%", "a_"]) {
      expect((await list({ q })).total, q).toBe(0);
    }
    // Le même mot, en entier, reste trouvé (3 caractères et plus).
    expect(ids(await list({ q: "lestrade" }))).toEqual([infix.id]);
    expect(ids(await list({ q: "jm.obrien@exemple" }))).toEqual([infix.id]);
    expect(ids(await list({ q: "condo" }))).toEqual([pct.id]);
  });

  it("un numéro ou un courriel COLLÉ avec sa ponctuation trouve sa fiche, dans les deux modes", async () => {
    await loginAs(patron);
    const line = await makeClient({ fullName: "Line Martel", phone: "+14185428728", email: "line.martel52@gmail.com" });
    await makeClient({ fullName: "Autre Personne", phone: "+15145550000" });

    for (const q of [
      "418-542-8728,",
      "4185428728,",
      "(418) 542-8728;",
      "+1 418 542 8728,",
      "418-542-8728:",
      "martel 418-542-8728,",
      "<line.martel52@gmail.com>",
      "Line Martel <line.martel52@gmail.com>",
    ]) {
      expect(ids(await search(q)), q).toEqual([line.id]);
      expect(ids(await list({ q })), `${q} (identity)`).toEqual([line.id]);
    }
  });

  it("un octet NUL dans q ne fait pas tomber la route (Postgres refuse 0x00)", async () => {
    await loginAs(patron);
    const fiche = await makeClient({ fullName: "Abc Def" });
    for (const q of ["\u0000", "abc\u0000def", "abc\u0000"]) {
      await search(q); // `list` exige un 200
      await list({ q });
    }
    expect(ids(await search("abc\u0000def"))).toEqual([fiche.id]);
    expect((await search("\u0000")).total).toBe(0);
  });

  it("une requête façon « ajouter des clients » (identity) ignore commentaires et notes", async () => {
    await loginAs(patron);
    const campaign = await makeCampaign("Relance");
    const byName = await makeClient({ fullName: "Piscine Côté" });
    const byNotes = await makeClient({ fullName: "Hélène Roy", notes: "veut une piscine" });
    const byComment = await makeClient({ fullName: "Paul Roy" });
    await addComment(byComment.id, patron.id, "Parle d'une piscine creusée");

    const dialog = await list({ q: "piscine", filter: "never", excludeCampaignId: campaign.id, pageSize: "25" });
    expect(ids(dialog)).toEqual([byName.id]);
    expect(dialog.total).toBe(1);

    const panel = await search("piscine");
    expect(new Set(ids(panel))).toEqual(new Set([byName.id, byNotes.id, byComment.id]));
  });
});

async function makeCampaign(name: string) {
  const [row] = await testDb
    .insert(campaigns)
    .values({
      name,
      status: "active",
      trigger: { kind: "manual" },
      audience: {},
      ladder: [{ delayHours: 0, body: "Bonjour", stopOnReply: true }],
      variants: [],
    })
    .returning();
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("2 — tri", () => {
  it("sort=relevance sans q = activité ; sort=name avec q = nom ; q sans tri = activité", async () => {
    await loginAs(patron);
    const old = await makeClient({ fullName: "Zoé Bouchard", city: null, updatedAt: new Date("2026-01-01T00:00:00Z") });
    const mid = await makeClient({ fullName: "Anne Bouchard", city: "Québec", updatedAt: new Date("2026-02-01T00:00:00Z") });
    const recent = await makeClient({
      fullName: "Marc Bouchard",
      city: "Lévis",
      updatedAt: new Date("2026-01-15T00:00:00Z"),
      lastContactedAt: new Date("2026-03-01T00:00:00Z"),
    });

    expect(ids(await list({ sort: "relevance" }))).toEqual([recent.id, mid.id, old.id]);
    // `dir` absent = desc (règle de la route, inchangée).
    expect(ids(await list({ q: "bouchard", sort: "name", dir: "asc" }))).toEqual([mid.id, recent.id, old.id]);
    expect(ids(await list({ q: "bouchard", sort: "name" }))).toEqual([old.id, recent.id, mid.id]);
    expect(ids(await list({ q: "bouchard", sort: "name", dir: "desc" }))).toEqual([old.id, recent.id, mid.id]);
    // Colonne nullable : NULLS LAST dans les deux sens.
    expect(ids(await list({ q: "bouchard", sort: "city", dir: "asc" }))).toEqual([recent.id, mid.id, old.id]);
    expect(ids(await list({ q: "bouchard", sort: "city", dir: "desc" }))).toEqual([mid.id, recent.id, old.id]);
    expect(ids(await list({ q: "bouchard" }))).toEqual([recent.id, mid.id, old.id]);
    expect(ids(await search("bouchard", { sort: "" }))).toEqual([recent.id, mid.id, old.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("3 — plis d'accents et caractères littéraux", () => {
  it("chaque cas de la matrice trouve sa fiche", async () => {
    await loginAs(patron);
    const helene = await makeClient({ fullName: "Hélène Côté" });
    const coeur = await makeClient({ fullName: "Marie Cœur" });
    const coeur2 = await makeClient({ fullName: "Jean Coeurdelion" });
    const ile = await makeClient({ fullName: "Paul Tanguay", city: "L’Île-Perrot" });
    const trois = await makeClient({ fullName: "Alice Roy", city: "Trois-Rivières" });
    const foy = await makeClient({ fullName: "Sylvie Morin", city: "Sainte-Foy" });
    const christine = await makeClient({ fullName: "Christine Lord" });
    const marcAndre = await makeClient({ fullName: "Marc-André Dion" });
    const marcel = await makeClient({ fullName: "Marcel Dion" });

    const expectHit = async (q: string, id: string) => {
      const b = await search(q);
      expect(ids(b), q).toContain(id);
    };
    for (const q of ["Hélène", "HELENE", "helene"]) await expectHit(q, helene.id);
    for (const q of ["Côté", "cote"]) await expectHit(q, helene.id);
    for (const q of ["cœur", "coeur"]) {
      await expectHit(q, coeur.id);
      await expectHit(q, coeur2.id);
    }
    for (const q of ["L’Île-Perrot", "l'ile", "l ile"]) await expectHit(q, ile.id);
    for (const q of ["Trois-Rivières", "trois rivieres", "rivi"]) await expectHit(q, trois.id);
    for (const q of ["Sainte-Foy", "st-foy", "ste foy", "saintefoy"]) await expectHit(q, foy.id);
    expect(ids(await search("st"))).not.toContain(christine.id);

    const marc = await search("marc");
    expect(ids(marc)).toEqual(expect.arrayContaining([marcAndre.id, marcel.id]));
    const reasonOf = (id: string) => marc.items.find((i) => i.id === id)!.match!.reasons[0];
    expect(reasonOf(marcAndre.id)).toMatchObject({ field: "name", level: "whole" });
    expect(reasonOf(marcel.id)).toMatchObject({ field: "name", level: "prefix" });
    // Mot entier devant début de mot.
    expect(ids(marc).indexOf(marcAndre.id)).toBeLessThan(ids(marc).indexOf(marcel.id));
  });

  it("%, _ et « 50% » restent littéraux", async () => {
    await loginAs(patron);
    const pct = await makeClient({ fullName: "Denis Roy", notes: "Mise de fonds : 50% comptant" });
    await makeClient({ fullName: "Denise Roy", notes: "Mise de fonds : 500 comptant" });
    await makeClient({ fullName: "Denis Roux", notes: "50 comptant" });
    await makeClient({ fullName: "Under_Score" });

    expect(ids(await search("50%"))).toEqual([pct.id]);
    expect((await search("%")).total).toBe(0);
    expect((await list({ q: "%" })).total).toBe(0);
    expect((await list({ q: "_" })).total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("4 — logique", () => {
  it("ET entre champs, opérateurs, dans:notes et facettes exactes, exclusion", async () => {
    await loginAs(patron);
    const levis = await makeClient({ fullName: "Marc Tremblay", city: "Lévis", phone: "+15145550001" });
    const quebec = await makeClient({ fullName: "Julie Tremblay", city: "Québec", phone: "+14185550002" });
    const piscine = await makeClient({ fullName: "Luc Tremblay", notes: "Veut une piscine" });
    const autre = await makeClient({ fullName: "Anne Gagnon", city: "Lévis" });

    expect(ids(await search("tremblay lévis"))).toEqual([levis.id]);
    expect(ids(await search("tremblay piscine"))).toEqual([piscine.id]);
    expect(ids(await search("marc 514"))).toEqual([levis.id]);

    // Opérateurs : ville:, nom:, note:.
    expect(new Set(ids(await search("ville:lévis")))).toEqual(new Set([levis.id, autre.id]));
    expect(ids(await search("nom:gagnon"))).toEqual([autre.id]);
    expect(ids(await search("note:piscine"))).toEqual([piscine.id]);
    expect((await search("ville:piscine")).total).toBe(0);

    // Facettes : lues AVANT la portée ; la portée filtre.
    const tremblay = await search("tremblay");
    expect(tremblay.search?.facets).toEqual({ all: 3, contact: 3, profile: 0, notes: 0 });
    const levisAll = await search("lévis");
    expect(levisAll.search?.facets).toEqual({ all: 2, contact: 0, profile: 2, notes: 0 });
    const inNotes = await search("dans:notes piscine");
    expect(ids(inNotes)).toEqual([piscine.id]);
    expect(inNotes.search?.scope).toBe("notes");
    expect(inNotes.search?.facets).toEqual({ all: 1, contact: 0, profile: 0, notes: 1 });
    const tremblayInNotes = await search("dans:notes tremblay");
    expect(tremblayInNotes.total).toBe(0);
    expect(tremblayInNotes.search?.facets).toEqual({ all: 3, contact: 3, profile: 0, notes: 0 });

    // Exclusion.
    const condoA = await makeClient({ fullName: "Condo Rosemont" });
    const condoB = await makeClient({ fullName: "Condo Verdun" });
    expect(ids(await search("condo -rosemont"))).toEqual([condoB.id]);
    expect(ids(await search("condo"))).toEqual(expect.arrayContaining([condoA.id, condoB.id]));
    // Seulement des exclusions : aucune requête, drapeau posé.
    const only = await search("-rosemont");
    expect(only.total).toBe(0);
    expect(only.search?.onlyExclusions).toBe(true);
    void quebec;
  });

  it("une exclusion trouvée dans un AUTRE commentaire écarte quand même la fiche", async () => {
    await loginAs(patron);
    const a = await makeClient({ fullName: "Paul Condo" });
    const b = await makeClient({ fullName: "Pierre Condo" });
    await addComment(a.id, patron.id, "Il habite Rosemont");
    await addComment(b.id, patron.id, "Il habite Verdun");
    expect(ids(await search("condo -rosemont"))).toEqual([b.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("5 — commentaires normalisés", () => {
  it("l'uuid d'une mention ne se cherche pas, son nom oui ; l'en-tête IA non plus ; origines", async () => {
    await loginAs(patron);
    const fiche = await makeClient({ fullName: "Robert Pelletier" });
    await addComment(fiche.id, patron.id, "Voir avec @[Josée](0000cafe-0000-4000-8000-00000000beef) demain");
    const ai = await makeClient({ fullName: "Carole Fortin" });
    await addComment(
      ai.id,
      patron.id,
      "🤖 Notes d'appel (IA) — appel sortant du 3 septembre 2026, 14 h 05 (4 min 12 s)\n\nLa cliente veut une verrière.",
    );
    const booked = await makeClient({ fullName: "Denis Paquette" });
    await addComment(
      booked.id,
      patron.id,
      "Rendez-vous fixé — 3 octobre 2026, 10 h\n\nProjet : Acheter\nNotes : cherche un jumelé",
    );

    expect((await search("cafe")).total).toBe(0);
    expect((await search("beef")).total).toBe(0);
    const josee = await search("josee");
    expect(ids(josee)).toEqual([fiche.id]);
    const snip = josee.items[0].match!.snippet!;
    expect(snip.text).toContain("@Josée");
    expect(snip.text).not.toMatch(/cafe|[0-9a-f]{8}-/);

    expect((await search("sortant")).total).toBe(0);
    expect((await search("septembre")).total).toBe(0);
    const verriere = await search("verriere");
    expect(ids(verriere)).toEqual([ai.id]);
    expect(verriere.items[0].match!.snippet).toMatchObject({ field: "comment", origin: "ai" });
    expect(verriere.items[0].match!.snippet!.text.startsWith("🤖")).toBe(false);

    const jumele = await search("jumelé");
    expect(ids(jumele)).toEqual([booked.id]);
    expect(jumele.items[0].match!.snippet).toMatchObject({ field: "comment", origin: "booking" });
  });

  // Le nettoyage ne tourne plus que sur les lignes qui peuvent trouver (texte
  // brut qui contient un motif, ou mention). Ce qui ne se voit QU'APRÈS
  // nettoyage (une expression à cheval sur la fin d'une mention) doit rester
  // trouvé ; ce que le nettoyage retire (en-tête, uuid) ne doit toujours rien
  // trouver — pour l'administrateur (tout, sans détour) comme pour un
  // téléphoniste (fiches visibles d'abord).
  it("mêmes résultats sur les deux chemins : tout voir, ou les fiches visibles d'abord", async () => {
    const mention = await makeClient({ fullName: "Robert Pelletier" });
    await addComment(mention.id, marie.id, "Voir avec @[Josée Roy](0000cafe-0000-4000-8000-00000000beef) demain matin");
    const both = await makeClient({ fullName: "Carole Fortin" });
    await addComment(
      both.id,
      marie.id,
      "🤖 Notes d'appel (IA) — appel sortant du 3 septembre 2026\n\nLa cliente veut une verrière, voir @[Luc](11111111-2222-4333-8444-555555555555) lundi.",
    );
    const plain = await makeClient({ fullName: "Denis Paquette" });
    await addComment(plain.id, marie.id, "Il veut une verrière et un spa");
    // Hors de vue du téléphoniste : même texte, fiche du patron.
    const hidden = await makeClient({ fullName: "Prospect Zeta", assignedToId: patron.id });
    await addComment(hidden.id, patron.id, "Voir avec @[Josée Roy](0000cafe-0000-4000-8000-00000000beef) demain matin, verrière");

    const expectations: Array<[string, string[], string[]]> = [
      // [requête, trouvées par le patron, trouvées par luc]
      ["josee", [mention.id, hidden.id], [mention.id]],
      ['"roy demain"', [mention.id, hidden.id], [mention.id]],
      ['"josée roy demain matin"', [mention.id, hidden.id], [mention.id]],
      ["verriere", [both.id, plain.id, hidden.id], [both.id, plain.id]],
      ["verriere luc", [both.id], [both.id]],
      ['"luc lundi"', [both.id], [both.id]],
      ["verriere -luc", [plain.id, hidden.id], [plain.id]],
      ["cafe", [], []],
      ["beef", [], []],
      ["555555555555", [], []],
      ["sortant", [], []],
      ["septembre", [], []],
    ];
    for (const [who, account] of [["patron", patron], ["luc", luc]] as const) {
      await loginAs(account);
      for (const [q, forPatron, forLuc] of expectations) {
        const b = await search(q);
        const want = who === "patron" ? forPatron : forLuc;
        expect(new Set(ids(b)), `${who} ${q}`).toEqual(new Set(want));
        expect(b.total, `${who} ${q}`).toBe(want.length);
      }
      // L'extrait montre la mention lisible, jamais son uuid.
      const snip = (await search('"roy demain"')).items.find((i) => i.id === mention.id)!.match!.snippet!;
      expect(snip.text).toContain("@Josée Roy demain");
      expect(snip.text).not.toMatch(/cafe|beef/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("6 — termes courts", () => {
  it("un terme de 2 lettres ne lit ni commentaires ni notes ; shortOnly", async () => {
    await loginAs(patron);
    const fiche = await makeClient({ fullName: "Paul Morin", notes: "ok bo" });
    await addComment(fiche.id, patron.id, "bo");
    const named = await makeClient({ fullName: "Bo Diddley" });

    const bo = await search("bo");
    expect(ids(bo)).toEqual([named.id]);
    expect(bo.search?.shortOnly).toBe(true);
    const mixed = await search("paul bo");
    expect(mixed.total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("7 — classement et pagination", () => {
  it("nom exact > début du nom > infixe du nom > ville > commentaire seul", async () => {
    await loginAs(patron);
    const base = new Date("2026-01-01T00:00:00Z");
    const comment = await makeClient({ fullName: "Luc Bérubé", updatedAt: new Date(base.getTime() + 5 * DAY) });
    await addComment(comment.id, patron.id, "Rappeler M. Gagnon demain");
    const city = await makeClient({ fullName: "Luc Côté", city: "Gagnon", updatedAt: new Date(base.getTime() + 4 * DAY) });
    const infix = await makeClient({ fullName: "Paul Bergagnon", updatedAt: new Date(base.getTime() + 3 * DAY) });
    const prefix = await makeClient({ fullName: "Gagnonne Sylvie", updatedAt: new Date(base.getTime() + 2 * DAY) });
    const exact = await makeClient({ fullName: "Gagnon", updatedAt: base });

    const b = await search("gagnon");
    expect(ids(b)).toEqual([exact.id, prefix.id, infix.id, city.id, comment.id]);
    const scores = b.items.map((i) => i.match!.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(b.items[4].match!.reasons.map((r) => r.field)).toEqual(["comment"]);
  });

  it("une adresse tapée : la fiche qui Y HABITE passe première ; 412 ne trouve pas 6412", async () => {
    await loginAs(patron);
    // Le nom de rue le plus courant du Québec est aussi le nom de famille le plus
    // courant. Téléphones toujours explicites : celui du gabarit, aléatoire,
    // pourrait contenir 412.
    const resident = await makeClient({ fullName: "Zacharie Nadeau", address: "412 rue Tremblay", phone: "+15819998877" });
    const phoneInfix = await makeClient({ fullName: "Éric Tremblay", phone: "+18198084127", address: "88 rue Saint-Jean" });
    const phoneInfix2 = await makeClient({ fullName: "Louise Tremblay", phone: "+15814126831" });
    const longerNumber = await makeClient({ fullName: "Réjean Tremblay", address: "6412 rue Bédard", phone: "+14185550199" });
    const streetAndPhone = await makeClient({ fullName: "Luc Poirier", phone: "+14184125555", address: "88 rue Tremblay" });
    const streetAndPhone2 = await makeClient({ fullName: "Éric Thibault", phone: "+15144120000", address: "15 rue Tremblay" });
    // Plus durs que le jeu de la revue : un Tremblay qui habite AU 412 (d'une
    // autre rue), et un Tremblay dont l'INDICATIF est 412.
    const sameNumber = await makeClient({ fullName: "Marc Tremblay", address: "412 rue Laurier", phone: "+14185550288" });
    const areaCode = await makeClient({ fullName: "Paul Tremblay", phone: "+14125550000", address: "9 rue Racine" });

    for (const q of ["412 rue tremblay", "412 tremblay", "412, rue Tremblay"]) {
      const b = await search(q);
      expect(ids(b)[0], q).toBe(resident.id);
      expect(b.items[0].match!.reasons.map((r) => r.field), q).toEqual(["address"]);
      expect(b.items[0].match!.snippet, q).toMatchObject({ field: "address", text: "412 rue Tremblay" });
      const scores = b.items.map((i) => i.match!.score);
      expect([...scores].sort((x, y) => y - x), q).toEqual(scores);
      // 6412 n'est pas 412 ; « contient 412 quelque part dans le numéro » ne suffit
      // plus à côté d'autres mots (1 numéro sur 125).
      for (const other of [longerNumber, phoneInfix, phoneInfix2, streetAndPhone, streetAndPhone2]) {
        expect(ids(b), `${q} / ${other.fullName}`).not.toContain(other.id);
      }
      expect(ids(b), q).toEqual(expect.arrayContaining([sameNumber.id, areaCode.id]));
    }

    // Seul, 412 reste une recherche de numéro : l'infixe du téléphone compte.
    const alone = await search("412");
    expect(ids(alone)).toEqual(
      expect.arrayContaining([phoneInfix.id, phoneInfix2.id, streetAndPhone.id, streetAndPhone2.id, areaCode.id]),
    );
    expect(ids(alone)).toEqual(expect.arrayContaining([resident.id, sameNumber.id]));
    expect(ids(alone)).not.toContain(longerNumber.id);

    // Un nom et la FIN de son numéro battent le « 5551 rue Tremblay ».
    const ending = await makeClient({ fullName: "Gilles Tremblay", phone: "+14185555551" });
    const street = await makeClient({ fullName: "Nadia Roy", address: "5551 rue Tremblay", phone: "+14185550377" });
    expect(ids(await search("tremblay 5551"))).toEqual([ending.id, street.id]);

    // Et la parité SQL = TS tient avec le nouveau bonus.
    const actor = (await currentActor())!;
    for (const q of ["412 rue tremblay", "412 tremblay", "tremblay 5551", "412", "marc 412"]) {
      const out = await searchClients(actor, {
        q,
        filters: undefined,
        mode: "all",
        sort: "relevance",
        dir: "desc",
        page: 1,
        pageSize: 50,
      });
      for (const h of out.hits) {
        expect(h.item.match.score, `${q} / ${h.item.fullName}`).toBe(scoreFeatures(h.features, out.now).total);
      }
    }
  });

  it("7 fiches à égalité : pages de 2 jusqu'au bout, sans doublon, ordre stable ; page hors plage", async () => {
    await loginAs(patron);
    const at = new Date("2026-02-02T00:00:00Z");
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await makeClient({ fullName: "Dupuis", updatedAt: at }));

    const walk = async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const b = await search("dupuis", { page: String(page), pageSize: "2" });
        expect(b.total).toBe(7);
        seen.push(...ids(b));
      }
      return seen;
    };
    const first = await walk();
    expect(first).toHaveLength(7);
    expect(new Set(first).size).toBe(7);
    expect(first).toEqual([...made.map((m) => m.id)].sort());
    expect(await walk()).toEqual(first);

    const out = await search("dupuis", { page: "99", pageSize: "2" });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(7);
    expect(out.page).toBe(99);

    const palette = await search("dupuis", { pageSize: "8" });
    const panel = await search("dupuis");
    expect(palette.total).toBe(panel.total);
    expect(new Set(ids(panel))).toEqual(new Set(first));
    expect(palette.search?.facets).toEqual(panel.search?.facets);
  });

  it("score SQL = scoreFeatures pour chaque ligne", async () => {
    await loginAs(patron);
    const a = await makeClient({ fullName: "Marc Tremblay", city: "Lévis", notes: "piscine et garage" });
    await addComment(a.id, patron.id, "tremblay veut une piscine", ago(3));
    const b = await makeClient({ fullName: "Julie Gagnon", city: "Québec" });
    await addComment(b.id, patron.id, "piscine creusée, garage double", ago(40));
    await addComment(b.id, patron.id, "encore la piscine", ago(2));
    await addComment(b.id, patron.id, "piscine!", ago(1));
    await addCall(b.id, patron.id, "Parlé du garage", ago(200));
    const c = await makeClient({ fullName: "Piscine Tremblay Garage" });
    await addFollowup(c.id, patron.id, "garage à voir");

    const actor = (await currentActor())!;
    for (const q of ["piscine", "piscine garage", "tremblay piscine", "garage", "tremblay", "trembly"]) {
      const out = await searchClients(actor, {
        q,
        filters: undefined,
        mode: "all",
        sort: "relevance",
        dir: "desc",
        page: 1,
        pageSize: 50,
      });
      expect(out.hits.length, q).toBeGreaterThan(0);
      for (const h of out.hits) {
        expect(h.item.match.score, `${q} / ${h.item.fullName}`).toBe(scoreFeatures(h.features, out.now).total);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("8 — une fiche du patron, vue par un téléphoniste", () => {
  it("ni nom, ni commentaire, ni chiffres : rien, total 0, facettes 0 ; le total ne compte que le visible", async () => {
    const hidden = await makeClient({ fullName: "Prospect Zeta", phone: "+14185559876", assignedToId: patron.id });
    await addComment(hidden.id, patron.id, "zorglub au sous-sol");
    await loginAs(luc);

    for (const q of ["zeta", "zorglub", "5559876", "4185559876"]) {
      const b = await search(q);
      expect(b.items, q).toEqual([]);
      expect(b.total, q).toBe(0);
      expect(b.search?.facets, q).toEqual({ all: 0, contact: 0, profile: 0, notes: 0 });
    }

    const visible = await makeClient({ fullName: "Zeta Visible" });
    const b = await search("zeta");
    expect(ids(b)).toEqual([visible.id]);
    expect(b.total).toBe(1);
    expect(b.search?.facets?.all).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("9 — la fiche d'une collègue, vue par un téléphoniste", () => {
  it("trouvée par son nom seulement, sans coordonnées ni extrait ; jamais par son historique ni ses coordonnées", async () => {
    const fiche = await makeClient({
      fullName: "Colette Marchand",
      phone: "+14185551111",
      email: "colette@exemple.com",
      assignedToId: marie.id,
    });
    await addComment(fiche.id, marie.id, "Elle veut une piscine");
    await addCall(fiche.id, marie.id, "Parlé du cabanon");
    await addFollowup(fiche.id, marie.id, "Rappeler pour le garage");
    await addSms(fiche.id, "in", "human", "J'aime la terrasse");
    await loginAs(luc);

    const byName = await search("marchand");
    expect(ids(byName)).toEqual([fiche.id]);
    const item = byName.items[0];
    expect(item.phone).toBeNull();
    expect(item.email).toBeNull();
    expect(item.contactHidden).toBe(true);
    expect(item.match!.reasons.map((r) => r.field)).toEqual(["name"]);
    expect(item.match!.snippet).toBeNull();
    expect(item.match!.href).toBe(`/clients/${fiche.id}`);

    for (const q of ["piscine", "cabanon", "garage", "terrasse", "5551111", "4185551111", "colette@exemple.com", "colette@"]) {
      const b = await search(q);
      expect(b.total, q).toBe(0);
    }
    // Même en mode identity (dialogue de campagne).
    expect((await list({ q: "5551111" })).total).toBe(0);
    expect((await list({ q: "colette@exemple.com" })).total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("10 — jumelles", () => {
  it("deux fiches identiques à l'écran, dont une a un commentaire caché : toujours ensemble", async () => {
    const at = new Date("2026-03-03T00:00:00Z");
    const one = await makeClient({ fullName: "Jumeau Twin", city: "Laval", phone: "+14185550100", assignedToId: marie.id, updatedAt: at });
    const two = await makeClient({ fullName: "Jumeau Twin", city: "Laval", phone: "+14185550100", assignedToId: marie.id, updatedAt: at });
    await addComment(two.id, marie.id, "zorglub");
    await loginAs(luc);
    const sorted = [one.id, two.id].sort();

    for (const q of ["twin", "twin zorglub", "twin -zorglub", "note:zorglub", "dans:notes twin"]) {
      const b = await search(q);
      const got = ids(b);
      if (got.length === 0) continue;
      expect(got, q).toEqual(sorted);
      const [x, y] = b.items;
      expect(x.match!.score, q).toBe(y.match!.score);
      expect(x.match!.reasons, q).toEqual(y.match!.reasons);
      expect(x.match!.snippet, q).toEqual(y.match!.snippet);
    }
    expect((await search("twin")).total).toBe(2);
    expect((await search("twin -zorglub")).total).toBe(2);
    expect((await search("twin zorglub")).total).toBe(0);
    expect((await search("note:zorglub")).total).toBe(0);
    expect((await search("dans:notes twin")).total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("11 — le classement ne fuit pas", () => {
  it("un commentaire caché ne fait pas passer la fiche d'une collègue devant", async () => {
    const a = await makeClient({ fullName: "Jean Laval", assignedToId: marie.id, updatedAt: new Date("2026-01-01T00:00:00Z") });
    // Lu, ce commentaire donnerait à A le bonus « même trace » sur « jean
    // laval » (+20) et le ferait passer devant B, plus récent.
    await addComment(a.id, marie.id, "Jean Laval : laval laval", ago(1));
    await addComment(a.id, marie.id, "laval", ago(2));
    const b = await makeClient({ fullName: "Jean Laval", assignedToId: luc.id, updatedAt: new Date("2026-02-01T00:00:00Z") });
    await loginAs(luc);
    const r = await search("laval");
    expect(ids(r)).toEqual([b.id, a.id]);
    expect(r.items[0].match!.score).toBe(r.items[1].match!.score);
    // Deux termes : le commentaire caché ne compte ni pour trouver ni pour classer.
    expect(ids(await search("jean laval"))).toEqual([b.id, a.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("12 — ses fiches et le bassin", () => {
  it("le mot d'un commentaire est trouvé, l'extrait le surligne, le lien vise le commentaire", async () => {
    const own = await makeClient({ fullName: "Olivier Brun", assignedToId: luc.id });
    const c1 = await addComment(own.id, luc.id, "Il cherche une piscine hors terre pour l'été prochain.");
    const pool = await makeClient({ fullName: "Nadia Blanc" });
    const c2 = await addComment(pool.id, marie.id, "Piscine creusée déjà en place");
    await loginAs(luc);

    const b = await search("piscine");
    expect(new Set(ids(b))).toEqual(new Set([own.id, pool.id]));
    for (const item of b.items) {
      const m = item.match!;
      expect(m.reasons.map((r) => r.field)).toContain("comment");
      const snip = m.snippet!;
      expect(snip.field).toBe("comment");
      expect(snip.ranges.length).toBeGreaterThan(0);
      const [s, e] = snip.ranges[0];
      expect(foldSearch(snip.text.slice(s, e))).toBe("piscine");
      const cid = item.id === own.id ? c1.id : c2.id;
      expect(snip.commentId).toBe(cid);
      expect(m.href).toBe(`/clients/${item.id}#comment-${cid}`);
      expect(snip.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(snip.author).toBe(item.id === own.id ? "Luc" : "Marie");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("13 — rôle sur mesure : historique fermé sur le bassin", () => {
  it("commentaire, appel, suivi, SMS : rien ; nom et téléphone : trouvés", async () => {
    await useCustomRole(
      luc,
      customRole("hist_off", ["clients.contact", "clients.history", "conversations.view"], {
        unassigned: ["visible", "contact"],
      }),
    );
    const fiche = await makeClient({ fullName: "Gilles Poirier", phone: "+14185557777" });
    await addComment(fiche.id, marie.id, "zorglub");
    await addCall(fiche.id, marie.id, "cabanon");
    await addFollowup(fiche.id, marie.id, "garage");
    await addSms(fiche.id, "in", "human", "terrasse");
    await loginAs(luc);

    for (const q of ["zorglub", "cabanon", "garage", "terrasse", "gilles zorglub"]) {
      expect((await search(q)).total, q).toBe(0);
    }
    expect(ids(await search("poirier"))).toEqual([fiche.id]);
    expect(ids(await search("5557777"))).toEqual([fiche.id]);
    expect(ids(await search("418 555 7777"))).toEqual([fiche.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("14 — rôle sur mesure : coordonnées fermées, historique ouvert", () => {
  it("chiffres et courriel ne trouvent rien, même écrits dans un commentaire ; l'extrait les masque", async () => {
    await useCustomRole(
      luc,
      customRole("contact_off", ["clients.contact", "clients.history", "conversations.view"], {
        unassigned: ["visible", "history"],
      }),
    );
    const fiche = await makeClient({ fullName: "Yves Caron", phone: "+14185552222", email: "yves@caron.ca" });
    await addComment(fiche.id, marie.id, "Rappeler au 418 555 3333 ou yves.perso@mail.com, parle de piscine");
    await loginAs(luc);

    for (const q of ["4185552222", "5552222", "4185553333", "418 555 3333", "yves@caron.ca", "yves.perso@mail.com", "piscine 4185553333"]) {
      expect((await search(q)).total, q).toBe(0);
    }
    // Entre guillemets, c'est du texte — mais un texte qui CONTIENT un
    // courriel ou un numéro reste un terme de coordonnées : sinon le
    // commentaire trahissait la fiche dont on cache ces coordonnées.
    for (const q of [
      '"yves.perso@mail.com"',
      'note:"yves.perso@mail.com"',
      '"418 555 3333"',
      '"418-555-3333"',
      '"418.555.3333"',
      'piscine "418 555 3333"',
      '"au 418 555 3333 ou"',
    ]) {
      expect((await search(q)).total, q).toBe(0);
    }
    const b = await search("piscine");
    expect(ids(b)).toEqual([fiche.id]);
    const item = b.items[0];
    expect(item.phone).toBeNull();
    expect(item.contactHidden).toBe(true);
    const snip = item.match!.snippet!;
    expect(snip.text).toContain("•••");
    expect(snip.text).not.toMatch(/3333|perso@mail/);
    // Le nom seul reste cherchable.
    expect(ids(await search("caron"))).toEqual([fiche.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("15 — SMS et droit conversations.view", () => {
  it("sans le droit : aucun SMS ; avec : entrants et envoyés à la main ; jamais ouverture ni agent", async () => {
    const fiche = await makeClient({ fullName: "Hugo Lemieux" });
    await addSms(fiche.id, "in", "human", "La véranda est prête");
    await addSms(fiche.id, "out", "human", "Parfait pour le solarium");
    await addSms(fiche.id, "out", "opener", "Bonjour, parlons barbecue");
    await addSms(fiche.id, "out", "agent", "Le foyer au bois est un plus");

    await useCustomRole(luc, customRole("no_threads", ["clients.contact", "clients.history"], { unassigned: READ_ALL }));
    await loginAs(luc);
    expect((await search("veranda")).total).toBe(0);
    expect((await search("solarium")).total).toBe(0);

    await useCustomRole(
      luc,
      customRole("threads", ["clients.contact", "clients.history", "conversations.view"], { unassigned: READ_ALL }),
    );
    await loginAs(luc);
    const veranda = await search("veranda");
    expect(ids(veranda)).toEqual([fiche.id]);
    expect(veranda.items[0].match!.snippet).toMatchObject({ field: "sms" });
    expect(ids(await search("solarium"))).toEqual([fiche.id]);
    expect((await search("barbecue")).total).toBe(0);
    expect((await search("foyer")).total).toBe(0);

    await loginAs(patron);
    expect((await search("barbecue")).total).toBe(0);
    expect((await search("foyer")).total).toBe(0);
    expect(ids(await search("veranda"))).toEqual([fiche.id]);
  });

  it("`sms:` / `texto:` seuls : la fiche dit POURQUOI elle remonte (raison et extrait SMS)", async () => {
    const fiche = await makeClient({ fullName: "Hugo Lemieux" });
    await addSms(fiche.id, "in", "human", "La véranda est prête");

    const expectSmsMatch = async (who: string) => {
      for (const q of ["sms:veranda", "texto:veranda"]) {
        const b = await search(q);
        expect(ids(b), `${who} ${q}`).toEqual([fiche.id]);
        const m = b.items[0].match!;
        expect(m.reasons.map((r) => r.field), `${who} ${q}`).toEqual(["sms"]);
        expect(m.snippet, `${who} ${q}`).toMatchObject({ field: "sms", text: "La véranda est prête" });
        expect(m.snippet!.ranges.length, `${who} ${q}`).toBeGreaterThan(0);
      }
    };
    await loginAs(patron);
    await expectSmsMatch("patron");

    await useCustomRole(
      luc,
      customRole("threads", ["clients.contact", "clients.history", "conversations.view"], { unassigned: READ_ALL }),
    );
    await loginAs(luc);
    await expectSmsMatch("luc");

    // Sans le droit, l'opérateur ne rouvre rien.
    await useCustomRole(luc, customRole("no_threads", ["clients.contact", "clients.history"], { unassigned: READ_ALL }));
    await loginAs(luc);
    expect((await search("sms:veranda")).total).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("16 — rôle sur mesure : historique ouvert, fiche invisible", () => {
  it("rien du tout", async () => {
    await useCustomRole(
      luc,
      customRole("ghost", ["clients.contact", "clients.history", "conversations.view"], {
        unassigned: ["contact", "history"],
      }),
    );
    const fiche = await makeClient({ fullName: "Fantôme Leduc", phone: "+14185554444" });
    await addComment(fiche.id, marie.id, "zorglub");
    await loginAs(luc);
    for (const q of ["leduc", "zorglub", "5554444"]) {
      const b = await search(q);
      expect(b.total, q).toBe(0);
      expect(b.search?.facets?.all, q).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("17 — observateur", () => {
  it("lit les commentaires des collègues ; la fiche du patron reste absente", async () => {
    const colleague = await makeClient({ fullName: "Réal Simard", assignedToId: marie.id });
    await addComment(colleague.id, marie.id, "zorglub");
    const boss = await makeClient({ fullName: "Réal Boss", assignedToId: patron.id });
    await addComment(boss.id, patron.id, "zorglub");
    await loginAs(stagiaire);
    expect(ids(await search("zorglub"))).toEqual([colleague.id]);
    expect(ids(await search("real"))).toEqual([colleague.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("18 — filtres avec q", () => {
  it("categoryId, campaignId, excludeCampaignId se combinent avec la recherche", async () => {
    await loginAs(patron);
    const hot = await makeCategory({ nameFr: "Chaud", nameEn: "Hot", color: "#ff0000" });
    const campaign = await makeCampaign("Printemps");
    const a = await makeClient({ fullName: "Sophie Ouellet", categoryId: hot.id });
    const b = await makeClient({ fullName: "Sophie Lavoie" });
    const c = await makeClient({ fullName: "Marc Ouellet", categoryId: hot.id });
    await testDb.insert(campaignEnrollments).values({ campaignId: campaign.id, clientId: b.id, status: "active" });

    const byCat = await search("sophie", { categoryId: String(hot.id) });
    expect(ids(byCat)).toEqual([a.id]);
    expect(byCat.items[0].categoryColor).toBe("#ff0000");
    expect(ids(await search("sophie", { campaignId: campaign.id }))).toEqual([b.id]);
    expect(ids(await search("sophie", { excludeCampaignId: campaign.id }))).toEqual([a.id]);
    expect(ids(await list({ q: "sophie", excludeCampaignId: campaign.id }))).toEqual([a.id]);
    expect(new Set(ids(await search("ouellet", { categoryId: String(hot.id) })))).toEqual(new Set([a.id, c.id]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("19 — faute de frappe", () => {
  it("« trembly » trouve Tremblay (approximatif) ; « trembly lévis » exige Lévis ; identity ne relance pas", async () => {
    await loginAs(patron);
    const levis = await makeClient({ fullName: "Marc Tremblay", city: "Lévis" });
    const quebec = await makeClient({ fullName: "Julie Tremblay", city: "Québec" });

    const one = await search("trembly");
    expect(new Set(ids(one))).toEqual(new Set([levis.id, quebec.id]));
    expect(one.search?.approximate).toBe(true);
    expect(one.items[0].match!.reasons[0]).toMatchObject({ field: "name", level: "fuzzy" });
    expect(one.items[0].match!.nameRanges.length).toBeGreaterThan(0);

    const two = await search("trembly lévis");
    expect(ids(two)).toEqual([levis.id]);
    expect(two.search?.approximate).toBe(true);

    const exact = await search("tremblay");
    expect(exact.search?.approximate).toBe(false);

    const identity = await list({ q: "trembly" });
    expect(identity.total).toBe(0);
    expect(identity.search?.approximate).toBe(false);
    expect((await search("zzzzzz")).search?.approximate).toBe(false);
  });
});
