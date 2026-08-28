import "server-only";
import { randomInt } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { users } from "@/db/schema";
import { adminRole, roleById } from "@/lib/permissions/access";
import { CALLER_ROLE_ID } from "@/lib/permissions/defaults";
import type { PermissionsConfig, Role } from "@/lib/permissions/types";
import { VoipMsError } from "@/lib/voipms";
import { computePhoneStatus, sipGatewayConfigured } from "./users/_phone-status";

// ── Générateurs de mots de passe ─────────────────────────────────────────────

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%*+-=?";

function shuffle(input: string): string {
  const arr = input.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

/** Mot de passe temporaire fort (connexion à l'app) — affiché une seule fois. */
export function generateTempPassword(length = 14): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  let out =
    UPPER[randomInt(UPPER.length)] +
    LOWER[randomInt(LOWER.length)] +
    DIGITS[randomInt(DIGITS.length)] +
    SYMBOLS[randomInt(SYMBOLS.length)];
  while (out.length < length) out += all[randomInt(all.length)];
  return shuffle(out);
}

/** Mot de passe SIP (voip.ms) — lettres + chiffres seulement pour compatibilité. */
export function generateSipPassword(length = 14): string {
  const all = UPPER + LOWER + DIGITS;
  let out = UPPER[randomInt(UPPER.length)] + LOWER[randomInt(LOWER.length)] + DIGITS[randomInt(DIGITS.length)];
  while (out.length < length) out += all[randomInt(all.length)];
  return shuffle(out);
}

// ── Lecture JSON validée ─────────────────────────────────────────────────────

export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.infer<S> | NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  return parsed.data as z.infer<S>;
}

// ── Transfert des fiches (suppression d'une catégorie / d'une source) ────────

const reassignSchema = z.object({ reassignTo: z.number().int().nullable() });

/**
 * Interrompt (et annule) la transaction de suppression avec un code d'erreur.
 * Le compte des fiches doit être fait DANS la transaction : une fiche arrivée
 * entre une lecture préalable et la suppression passerait sinon entre les
 * mailles et perdrait sa catégorie / sa source.
 */
export class AbortDelete extends Error {
  constructor(
    readonly code: "reassign_required" | "invalid_target",
    readonly clientCount = 0,
  ) {
    super(code);
  }
}

/** Réponse 400 correspondante, ou relance si l'erreur est d'une autre nature. */
export function abortDeleteResponse(err: unknown): NextResponse {
  if (err instanceof AbortDelete) {
    return NextResponse.json(
      { error: err.code, ...(err.clientCount > 0 ? { clientCount: err.clientCount } : {}) },
      { status: 400 },
    );
  }
  throw err;
}

/**
 * Lit la destination des fiches rattachées à l'entité qu'on supprime.
 * `provided` distingue « l'admin a choisi Aucune » (null explicite) de
 * « l'admin n'a rien décidé » — l'appelant refuse le second cas dès qu'une
 * fiche est rattachée, pour ne jamais orphelin­iser des données en silence.
 */
export async function readReassignTarget(
  req: Request,
): Promise<{ provided: boolean; reassignTo: number | null }> {
  try {
    const parsed = reassignSchema.safeParse(await req.json());
    if (parsed.success) return { provided: true, reassignTo: parsed.data.reassignTo };
  } catch {
    // Corps absent ou illisible : accepté seulement si rien n'est rattaché.
  }
  return { provided: false, reassignTo: null };
}

// ── voip.ms — enveloppe d'erreur uniforme ────────────────────────────────────

/**
 * Réponse d'erreur voip.ms : on remonte le statut exact retourné par l'API
 * (ex. `ip_not_enabled` quand l'IP appelante n'est pas autorisée) pour que
 * l'UI puisse afficher le message précis + un indice de correction.
 */
export function voipmsErrorResponse(err: unknown): NextResponse {
  if (err instanceof VoipMsError) {
    return NextResponse.json(
      { error: "voipms", status: err.status, message: err.message },
      { status: 502 },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: "voipms", status: "unknown", message }, { status: 502 });
}

// ── Rôle demandé par un formulaire de compte ─────────────────────────────────

/**
 * Le rôle CONFIGURÉ que vise une création ou une modification de compte.
 *
 * Deux formes arrivent ici, une seule est à jour : `roleId` désigne un rôle de
 * la matrice ; `role` (« admin » / « caller ») est l'ancien couple de valeurs
 * de l'énumération de la base, encore envoyé par des appels plus vieux que cet
 * écran — on le traduit plutôt que de le refuser.
 *
 * Rend `null` quand la requête ne demande aucun rôle (une modification de
 * courriel n'en parle pas), et un 422 quand l'identifiant ne correspond à
 * rien : retomber en silence sur le rôle par défaut donnerait des droits que
 * personne n'a choisis.
 */
export function requestedRole(
  cfg: PermissionsConfig,
  body: { roleId?: string; role?: "admin" | "caller" },
): Role | null | NextResponse {
  const unknown = () => NextResponse.json({ error: "unknown_role" }, { status: 422 });

  if (body.roleId !== undefined) return roleById(cfg, body.roleId) ?? unknown();
  if (body.role === undefined) return null;

  // Ancienne forme : « admin » vise le rôle super-administrateur, « caller »
  // le rôle livré du même nom — et jamais un rôle qui aurait les clés de la
  // maison, même si quelqu'un a renommé les identifiants entre-temps.
  if (body.role === "admin") return adminRole(cfg);
  const caller = roleById(cfg, CALLER_ROLE_ID);
  if (caller && !caller.superAdmin) return caller;
  return defaultRole(cfg) ?? unknown();
}

/** Le rôle donné à un compte qui n'en demande aucun — celui de la matrice. */
export function defaultRole(cfg: PermissionsConfig): Role | null {
  const fallback = roleById(cfg, cfg.defaultRoleId);
  return fallback && !fallback.superAdmin ? fallback : null;
}

// ── Sérialisation utilisateur (jamais de secrets) ────────────────────────────

/**
 * L'UNIQUE forme d'un compte qui atteint le navigateur.
 *
 * `role` reste le plancher de la base (« admin », ou pas) ; ce qui décide des
 * droits est le rôle CONFIGURÉ, que l'appelant résout et passe ici. Les routes
 * voip.ms ne lisent pas la matrice : elles laissent `role` absent, `roleId`
 * vaut alors `null` et l'écran garde le rôle qu'il affichait. Le déduire du
 * plancher rétrograderait un superviseur en téléphoniste à chaque numéro
 * attribué.
 */
export function toAdminUser(
  u: typeof users.$inferSelect,
  gateway = sipGatewayConfigured(),
  role?: Role | null,
) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleId: role?.id ?? null,
    roleNameFr: role?.nameFr ?? null,
    roleNameEn: role?.nameEn ?? null,
    roleLook: role?.look ?? null,
    locale: u.locale,
    isActive: u.isActive,
    sipUsername: u.sipUsername,
    hasSipPassword: Boolean(u.sipPasswordEnc),
    didNumber: u.didNumber,
    // Diagnostic téléphonie — booléens seulement, jamais le secret ni l'URL.
    phone: computePhoneStatus(u, gateway),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}
export type AdminUser = ReturnType<typeof toAdminUser>;
