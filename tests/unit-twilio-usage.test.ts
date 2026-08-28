/**
 * Unitaire — coût SMS réel depuis Twilio (Usage Records).
 *
 * Le réseau est simulé : on vérifie la résolution des identifiants, l'analyse
 * du prix, et surtout que TOUT échec (non configuré, HTTP, réseau, corps vide)
 * rend `null` — l'appelant retombe alors sur l'estimation, jamais une erreur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getTwilioSmsCost, getTwilioBalance, getTwilioDailySmsUsage } = await import(
  "@/lib/sms-server/twilio-usage"
);

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

// ── Solde du compte ──────────────────────────────────────────────────────────

describe("getTwilioBalance", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("sans identifiants : null, aucun appel réseau", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await getTwilioBalance({})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("analyse le solde (une CHAÎNE) et vise Balance.json", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return jsonRes({ account_sid: "AC123", balance: "12.29", currency: "usd" });
    });
    expect(await getTwilioBalance(CREDS)).toEqual({
      balanceUsd: 12.29,
      currency: "USD",
      authKind: "apiKey",
    });
    expect(seen).toContain("/Accounts/AC123/Balance.json");
  });

  it("solde NÉGATIF : conservé tel quel — surtout pas de valeur absolue", async () => {
    // Le compte à découvert est justement ce qu'il faut voir ; le coût des SMS,
    // lui, se borne en positif. Les deux règles ne sont pas la même.
    mockFetch(() => jsonRes({ balance: "-3.41", currency: "USD" }));
    expect((await getTwilioBalance(CREDS))?.balanceUsd).toBeCloseTo(-3.41, 6);
  });

  it("clé API refusée : UN essai avec le jeton maître, et il gagne", async () => {
    // Twilio ne documente pas si une clé « Standard » lit Balance.json. On ne
    // parie pas : un 401 déclenche un unique repli sur le jeton maître.
    const auths: string[] = [];
    mockFetch((_url, init) => {
      const header = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      auths.push(header);
      return header === `Basic ${btoa("AC123:tok")}`
        ? jsonRes({ balance: "5.00", currency: "USD" })
        : jsonRes({}, false, 401);
    });
    const r = await getTwilioBalance({ ...CREDS, TWILIO_AUTH_TOKEN: "tok" });
    expect(r).toMatchObject({ balanceUsd: 5, authKind: "authToken" });
    expect(auths).toHaveLength(2);
    expect(auths[0]).toBe(`Basic ${btoa("SK123:secret")}`);
  });

  it("les deux refusés → null (la tuile dira « indisponible », jamais 0 $)", async () => {
    mockFetch(() => jsonRes({}, false, 401));
    expect(await getTwilioBalance({ ...CREDS, TWILIO_AUTH_TOKEN: "tok" })).toBeNull();
  });

  it("réseau qui lève, ou solde non numérique → null", async () => {
    mockFetch(() => {
      throw new Error("ECONNRESET");
    });
    expect(await getTwilioBalance(CREDS)).toBeNull();
    mockFetch(() => jsonRes({ balance: "n/a" }));
    expect(await getTwilioBalance(CREDS)).toBeNull();
  });
});

// ── Dépense jour par jour ────────────────────────────────────────────────────

describe("getTwilioDailySmsUsage", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("une ligne par journée facturée, chiffres convertis depuis les chaînes", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return jsonRes({
        usage_records: [
          { start_date: "2026-08-01", end_date: "2026-08-01", price: "0.79", count: "12" },
          { start_date: "2026-08-03", end_date: "2026-08-03", price: "1.20", count: "20" },
        ],
        next_page_uri: null,
      });
    });
    const rows = await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS);
    expect(rows).toEqual([
      { date: "2026-08-01", costUsd: 0.79, messages: 12 },
      { date: "2026-08-03", costUsd: 1.2, messages: 20 },
    ]);
    expect(seen).toContain("/Usage/Records/Daily.json");
    expect(seen).toContain("Category=sms");
    expect(seen).toContain("StartDate=2026-08-01");
  });

  it("catégorie des frais de transporteur : une requête à part", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return jsonRes({ usage_records: [] });
    });
    await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms-messages-carrierfees", CREDS);
    expect(seen).toContain("Category=sms-messages-carrierfees");
  });

  it("aucune journée facturée : liste VIDE, pas null (la différence compte)", async () => {
    // Vide = « rien dépensé » ; null = « on ne sait pas ». L'écran les dessine
    // différemment, donc l'API ne doit pas les confondre.
    mockFetch(() => jsonRes({ usage_records: [] }));
    expect(await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS)).toEqual([]);
  });

  it("HTTP en erreur, réseau qui lève, ou pas d'identifiants → null", async () => {
    mockFetch(() => jsonRes({}, false, 500));
    expect(await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS)).toBeNull();
    mockFetch(() => {
      throw new Error("timeout");
    });
    expect(await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS)).toBeNull();
    expect(await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", {})).toBeNull();
  });

  it("pagination sans fin : null, PAS une série tronquée présentée comme complète", async () => {
    // Une série amputée manquerait de la dépense sans le dire. Le garde-fou de
    // pages ne renvoie donc pas ce qu'il a lu : il déclare « indisponible ».
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return jsonRes({
        usage_records: [{ start_date: "2026-08-01", price: "1", count: "1" }],
        next_page_uri: "/2010-04-01/Accounts/AC123/Usage/Records/Daily.json?Page=99",
      });
    });
    expect(await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS)).toBeNull();
    expect(calls).toBe(5); // la borne de pages a bien mordu
  });

  it("date illisible : la ligne est écartée, pas le rapport", async () => {
    mockFetch(() =>
      jsonRes({ usage_records: [{ start_date: "hier", price: "1" }, { start_date: "2026-08-02", price: "2" }] }),
    );
    const rows = await getTwilioDailySmsUsage("2026-08-01", "2026-08-31", "sms", CREDS);
    expect(rows).toEqual([{ date: "2026-08-02", costUsd: 2, messages: 0 }]);
  });
});
