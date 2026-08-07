"use server";

import { randomBytes } from "crypto";
import { and, eq, gt, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { loginThrottle, passwordResets, users } from "@/db/schema";
import { getClientIp, logAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { sha256Hex } from "@/lib/crypto";
import { isEmailConfigured, passwordResetEmail, sendEmail } from "@/lib/email";

const EXPIRES_MIN = 60;
const MAX_REQUESTS = 5;
const WINDOW_MIN = 15;

/**
 * Demande de réinitialisation. Réponse TOUJOURS identique (succès) : on ne
 * révèle jamais si une adresse existe dans le système.
 */
export type ForgotState = { done: true } | { error: "invalid" | "throttled" | "unavailable" } | null;

async function throttled(key: string): Promise<boolean> {
  const row = await db.query.loginThrottle.findFirst({
    where: and(eq(loginThrottle.key, key), gt(loginThrottle.resetAt, new Date())),
  });
  return (row?.count ?? 0) >= MAX_REQUESTS;
}

async function bump(key: string): Promise<void> {
  const resetAt = new Date(Date.now() + WINDOW_MIN * 60_000);
  await db
    .insert(loginThrottle)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        count: dsql`CASE WHEN ${loginThrottle.resetAt} < now() THEN 1 ELSE ${loginThrottle.count} + 1 END`,
        resetAt: dsql`CASE WHEN ${loginThrottle.resetAt} < now() THEN ${resetAt.toISOString()}::timestamptz ELSE ${loginThrottle.resetAt} END`,
      },
    });
}

export async function requestResetAction(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const parsed = z
    .object({ email: z.string().email().max(200) })
    .safeParse({ email: String(formData.get("email") ?? "").trim().toLowerCase() });
  if (!parsed.success) return { error: "invalid" };
  const { email } = parsed.data;

  if (!isEmailConfigured()) return { error: "unavailable" };

  // Pas d'IP exploitable → limiteur par IP ignoré (celui par courriel reste).
  const ip = await getClientIp();
  const ipKey = ip ? `reset-ip:${ip}` : null;
  if ((ipKey !== null && (await throttled(ipKey))) || (await throttled(`reset-mail:${email}`))) {
    return { error: "throttled" };
  }
  await Promise.all([
    ...(ipKey !== null ? [bump(ipKey)] : []),
    bump(`reset-mail:${email}`),
  ]);

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });

  // Compte inexistant ou désactivé : on s'arrête ici, sans rien révéler.
  if (user && user.isActive) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + EXPIRES_MIN * 60_000);
    await db.insert(passwordResets).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt,
    });

    const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const url = `${base}/reset-password?token=${token}`;
    const mail = passwordResetEmail({
      name: user.name,
      url,
      locale: user.locale,
      expiresMinutes: EXPIRES_MIN,
    });

    try {
      await sendEmail({ to: user.email, ...mail });
      await logAudit({ userId: user.id, action: "password.reset_requested" });
    } catch (err) {
      console.error("reset email failed", err);
      return { error: "unavailable" };
    }
  }

  return { done: true };
}

// ── Étape 2 : application du nouveau mot de passe ────────────────────────────

export type ResetState = { done: true } | { error: "invalid_token" | "weak" | "mismatch" } | null;

export async function applyResetAction(_prev: ResetState, formData: FormData): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 10) return { error: "weak" };
  if (password !== confirm) return { error: "mismatch" };
  if (!token) return { error: "invalid_token" };

  const row = await db.query.passwordResets.findFirst({
    where: and(
      eq(passwordResets.tokenHash, sha256Hex(token)),
      isNull(passwordResets.usedAt),
      gt(passwordResets.expiresAt, new Date()),
    ),
  });
  if (!row) return { error: "invalid_token" };

  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user || !user.isActive) return { error: "invalid_token" };

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        // Invalide toutes les sessions existantes de ce compte.
        tokenVersion: user.tokenVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(eq(passwordResets.id, row.id));
    // Les autres jetons en cours pour ce compte deviennent caducs.
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
  });

  await logAudit({ userId: user.id, action: "password.reset_completed" });
  return { done: true };
}
