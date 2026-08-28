/**
 * Unitaire — la MATRICE des droits, sans base ni session.
 *
 * Tout ce qui décide « qui voit quoi » est pur (src/lib/permissions/access.ts),
 * et c'est délibéré : une matrice de droits ne se vérifie pas à l'œil sur un
 * écran, elle se vérifie en posant la question et en lisant la réponse. Ce
 * fichier pose les questions que l'exploitant a posées le 2026-08-28 —
 * « quand une fiche est à moi, que reste-t-il au téléphoniste ? », « peut-il
 * voler le lead d'un collègue ? » — et fige les réponses.
 *
 * Seule la RÉSOLUTION est testée ici. Que chaque écran interroge bien la
 * matrice est l'affaire de tests/int-permissions.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  bucketFor,
  can,
  canAssignTo,
  canClaim,
  canRelease,
  grantsFor,
  lockExpired,
  readScope,
  roleById,
  roleForUser,
} from "@/lib/permissions/access";
import { GRANT_KEYS, LOCKED_TO_ADMIN, PERMISSION_KEYS } from "@/lib/permissions/catalog";
import {
  ADMIN_ROLE_ID,
  CALLER_ROLE_ID,
  OBSERVER_ROLE_ID,
  SUPERVISOR_ROLE_ID,
  defaultPermissionsConfig,
} from "@/lib/permissions/defaults";
import { permissionsSettingsSchema, repairConfig } from "@/lib/permissions/schema";
import type { PermissionsConfig, Role } from "@/lib/permissions/types";

// ── Décor ────────────────────────────────────────────────────────────────────

const PATRON = "11111111-1111-1111-1111-111111111111";
const CHEF = "22222222-2222-2222-2222-222222222222";
const LUC = "33333333-3333-3333-3333-333333333333";
const MARIE = "44444444-4444-4444-4444-444444444444";
const STAGIAIRE = "55555555-5555-5555-5555-555555555555";

function config(): PermissionsConfig {
  const base = defaultPermissionsConfig();
  return {
    ...base,
    userRoles: {
      [CHEF]: SUPERVISOR_ROLE_ID,
      [LUC]: CALLER_ROLE_ID,
      [MARIE]: CALLER_ROLE_ID,
      [STAGIAIRE]: OBSERVER_ROLE_ID,
    },
  };
}

function role(cfg: PermissionsConfig, id: string): Role {
  const found = roleById(cfg, id);
  if (!found) throw new Error(`rôle absent du décor : ${id}`);
  return found;
}

const NOW = new Date("2026-08-28T15:00:00.000Z");
const HIER = new Date("2026-08-27T15:00:00.000Z");
const LE_MOIS_DERNIER = new Date("2026-07-20T15:00:00.000Z");

/** Une fiche, réduite à ce qui décide de l'accès. */
function fiche(assignedToId: string | null, lastContactedAt: Date | null = HIER) {
  return { assignedToId, lastContactedAt, updatedAt: HIER };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("rôle effectif", () => {
  it("le plancher de la base prime : un compte admin reste administrateur", () => {
    const cfg = config();
    // Même affecté « observateur » par une clé JSON douteuse.
    const trafique = { ...cfg, userRoles: { ...cfg.userRoles, [PATRON]: OBSERVER_ROLE_ID } };
    expect(roleForUser(trafique, { id: PATRON, role: "admin" }).id).toBe(ADMIN_ROLE_ID);
  });

  it("un compte sans affectation retombe sur le rôle par défaut", () => {
    const cfg = config();
    expect(roleForUser(cfg, { id: "inconnu", role: "caller" }).id).toBe(CALLER_ROLE_ID);
  });

  it("une affectation vers le rôle administrateur ne fait PAS un administrateur", () => {
    // Sans ça, une clé JSON suffirait à contourner `users.role`.
    const cfg = { ...config(), userRoles: { [LUC]: ADMIN_ROLE_ID } };
    expect(roleForUser(cfg, { id: LUC, role: "caller" }).id).toBe(CALLER_ROLE_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("droits", () => {
  it("l'administrateur a TOUS les droits, sans qu'aucun soit coché", () => {
    const cfg = config();
    const admin = role(cfg, ADMIN_ROLE_ID);
    expect(Object.keys(admin.perms)).toHaveLength(0);
    for (const key of PERMISSION_KEYS) expect(can(admin, key), key).toBe(true);
  });

  it("personne d'autre ne peut détenir les clés de la maison", () => {
    const cfg = config();
    for (const id of [SUPERVISOR_ROLE_ID, CALLER_ROLE_ID, OBSERVER_ROLE_ID]) {
      const r = { ...role(cfg, id), perms: Object.fromEntries(LOCKED_TO_ADMIN.map((k) => [k, true])) };
      for (const key of LOCKED_TO_ADMIN) expect(can(r, key), `${id}/${key}`).toBe(false);
    }
  });

  it("le superviseur voit les statistiques et les appels, jamais les réglages", () => {
    const cfg = config();
    const chef = role(cfg, SUPERVISOR_ROLE_ID);
    expect(can(chef, "admin.analytics")).toBe(true);
    expect(can(chef, "admin.calls")).toBe(true);
    expect(can(chef, "admin.settings")).toBe(false);
    expect(can(chef, "admin.billing")).toBe(false);
    expect(can(chef, "clients.delete")).toBe(false);
    expect(can(chef, "clients.export")).toBe(false);
  });

  it("l'observateur ne peut ni appeler, ni commenter, ni modifier", () => {
    const cfg = config();
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    for (const key of ["clients.call", "clients.comment", "clients.edit", "clients.sms"] as const) {
      expect(can(stagiaire, key), key).toBe(false);
    }
    expect(can(stagiaire, "clients.history")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la fiche du patron", () => {
  const cfg = config();
  const luc = role(cfg, CALLER_ROLE_ID);
  const patron = role(cfg, ADMIN_ROLE_ID);

  it("est INVISIBLE pour un téléphoniste — la décision du 2026-08-28", () => {
    const g = grantsFor(cfg, luc, bucketFor(LUC, fiche(PATRON), patron));
    expect(g.visible).toBe(false);
    for (const key of GRANT_KEYS) expect(g[key], key).toBe(false);
  });

  it("est invisible pour l'observateur aussi", () => {
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    expect(grantsFor(cfg, stagiaire, bucketFor(STAGIAIRE, fiche(PATRON), patron)).visible).toBe(false);
  });

  it("reste ouverte au superviseur", () => {
    const chef = role(cfg, SUPERVISOR_ROLE_ID);
    const g = grantsFor(cfg, chef, bucketFor(CHEF, fiche(PATRON), patron));
    expect(g.visible).toBe(true);
    expect(g.edit).toBe(true);
    expect(g.assign).toBe(true);
    // Le superviseur ne supprime rien : le droit lui manque, donc la case
    // reste fermée même si la relation l'ouvrait.
    expect(g.delete).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la fiche d'un collègue", () => {
  const cfg = config();
  const luc = role(cfg, CALLER_ROLE_ID);
  const marieRole = role(cfg, CALLER_ROLE_ID);

  it("se VOIT — pour ne pas la rappeler — mais rien de plus", () => {
    const g = grantsFor(cfg, luc, bucketFor(LUC, fiche(MARIE), marieRole));
    expect(g.visible).toBe(true);
    expect(g.contact).toBe(false);
    expect(g.history).toBe(false);
    expect(g.comment).toBe(false);
    expect(g.edit).toBe(false);
    expect(g.call).toBe(false);
    expect(g.assign).toBe(false);
  });

  it("ses propres fiches, elles, sont grandes ouvertes", () => {
    const g = grantsFor(cfg, luc, bucketFor(LUC, fiche(LUC), luc));
    expect(g.visible).toBe(true);
    expect(g.contact).toBe(true);
    expect(g.call).toBe(true);
    expect(g.comment).toBe(true);
    expect(g.edit).toBe(true);
    expect(g.delete).toBe(false);
  });

  it("le bassin est ouvert : c'est là qu'il se sert", () => {
    const g = grantsFor(cfg, luc, bucketFor(LUC, fiche(null), null));
    expect(g.visible).toBe(true);
    expect(g.call).toBe(true);
    expect(g.assign).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("le plafond ferme ce que la relation ouvre", () => {
  it("une case de relation ne s'ouvre pas si le droit manque", () => {
    const cfg = config();
    const base = role(cfg, CALLER_ROLE_ID);
    // On lui retire le droit d'appeler, on laisse la relation grande ouverte.
    const sansTelephone: Role = { ...base, perms: { ...base.perms, "clients.call": false } };
    const g = grantsFor(cfg, sansTelephone, "own");
    expect(g.call).toBe(false);
    expect(g.comment).toBe(true);
  });

  it("« visible » n'a pas de plafond : la relation seule décide", () => {
    const cfg = config();
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    expect(grantsFor(cfg, stagiaire, "own").visible).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("portée de lecture (ce que voit une LISTE)", () => {
  const cfg = config();
  const usersByRole = new Map<string, string[]>([
    [ADMIN_ROLE_ID, [PATRON]],
    [SUPERVISOR_ROLE_ID, [CHEF]],
    [CALLER_ROLE_ID, [LUC, MARIE]],
    [OBSERVER_ROLE_ID, [STAGIAIRE]],
  ]);

  it("l'administrateur voit tout, sans filtre", () => {
    expect(readScope(cfg, role(cfg, ADMIN_ROLE_ID), PATRON, usersByRole)).toEqual({ kind: "all" });
  });

  it("le superviseur aussi — toutes ses relations sont ouvertes", () => {
    expect(readScope(cfg, role(cfg, SUPERVISOR_ROLE_ID), CHEF, usersByRole)).toEqual({ kind: "all" });
  });

  it("le téléphoniste voit les siennes, le bassin et ses collègues — jamais le patron", () => {
    const scope = readScope(cfg, role(cfg, CALLER_ROLE_ID), LUC, usersByRole);
    expect(scope.kind).toBe("some");
    if (scope.kind !== "some") return;
    expect(scope.own).toBe(true);
    expect(scope.unassigned).toBe(true);
    expect(scope.userIds).toContain(MARIE);
    expect(scope.userIds).toContain(CHEF);
    expect(scope.userIds).not.toContain(PATRON);
    expect(scope.userIds).not.toContain(LUC);
  });

  it("un rôle qui ne voit rien rend une portée VIDE, pas une portée absente", () => {
    const cfg2 = config();
    const aveugle: Role = {
      ...role(cfg2, OBSERVER_ROLE_ID),
      id: "aveugle",
      relations: {},
      superAdmin: false,
    };
    const cfg3 = { ...cfg2, roles: [...cfg2.roles, aveugle], defaultRoleId: "aveugle" };
    expect(readScope(cfg3, aveugle, STAGIAIRE, usersByRole)).toEqual({ kind: "none" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("anti-vol de leads", () => {
  const cfg = config();
  const luc = role(cfg, CALLER_ROLE_ID);
  const chef = role(cfg, SUPERVISOR_ROLE_ID);
  const marieRole = role(cfg, CALLER_ROLE_ID);

  it("il prend une fiche du bassin", () => {
    expect(canClaim(cfg, luc, LUC, fiche(null), null, 0, NOW)).toEqual({ ok: true });
  });

  it("il ne prend PAS celle d'un collègue", () => {
    expect(canClaim(cfg, luc, LUC, fiche(MARIE), marieRole, 0, NOW)).toEqual({
      ok: false,
      reason: "not_allowed_here",
    });
  });

  it("le superviseur, lui, la reprend", () => {
    expect(canClaim(cfg, chef, CHEF, fiche(MARIE), marieRole, 0, NOW)).toEqual({ ok: true });
  });

  it("le verrou saute après 14 jours sans contact", () => {
    const froide = fiche(MARIE, LE_MOIS_DERNIER);
    // La relation « collègue » ferme l'assignation : même un verrou expiré ne
    // la rouvre pas. C'est le compartiment qui tranche en premier.
    expect(canClaim(cfg, luc, LUC, froide, marieRole, 0, NOW)).toEqual({
      ok: false,
      reason: "not_allowed_here",
    });
    // Avec la case ouverte, le verrou expiré devient la seule question.
    const ouvert: Role = {
      ...luc,
      relations: { ...luc.relations, [`role:${CALLER_ROLE_ID}`]: { visible: true, assign: true } },
    };
    expect(canClaim(cfg, ouvert, LUC, froide, marieRole, 0, NOW)).toEqual({ ok: true });
    expect(canClaim(cfg, ouvert, LUC, fiche(MARIE), marieRole, 0, NOW)).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("le plafond arrête l'appétit, pas la distribution", () => {
    expect(canClaim(cfg, luc, LUC, fiche(null), null, 50, NOW)).toEqual({
      ok: false,
      reason: "cap_reached",
    });
    // Le patron la lui DONNE : le plafond ne s'applique pas.
    const patron = role(cfg, ADMIN_ROLE_ID);
    expect(canAssignTo(cfg, patron, PATRON, fiche(null), null, LUC, 999, NOW)).toEqual({ ok: true });
  });

  it("il rend sa fiche, mais ne rend pas celle des autres", () => {
    expect(canRelease(cfg, luc, LUC, fiche(LUC), luc, NOW)).toEqual({ ok: true });
    expect(canRelease(cfg, luc, LUC, fiche(MARIE), marieRole, NOW)).toEqual({
      ok: false,
      reason: "not_allowed_here",
    });
  });

  it("il ne distribue pas le travail d'autrui", () => {
    expect(canAssignTo(cfg, luc, LUC, fiche(null), null, MARIE, 0, NOW)).toEqual({
      ok: false,
      reason: "no_right",
    });
  });

  it("l'observateur ne touche à aucune assignation", () => {
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    expect(canClaim(cfg, stagiaire, STAGIAIRE, fiche(null), null, 0, NOW).ok).toBe(false);
  });

  it("« jamais » veut dire jamais : à 0 jour, le verrou ne saute pas", () => {
    expect(lockExpired(fiche(MARIE, LE_MOIS_DERNIER), 0, NOW)).toBe(false);
    expect(lockExpired(fiche(MARIE, LE_MOIS_DERNIER), 14, NOW)).toBe(true);
    expect(lockExpired(fiche(MARIE, HIER), 14, NOW)).toBe(false);
  });

  it("une fiche jamais contactée se juge sur sa dernière modification", () => {
    expect(lockExpired({ assignedToId: MARIE, lastContactedAt: null, updatedAt: LE_MOIS_DERNIER }, 14, NOW)).toBe(true);
    expect(lockExpired({ assignedToId: MARIE, lastContactedAt: null, updatedAt: HIER }, 14, NOW)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("réparation de la configuration", () => {
  const parse = (raw: unknown) => permissionsSettingsSchema.parse(raw);

  it("une configuration vide rend les quatre rôles livrés", () => {
    const cfg = parse({});
    expect(cfg.roles.map((r) => r.id).sort()).toEqual(
      [ADMIN_ROLE_ID, CALLER_ROLE_ID, OBSERVER_ROLE_ID, SUPERVISOR_ROLE_ID].sort(),
    );
    expect(cfg.defaultRoleId).toBe(CALLER_ROLE_ID);
  });

  it("un rôle livré supprimé à la main revient", () => {
    const cfg = parse({ roles: [{ id: "bidule", nameFr: "Bidule", nameEn: "Thing" }] });
    expect(roleById(cfg, ADMIN_ROLE_ID)).not.toBeNull();
    expect(roleById(cfg, "bidule")).not.toBeNull();
  });

  it("il n'y a jamais deux administrateurs", () => {
    const cfg = parse({
      roles: [
        { id: "pirate", nameFr: "Pirate", nameEn: "Pirate", superAdmin: true },
        { id: ADMIN_ROLE_ID, nameFr: "Admin", nameEn: "Admin", superAdmin: true },
      ],
    });
    expect(cfg.roles.filter((r) => r.superAdmin).map((r) => r.id)).toEqual([ADMIN_ROLE_ID]);
  });

  it("un rôle ne s'accorde pas les clés de la maison", () => {
    const cfg = parse({
      roles: [
        {
          id: "pirate",
          nameFr: "Pirate",
          nameEn: "Pirate",
          perms: { "admin.roles": true, "admin.users": true, "admin.audit": true },
        },
      ],
    });
    const pirate = role(cfg, "pirate");
    expect(pirate.perms["admin.roles"]).toBeUndefined();
    expect(pirate.perms["admin.users"]).toBeUndefined();
    expect(pirate.perms["admin.audit"]).toBe(true);
  });

  it("le rôle par défaut ne peut pas être l'administrateur", () => {
    expect(parse({ defaultRoleId: ADMIN_ROLE_ID }).defaultRoleId).toBe(CALLER_ROLE_ID);
    expect(parse({ defaultRoleId: "fantome" }).defaultRoleId).toBe(CALLER_ROLE_ID);
  });

  it("une affectation vers un rôle disparu est oubliée", () => {
    const cfg = parse({ userRoles: { [LUC]: "fantome", [MARIE]: SUPERVISOR_ROLE_ID } });
    expect(cfg.userRoles[LUC]).toBeUndefined();
    expect(cfg.userRoles[MARIE]).toBe(SUPERVISOR_ROLE_ID);
  });

  it("un droit inventé est jeté, pas conservé", () => {
    const cfg = parse({
      roles: [{ id: "bidule", nameFr: "B", nameEn: "B", perms: { "clients.tout": true, "clients.edit": true } }],
    });
    expect(role(cfg, "bidule").perms).toEqual({ "clients.edit": true });
  });

  it("une case AJOUTÉE au catalogue arrive réglée comme le rôle livré", () => {
    // Le cas réel : une configuration enregistrée AVANT que la case existe.
    // La lire comme fermée serait prudent et faux — l'exploitant n'a rien
    // fermé, et il verrait un bouton disparaître sans avoir touché à rien.
    const stored = JSON.parse(JSON.stringify(defaultPermissionsConfig())) as PermissionsConfig;
    for (const r of stored.roles) {
      for (const bucket of Object.keys(r.relations)) {
        delete (r.relations[bucket] as Record<string, boolean>).assistant;
      }
    }
    const repaired = parse(stored);
    const luc = role(repaired, CALLER_ROLE_ID);
    expect(grantsFor(repaired, luc, "own").assistant).toBe(true);
    expect(grantsFor(repaired, luc, `role:${CALLER_ROLE_ID}`).assistant).toBe(false);
  });

  it("un rôle SUR MESURE, lui, reçoit la case neuve fermée", () => {
    // Personne ne peut deviner l'intention d'un rôle inventé : on ferme, et
    // l'écran le montre fermé.
    const cfg = parse({
      roles: [
        { id: "maison", nameFr: "Maison", nameEn: "House", relations: { own: { visible: true } } },
      ],
    });
    expect(grantsFor(cfg, role(cfg, "maison"), "own").assistant).toBe(false);
  });

  it("réparer une configuration déjà saine ne la change pas", () => {
    const once = parse(config());
    const twice = repairConfig(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("les assistants : lire, écrire, brancher", () => {
  const cfg = config();

  it("le superviseur LIT les assistants, il ne les réécrit pas", () => {
    const chef = role(cfg, SUPERVISOR_ROLE_ID);
    expect(can(chef, "admin.assistants")).toBe(true);
    expect(can(chef, "admin.assistantsEdit")).toBe(false);
  });

  it("le téléphoniste n'ouvre pas l'écran des assistants", () => {
    const luc = role(cfg, CALLER_ROLE_ID);
    expect(can(luc, "admin.assistants")).toBe(false);
    expect(can(luc, "admin.assistantsEdit")).toBe(false);
  });

  it("mais il branche un assistant sur SES fiches, et sur le bassin", () => {
    const luc = role(cfg, CALLER_ROLE_ID);
    expect(can(luc, "conversations.assistant")).toBe(true);
    expect(grantsFor(cfg, luc, "own").assistant).toBe(true);
    expect(grantsFor(cfg, luc, "unassigned").assistant).toBe(true);
  });

  it("jamais sur la fiche d'un collègue ni sur celle du patron", () => {
    const luc = role(cfg, CALLER_ROLE_ID);
    const marieRole = role(cfg, CALLER_ROLE_ID);
    const patron = role(cfg, ADMIN_ROLE_ID);
    expect(grantsFor(cfg, luc, bucketFor(LUC, fiche(MARIE), marieRole)).assistant).toBe(false);
    expect(grantsFor(cfg, luc, bucketFor(LUC, fiche(PATRON), patron)).assistant).toBe(false);
  });

  it("l'observateur ne branche rien du tout", () => {
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    expect(can(stagiaire, "conversations.assistant")).toBe(false);
    expect(grantsFor(cfg, stagiaire, "own").assistant).toBe(false);
  });

  it("retirer le droit ferme la case, même ouverte dans la relation", () => {
    const base = role(cfg, CALLER_ROLE_ID);
    const sansRobot: Role = {
      ...base,
      perms: { ...base.perms, "conversations.assistant": false },
    };
    expect(grantsFor(cfg, sansRobot, "own").assistant).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("les SMS : voir et écrire, séparément", () => {
  const cfg = config();

  it("le téléphoniste voit les conversations ET peut y répondre", () => {
    const luc = role(cfg, CALLER_ROLE_ID);
    expect(can(luc, "conversations.view")).toBe(true);
    expect(can(luc, "conversations.reply")).toBe(true);
    expect(can(luc, "clients.sms")).toBe(true);
  });

  it("l'observateur voit et n'écrit pas", () => {
    const stagiaire = role(cfg, OBSERVER_ROLE_ID);
    expect(can(stagiaire, "conversations.view")).toBe(true);
    expect(can(stagiaire, "conversations.reply")).toBe(false);
    expect(can(stagiaire, "clients.sms")).toBe(false);
    expect(grantsFor(cfg, stagiaire, "own").sms).toBe(false);
  });

  it("écrire à un client se ferme aussi fiche par fiche", () => {
    const luc = role(cfg, CALLER_ROLE_ID);
    const marieRole = role(cfg, CALLER_ROLE_ID);
    expect(grantsFor(cfg, luc, "own").sms).toBe(true);
    expect(grantsFor(cfg, luc, bucketFor(LUC, fiche(MARIE), marieRole)).sms).toBe(false);
  });
});
