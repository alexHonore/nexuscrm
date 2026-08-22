/**
 * Intégration — un import refusé DIT ce qui cloche.
 *
 * Le scénario réel : Alex fait rédiger un fichier d'assistant par un modèle à
 * partir de la documentation, l'importe, et reçoit « ce fichier n'est pas un
 * export valide ». Rien sur le champ fautif, rien sur la ligne. Ces tests
 * tiennent les deux moitiés de la réparation : le fichier écrit à la main
 * PASSE quand il ne lui manque que de la tenue de livres, et quand il ne passe
 * pas, la réponse porte de quoi le corriger.
 */
import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeUser, resetDb } from "./helpers/db";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

const assistantImport = await import("@/app/api/assistants/import/route");
const campaignImport = await import("@/app/api/campaigns/import/route");
const assistantsRoute = await import("@/app/api/assistants/route");
const exportRoute = await import("@/app/api/assistants/[id]/export/route");

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function loginAsAdmin() {
  const admin = await makeUser({ role: "admin" });
  const token = await new SignJWT({ uid: admin.id, role: "admin", tv: admin.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
  jar.set("nexus_session", token);
  return admin;
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Issue = {
  path: string;
  code: string;
  expected?: string;
  received?: string;
  value?: string;
  options?: string[];
  field?: { label: string; what?: string };
};

async function preview(bundle: unknown) {
  const res = await assistantImport.POST(post("http://localhost:3000/api/assistants/import", { mode: "preview", bundle }));
  return { status: res.status, body: (await res.json()) as { error?: string; issues?: Issue[] } };
}

/** Ce qu'un modèle écrit à partir de la documentation : pas de tenue de livres. */
function handWritten(): Record<string, unknown> {
  return {
    format: "nexus.assistant/v1",
    assistant: {
      name: "Acheteurs Facebook",
      description: "Relance les leads acheteurs venus de Facebook.",
      goal: {
        primary: { type: "video_meeting", durationMin: 30, requiredFields: ["project_type"] },
        fallbacks: [{ type: "phone_call", durationMin: 15 }],
      },
      knowledge: { claims: ["Nous couvrons Québec et Lévis."] },
      tools: ["get_slots", "book_meeting", "update_qualification", "stop", "handoff"],
    },
  };
}

beforeEach(async () => {
  await resetDb();
  await loginAsAdmin();
});

afterAll(async () => {
  await closeDb();
});

describe("un fichier écrit à la main", () => {
  it("passe : il ne lui manquait que la date d'export et des blocs à valeurs par défaut", async () => {
    // C'est LE cas qui a mordu : `exportedAt` — une ligne que personne ne relit
    // — faisait refuser tout le document.
    const { status, body } = await preview(handWritten());
    expect(body.issues ?? body.error).toBeUndefined();
    expect(status).toBe(200);
  });

  it("mais le modèle appliqué par défaut est SIGNALÉ, pas subi", async () => {
    const res = await assistantImport.POST(
      post("http://localhost:3000/api/assistants/import", { mode: "preview", bundle: handWritten() }),
    );
    const body = (await res.json()) as { warnings: { code: string }[] };
    expect(body.warnings.map((w) => w.code)).toContain("model_defaulted");
  });

  it("les blocs complétés par défaut sont DITS — ce sont les noms qui partent en SMS", async () => {
    // `identity` par défaut fait signer « Groupe Nexus / Alex-Honoré ». Toléré
    // à l'import, mais jamais en silence.
    const res = await assistantImport.POST(
      post("http://localhost:3000/api/assistants/import", { mode: "preview", bundle: handWritten() }),
    );
    const body = (await res.json()) as { warnings: { code: string; messageFr: string }[] };
    const warning = body.warnings.find((w) => w.code === "blocks_defaulted");
    expect(warning, JSON.stringify(body.warnings)).toBeDefined();
    expect(warning!.messageFr).toContain("Groupe Nexus");
  });

  it("un fichier complet ne déclenche aucun avertissement de valeur par défaut", async () => {
    const bundle = handWritten();
    Object.assign(bundle.assistant as Record<string, unknown>, {
      identity: { mode: "team", orgName: "Autre Courtage", brokerName: "Marie Tremblay" },
      approach: { formality: "vous", persistence: 2 },
      model: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    const res = await assistantImport.POST(
      post("http://localhost:3000/api/assistants/import", { mode: "preview", bundle }),
    );
    const body = (await res.json()) as { warnings: { code: string }[] };
    const codes = body.warnings.map((w) => w.code);
    expect(codes).not.toContain("blocks_defaulted");
    expect(codes).not.toContain("model_defaulted");
  });

  it("un fichier qui nomme son modèle ne déclenche pas l'avertissement", async () => {
    const bundle = handWritten();
    (bundle.assistant as Record<string, unknown>).model = {
      provider: "anthropic",
      model: "claude-sonnet-5",
    };
    const res = await assistantImport.POST(
      post("http://localhost:3000/api/assistants/import", { mode: "preview", bundle }),
    );
    const body = (await res.json()) as { warnings: { code: string }[] };
    expect(body.warnings.map((w) => w.code)).not.toContain("model_defaulted");
  });
});

describe("un fichier refusé dit POURQUOI", () => {
  it("une valeur d'énumération inconnue rend le chemin, le champ et la liste permise", async () => {
    const bundle = handWritten();
    (bundle.assistant as { goal: { primary: { type: string } } }).goal.primary.type = "rencontre";

    const { status, body } = await preview(bundle);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_bundle");

    const issue = body.issues?.find((i) => i.path === "assistant.goal.primary.type");
    expect(issue, JSON.stringify(body.issues)).toBeDefined();
    expect(issue!.code).toBe("not_allowed");
    // La liste des valeurs permises : c'est elle qui rend l'erreur réparable.
    expect(issue!.options).toContain("video_meeting");
    // Ce que le fichier disait vraiment, pour ne pas avoir à le rechercher.
    expect(issue!.value).toBe("rencontre");
    // Et le nom humain du champ, pris dans la référence.
    expect(issue!.field?.label).toBeTruthy();
  });

  it("un mauvais format de document le dit avec la valeur trouvée", async () => {
    const { body } = await preview({ ...handWritten(), format: "nexus.assistant/v2" });
    const issue = body.issues?.find((i) => i.path === "format");
    expect(issue?.code).toBe("not_allowed");
    expect(issue?.expected).toBe("nexus.assistant/v1");
    expect(issue?.value).toBe("nexus.assistant/v2");
    // Une seule valeur possible n'est pas un choix : pas de liste trompeuse.
    expect(issue?.options).toBeUndefined();
  });

  it("« mauvais type » garde le TYPE trouvé et montre la valeur à part", async () => {
    const bundle = handWritten();
    (bundle.assistant as Record<string, unknown>).tools = "get_slots,stop";
    const { body } = await preview(bundle);
    const issue = body.issues?.find((i) => i.path === "assistant.tools");
    expect(issue?.code).toBe("wrong_type");
    expect(issue?.expected).toBe("array");
    // Le type, pour la phrase…
    expect(issue?.received).toBe("string");
    // …et la valeur, pour savoir quoi corriger.
    expect(issue?.value).toBe("get_slots,stop");
  });

  it("un champ vraiment obligatoire est signalé comme MANQUANT, pas comme mal typé", async () => {
    const bundle = handWritten();
    delete (bundle.assistant as Record<string, unknown>).goal;
    const { body } = await preview(bundle);
    const issue = body.issues?.find((i) => i.path === "assistant.goal");
    expect(issue?.code).toBe("missing");
  });

  it("une règle de garde-fou mal configurée pointe la règle, pas le document entier", async () => {
    const bundle = handWritten();
    bundle.guardrails = [
      {
        scope: "assistant",
        key: "longueur",
        label: "Longueur",
        kind: "max_chars",
        config: { max: "trois cents" },
        severity: "block",
        enabled: true,
        orderIndex: 1,
      },
    ];
    const { body } = await preview(bundle);
    expect(body.issues?.some((i) => i.path === "guardrails[0].config.max")).toBe(true);
  });

  it("plusieurs problèmes sont rendus ENSEMBLE, pas un par tentative", async () => {
    const { body } = await preview({
      format: "nexus.assistant/v1",
      assistant: { name: "X", goal: { primary: { type: "rencontre" } }, approach: { persistence: 99 } },
    });
    expect((body.issues ?? []).length).toBeGreaterThan(1);
  });
});

describe("campagnes — même traitement", () => {
  it("un fichier écrit à la main passe sans date d'export", async () => {
    const res = await campaignImport.POST(
      post("http://localhost:3000/api/campaigns/import", {
        mode: "preview",
        bundle: {
          format: "nexus.campaign/v1",
          campaign: {
            name: "Réactivation 180 j",
            trigger: { kind: "scheduled", everyHours: 24 },
            ladder: [{ delayHours: 0, body: "Bonjour, ici Groupe Nexus." }],
          },
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("et un champ refusé porte son chemin et son libellé", async () => {
    const res = await campaignImport.POST(
      post("http://localhost:3000/api/campaigns/import", {
        mode: "preview",
        bundle: {
          format: "nexus.campaign/v1",
          campaign: { name: "X", trigger: { kind: "jamais" }, ladder: [] },
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues?: Issue[] };
    const issue = body.issues?.find((i) => i.path.startsWith("campaign.trigger"));
    expect(issue, JSON.stringify(body.issues)).toBeDefined();
    expect(issue!.field?.label, "le champ doit être nommé par la référence").toBeTruthy();
  });
});

describe("export — la langue vient de la requête, pas d'un composant", () => {
  // `getLocale()` de next-intl lève hors d'un composant serveur ; ces routes
  // l'appelaient. Une route d'export qui explose ne se voit qu'en production.
  async function createAssistant(): Promise<string> {
    const res = await assistantsRoute.POST(
      post("http://localhost:3000/api/assistants", {
        name: "Export test",
        identity: { mode: "team", orgName: "Groupe Nexus", brokerName: "Alex-Honoré" },
        goal: { primary: { type: "video_meeting", durationMin: 30 }, fallbacks: [] },
        approach: {},
        model: {},
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function exportWith(locale: string | null): Promise<Record<string, unknown>> {
    if (locale) jar.set("NEXT_LOCALE", locale);
    else jar.delete("NEXT_LOCALE");
    const id = await createAssistant();
    const res = await exportRoute.GET(
      new Request(`http://localhost:3000/api/assistants/${id}/export`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status, "l'export ne doit pas tomber").toBe(200);
    return JSON.parse(await res.text()) as Record<string, unknown>;
  }

  it("répond 200 et annote en français par défaut", async () => {
    const file = await exportWith(null);
    const docs = file._docs as Record<string, { label: string }>;
    expect(docs["identity.orgName"].label).toBe("Nom de l'organisation");
  });

  it("annote en anglais quand l'interface est en anglais", async () => {
    const file = await exportWith("en");
    const docs = file._docs as Record<string, { label: string }>;
    expect(docs["identity.orgName"].label).toBe("Organization name");
    // La configuration exportée, elle, ne bouge pas d'un poil.
    expect((file.assistant as { language: string }).language).toBe("fr-CA");
  });
})
