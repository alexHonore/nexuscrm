/**
 * Unitaire — coût SMS réel depuis Twilio (Usage Records).
 *
 * Le réseau est simulé : on vérifie la résolution des identifiants, l'analyse
 * du prix, et surtout que TOUT échec (non configuré, HTTP, réseau, corps vide)
 * rend `null` — l'appelant retombe alors sur l'estimation, jamais une erreur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getTwilioSmsCost } = await import("@/lib/sms-server/twilio-usage");

const CREDS = {
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_API_KEY_SID: "SK123",
  TWILIO_API_KEY_SECRET: "secret",
};

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl as never));
}
const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

describe("getTwilioSmsCost", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("sans identifiants Twilio : null, aucun appel réseau", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await getTwilioSmsCost("2026-08-01", "2026-08-31", {})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("réponse Twilio : parse le prix facturé et vise la bonne URL", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return jsonRes({ usage_records: [{ price: "0.79", price_unit: "usd", category: "sms" }] });
    });
    const r = await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS);
    expect(r).toEqual({ costUsd: 0.79, priceUnit: "usd" });
    expect(seen).toContain("/Accounts/AC123/Usage/Records.json");
    expect(seen).toContain("Category=sms");
    expect(seen).toContain("StartDate=2026-08-01");
    expect(seen).toContain("EndDate=2026-08-31");
  });

  it("prix négatif (convention de charge) : rendu en valeur absolue", async () => {
    mockFetch(() => jsonRes({ usage_records: [{ price: "-1.50", price_unit: "usd" }] }));
    expect((await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS))?.costUsd).toBeCloseTo(1.5, 6);
  });

  it("clé SMS dédiée : préférée à la clé voix", async () => {
    const seen: string[] = [];
    mockFetch((_url, init) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return jsonRes({ usage_records: [{ price: "0.10" }] });
    });
    await getTwilioSmsCost("2026-08-01", "2026-08-31", {
      ...CREDS,
      TWILIO_SMS_API_KEY_SID: "SKsms",
      TWILIO_SMS_API_KEY_SECRET: "smssecret",
    });
    expect(seen[0]).toBe(`Basic ${btoa("SKsms:smssecret")}`);
  });

  it("HTTP en erreur → null", async () => {
    mockFetch(() => jsonRes({}, false, 401));
    expect(await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS)).toBeNull();
  });

  it("réseau qui lève → null (jamais d'exception)", async () => {
    mockFetch(() => {
      throw new Error("ECONNRESET");
    });
    expect(await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS)).toBeNull();
  });

  it("corps vide ou prix non numérique → null", async () => {
    mockFetch(() => jsonRes({ usage_records: [] }));
    expect(await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS)).toBeNull();
    mockFetch(() => jsonRes({ usage_records: [{ price: "n/a" }] }));
    expect(await getTwilioSmsCost("2026-08-01", "2026-08-31", CREDS)).toBeNull();
  });
});
