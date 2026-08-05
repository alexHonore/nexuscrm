import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "nexus_session";
const REMEMBER_MAX_AGE = 60 * 60 * 24 * 60; // 60 jours
const SHORT_MAX_AGE = 60 * 60 * 15; // 15 h (journée de travail)

export type SessionPayload = {
  /** user id */
  uid: string;
  role: "admin" | "caller";
  /** token version — must match users.token_version */
  tv: number;
  remember: boolean;
};

function secret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw) throw new Error("AUTH_SECRET manquant");
  return new TextEncoder().encode(raw);
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const maxAge = payload.remember ? REMEMBER_MAX_AGE : SHORT_MAX_AGE;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
    .sign(secret());

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Cookie de session (disparaît à la fermeture) si "se souvenir" décoché.
    ...(payload.remember ? { maxAge: REMEMBER_MAX_AGE } : {}),
  });
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
