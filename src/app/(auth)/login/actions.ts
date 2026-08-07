"use server";

import { and, eq, gt, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { loginThrottle, users } from "@/db/schema";
import { getClientIp, logAudit } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  remember: z.boolean(),
});

export type LoginState = { error: "invalid" | "disabled" | "throttled" } | null;

const MAX_ATTEMPTS = 10;
const WINDOW_MIN = 15;

async function isThrottled(key: string): Promise<boolean> {
  const row = await db.query.loginThrottle.findFirst({
    where: and(eq(loginThrottle.key, key), gt(loginThrottle.resetAt, new Date())),
  });
  return (row?.count ?? 0) >= MAX_ATTEMPTS;
}

async function bumpThrottle(key: string): Promise<void> {
  const resetAt = new Date(Date.now() + WINDOW_MIN * 60_000);
  await db
    .insert(loginThrottle)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        // Fenêtre expirée → repartir à 1, sinon incrémenter.
        count: sql`CASE WHEN ${loginThrottle.resetAt} < now() THEN 1 ELSE ${loginThrottle.count} + 1 END`,
        resetAt: sql`CASE WHEN ${loginThrottle.resetAt} < now() THEN ${resetAt.toISOString()}::timestamptz ELSE ${loginThrottle.resetAt} END`,
      },
    });
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    password: String(formData.get("password") ?? ""),
    remember: formData.get("remember") === "on",
  });
  if (!parsed.success) return { error: "invalid" };
  const { email, password, remember } = parsed.data;

  // Pas d'IP exploitable (local, cron, en-têtes absents) → on saute le limiteur
  // par IP au lieu de mettre tout le monde sous une clé partagée type « ::1 ».
  const ip = await getClientIp();
  const ipKey = ip ? `ip:${ip}` : null;

  if ((ipKey !== null && (await isThrottled(ipKey))) || (await isThrottled(`email:${email}`))) {
    return { error: "throttled" };
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid) {
    await Promise.all([
      ...(ipKey !== null ? [bumpThrottle(ipKey)] : []),
      bumpThrottle(`email:${email}`),
    ]);
    await logAudit({ action: "login.failed", detail: { email } });
    return { error: "invalid" };
  }
  if (!user.isActive) {
    await logAudit({ userId: user.id, action: "login.disabled" });
    return { error: "disabled" };
  }

  await createSession({ uid: user.id, role: user.role, tv: user.tokenVersion, remember });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await logAudit({ userId: user.id, action: "login.success" });

  redirect("/dashboard");
}
