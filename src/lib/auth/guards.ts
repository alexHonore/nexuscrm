import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { cache } from "react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { readSession } from "./session";

export type CurrentUser = typeof users.$inferSelect;

/**
 * Session + DB check (isActive, tokenVersion). Cached per request.
 * Returns null when not authenticated or session revoked.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await readSession();
  if (!session) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, session.uid) });
  if (!user || !user.isActive || user.tokenVersion !== session.tv) return null;
  return user;
});

/** For pages/layouts — redirects to /login when unauthenticated. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For admin pages — redirects callers to their dashboard. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}

/**
 * For API route handlers.
 * Usage: const auth = await apiUser(); if (auth instanceof NextResponse) return auth;
 */
export async function apiUser(): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return user;
}

export async function apiAdmin(): Promise<CurrentUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return user;
}
