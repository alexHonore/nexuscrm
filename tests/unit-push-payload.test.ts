/**
 * Unitaire — ce qui voyage jusqu'au téléphone, et ce qui n'y arrive pas.
 *
 * Ce que ces tests protègent : la RFC 8030 garantit 4096 OCTETS pour le corps
 * chiffré, et l'enveloppe aes128gcm en mange une centaine avant le premier
 * caractère utile. Dépasser ne produit AUCUNE erreur visible chez nous — le
 * service de push répond 413, l'envoi est compté comme parti, et la
 * notification n'apparaît jamais. C'est la panne la plus difficile à
 * diagnostiquer de toute la chaîne, parce qu'elle ne se déclenche que sur les
 * messages longs : tout marche en démonstration, rien ne marche le jour où un
 * client écrit un paragraphe.
 *
 * Et le compte est en octets, pas en caractères. « Rendez-vous confirmé » coûte
 * deux octets par accent : couper à l'octet près scinde un « é » en deux, et le
 * téléphone affiche un losange noir à la place du dernier mot. Dans une
 * application entièrement française, ce n'est pas un cas limite — c'est le cas
 * ordinaire.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PUSH_BYTES,
  buildPushPayload,
  clampBytes,
  pushOptionsFor,
  serializePushPayload,
  type PushPayload,
} from "@/lib/push/payload";
import { pushRule } from "@/lib/push/policy";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Le caractère de remplacement : la trace d'un octet coupé au mauvais endroit. */
const REPLACEMENT = "�";

const payload = (overrides: Partial<PushPayload> = {}): PushPayload => ({
  title: "Nouveau message",
  body: null,
  url: "/notifications",
  tag: "client:0000000a-0000-4000-8000-000000000000",
  type: "sms_inbound",
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════
// clampBytes — on coupe entre les caractères, jamais dedans
// ═══════════════════════════════════════════════════════════════════════════

describe("clampBytes", () => {
  it("ne scinde JAMAIS un caractère multi-octets", () => {
    // Un « é » vaut deux octets : couper à l'octet impair laisse une moitié de
    // caractère que le décodeur remplace par un losange noir. On balaie toutes
    // les limites autour du budget pour attraper le décalage d'un octet.
    const accents = "é".repeat(500);
    for (let max = 4; max <= 60; max++) {
      const out = clampBytes(accents, max);
      expect(bytes(out), `${max} octets`).toBeLessThanOrEqual(max);
      // Aller-retour UTF-8 : un caractère amputé ne survit pas au décodage.
      expect(Buffer.from(out, "utf8").toString("utf8"), `${max} octets`).toBe(out);
      expect(out, `${max} octets`).not.toContain(REPLACEMENT);
    }
  });

  it("tient aussi pour les caractères hors du plan de base", () => {
    // Un emoji vaut quatre octets et s'écrit sur DEUX unités de code : itérer
    // sur les indices au lieu des caractères le couperait en deux moitiés
    // invalides. Les clients en mettent dans leurs textos.
    const emojis = "🏠".repeat(200);
    for (let max = 6; max <= 40; max++) {
      const out = clampBytes(emojis, max);
      expect(bytes(out), `${max} octets`).toBeLessThanOrEqual(max);
      expect(out, `${max} octets`).not.toContain(REPLACEMENT);
      expect([...out].every((c) => c === "🏠" || c === "…"), `${max} octets`).toBe(true);
    }
  });

  it("laisse intact ce qui tient déjà, sans ajouter de points de suspension", () => {
    // Le contraire ferait apparaître « … » à la fin de titres complets, ce qui
    // laisse croire qu'il manque quelque chose.
    expect(clampBytes("Rendez-vous confirmé", 200)).toBe("Rendez-vous confirmé");
    // Pile à la limite, en octets : 20 caractères dont un accent = 21 octets.
    expect(clampBytes("Rendez-vous confirmé", 21)).toBe("Rendez-vous confirmé");
    expect(clampBytes("Rendez-vous confirmé", 20)).not.toBe("Rendez-vous confirmé");
  });

  it("signale la coupe plutôt que de laisser une phrase tronquée sans le dire", () => {
    const out = clampBytes("é".repeat(500), 40);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPushPayload — un corps absent n'est pas un corps vide
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPushPayload", () => {
  it("un corps nul ne devient pas une chaîne vide", () => {
    // Une notification réduite à son titre AVEC une clé `body: ""` s'affiche de
    // travers sur certains lanceurs Android : une deuxième ligne blanche sous
    // le titre, comme si le texte n'avait pas chargé. L'absence se dit `null`.
    const built = buildPushPayload({
      type: "missed_call",
      title: "Appel manqué",
      body: null,
      link: null,
    });
    expect(built.body).toBeNull();
    expect(serializePushPayload(built)).not.toContain('"body":""');
    // Une chaîne vide venue de la base est traitée comme une absence, pas
    // recopiée telle quelle.
    const empty = buildPushPayload({ type: "system", title: "Avis", body: "", link: null });
    expect(empty.body).toBeNull();
    expect(serializePushPayload(empty)).not.toContain('"body":""');
  });

  it("un lien disparu mène quand même quelque part", () => {
    // Une notification qu'on touche et qui n'ouvre rien fait croire que
    // l'application est cassée : le geste a été fait pour rien.
    expect(buildPushPayload({ type: "system", title: "Avis", body: null, link: null }).url)
      .toBe("/notifications");
    expect(
      buildPushPayload({ type: "mention", title: "M", body: null, link: "/clients/x" }).url,
    ).toBe("/clients/x");
  });

  it("le badge n'apparaît que s'il a été demandé", () => {
    const without = buildPushPayload({ type: "system", title: "A", body: null, link: null });
    expect("badge" in without).toBe(false);
    const with3 = buildPushPayload({ type: "system", title: "A", body: null, link: null, badge: 3 });
    expect(with3.badge).toBe(3);
    // Zéro est une valeur : c'est ce qui EFFACE la pastille sur l'icône.
    const zero = buildPushPayload({ type: "system", title: "A", body: null, link: null, badge: 0 });
    expect(zero.badge).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// serializePushPayload — l'enveloppe tient, quoi qu'on y mette
// ═══════════════════════════════════════════════════════════════════════════

describe("serializePushPayload", () => {
  it("tient dans l'enveloppe même pour un corps de 10 000 caractères accentués", () => {
    // 10 000 « é » = 20 000 octets, cinq fois le plafond absolu. Le service de
    // push répondrait 413 et la notification n'existerait pour personne.
    const json = serializePushPayload(payload({ body: "é".repeat(10_000) }));
    expect(bytes(json)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    const parsed = JSON.parse(json) as PushPayload;
    expect(parsed.title).toBe("Nouveau message");
    expect(parsed.url).toBe("/notifications");
    // Amputé, mais lisible : ni moitié de caractère, ni losange noir.
    expect(parsed.body).not.toContain(REPLACEMENT);
    expect(parsed.body).not.toBeNull();
  });

  it("tient aussi quand le corps est fait d'emojis, où chaque signe vaut quatre octets", () => {
    const json = serializePushPayload(payload({ body: "🏠".repeat(10_000) }));
    expect(bytes(json)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    expect(JSON.parse(json).body).not.toContain(REPLACEMENT);
  });

  it("tient encore quand le titre lui-même est démesuré", () => {
    // Dernier recours : le titre seul, borné. Un titre géant venu d'un import
    // ne doit pas emporter toute la notification avec lui.
    const json = serializePushPayload(payload({ title: "é".repeat(10_000), body: "é".repeat(10_000) }));
    expect(bytes(json)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    expect(JSON.parse(json).title).not.toContain(REPLACEMENT);
  });

  it("ne rogne rien quand rien ne dépasse", () => {
    // Le contraire — un texte raboté « par précaution » — enlèverait la fin des
    // messages courts, c'est-à-dire de la quasi-totalité d'entre eux.
    const p = payload({ body: "Marie Tremblay a répondu : « Oui, jeudi 14 h me convient. »" });
    expect(JSON.parse(serializePushPayload(p))).toEqual(p);
  });

  it("ce qui sort est toujours du JSON que le service worker peut lire", () => {
    // `public/sw.js` ne partage aucun type avec l'application : il ne peut rien
    // déduire, il ne fait que `JSON.parse`. Du JSON invalide, c'est une
    // notification muette de plus.
    for (const body of [null, "", "é".repeat(10_000), '"guillemets" et \\ contre-obliques', "\n\t"]) {
      const json = serializePushPayload(payload({ body }));
      expect(() => JSON.parse(json) as PushPayload, JSON.stringify(body).slice(0, 40)).not.toThrow();
      expect(bytes(json)).toBeLessThanOrEqual(MAX_PUSH_BYTES);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pushOptionsFor — la durée de vie vient du TYPE, pas de l'appelant
// ═══════════════════════════════════════════════════════════════════════════

describe("pushOptionsFor", () => {
  it("reprend exactement la règle du type", () => {
    // Une notification d'appel manqué qui arrive deux heures plus tard
    // n'informe plus : elle ment. La durée de vie est une décision de la
    // politique, jamais un chiffre recopié dans un producteur.
    for (const type of ["missed_call", "followup_due", "system"]) {
      expect(pushOptionsFor(type), type).toEqual({
        ttl: pushRule(type).ttl,
        urgency: pushRule(type).urgency,
      });
    }
  });
});
