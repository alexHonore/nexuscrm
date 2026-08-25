/**
 * Unitaire — validation de signature Twilio (src/lib/sms-server/twilio-signature.ts).
 *
 * Le vecteur canonique vient de l'exemple des docs de sécurité Twilio, et sa
 * valeur attendue a été vérifiée contre le SDK officiel
 * (`twilio.getExpectedTwilioSignature`) : c'est le premier test capable
 * d'attraper une déviation SYMÉTRIQUE (implémentation + miroir de test faux
 * ensemble) — les tests d'intégration recalculent le HMAC avec le même
 * algorithme que le code de prod, ils ne prouvent donc pas la conformité.
 */
import { createHmac } from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  isValidTwilioSignature,
  isValidTwilioSignatureAnyUrl,
  webhookUrlCandidates,
} from "@/lib/sms-server/twilio-signature";

const CANONICAL_URL = "https://mycompany.com/myapp.php?foo=1&CallSid=CA1234567890ABCDE";
const CANONICAL_PARAMS = new URLSearchParams({
  CallSid: "CA1234567890ABCDE",
  Caller: "+12349013030",
  Digits: "1234",
  From: "+12349013030",
  To: "+18005551212",
});
const CANONICAL_TOKEN = "12345";
/** Vérifiée contre twilio.getExpectedTwilioSignature (SDK officiel, 2026-08). */
const CANONICAL_SIGNATURE = "WIFn5kDfD8BDiA5k5v6xQxFjPh8=";

function sign(url: string, params: URLSearchParams, token: string): string {
  const data = url + [...params.keys()].sort().map((k) => k + (params.get(k) ?? "")).join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

describe("isValidTwilioSignature", () => {
  it("accepte le vecteur canonique des docs Twilio", () => {
    expect(
      isValidTwilioSignature({
        url: CANONICAL_URL,
        params: CANONICAL_PARAMS,
        signature: CANONICAL_SIGNATURE,
        authToken: CANONICAL_TOKEN,
        isProduction: true,
      }),
    ).toBe(true);
  });

  it("refuse une signature altérée, une URL différente, un jeton différent", () => {
    const base = {
      url: CANONICAL_URL,
      params: CANONICAL_PARAMS,
      signature: CANONICAL_SIGNATURE,
      authToken: CANONICAL_TOKEN,
      isProduction: true,
    };
    expect(isValidTwilioSignature({ ...base, signature: "AAAA" + CANONICAL_SIGNATURE.slice(4) })).toBe(false);
    expect(isValidTwilioSignature({ ...base, url: CANONICAL_URL.replace("https", "http") })).toBe(false);
    expect(isValidTwilioSignature({ ...base, authToken: "54321" })).toBe(false);
    expect(isValidTwilioSignature({ ...base, signature: null })).toBe(false);
  });

  it("sans jeton : ouvert hors production, fermé en production", () => {
    const base = { url: CANONICAL_URL, params: CANONICAL_PARAMS, signature: null, authToken: undefined };
    expect(isValidTwilioSignature({ ...base, isProduction: false })).toBe(true);
    expect(isValidTwilioSignature({ ...base, isProduction: true })).toBe(false);
  });
});

describe("isValidTwilioSignatureAnyUrl", () => {
  const params = new URLSearchParams({ MessageSid: "SM123", Body: "C'est réglé — à bientôt" });
  const token = "test_token";

  it("valide dès qu'UNE candidate correspond (l'URL signée n'est pas la première)", () => {
    const signedUrl = "https://groupe-nexus.vercel.app/api/webhooks/twilio/inbound";
    expect(
      isValidTwilioSignatureAnyUrl({
        urls: ["http://localhost:3000/api/webhooks/twilio/inbound", signedUrl],
        params,
        signature: sign(signedUrl, params, token),
        authToken: token,
        isProduction: true,
      }),
    ).toBe(true);
  });

  it("refuse quand aucune candidate ne correspond, ou sans candidate avec jeton", () => {
    const base = {
      params,
      signature: sign("https://ailleurs.example.com/api", params, token),
      authToken: token,
      isProduction: true,
    };
    expect(isValidTwilioSignatureAnyUrl({ ...base, urls: ["https://groupe-nexus.vercel.app/x"] })).toBe(false);
    expect(isValidTwilioSignatureAnyUrl({ ...base, urls: [] })).toBe(false);
  });

  it("sans jeton : même règle que la validation simple", () => {
    const base = { urls: ["https://a.example.com/x"], params, signature: null, authToken: undefined };
    expect(isValidTwilioSignatureAnyUrl({ ...base, isProduction: false })).toBe(true);
    expect(isValidTwilioSignatureAnyUrl({ ...base, isProduction: true })).toBe(false);
  });
});

describe("webhookUrlCandidates", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  });

  it("reconstruit depuis NEXT_PUBLIC_APP_URL ET l'hôte réellement appelé (x-forwarded-*)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3100";
    const urls = webhookUrlCandidates({
      path: "/api/webhooks/twilio/status",
      headers: new Headers({ "x-forwarded-host": "groupe-nexus.vercel.app", "x-forwarded-proto": "https" }),
    });
    expect(urls).toEqual([
      "http://localhost:3100/api/webhooks/twilio/status",
      "https://groupe-nexus.vercel.app/api/webhooks/twilio/status",
    ]);
  });

  it("dédoublonne quand tout coïncide, conserve la query, retombe sur host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://groupe-nexus.vercel.app/";
    const urls = webhookUrlCandidates({
      path: "/api/webhooks/twilio/inbound",
      search: "?x=1",
      headers: new Headers({ host: "groupe-nexus.vercel.app", "x-forwarded-proto": "https" }),
    });
    expect(urls).toEqual(["https://groupe-nexus.vercel.app/api/webhooks/twilio/inbound?x=1"]);
  });

  it("sans NEXT_PUBLIC_APP_URL : l'hôte forwardé reste une candidate (https par défaut)", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const urls = webhookUrlCandidates({
      path: "/api/webhooks/twilio/inbound",
      headers: new Headers({ "x-forwarded-host": "groupe-nexus.vercel.app" }),
    });
    expect(urls).toEqual(["https://groupe-nexus.vercel.app/api/webhooks/twilio/inbound"]);
  });
});
