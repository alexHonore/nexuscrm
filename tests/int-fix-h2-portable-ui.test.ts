/**
 * Intégration — correctifs d'audit H2, côté ROUTES d'import.
 *
 * Le fichier vient d'ailleurs et l'administrateur est la victime, pas
 * l'attaquant : la prévisualisation part dès le choix du fichier, avant tout
 * écran. Ce qu'on garantit ici :
 *  · un fichier d'assistant dont une liaison vise « __proto__.… » fait un 400
 *    « invalid_bundle » — et Object.prototype ressort intact du processus ;
 *  · un fichier de campagne dont la sorte ne colle pas au chemin fait un 400
 *    à la prévisualisation, au lieu d'un 500 FK au commit.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb } from "./helpers/db";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { campaignConfigSchema } from "@/lib/campaigns/schema";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (name: string, value: string) => ctx.cookies.set(name, value),
    delete: (name: string) => ctx.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

const assistantImport = await import("@/app/api/assistants/import/route");
const campaignImport = await import("@/app/api/campaigns/import/route");

async function loginAsAdmin(user: { id: string; tokenVersion: number }) {
  const token = await new SignJWT({
    uid: user.id,
    role: "admin",
    tv: user.tokenVersion,
    remember: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
}

function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function expectPrototypePristine() {
  expect(Object.prototype.hasOwnProperty).toBeTypeOf("function");
  const probe = {} as Record<string, unknown>;
  expect(probe.polluted).toBeUndefined();
}

afterAll(closeDb);

describe("import d'assistant — chemin de liaison hostile", () => {
  beforeEach(async () => {
    ctx.cookies.clear();
    await resetDb();
  });

  it("préview d'un fichier « __proto__ » : 400, prototype intact", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAsAdmin(admin);

    const bundle = {
      format: "nexus.assistant/v1",
      assistant: assistantConfigSchema.parse({
        name: "Acheteur FB",
        identity: {},
        goal: { primary: { type: "qualify_only", requiredFields: [] }, fallbacks: [] },
        approach: {},
        model: {},
      }),
      bindings: [
        { path: "__proto__.hasOwnProperty", kind: "user", sourceValue: null, label: "", hint: "" },
      ],
    };

    for (const mode of ["preview", "commit"] as const) {
      const res = await assistantImport.POST(req("/api/assistants/import", { mode, bundle }));
      expect(res.status, mode).toBe(400);
      const body = await res.json();
      expect(body.error, mode).toBe("invalid_bundle");
      expectPrototypePristine();
    }
  });
});

describe("import de campagne — sorte contre chemin", () => {
  beforeEach(async () => {
    ctx.cookies.clear();
    await resetDb();
  });

  it("un uuid d'utilisateur dans « assistantId » : 400 dès la préview, pas un 500 au commit", async () => {
    const admin = await makeUser({ role: "admin", email: "alex@example.com" });
    await loginAsAdmin(admin);

    const campaign = campaignConfigSchema.parse({
      name: "Réactivation",
      trigger: { kind: "manual" },
      audience: {},
      ladder: [{ delayHours: 0, body: "Bonjour.", label: "ouverture" }],
    });
    campaign.assistantId = null;
    campaign.smsNumberId = null;
    const bundle = {
      format: "nexus.campaign/v1",
      campaign,
      bindings: [
        // L'étiquette correspond à un VRAI utilisateur local : avant le
        // correctif, la résolution passait et l'uuid partait dans le champ
        // d'assistant — 500 FK au commit, rien à la préview.
        {
          path: "assistantId",
          kind: "user",
          sourceValue: "33333333-3333-4333-8333-333333333333",
          label: "alex@example.com",
          hint: "",
        },
      ],
    };

    for (const mode of ["preview", "commit"] as const) {
      const res = await campaignImport.POST(req("/api/campaigns/import", { mode, bundle }));
      expect(res.status, mode).toBe(400);
      const body = await res.json();
      expect(body.error, mode).toBe("invalid_bundle");
      // Le diagnostic nomme la liaison fautive : c'est ce qui rend un refus
      // exploitable pour un fichier écrit à la main.
      expect(JSON.stringify(body.issues), mode).toContain("assistantId");
    }
  });
});
