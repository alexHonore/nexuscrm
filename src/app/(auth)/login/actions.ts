"use server";

import { eq, inArray, lt, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { afterLoginPath } from "@/lib/auth/next-path";
import { z } from "zod";
import { db } from "@/db";
import { loginThrottle, users } from "@/db/schema";
import { getClientIp, logAudit } from "@/lib/audit";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  remember: z.boolean(),
});

export type LoginState = { error: "invalid" | "disabled" | "throttled" } | null;

const MAX_ATTEMPTS = 10;
const WINDOW_MIN = 15;
/** Une ligne de limiteur expirée depuis plus longtemps ne sert plus à rien. */
const PURGE_AFTER_MS = 24 * 60 * 60_000;

/**
 * Incrémente le compteur d'une clé et renvoie la valeur obtenue — en UNE seule
 * instruction (upsert + RETURNING) : des requêtes simultanées lisent des
 * valeurs strictement croissantes, une rafale ne peut donc pas passer sous la
 * limite le temps d'une comparaison bcrypt. L'horloge est celle de
 * l'application (comme `resetAt`), pas celle de la base.
 */
async function bumpThrottle(key: string): Promise<number> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + WINDOW_MIN * 60_000);
  const [row] = await db
    .insert(loginThrottle)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        // Fenêtre expirée → repartir à 1, sinon incrémenter.
        count: sql`CASE WHEN ${loginThrottle.resetAt} < ${now.toISOString()}::timestamptz THEN 1 ELSE ${loginThrottle.count} + 1 END`,
        resetAt: sql`CASE WHEN ${loginThrottle.resetAt} < ${now.toISOString()}::timestamptz THEN ${resetAt.toISOString()}::timestamptz ELSE ${loginThrottle.resetAt} END`,
      },
    })
    .returning({ count: loginThrottle.count });
  return row.count;
}

/** Bon mot de passe : la tentative n'était pas une devinette, on la rend. */
async function releaseThrottle(keys: string[]): Promise<void> {
  await db
    .update(loginThrottle)
    .set({ count: sql`GREATEST(${loginThrottle.count} - 1, 0)` })
    .where(inArray(loginThrottle.key, keys));
}

/** Purge les lignes expirées depuis plus d'un jour — la table ne doit pas enfler. */
async function purgeExpiredThrottle(): Promise<void> {
  await db
    .delete(loginThrottle)
    .where(lt(loginThrottle.resetAt, new Date(Date.now() - PURGE_AFTER_MS)));
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    password: String(formData.get("password") ?? ""),
    remember: formData.get("remember") === "on",
  });
  // La destination voyage dans le formulaire plutôt que dans l'action : une
  // action serveur est joignable par n'importe quel POST, et `afterLoginPath`
  // refuse tout ce qui n'est pas un chemin relatif à nous.
  const next = afterLoginPath(String(formData.get("next") ?? "") || null);
  if (!parsed.success) return { error: "invalid" };
  const { email, password, remember } = parsed.data;

  // Pas d'IP exploitable (local, cron, en-têtes absents) → on saute le limiteur
  // par IP au lieu de mettre tout le monde sous une clé partagée type « ::1 ».
  const ip = await getClientIp();
  const ipKey = ip ? `ip:${ip}` : null;
  const throttleKeys = [...(ipKey !== null ? [ipKey] : []), `email:${email}`];

  // Compter AVANT de vérifier : un compteur lu puis incrémenté après bcrypt
  // laisserait passer toute une rafale simultanée sous la limite.
  const counts = await Promise.all(throttleKeys.map(bumpThrottle));
  if (counts.some((count) => count > MAX_ATTEMPTS)) return { error: "throttled" };

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  // Comparaison bcrypt même sans compte (empreinte factice) : le temps de
  // réponse ne doit pas dire si l'adresse existe.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const valid = !!user && ok;

  if (!user || !valid) {
    await logAudit({ action: "login.failed", detail: { email } });
    return { error: "invalid" };
  }
  // Seuls les échecs comptent : on rend la tentative que l'on vient de compter.
  await releaseThrottle(throttleKeys);

  if (!user.isActive) {
    await logAudit({ userId: user.id, action: "login.disabled" });
    return { error: "disabled" };
  }

  await createSession({ uid: user.id, role: user.role, tv: user.tokenVersion, remember });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await purgeExpiredThrottle();
  await logAudit({ userId: user.id, action: "login.success" });

  redirect(next);
}
