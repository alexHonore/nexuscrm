/**
 * Tests unitaires du différentiel d'audit (`diffFields`, `secretChange`).
 *
 * Le journal doit répondre à « qu'est-ce qui a changé ? » : uniquement les
 * champs modifiés, avec l'ancienne ET la nouvelle valeur — et JAMAIS un secret.
 *
 * Aucun accès réseau ni base. `server-only` est neutralisé (paquet marqueur
 * React, pas le code sous test).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

import { diffFields, isSecretField, SECRET_MARKERS, secretChange } from "@/lib/audit";
import { buildAuditEntry, type AuditLookups } from "@/app/(app)/admin/audit/audit-view";
import { fr } from "date-fns/locale";

afterAll(closeDb);

describe("audit — diffFields (champs modifiés seulement)", () => {
  it("ne retient que les champs réellement modifiés", () => {
    const before = { fullName: "Jean", phone: "+14184761542", city: "Québec" };
    const after = { fullName: "Jean", phone: "+15145550188", city: "Québec" };

    expect(diffFields(before, after, ["fullName", "phone", "city"])).toEqual({
      phone: { from: "+14184761542", to: "+15145550188" },
    });
  });

  it("renvoie null quand rien n'a bougé", () => {
    const row = { name: "Marie", isActive: true };
    expect(diffFields(row, { ...row }, ["name", "isActive"])).toBeNull();
  });

  it("ignore les champs absents de la liste demandée", () => {
    const changes = diffFields({ a: 1, b: 1 }, { a: 2, b: 2 }, ["a"]);
    expect(changes).toEqual({ a: { from: 1, to: 2 } });
  });

  it("traite `null`, `undefined` et la chaîne vide comme « rien »", () => {
    expect(diffFields({ email: null }, { email: "" }, ["email"])).toBeNull();
    expect(diffFields({ email: undefined }, { email: null }, ["email"])).toBeNull();
    expect(diffFields({ email: "" }, { email: "a@b.ca" }, ["email"])).toEqual({
      email: { from: null, to: "a@b.ca" },
    });
  });

  it("normalise les dates en ISO (comparables et sérialisables en JSON)", () => {
    const before = { dueAt: new Date("2026-03-01T15:00:00.000Z") };
    const after = { dueAt: new Date("2026-03-02T15:00:00.000Z") };

    expect(diffFields(before, after, ["dueAt"])).toEqual({
      dueAt: { from: "2026-03-01T15:00:00.000Z", to: "2026-03-02T15:00:00.000Z" },
    });
    // Même instant exprimé par deux objets Date distincts : aucun changement.
    expect(
      diffFields({ dueAt: new Date("2026-03-01T15:00:00Z") }, before, ["dueAt"]),
    ).toBeNull();
  });

  it("compare en profondeur (ordre des clés indifférent)", () => {
    expect(diffFields({ meta: { a: 1, b: 2 } }, { meta: { b: 2, a: 1 } }, ["meta"])).toBeNull();
    expect(diffFields({ ids: [1, 2] }, { ids: [2, 1] }, ["ids"])).toEqual({
      ids: { from: [1, 2], to: [2, 1] },
    });
  });

  it("décrit une création (avant = null) et une suppression (après = null)", () => {
    const client = { fullName: "Jean", phone: "+14184761542", notes: null };

    expect(diffFields(null, client, ["fullName", "phone", "notes"])).toEqual({
      fullName: { from: null, to: "Jean" },
      phone: { from: null, to: "+14184761542" },
    });
    expect(diffFields(client, null, ["fullName", "phone", "notes"])).toEqual({
      fullName: { from: "Jean", to: null },
      phone: { from: "+14184761542", to: null },
    });
  });
});

describe("audit — aucun secret dans le journal", () => {
  it("reconnaît les noms de champs sensibles", () => {
    for (const field of ["passwordHash", "sipPasswordEnc", "sipPassword", "refreshTokenEnc"]) {
      expect(isSecretField(field), field).toBe(true);
    }
    for (const field of ["fullName", "email", "didNumber", "sipUsername"]) {
      expect(isSecretField(field), field).toBe(false);
    }
  });

  it("remplace toute valeur sensible par un marqueur", () => {
    const changes = diffFields(
      { sipPasswordEnc: "chiffré-avant", passwordHash: "$2b$hash-avant" },
      { sipPasswordEnc: "chiffré-après", passwordHash: "$2b$hash-après" },
      ["sipPasswordEnc", "passwordHash"],
    );

    expect(changes).toEqual({
      sipPasswordEnc: { from: SECRET_MARKERS.set, to: SECRET_MARKERS.updated },
      passwordHash: { from: SECRET_MARKERS.set, to: SECRET_MARKERS.updated },
    });
    expect(JSON.stringify(changes)).not.toMatch(/chiffré|hash-avant|hash-après/);
  });

  it("masque aussi un secret imbriqué dans un objet", () => {
    const changes = diffFields(
      { google: { calendarId: "primary", refreshTokenEnc: "jeton-secret" } },
      { google: { calendarId: "equipe", refreshTokenEnc: "jeton-secret" } },
      ["google"],
    );
    expect(JSON.stringify(changes)).not.toContain("jeton-secret");
    expect(changes).toEqual({
      google: {
        from: { calendarId: "primary", refreshTokenEnc: SECRET_MARKERS.set },
        to: { calendarId: "equipe", refreshTokenEnc: SECRET_MARKERS.set },
      },
    });
  });

  it("secretChange dit seulement s'il y avait puis s'il y a une valeur", () => {
    expect(secretChange(true)).toEqual({ from: SECRET_MARKERS.set, to: SECRET_MARKERS.updated });
    expect(secretChange(false)).toEqual({ from: SECRET_MARKERS.none, to: SECRET_MARKERS.updated });
    expect(secretChange(true, false)).toEqual({
      from: SECRET_MARKERS.set,
      to: SECRET_MARKERS.none,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mise en forme de l'écran /admin/audit
// ═══════════════════════════════════════════════════════════════════════════

const MESSAGES: Record<string, string> = {
  "audit.system": "Système",
  "audit.detail": "Détail",
  "audit.yes": "Oui",
  "audit.no": "Non",
  "audit.secret.set": "défini (valeur masquée)",
  "audit.secret.updated": "modifié (valeur masquée)",
  "audit.actions.client_update": "Fiche client modifiée",
  "audit.entities.client": "Client",
  "audit.fields.categoryId": "Catégorie",
  "audit.fields.assignedToId": "Assigné à",
  "audit.fields.isActive": "Compte actif",
  "audit.fields.sipPassword": "Mot de passe SIP",
  "audit.fields.phone": "Téléphone",
  "audit.fields.changed": "Champs touchés",
  "audit.fields.didNumber": "Numéro (DID)",
};

const t = Object.assign((key: string) => MESSAGES[key] ?? key, {
  has: (key: string) => key in MESSAGES,
  raw: (key: string) => MESSAGES[key],
});

const LOOKUPS: AuditLookups = {
  users: new Map([["9f1d0d5e-6a3f-4f3c-9d3a-1f2e3d4c5b6a", "Marie Tremblay"]]),
  categories: new Map([
    [1, "Non contacté"],
    [2, "Rappel"],
  ]),
  sources: new Map([[3, "Facebook"]]),
  clients: new Map([["11111111-2222-3333-4444-555555555555", "Jean Tremblay"]]),
};

const base = { t, dateLocale: fr, lookups: LOOKUPS };

function log(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    action: "client.update",
    entity: "client",
    entityId: "11111111-2222-3333-4444-555555555555",
    detail: null as unknown,
    ip: "24.201.0.10",
    createdAt: new Date("2026-03-02T20:30:00.000Z"),
    ...over,
  };
}

describe("audit — mise en forme des entrées", () => {
  it("résout les id en noms, traduit les libellés et rend les valeurs lisibles", () => {
    const entry = buildAuditEntry(
      log({
        detail: {
          changes: {
            categoryId: { from: 1, to: 2 },
            assignedToId: { from: null, to: "9f1d0d5e-6a3f-4f3c-9d3a-1f2e3d4c5b6a" },
            isActive: { from: true, to: false },
            phone: { from: "+14184761542", to: "+15145550188" },
          },
        },
      }),
      "Marie Tremblay",
      base,
    );

    expect(entry.actionLabel).toBe("Fiche client modifiée");
    expect(entry.entityLabel).toBe("Client");
    expect(entry.entityName).toBe("Jean Tremblay");
    expect(entry.entityHref).toBe("/clients/11111111-2222-3333-4444-555555555555");
    // 20:30 UTC le 2 mars = 15:30 à Montréal (heure normale de l'Est).
    expect(entry.dateLabel).toContain("15:30");

    const byField = Object.fromEntries(entry.changes.map((c) => [c.field, c]));
    expect(byField.categoryId).toMatchObject({
      label: "Catégorie",
      from: { text: "Non contacté" },
      to: { text: "Rappel" },
    });
    expect(byField.assignedToId.from).toEqual({ text: "—", empty: true });
    expect(byField.assignedToId.to.text).toBe("Marie Tremblay");
    expect(byField.isActive.from.text).toBe("Oui");
    expect(byField.isActive.to.text).toBe("Non");
    expect(byField.phone.to.text).toBe("(514) 555-0188");
  });

  it("affiche un secret comme un marqueur traduit, jamais une valeur", () => {
    const entry = buildAuditEntry(
      log({
        action: "user.update",
        entity: "user",
        detail: {
          changes: { sipPassword: { from: SECRET_MARKERS.set, to: SECRET_MARKERS.updated } },
        },
      }),
      "Admin",
      base,
    );
    expect(entry.changes[0]).toMatchObject({
      label: "Mot de passe SIP",
      from: { text: "défini (valeur masquée)" },
      to: { text: "modifié (valeur masquée)" },
    });
  });

  it("rend lisibles les entrées anciennes ({from, to} à la racine)", () => {
    const entry = buildAuditEntry(
      log({ action: "client.category", detail: { from: 1, to: 2 } }),
      "Marie Tremblay",
      base,
    );
    expect(entry.changes).toEqual([
      {
        field: "categoryId",
        label: "Catégorie",
        from: { text: "Non contacté" },
        to: { text: "Rappel" },
      },
    ]);
    // Les clés brutes ne sont pas répétées dans le contexte.
    expect(entry.facts).toEqual([]);
  });

  it("n'ouvre jamais un dialogue vide : sans changements, le contexte reste", () => {
    const entry = buildAuditEntry(
      log({ action: "user.update", entity: "user", detail: { changed: ["didNumber"] } }),
      null,
      base,
    );
    expect(entry.changes).toEqual([]);
    expect(entry.userLabel).toBe("Système");
    expect(entry.isSystem).toBe(true);
    expect(entry.facts).toEqual([
      { key: "changed", label: "Champs touchés", value: { text: "Numéro (DID)" } },
    ]);
    expect(entry.rawJson).toContain("didNumber");
  });

  it("ne propose pas de lien vers une fiche supprimée", () => {
    const entry = buildAuditEntry(
      log({ action: "client.delete", entityId: "00000000-0000-4000-8000-000000000000" }),
      "Admin",
      base,
    );
    expect(entry.entityHref).toBeNull();
    expect(entry.entityName).toBeNull();
  });
});

describe("audit — le contexte ne répète pas ce qui est déjà en avant → après", () => {
  it("masque les clés du detail déjà présentées comme un changement", () => {
    const entry = buildAuditEntry(
      log({
        action: "client.create",
        detail: {
          fullName: "Jean Tremblay",
          phone: "+14184761542",
          changes: {
            fullName: { from: null, to: "Jean Tremblay" },
            phone: { from: null, to: "+14184761542" },
          },
        },
      }),
      "Marie Tremblay",
      base,
    );
    expect(entry.changes).toHaveLength(2);
    expect(entry.facts).toEqual([]);
    // Le JSON brut reste intégralement disponible.
    expect(entry.rawJson).toContain("Jean Tremblay");
  });
});
