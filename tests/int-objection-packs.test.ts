/**
 * Intégration — les paquets d'objections sont enfin modifiables.
 *
 * Ils étaient semés une fois et jamais touchés : l'onglet offrait des cases à
 * cocher sur du contenu écrit par quelqu'un d'autre. Or une objection est ce
 * qu'un courtier entend tous les jours et reformule sans arrêt.
 *
 * Ce que ces tests tiennent : un paquet est une ressource PARTAGÉE. Le
 * modifier change ce que répondent tous les assistants qui s'en servent — donc
 * leur prompt compilé devient périmé — et le supprimer sous leurs pieds est
 * refusé, pas silencieusement accepté.
 */
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

const packsRoute = await import("@/app/api/objection-packs/route");
const packRoute = await import("@/app/api/objection-packs/[id]/route");
const assistantsRoute = await import("@/app/api/assistants/route");
const { assistants, objectionPacks } = await import("@/db/schema-sms");
const { auditLogs } = await import("@/db/schema");

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function loginAs(role: "admin" | "caller") {
  const user = await makeUser({ role, email: `${role}-${Date.now()}@x.test` });
  jar.set(
    "nexus_session",
    await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(SECRET),
  );
  return user;
}

const json = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ITEM = {
  key: "deja_courtier",
  triggerHint: "j'ai déjà un courtier",
  acknowledge: "c'est correct",
  reframe: "un deuxième avis n'engage à rien",
  ask: "quinze minutes cette semaine?",
};

const base = "http://localhost:3000/api/objection-packs";

async function createPack(id = "vendeur_fr", items: unknown[] = [ITEM]) {
  return packsRoute.POST(json(base, "POST", { id, label: "Objections vendeur", items }));
}

async function patch(id: string, body: unknown) {
  return packRoute.PATCH(json(`${base}/${id}`, "PATCH", body), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  await resetDb();
  await loginAs("admin");
});

afterAll(async () => {
  await closeDb();
});

describe("créer", () => {
  it("crée un paquet et le journalise", async () => {
    const res = await createPack();
    expect(res.status).toBe(201);

    const [row] = await testDb.select().from(objectionPacks);
    expect(row).toMatchObject({ id: "vendeur_fr", label: "Objections vendeur", isBuiltin: false });
    expect(row.items).toHaveLength(1);

    const logs = await testDb.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toContain("objection_pack.create");
  });

  it("refuse un identifiant déjà pris plutôt que d'écraser le paquet d'un autre", async () => {
    await createPack();
    const again = await createPack("vendeur_fr", []);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("id_taken");
    expect(await testDb.select().from(objectionPacks)).toHaveLength(1);
  });

  it("refuse un identifiant qui n'est pas une clé stable", async () => {
    // Il voyage dans les fichiers d'export et sert de référence : espaces et
    // majuscules en feraient une clé qu'on ne retrouve pas.
    const res = await createPack("Vendeur FR");
    expect(res.status).toBe(400);
  });

  it("refuse une objection incomplète — trois temps sur quatre ne répondent rien", async () => {
    // Un paquet dont on ne remplit que « reconnais » produit une réponse qui
    // compatit et ne demande rien : c'est pire que pas de paquet du tout.
    const res = await createPack("partiel", [{ key: "k", triggerHint: "x", acknowledge: "y" }]);
    expect(res.status).toBe(400);
  });
});

describe("modifier", () => {
  it("réécrit le contenu", async () => {
    await createPack();
    const res = await patch("vendeur_fr", {
      label: "Objections vendeur (v2)",
      items: [{ ...ITEM, ask: "jeudi 14 h?" }],
    });
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(objectionPacks);
    expect(row.label).toBe("Objections vendeur (v2)");
    expect((row.items as { ask: string }[])[0].ask).toBe("jeudi 14 h?");
  });

  it("rend PÉRIMÉ le prompt des assistants qui s'en servent", async () => {
    // C'est le piège d'une ressource partagée : le texte compilé de chaque
    // assistant cite encore l'ancienne formulation, sans que rien ne le dise.
    await createPack();
    const created = await assistantsRoute.POST(
      json("http://localhost:3000/api/assistants", "POST", {
        name: "Vendeurs",
        identity: {},
        goal: { primary: { type: "video_meeting" } },
        approach: {},
        model: {},
        objectionPacks: ["vendeur_fr"],
      }),
    );
    const { id } = (await created.json()) as { id: string };
    await testDb.update(assistants).set({ needsRecompile: false }).where(eq(assistants.id, id));

    const res = await patch("vendeur_fr", { items: [{ ...ITEM, reframe: "autrement dit" }] });
    expect((await res.json()).invalidated).toEqual(["Vendeurs"]);

    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, id));
    expect(row.needsRecompile).toBe(true);
  });

  it("un paquet inconnu répond 404, pas 500", async () => {
    expect((await patch("fantome", { label: "x" })).status).toBe(404);
  });
});

describe("supprimer", () => {
  const del = (id: string) =>
    packRoute.DELETE(json(`${base}/${id}`, "DELETE"), { params: Promise.resolve({ id }) });

  it("supprime un paquet que personne n'utilise", async () => {
    await createPack();
    expect((await del("vendeur_fr")).status).toBe(200);
    expect(await testDb.select().from(objectionPacks)).toHaveLength(0);
  });

  it("REFUSE de le retirer sous les pieds d'un assistant, et nomme lesquels", async () => {
    await createPack();
    await assistantsRoute.POST(
      json("http://localhost:3000/api/assistants", "POST", {
        name: "Vendeurs",
        identity: {},
        goal: { primary: { type: "video_meeting" } },
        approach: {},
        model: {},
        objectionPacks: ["vendeur_fr"],
      }),
    );

    const res = await del("vendeur_fr");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; assistants: { name: string }[] };
    expect(body.error).toBe("in_use");
    // Nommer les assistants rend le geste suivant évident.
    expect(body.assistants.map((a) => a.name)).toEqual(["Vendeurs"]);
    expect(await testDb.select().from(objectionPacks)).toHaveLength(1);
  });
});

describe("RBAC", () => {
  it("un téléphoniste ne crée, ne modifie ni ne supprime rien", async () => {
    await createPack();
    await loginAs("caller");

    expect((await createPack("autre")).status).toBe(403);
    expect((await patch("vendeur_fr", { label: "pirate" })).status).toBe(403);
    expect(
      (
        await packRoute.DELETE(json(`${base}/vendeur_fr`, "DELETE"), {
          params: Promise.resolve({ id: "vendeur_fr" }),
        })
      ).status,
    ).toBe(403);

    const [row] = await testDb.select().from(objectionPacks);
    expect(row.label).toBe("Objections vendeur");
  });
});
