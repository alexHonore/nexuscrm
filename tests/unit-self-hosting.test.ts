/**
 * Tests unitaires de l'hébergement double : Vercel + Supabase cloud (la
 * version d'origine, gardée en repli) et Tayoo Ops (Supabase auto-hébergé).
 *
 * Ce qui est vérifié ici, c'est la promesse du repli : SANS variable, tout se
 * comporte exactement comme avant ; les variables de Tayoo Ops ne changent
 * que ce qu'elles nomment, et une valeur mal tapée ne passe jamais en silence.
 *
 * Aucun accès réseau ni base.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

import { DEFAULT_POOL_MAX, resolveDbSsl, resolvePoolMax } from "@/db/connection";
import { clientIpFromHeaders, resolveTrustedProxy } from "@/lib/audit";

afterAll(closeDb);

const CLOUD = "postgresql://postgres.ref:pw@aws-0-ca-central-1.pooler.supabase.com:6543/postgres";
const VPS = "postgresql://postgres:pw@db:5432/postgres";
const LOCAL = "postgres://nexus:nexus@localhost:5455/nexus";

describe("db — resolveDbSsl", () => {
  it("sans réglage : TLS exigé partout sauf en local (comportement d'origine)", () => {
    expect(resolveDbSsl(CLOUD, undefined)).toBe("require");
    expect(resolveDbSsl(VPS, undefined)).toBe("require");
    expect(resolveDbSsl(LOCAL, undefined)).toBe("disable");
    expect(resolveDbSsl("postgres://u:p@127.0.0.1:5432/x", "")).toBe("disable");
    expect(resolveDbSsl(CLOUD, "auto")).toBe("require");
  });

  it("l'ancienne astuce « localhost » dans application_name marche toujours", () => {
    expect(resolveDbSsl(`${VPS}?application_name=nexuscrm_fork_localhost`, undefined)).toBe("disable");
  });

  it("DATABASE_SSL=disable coupe TLS sur le réseau privé de l'instance", () => {
    expect(resolveDbSsl(VPS, "disable")).toBe("disable");
    expect(resolveDbSsl(VPS, " DISABLE ")).toBe("disable");
  });

  it("DATABASE_SSL=require l'impose même en local", () => {
    expect(resolveDbSsl(LOCAL, "require")).toBe("require");
  });

  it("une valeur inconnue lève au lieu de choisir en silence", () => {
    expect(() => resolveDbSsl(VPS, "off")).toThrow(/DATABASE_SSL/);
    expect(() => resolveDbSsl(VPS, "verify-full")).toThrow(/DATABASE_SSL/);
  });
});

describe("db — resolvePoolMax", () => {
  it("30 par défaut", () => {
    expect(DEFAULT_POOL_MAX).toBe(30);
    expect(resolvePoolMax(undefined)).toBe(30);
    expect(resolvePoolMax("")).toBe(30);
  });

  it("accepte un entier raisonnable", () => {
    expect(resolvePoolMax("20")).toBe(20);
    expect(resolvePoolMax(" 1 ")).toBe(1);
  });

  it("refuse zéro, les décimaux, le texte et l'excès", () => {
    for (const bad of ["0", "-3", "2.5", "trente", "500"]) {
      expect(() => resolvePoolMax(bad)).toThrow(/DATABASE_POOL_MAX/);
    }
  });
});

describe("audit — resolveTrustedProxy", () => {
  it("vercel par défaut", () => {
    expect(resolveTrustedProxy(undefined)).toBe("vercel");
    expect(resolveTrustedProxy("")).toBe("vercel");
    expect(resolveTrustedProxy("Vercel")).toBe("vercel");
  });

  it("cloudflare quand demandé", () => {
    expect(resolveTrustedProxy("cloudflare")).toBe("cloudflare");
    expect(resolveTrustedProxy(" CloudFlare ")).toBe("cloudflare");
  });

  it("une faute de frappe est « invalid », pas un retour à la chaîne Vercel", () => {
    expect(resolveTrustedProxy("cloudfare")).toBe("invalid");
  });
});

describe("audit — clientIpFromHeaders derrière Cloudflare (Tayoo Ops)", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("ne lit que cf-connecting-ip", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "203.0.113.7" }), "cloudflare")).toBe("203.0.113.7");
  });

  it("ignore les en-têtes qu'un visiteur peut écrire lui-même", () => {
    const spoofed = h({
      "x-vercel-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "198.51.100.3",
    });
    expect(clientIpFromHeaders(spoofed, "cloudflare")).toBeNull();

    spoofed.set("cf-connecting-ip", "203.0.113.9");
    expect(clientIpFromHeaders(spoofed, "cloudflare")).toBe("203.0.113.9");
  });

  it("une adresse privée n'est pas une IP client", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "172.18.0.5" }), "cloudflare")).toBeNull();
  });

  it("accepte l'IPv6", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "2001:4860:4860::8888" }), "cloudflare")).toBe(
      "2001:4860:4860::8888",
    );
  });

  it("réglage invalide : aucune IP", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "203.0.113.7" }), "invalid")).toBeNull();
  });

  it("mode vercel (défaut) : chaîne d'origine inchangée, cf-connecting-ip ignoré", () => {
    expect(clientIpFromHeaders(h({ "cf-connecting-ip": "203.0.113.7" }), "vercel")).toBeNull();
    expect(
      clientIpFromHeaders(h({ "x-vercel-forwarded-for": "203.0.113.8", "cf-connecting-ip": "203.0.113.7" })),
    ).toBe("203.0.113.8");
  });
});
