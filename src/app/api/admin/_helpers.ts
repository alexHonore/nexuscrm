import "server-only";
import { randomInt } from "crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { users } from "@/db/schema";
import { VoipMsError } from "@/lib/voipms";

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

// ── Sérialisation utilisateur (jamais de secrets) ────────────────────────────

export function toAdminUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    locale: u.locale,
    isActive: u.isActive,
    sipUsername: u.sipUsername,
    hasSipPassword: Boolean(u.sipPasswordEnc),
    didNumber: u.didNumber,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}
export type AdminUser = ReturnType<typeof toAdminUser>;
