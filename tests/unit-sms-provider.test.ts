/**
 * Tests unitaires — fournisseur SMS (src/lib/sms/provider.ts).
 *
 * Aucune base de données, aucun réseau : tous les ports (gate, suppressions,
 * transport, logger, clock) sont des simulacres injectés.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createSmsProvider,
  createTwilioTransport,
  parseAllowlist,
  resolveSmsMode,
  TwilioSendError,
  type SmsProviderDeps,
} from "@/lib/sms/provider";
import type { Clock, Logger, SendGate, SendInput, SuppressionStore } from "@/lib/sms/types";
import { noopLogger, systemClock } from "@/lib/sms/types";

// ── Simulacres ───────────────────────────────────────────────────────────────

const fixedClock: Clock = { now: () => new Date("2026-08-20T12:00:00.000Z") };

function makeGate(allowed: boolean): SendGate {
  return { isSendingAllowed: vi.fn(async () => allowed) };
}

function makeSuppressions(suppressed: boolean): SuppressionStore {
  return {
    isSuppressed: vi.fn(async () => suppressed),
    suppress: vi.fn(async () => {}),
  };
}

function makeTransport(sid = "SM_fake_sid") {
  const calls: Array<{ to: string; body: string; idempotencyKey: string }> = [];
  const transport = async (input: { to: string; body: string; idempotencyKey: string }) => {
    calls.push(input);
    return { sid };
  };
  return { transport, calls };
}

function makeLogger() {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (msg, data) => lines.push({ level: "info", msg, data }),
    warn: (msg, data) => lines.push({ level: "warn", msg, data }),
    error: (msg, data) => lines.push({ level: "error", msg, data }),
  };
  return { logger, lines };
}

function makeDeps(overrides: Partial<SmsProviderDeps> = {}) {
  const { transport, calls } = makeTransport();
  const deps: SmsProviderDeps = {
    mode: "live",
    allowlist: [],
    transport,
    suppressions: makeSuppressions(false),
    gate: makeGate(true),
    logger: noopLogger,
    clock: fixedClock,
    ...overrides,
  };
  return { deps, transportCalls: calls };
}

const input: SendInput = {
  to: "+15145551234",
  body: "Bonjour, on se parle demain?",
  conversationId: "conv-1",
  idempotencyKey: "idem-1",
};

// ═══════════════════════════════════════════════════════════════════════════
// resolveSmsMode — fermé par défaut
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveSmsMode", () => {
  it.each([
    [{}, "dry_run"],
    [{ SMS_MODE: "n'importe quoi" }, "dry_run"],
    [{ SMS_MODE: "dry_run" }, "dry_run"],
    [{ SMS_MODE: "live" }, "dry_run"], // live sans confirmation = dry_run
    [{ SMS_MODE: "live", SMS_LIVE_CONFIRMED: "1" }, "dry_run"], // exiger "true" exactement
    [{ SMS_MODE: "live", SMS_LIVE_CONFIRMED: "true" }, "live"],
    [{ SMS_MODE: "sandbox" }, "sandbox"],
    [{ SMS_LIVE_CONFIRMED: "true" }, "dry_run"], // confirmation seule ne suffit pas
  ] as const)("%o → %s", (env, expected) => {
    expect(resolveSmsMode({ ...env })).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseAllowlist
// ═══════════════════════════════════════════════════════════════════════════

describe("parseAllowlist", () => {
  it("undefined et chaîne vide donnent une liste vide", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("découpe sur la virgule et tolère les espaces", () => {
    expect(parseAllowlist(" +15145551234 , +14385556789 ")).toEqual([
      "+15145551234",
      "+14385556789",
    ]);
  });

  it("écarte tout ce qui n'est pas un E.164 valide", () => {
    expect(parseAllowlist("abc,5145551234,+1514555,+123456789012345678,+15145551234")).toEqual([
      "+15145551234",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pipeline send() — gardes dans l'ordre, transport jamais appelé quand bloqué
// ═══════════════════════════════════════════════════════════════════════════

describe("createSmsProvider — gardes", () => {
  it("destination invalide → invalid_to, rien d'autre n'est consulté", async () => {
    const gate = makeGate(true);
    const suppressions = makeSuppressions(false);
    const { deps, transportCalls } = makeDeps({ gate, suppressions });
    const provider = createSmsProvider(deps);

    const result = await provider.send({ ...input, to: "5145551234" });

    expect(result).toMatchObject({ sent: false, skippedReason: "invalid_to", mode: "live" });
    expect(result.encoding).toBe("GSM-7");
    expect(result.segments).toBe(1);
    expect(transportCalls).toHaveLength(0);
    expect(gate.isSendingAllowed).not.toHaveBeenCalled();
    expect(suppressions.isSuppressed).not.toHaveBeenCalled();
  });

  it("interrupteur d'arrêt → kill_switch, avant même la liste de suppression", async () => {
    const suppressions = makeSuppressions(false);
    const { deps, transportCalls } = makeDeps({ gate: makeGate(false), suppressions });
    const provider = createSmsProvider(deps);

    const result = await provider.send(input);

    expect(result).toMatchObject({ sent: false, skippedReason: "kill_switch" });
    expect(result.sid).toBeUndefined();
    expect(transportCalls).toHaveLength(0);
    expect(suppressions.isSuppressed).not.toHaveBeenCalled();
  });

  it("numéro supprimé → suppressed, le transport n'est JAMAIS appelé", async () => {
    const { deps, transportCalls } = makeDeps({ suppressions: makeSuppressions(true) });
    const provider = createSmsProvider(deps);

    const result = await provider.send(input);

    expect(result).toMatchObject({ sent: false, skippedReason: "suppressed" });
    expect(transportCalls).toHaveLength(0);
  });
});

describe("createSmsProvider — mode dry_run", () => {
  it("journalise sans envoyer, avec segments et encodage calculés", async () => {
    const { logger, lines } = makeLogger();
    const { deps, transportCalls } = makeDeps({ mode: "dry_run", logger });
    const provider = createSmsProvider(deps);

    const result = await provider.send({ ...input, body: "allô" });

    expect(result).toMatchObject({
      sent: false,
      skippedReason: "dry_run",
      mode: "dry_run",
      encoding: "UCS-2",
      segments: 1,
    });
    expect(result.sid).toBeUndefined();
    expect(transportCalls).toHaveLength(0);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "sms.send.dry_run" });
    const data = lines[0].data ?? {};
    expect(data.conversationId).toBe("conv-1");
    expect(data.idempotencyKey).toBe("idem-1");
    expect(data.segments).toBe(1);
    expect(data.encoding).toBe("UCS-2");
    expect(data.bodyLength).toBe(4);
    // Renseignements personnels : jamais le corps ni le numéro complet.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("allô");
    expect(serialized).not.toContain("+15145551234");
    expect(String(data.to)).toContain("1234");
  });
});

describe("createSmsProvider — mode sandbox", () => {
  it("bloque hors liste d'autorisation et avertit", async () => {
    const { logger, lines } = makeLogger();
    const { deps, transportCalls } = makeDeps({
      mode: "sandbox",
      allowlist: ["+14385556789"],
      logger,
    });
    const provider = createSmsProvider(deps);

    const result = await provider.send(input); // +15145551234 hors liste

    expect(result).toMatchObject({ sent: false, skippedReason: "sandbox_not_allowlisted" });
    expect(transportCalls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", msg: "sms.send.sandbox_blocked" });
    expect(JSON.stringify(lines[0].data ?? {})).not.toContain("+15145551234");
  });

  it("envoie aux numéros de la liste", async () => {
    const { deps, transportCalls } = makeDeps({
      mode: "sandbox",
      allowlist: ["+15145551234"],
    });
    const provider = createSmsProvider(deps);

    const result = await provider.send(input);

    expect(result).toMatchObject({ sent: true, sid: "SM_fake_sid", mode: "sandbox" });
    expect(transportCalls).toEqual([
      { to: "+15145551234", body: input.body, idempotencyKey: "idem-1" },
    ]);
  });
});

describe("createSmsProvider — mode live", () => {
  it("envoie et renvoie le sid, segments et encodage", async () => {
    const { deps, transportCalls } = makeDeps();
    const provider = createSmsProvider(deps);

    const result = await provider.send(input);

    expect(result).toEqual({
      sid: "SM_fake_sid",
      sent: true,
      mode: "live",
      encoding: "GSM-7",
      segments: 1,
    });
    expect(transportCalls).toHaveLength(1);
  });

  it("laisse remonter les erreurs du transport (la file possède les reprises)", async () => {
    const { deps } = makeDeps({
      transport: async () => {
        throw new Error("twilio_send_failed: 30007 Message filtered");
      },
    });
    const provider = createSmsProvider(deps);

    await expect(provider.send(input)).rejects.toThrow("twilio_send_failed: 30007");
  });

  it("systemClock et noopLogger conviennent comme dépendances par défaut", async () => {
    const { deps } = makeDeps({ clock: systemClock, logger: noopLogger, mode: "dry_run" });
    const result = await createSmsProvider(deps).send(input);
    expect(result.skippedReason).toBe("dry_run");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createTwilioTransport — fetch simulé, jamais de réseau
// ═══════════════════════════════════════════════════════════════════════════

function makeFetch(status: number, body: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (requestUrl, init) => {
    calls.push({ url: String(requestUrl), init: init ?? {} });
    return new Response(body, { status });
  };
  return { fetchFn, calls };
}

describe("createTwilioTransport", () => {
  const cfg = {
    accountSid: "AC0000000000000000000000000000test",
    keySid: "SK0000000000000000000000000000test",
    keySecret: "secret-de-test",
    messagingServiceSid: "MG0000000000000000000000000000test",
  };

  it("frappe la bonne URL avec l'en-tête Basic et le formulaire complet", async () => {
    const { fetchFn, calls } = makeFetch(201, JSON.stringify({ sid: "SM42", status: "queued" }));
    const transport = createTwilioTransport({
      ...cfg,
      statusCallbackUrl: "https://crm.example.com/api/webhooks/twilio/status",
      fetchFn,
    });

    const result = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k1" });

    expect(result).toEqual({ sid: "SM42" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
    );
    expect(calls[0].init.method).toBe("POST");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa(`${cfg.keySid}:${cfg.keySecret}`)}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("To")).toBe("+15145551234");
    expect(form.get("Body")).toBe("Salut!");
    expect(form.get("MessagingServiceSid")).toBe(cfg.messagingServiceSid);
    expect(form.get("StatusCallback")).toBe("https://crm.example.com/api/webhooks/twilio/status");
  });

  it("omet StatusCallback quand aucune URL n'est fournie", async () => {
    const { fetchFn, calls } = makeFetch(201, JSON.stringify({ sid: "SM43" }));
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k2" });

    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.has("StatusCallback")).toBe(false);
  });

  it("non-2xx avec erreur JSON Twilio → TwilioSendError portant statut HTTP ET code Twilio", async () => {
    const { fetchFn } = makeFetch(
      400,
      JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number", status: 400 }),
    );
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    const err = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k3" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err).toMatchObject({
      status: 400,
      code: 21211,
      message: "twilio_send_failed: http 400 21211 Invalid 'To' Phone Number",
    });
  });

  it("5xx AVEC corps JSON Twilio (le cas réel) → le statut reste lisible : 500, code 20500", async () => {
    // Twilio met un corps JSON sur ses 5xx aussi — avant, le message ne
    // disait que « 20500 Internal Server Error » et la file ne reconnaissait
    // plus une panne à retenter.
    const { fetchFn } = makeFetch(
      500,
      JSON.stringify({ code: 20500, message: "Internal Server Error", status: 500 }),
    );
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    const err = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k3b" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err).toMatchObject({
      status: 500,
      code: 20500,
      message: "twilio_send_failed: http 500 20500 Internal Server Error",
    });
  });

  it("non-2xx au corps illisible → TwilioSendError avec le statut HTTP seul", async () => {
    const { fetchFn } = makeFetch(500, "Internal Server Error");
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    const err = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k4" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TwilioSendError);
    expect(err).toMatchObject({ status: 500, code: null, message: "twilio_send_failed: http 500" });
  });

  it("2xx sans sid exploitable → throw malformed_response (PAS un TwilioSendError : Twilio a peut-être accepté)", async () => {
    const { fetchFn } = makeFetch(200, "pas du json");
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    const err = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k5" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TwilioSendError);
    expect((err as Error).message).toBe("twilio_send_failed: http 200 malformed_response");
  });

  it("arme un signal d'abandon sur chaque appel (plafond de temps)", async () => {
    const { fetchFn, calls } = makeFetch(201, JSON.stringify({ sid: "SM44" }));
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k6" });

    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("socket qui pend : abandon net au lieu de bloquer la file du dispatcher", async () => {
    // Un fetch qui ne répond jamais — seul le signal peut le dénouer.
    const fetchFn: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason as Error));
      });
    const transport = createTwilioTransport({ ...cfg, fetchFn, timeoutMs: 20 });

    const err = await transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k7" }).then(
      () => null,
      (e: unknown) => e,
    );
    // Délai = issue INCONNUE, pas un refus de Twilio : jamais de statut HTTP.
    expect(err).not.toBeInstanceOf(TwilioSendError);
    expect((err as Error).message).toBe("twilio_send_failed: timeout after 20ms");
  });

  it("une panne réseau ordinaire remonte telle quelle", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const transport = createTwilioTransport({ ...cfg, fetchFn });

    await expect(
      transport({ to: "+15145551234", body: "Salut!", idempotencyKey: "k8" }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
