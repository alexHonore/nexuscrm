/**
 * Tests unitaires « noyau » — logique pure, cas limites exhaustifs.
 *
 * Couvre : src/lib/phone.ts, src/lib/crypto.ts, src/lib/dispositions.ts,
 * clientIpFromHeaders (src/lib/audit.ts), les schémas de src/lib/settings.ts
 * et l'innocuité SSR des moteurs de téléphonie.
 *
 * Aucun accès réseau. Les modules marqués `server-only` sont importables ici
 * grâce au stub ci-dessous (paquet marqueur React, pas le code sous test).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

import { normalizePhone, formatPhone, phoneMatchKey } from "@/lib/phone";
import {
  encryptSecret,
  decryptSecret,
  generateApiKey,
  safeEqual,
  sha256Hex,
} from "@/lib/crypto";
import { DISPOSITION_CONFIG, DISPOSITION_ORDER } from "@/lib/dispositions";
import { DISPOSITIONS, type Disposition } from "@/db/schema";
import { clientIpFromHeaders } from "@/lib/audit";
import {
  bookingSettingsSchema,
  googleSettingsSchema,
  telephonySettingsSchema,
} from "@/lib/settings";

const REPO = path.resolve(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

afterAll(closeDb);

// ═══════════════════════════════════════════════════════════════════════════
// 1. src/lib/phone.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("phone — normalizePhone", () => {
  it.each([
    ["10 chiffres avec tirets", "418-476-1542", "+14184761542"],
    ["10 chiffres bruts", "4184761542", "+14184761542"],
    ["format nord-américain classique", "(418) 476-1542", "+14184761542"],
    ["points comme séparateurs", "418.476.1542", "+14184761542"],
    ["espaces partout", " 418  476  1542 ", "+14184761542"],
    ["11 chiffres commençant par 1", "14184761542", "+14184761542"],
    ["1 + espaces", "1 (418) 476-1542", "+14184761542"],
    ["déjà en E.164", "+14184761542", "+14184761542"],
    ["E.164 avec espaces", "+1 418 476 1542", "+14184761542"],
    ["international France", "+33 6 12 34 56 78", "+33612345678"],
    ["international Suisse compact", "+41791234567", "+41791234567"],
    ["préfixe 011 international", "011 33 6 12 34 56 78", "+011336123456 78".replace(/\s/g, "")],
  ])("%s", (_label, input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["chaîne vide", ""],
    ["espaces seulement", "   "],
    ["seulement un +", "+"],
    ["ponctuation seulement", "()- . "],
    ["lettres seulement", "abcdef"],
  ])("renvoie null pour %s", (_label, input) => {
    expect(normalizePhone(input as string | null | undefined)).toBeNull();
  });

  it("est idempotent : normalize(normalize(x)) === normalize(x)", () => {
    const inputs = [
      "418-476-1542",
      "(418) 476-1542",
      "14184761542",
      "+14184761542",
      "+33 6 12 34 56 78",
      "418-476-1542 x22",
      "1-800-FLOWERS",
      "0",
    ];
    for (const input of inputs) {
      const once = normalizePhone(input);
      expect(once).not.toBeNull();
      expect(normalizePhone(once)).toBe(once);
    }
  });

  it("produit toujours un « + » suivi uniquement de chiffres", () => {
    for (const input of ["418-476-1542", "+33 6 12 34 56 78", "1 (418) 476-1542", "abc 418 476 1542"]) {
      expect(normalizePhone(input)).toMatch(/^\+\d+$/);
    }
  });

  it("ignore les lettres d'un numéro mnémonique (comportement actuel, documenté)", () => {
    // "1-800-FLOWERS" → seuls "1800" survivent. Le numéro obtenu est inutilisable
    // mais non-null : voir le drapeau du rapport.
    expect(normalizePhone("1-800-FLOWERS")).toBe("+1800");
    expect(normalizePhone("418-GO-NEXUS")).toBe("+418");
  });

  it("RÉGRESSION (corrigé) : une extension (« x22 ») est fusionnée dans le numéro au lieu d'être ignorée", () => {
    // Cas très courant dans les listes de leads québécoises importées en CSV
    // (« 418-476-1542 poste 22 », « 418-476-1542 x22 »).
    // Attendu : le numéro composable, l'extension écartée.
    expect(normalizePhone("418-476-1542 x22")).toBe("+14184761542");
    expect(normalizePhone("418-476-1542 poste 22")).toBe("+14184761542");
    expect(normalizePhone("(418) 476-1542 ext. 22")).toBe("+14184761542");
  });

  it("RÉGRESSION (corrigé) : un numéro avec extension ne se recolle pas au client lors d'un appel entrant", () => {
    // phoneMatchKey garde les 10 DERNIERS chiffres : avec l'extension collée,
    // la clé devient « 8476154222 » et l'appel entrant du même client n'est plus reconnu.
    expect(phoneMatchKey(normalizePhone("418-476-1542 x22"))).toBe(
      phoneMatchKey("+14184761542"),
    );
  });
});

describe("phone — formatPhone", () => {
  it.each([
    ["E.164 nord-américain", "+14184761542", "(418) 476-1542"],
    ["autre indicatif régional", "+15145551234", "(514) 555-1234"],
    ["international laissé tel quel", "+33612345678", "+33612345678"],
    ["non normalisé laissé tel quel", "4184761542", "4184761542"],
    ["numéro trop long laissé tel quel", "+141847615421", "+141847615421"],
    ["numéro trop court laissé tel quel", "+1418476154", "+1418476154"],
  ])("%s", (_label, input, expected) => {
    expect(formatPhone(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["chaîne vide", ""],
  ])("renvoie une chaîne vide pour %s", (_label, input) => {
    expect(formatPhone(input as string | null | undefined)).toBe("");
  });

  it("formatPhone(normalizePhone(x)) est stable quel que soit le format saisi", () => {
    for (const input of ["4184761542", "418-476-1542", "(418) 476-1542", "1 418 476 1542", "+14184761542"]) {
      expect(formatPhone(normalizePhone(input))).toBe("(418) 476-1542");
    }
  });
});

describe("phone — phoneMatchKey", () => {
  it("donne la même clé pour tous les formats d'un même numéro", () => {
    const variants = [
      "4184761542",
      "418-476-1542",
      "(418) 476-1542",
      "418.476.1542",
      "14184761542",
      "1 (418) 476-1542",
      "+14184761542",
      "+1 418 476 1542",
    ];
    const keys = new Set(variants.map((v) => phoneMatchKey(v)));
    expect([...keys]).toEqual(["4184761542"]);
  });

  it("garde les 10 derniers chiffres d'un numéro international", () => {
    expect(phoneMatchKey("+33612345678")).toBe("3612345678");
    expect(phoneMatchKey("+41791234567")).toBe("1791234567");
  });

  it("accepte un numéro de 7 chiffres (local) et le renvoie tel quel", () => {
    expect(phoneMatchKey("476-1542")).toBe("4761542");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["chaîne vide", ""],
    ["6 chiffres", "476154"],
    ["ponctuation seulement", "()-. "],
    ["lettres", "NEXUS"],
  ])("renvoie null pour %s", (_label, input) => {
    expect(phoneMatchKey(input as string | null | undefined)).toBeNull();
  });

  it("est stable après normalisation", () => {
    for (const input of ["4184761542", "418-476-1542", "+14184761542"]) {
      expect(phoneMatchKey(normalizePhone(input))).toBe(phoneMatchKey(input));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. src/lib/crypto.ts
// ═══════════════════════════════════════════════════════════════════════════

describe("crypto — encryptSecret / decryptSecret", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["ascii", "sip-password-123"],
    ["français accentué", "Réservé à l'Hôtel — Éléonore çà & là"],
    ["emoji", "🔐 clé 🇨🇦 secrète 👨‍👩‍👧‍👦"],
    ["chaîne vide", ""],
    ["caractères de contrôle", "a\n\t b"],
  ])("aller-retour : %s", (_label, plain) => {
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it("aller-retour sur 10 Ko", () => {
    const plain = "é🔐x".repeat(3500).slice(0, 10_000);
    const payload = encryptSecret(plain);
    expect(decryptSecret(payload)).toBe(plain);
  });

  it("produit un chiffré différent à chaque appel (IV aléatoire) mais déchiffrable", () => {
    const plain = "même-secret";
    const payloads = Array.from({ length: 20 }, () => encryptSecret(plain));
    expect(new Set(payloads).size).toBe(20);
    for (const p of payloads) expect(decryptSecret(p)).toBe(plain);
  });

  it("émet un format base64(iv[12] | tag[16] | ciphertext)", () => {
    const payload = encryptSecret("abc");
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const buf = Buffer.from(payload, "base64");
    expect(buf.length).toBe(12 + 16 + Buffer.byteLength("abc"));
  });

  it("refuse un chiffré altéré (ciphertext modifié)", () => {
    const payload = encryptSecret("sip-password-123");
    const buf = Buffer.from(payload, "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("refuse un chiffré altéré (tag d'authentification modifié)", () => {
    const buf = Buffer.from(encryptSecret("sip-password-123"), "base64");
    buf[15] ^= 0x01;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("refuse un chiffré altéré (IV modifié)", () => {
    const buf = Buffer.from(encryptSecret("sip-password-123"), "base64");
    buf[0] ^= 0x01;
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("refuse une charge tronquée", () => {
    const buf = Buffer.from(encryptSecret("sip-password-123"), "base64");
    expect(() => decryptSecret(buf.subarray(0, 20).toString("base64"))).toThrow();
  });

  it("refuse un déchiffrement avec une autre clé", () => {
    const payload = encryptSecret("sip-password-123");
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("exige APP_ENCRYPTION_KEY", () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("exige une clé de 32 octets", () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => encryptSecret("x")).toThrow(/32 octets/);
  });
});

describe("crypto — sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["Groupe Nexus", "37dfe67e9a550c3d3bae92a869d9a3007fef552bcaa95e8e19d44fd5e3d648f7"],
  ])("vecteur connu pour %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("est déterministe et de longueur 64 hex", () => {
    const k = generateApiKey();
    expect(sha256Hex(k)).toBe(sha256Hex(k));
    expect(sha256Hex(k)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distingue deux entrées proches", () => {
    expect(sha256Hex("clé-a")).not.toBe(sha256Hex("clé-b"));
  });
});

describe("crypto — safeEqual", () => {
  it("est vrai pour deux chaînes identiques", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("clé-é-🔐", "clé-é-🔐")).toBe(true);
    const hash = sha256Hex("secret");
    expect(safeEqual(hash, sha256Hex("secret"))).toBe(true);
  });

  it("est faux pour deux chaînes différentes de même longueur", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });

  it("est faux (sans lever) pour des longueurs différentes", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
    expect(safeEqual("a", "")).toBe(false);
    // Longueurs en OCTETS : "é" fait 2 octets, "e" en fait 1.
    expect(safeEqual("é", "e")).toBe(false);
  });
});

describe("crypto — generateApiKey", () => {
  it("fait 48 caractères hexadécimaux (24 octets)", () => {
    for (let i = 0; i < 20; i++) {
      const k = generateApiKey();
      expect(k).toHaveLength(48);
      expect(k).toMatch(/^[0-9a-f]{48}$/);
    }
  });

  it("est unique sur un grand tirage", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey()));
    expect(keys.size).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. src/lib/dispositions.ts
// ═══════════════════════════════════════════════════════════════════════════

/** Clés de catégories système réellement créées par `pnpm db:seed`. */
function seedSystemCategoryKeys(): string[] {
  const source = src("src/db/seed.ts");
  const block = source.slice(
    source.indexOf("const systemCategories"),
    source.indexOf("for (const cat of systemCategories)"),
  );
  const keys = [...block.matchAll(/\{\s*key:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (keys.length === 0) throw new Error("Impossible d'extraire les catégories système du seed");
  return keys;
}

describe("dispositions", () => {
  const seedKeys = seedSystemCategoryKeys();

  it("le seed déclare bien 7 catégories système", () => {
    expect(seedKeys).toEqual([
      "new",
      "voicemail",
      "callback",
      "booked",
      "not_interested",
      "not_qualified",
      "dncl",
    ]);
  });

  it("chaque Disposition du schéma a une entrée DISPOSITION_CONFIG", () => {
    for (const d of DISPOSITIONS) {
      expect(DISPOSITION_CONFIG[d], `disposition manquante: ${d}`).toBeDefined();
    }
  });

  it("DISPOSITION_CONFIG n'a pas d'entrée en trop", () => {
    expect(Object.keys(DISPOSITION_CONFIG).sort()).toEqual([...DISPOSITIONS].sort());
  });

  it("DISPOSITION_ORDER est une permutation exacte de DISPOSITIONS", () => {
    expect(DISPOSITION_ORDER).toHaveLength(DISPOSITIONS.length);
    expect(new Set(DISPOSITION_ORDER).size).toBe(DISPOSITION_ORDER.length); // pas de doublon
    expect([...DISPOSITION_ORDER].sort()).toEqual([...DISPOSITIONS].sort());
  });

  it("chaque categoryKey est null ou une des clés système du seed", () => {
    for (const d of DISPOSITIONS) {
      const { categoryKey } = DISPOSITION_CONFIG[d];
      if (categoryKey === null) continue;
      expect(seedKeys, `categoryKey inconnue pour ${d}: ${categoryKey}`).toContain(categoryKey);
    }
  });

  it("les 6 catégories de pipeline atteignables par un appel sont couvertes", () => {
    const mapped = new Set(
      DISPOSITIONS.map((d) => DISPOSITION_CONFIG[d].categoryKey).filter(
        (k): k is string => k !== null,
      ),
    );
    // « new » n'est jamais appliquée par une disposition (c'est l'état initial).
    expect([...mapped].sort()).toEqual(
      seedKeys.filter((k) => k !== "new").sort(),
    );
  });

  it("no_answer ne change pas la catégorie du client", () => {
    expect(DISPOSITION_CONFIG.no_answer.categoryKey).toBeNull();
  });

  it("toutes les couleurs sont des hex valides #rrggbb", () => {
    for (const d of DISPOSITIONS) {
      expect(DISPOSITION_CONFIG[d].color, `couleur invalide pour ${d}`).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
      const { textColor } = DISPOSITION_CONFIG[d];
      if (textColor !== undefined) expect(textColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("chaque disposition a une couleur distincte (boutons discernables)", () => {
    const colors = DISPOSITIONS.map((d) => DISPOSITION_CONFIG[d].color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("DISPOSITION_ORDER commence par les issues positives", () => {
    expect(DISPOSITION_ORDER.slice(0, 2)).toEqual<Disposition[]>(["booked", "callback"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. src/lib/audit.ts — clientIpFromHeaders
// ═══════════════════════════════════════════════════════════════════════════

const ipOf = (init: Record<string, string>) => clientIpFromHeaders(new Headers(init));

describe("audit — clientIpFromHeaders (priorité des en-têtes)", () => {
  it("x-vercel-forwarded-for gagne sur tout le reste", () => {
    expect(
      ipOf({
        "x-vercel-forwarded-for": "203.0.113.7",
        "x-real-ip": "198.51.100.9",
        "x-forwarded-for": "192.0.2.5",
      }),
    ).toBe("203.0.113.7");
  });

  it("retombe sur x-real-ip quand x-vercel-forwarded-for est absent", () => {
    expect(ipOf({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "192.0.2.5" })).toBe(
      "198.51.100.9",
    );
  });

  it("retombe sur x-real-ip quand x-vercel-forwarded-for est privé", () => {
    expect(ipOf({ "x-vercel-forwarded-for": "10.0.0.4", "x-real-ip": "198.51.100.9" })).toBe(
      "198.51.100.9",
    );
  });

  it("retombe sur x-forwarded-for quand x-real-ip est privé", () => {
    expect(ipOf({ "x-real-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.7" })).toBe(
      "203.0.113.7",
    );
  });

  it("prend la PREMIÈRE entrée publique de x-forwarded-for", () => {
    expect(ipOf({ "x-forwarded-for": "10.1.2.3, 203.0.113.7, 198.51.100.9" })).toBe(
      "203.0.113.7",
    );
    expect(ipOf({ "x-forwarded-for": "203.0.113.7, 198.51.100.9" })).toBe("203.0.113.7");
    expect(ipOf({ "x-forwarded-for": " 192.168.1.1 ,  198.51.100.9 " })).toBe("198.51.100.9");
  });

  it("renvoie null quand aucun en-tête n'est présent", () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  it("renvoie null quand toutes les entrées sont privées", () => {
    expect(
      ipOf({
        "x-vercel-forwarded-for": "::1",
        "x-real-ip": "127.0.0.1",
        "x-forwarded-for": "10.0.0.1, 192.168.0.4, 172.20.5.6",
      }),
    ).toBeNull();
  });
});

describe("audit — clientIpFromHeaders (plages non routables)", () => {
  it.each([
    ["loopback IPv6", "::1"],
    ["adresse nulle IPv6", "::"],
    ["loopback IPv4", "127.0.0.1"],
    ["loopback IPv4 (autre)", "127.255.255.254"],
    ["réseau 0.0.0.0/8", "0.0.0.0"],
    ["privé 10/8", "10.0.0.1"],
    ["privé 10/8 (haut)", "10.255.255.255"],
    ["privé 192.168/16", "192.168.1.42"],
    ["privé 172.16/12 (bas)", "172.16.0.1"],
    ["privé 172.16/12 (milieu)", "172.20.10.1"],
    ["privé 172.16/12 (haut)", "172.31.255.254"],
    ["link-local IPv4", "169.254.10.1"],
    ["unique-local IPv6 fc00::/7", "fc00::1"],
    ["unique-local IPv6 fd00::/8", "fd12:3456:789a::1"],
    ["link-local IPv6 fe80::/10", "fe80::1"],
    ["link-local IPv6 feb0::", "feb0::1"],
    ["littéral « unknown »", "unknown"],
  ])("écarte %s", (_label, ip) => {
    expect(ipOf({ "x-real-ip": ip })).toBeNull();
    expect(ipOf({ "x-vercel-forwarded-for": ip })).toBeNull();
    expect(ipOf({ "x-forwarded-for": ip })).toBeNull();
  });

  it.each([
    ["publique IPv4", "203.0.113.7"],
    ["publique IPv4 hors plages privées", "172.15.0.1"],
    ["publique IPv4 juste au-dessus de 172.31", "172.32.0.1"],
    ["publique IPv4 192.169", "192.169.0.1"],
    ["publique IPv4 169.253", "169.253.0.1"],
    ["publique IPv6", "2001:db8::1"],
    ["publique IPv6 (majuscules)", "2001:DB8::1"],
  ])("accepte %s", (_label, ip) => {
    expect(ipOf({ "x-real-ip": ip })).toBe(ip);
  });
});

describe("audit — clientIpFromHeaders (nettoyage de la valeur)", () => {
  it("retire le port d'une IPv4", () => {
    expect(ipOf({ "x-real-ip": "203.0.113.7:56789" })).toBe("203.0.113.7");
    expect(ipOf({ "x-forwarded-for": "10.0.0.1:1234, 203.0.113.7:443" })).toBe("203.0.113.7");
  });

  it("retire les crochets et le port d'une IPv6", () => {
    expect(ipOf({ "x-real-ip": "[2001:db8::1]:443" })).toBe("2001:db8::1");
    expect(ipOf({ "x-real-ip": "[2001:db8::1]" })).toBe("2001:db8::1");
    expect(ipOf({ "x-real-ip": "[::1]:443" })).toBeNull();
  });

  it("déplie une IPv4 encapsulée en IPv6", () => {
    expect(ipOf({ "x-real-ip": "::ffff:203.0.113.7" })).toBe("203.0.113.7");
    expect(ipOf({ "x-real-ip": "::FFFF:203.0.113.7" })).toBe("203.0.113.7");
    // …et applique ensuite les règles IPv4 : celle-ci est privée.
    expect(ipOf({ "x-real-ip": "::ffff:192.168.1.1" })).toBeNull();
    expect(ipOf({ "x-real-ip": "::ffff:127.0.0.1" })).toBeNull();
  });

  it("ignore les espaces autour de la valeur", () => {
    expect(ipOf({ "x-real-ip": "   203.0.113.7   " })).toBe("203.0.113.7");
  });

  it("ne garde pas une IPv6 laissée telle quelle par un port sans crochets", () => {
    // "2001:db8::1:443" n'est pas décomposable sans crochets — la valeur reste
    // une IPv6 syntaxiquement plausible, donc acceptée telle quelle.
    expect(ipOf({ "x-real-ip": "2001:db8::1:443" })).toBe("2001:db8::1:443");
  });
});

describe("audit — clientIpFromHeaders (entrées invalides)", () => {
  it.each([
    ["chaîne vide", ""],
    ["espaces", "   "],
    ["texte quelconque", "not-an-ip"],
    ["octet > 255", "999.1.1.1"],
    ["octet > 255 (dernier)", "203.0.113.999"],
    ["trois octets", "203.0.113"],
    ["virgule seule", ","],
    ["injection SQL sans « : »", "1; DROP TABLE users"],
  ])("renvoie null pour %s", (_label, value) => {
    expect(ipOf({ "x-real-ip": value })).toBeNull();
  });

  it("RÉGRESSION (corrigé) : n'importe quelle chaîne contenant « : » passe pour une IPv6 publique", () => {
    // isPublicIp() ne valide pas la syntaxe IPv6 : tout ce qui contient un « : »
    // et ne commence pas par fc/fd/fe8x est accepté. La valeur brute finit
    // telle quelle dans audit_logs.ip et comme clé du limiteur par IP.
    expect(ipOf({ "x-real-ip": '{"ip":"203.0.113.7"}' })).toBeNull();
    expect(ipOf({ "x-real-ip": "1; DROP TABLE users -- :" })).toBeNull();
    expect(ipOf({ "x-forwarded-for": "pas:une:ip, 203.0.113.7" })).toBe("203.0.113.7");
    expect(ipOf({ "x-real-ip": "x".repeat(500) + ":" })).toBeNull();
  });

  it("saute les entrées invalides de x-forwarded-for pour trouver la bonne", () => {
    expect(ipOf({ "x-forwarded-for": "garbage, 999.999.999.999, , 203.0.113.7" })).toBe(
      "203.0.113.7",
    );
  });

  it("une liste dans x-vercel-forwarded-for n'est pas exploitée (retombe sur les autres en-têtes)", () => {
    // Comportement actuel : la valeur n'est pas découpée sur les virgules.
    expect(
      ipOf({
        "x-vercel-forwarded-for": "203.0.113.7, 198.51.100.9",
        "x-forwarded-for": "192.0.2.5",
      }),
    ).toBe("192.0.2.5");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. src/lib/settings.ts — schémas
// ═══════════════════════════════════════════════════════════════════════════

describe("settings — bookingSettingsSchema", () => {
  it("applique tous les défauts sur un objet vide", () => {
    expect(bookingSettingsSchema.parse({})).toEqual({
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: "06:00",
      endHour: "23:00",
      meetDurationMin: 30,
      inPersonDurationMin: 60,
      bufferMin: 15,
      timezone: "America/Toronto",
      inPersonDefaultLocation: "",
    });
  });

  it("complète un objet partiel sans écraser les valeurs fournies", () => {
    const parsed = bookingSettingsSchema.parse({ days: [1, 2, 3], startHour: "09:00" });
    expect(parsed.days).toEqual([1, 2, 3]);
    expect(parsed.startHour).toBe("09:00");
    expect(parsed.endHour).toBe("23:00");
    expect(parsed.meetDurationMin).toBe(30);
    expect(parsed.timezone).toBe("America/Toronto");
  });

  it("accepte une liste de jours vide (aucun jour réservable)", () => {
    expect(bookingSettingsSchema.parse({ days: [] }).days).toEqual([]);
  });

  it("retire les clés inconnues", () => {
    const parsed = bookingSettingsSchema.parse({ days: [1], bogus: "x" } as never);
    expect(parsed).not.toHaveProperty("bogus");
  });

  it.each([
    ["jour > 6", { days: [7] }],
    ["jour < 0", { days: [-1] }],
    ["jours non tableau", { days: "lundi" }],
    ["jour non numérique", { days: ["1"] }],
    ["durée en chaîne", { meetDurationMin: "30" }],
    ["durée nulle (null)", { inPersonDurationMin: null }],
    ["buffer en chaîne", { bufferMin: "15" }],
    ["startHour numérique", { startHour: 9 }],
    ["timezone numérique", { timezone: 42 }],
    ["lieu par défaut non chaîne", { inPersonDefaultLocation: 12 }],
    ["racine null", null],
    ["racine tableau", []],
    ["racine chaîne", "booking"],
  ])("rejette : %s", (_label, value) => {
    expect(bookingSettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe("settings — googleSettingsSchema", () => {
  it("applique les défauts sur un objet vide", () => {
    expect(googleSettingsSchema.parse({})).toEqual({
      refreshTokenEnc: null,
      email: null,
      calendarId: "primary",
      connectedAt: null,
    });
  });

  it("accepte explicitement null pour les champs nullables", () => {
    const parsed = googleSettingsSchema.parse({ refreshTokenEnc: null, email: null, connectedAt: null });
    expect(parsed.refreshTokenEnc).toBeNull();
    expect(parsed.calendarId).toBe("primary");
  });

  it("conserve un état connecté partiel", () => {
    const parsed = googleSettingsSchema.parse({
      refreshTokenEnc: encryptSecret("refresh-token"),
      email: "courtier@nexus.ca",
    });
    expect(decryptSecret(parsed.refreshTokenEnc!)).toBe("refresh-token");
    expect(parsed.email).toBe("courtier@nexus.ca");
    expect(parsed.calendarId).toBe("primary");
    expect(parsed.connectedAt).toBeNull();
  });

  it.each([
    ["refreshTokenEnc numérique", { refreshTokenEnc: 123 }],
    ["email numérique", { email: 1 }],
    ["calendarId null", { calendarId: null }],
    ["calendarId numérique", { calendarId: 7 }],
    ["connectedAt Date (objet)", { connectedAt: new Date() }],
  ])("rejette : %s", (_label, value) => {
    expect(googleSettingsSchema.safeParse(value).success).toBe(false);
  });
});

describe("settings — telephonySettingsSchema", () => {
  it("applique le défaut voip.ms sur un objet vide", () => {
    expect(telephonySettingsSchema.parse({})).toEqual({ provider: "voipms" });
  });

  it.each(["voipms", "twilio"])("accepte le fournisseur %s", (provider) => {
    expect(telephonySettingsSchema.parse({ provider }).provider).toBe(provider);
  });

  it.each([
    ["fournisseur inconnu", { provider: "sip" }],
    ["casse différente", { provider: "Twilio" }],
    ["fournisseur null", { provider: null }],
    ["fournisseur numérique", { provider: 1 }],
  ])("rejette : %s", (_label, value) => {
    expect(telephonySettingsSchema.safeParse(value).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Téléphonie — innocuité SSR
// ═══════════════════════════════════════════════════════════════════════════

describe("telephony — les moteurs ne cassent pas le rendu serveur", () => {
  const ENGINES = [
    "src/lib/telephony/engines/jssip-engine.ts",
    "src/lib/telephony/engines/twilio-engine.ts",
  ];

  it("l'abstraction types.ts s'importe en environnement node (aucune API navigateur)", async () => {
    await expect(import("@/lib/telephony/types")).resolves.toBeDefined();
  });

  it("les moteurs sont marqués \"use client\"", () => {
    for (const file of ENGINES) {
      expect(src(file).trimStart().startsWith('"use client"'), file).toBe(true);
    }
  });

  it("aucun module ne fait d'import STATIQUE d'un moteur", () => {
    const offenders: string[] = [];
    const files = listSourceFiles(path.join(REPO, "src"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // import ... from "@/lib/telephony/engines/..."  → interdit (chargerait
      // jssip / @twilio/voice-sdk pendant le rendu serveur).
      if (/^\s*import\s[^\n]*from\s+["'][^"']*telephony\/engines\//m.test(text)) {
        offenders.push(path.relative(REPO, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("le contexte téléphonie n'instancie les moteurs que via import() dynamique", () => {
    const text = src("src/components/telephony/telephony-context.tsx");
    const refs = [...text.matchAll(/["'][^"']*telephony\/engines\/[\w-]+["']/g)];
    expect(refs.length).toBe(2); // jssip + twilio
    for (const ref of refs) {
      const before = text.slice(Math.max(0, ref.index! - 20), ref.index!);
      expect(before, `référence non dynamique: ${ref[0]}`).toMatch(/await import\(\s*$/);
    }
  });

  it("aucune API navigateur n'est touchée au niveau module dans les moteurs", () => {
    for (const file of ENGINES) {
      const moduleLevel = src(file)
        .split("\n")
        // Niveau module = colonne 0 (les corps de classe/fonction sont indentés).
        .filter((line) => line.length > 0 && !/^\s/.test(line))
        .join("\n");
      expect(moduleLevel, file).not.toMatch(/\b(window|document|navigator|localStorage)\b/);
    }
  });
});

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
