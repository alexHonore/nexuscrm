/**
 * Unitaire — le client voip.ms (src/lib/voipms.ts) borne chaque appel HTTP.
 *
 * Régression : `voipms()` appelait `fetch` sans signal d'abandon. Un socket
 * muet côté voip.ms (ou passerelle) faisait pendre la synchro CDR jusqu'à ce
 * que Vercel tue la fonction à maxDuration — sans réponse, sans ligne d'audit,
 * et n8n ne voyait qu'un délai dépassé. Un abandon devient une `VoipMsError`
 * normale, que cdr-sync range dans `errors` et dépasse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { VoipMsError, voipms } = await import("@/lib/voipms");

describe("voipms() — plafond de temps", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.VOIPMS_API_USERNAME = "user@test.local";
    process.env.VOIP_MS_API_PASSWORD = "secret";
    delete process.env.VOIPMS_API_PROXY_URL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it("arme un signal d'abandon sur chaque appel", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify({ status: "success", balance: {} }), { status: 200 });
      }),
    );

    await voipms("getBalance");
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("socket muet : VoipMsError « timeout » après le délai, au lieu de pendre", async () => {
    process.env.VOIPMS_TIMEOUT_MS = "20";
    // Un fetch qui ne répond jamais — seul le signal peut le dénouer.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          }),
      ),
    );

    const err = await voipms("getCDR").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VoipMsError);
    expect((err as InstanceType<typeof VoipMsError>).status).toBe("timeout");
    expect((err as Error).message).toContain("20 ms");
    expect((err as Error).message).toContain("getCDR");
  });

  it("VOIPMS_TIMEOUT_MS invalide ou absent : on retombe sur le délai par défaut (pas 0, pas NaN)", async () => {
    process.env.VOIPMS_TIMEOUT_MS = "pas-un-nombre";
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Response(JSON.stringify({ status: "success" }), { status: 200 });
      }),
    );

    await voipms("getBalance");
    // Un délai de 0/NaN aurait déjà abandonné le signal au moment de l'appel.
    expect(signal?.aborted).toBe(false);
  });

  it("une panne réseau ordinaire remonte telle quelle (pas maquillée en délai)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(voipms("getBalance")).rejects.toThrow("fetch failed");
  });
});
