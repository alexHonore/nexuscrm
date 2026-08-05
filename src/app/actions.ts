"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/guards";
import { destroySession } from "@/lib/auth/session";

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function setLocaleAction(locale: "fr" | "en"): Promise<void> {
  const store = await cookies();
  store.set("NEXT_LOCALE", locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  const user = await getCurrentUser();
  if (user) {
    await db.update(users).set({ locale }).where(eq(users.id, user.id));
  }
}
