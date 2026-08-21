/**
 * Intégration — consentement SMS enregistré à la main.
 *
 * Ce qui compte : un TÉLÉPHONISTE peut l'enregistrer (c'est lui qui obtient le
 * oui), la durée suit le réglage SMS, la révocation pose une date sans rien
 * effacer, et la lecture reflète l'état que le fil affiche.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs } from "@/db/schema";
import { consents } from "@/db/schema-sms";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (name: string, value: string) => ctx.cookies.set(name, value),
    delete: (name: string) => ctx.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

const { grantSmsConsentAction, revokeSmsConsentAction } = await import(
  "@/app/(app)/clients/consent-actions"
);
const { readSmsConsent } = await import("@/lib/sms-server/consent-state");
const { setSetting } = await import("@/lib/settings");

async function loginAs(user: { id: string; tokenVersion: number }, role: "admin" | "caller") {
  const token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
}

afterAll(closeDb);

describe("consentement manuel", () => {
  beforeEach(async () => {
    await resetDb();
    ctx.cookies.clear();
  });

  it("un TÉLÉPHONISTE enregistre un consentement exprès obtenu au téléphone", async () => {
    const caller = await makeUser({ role: "caller", email: "c@x.test" });
    const client = await makeClient({ phone: "+15145550142" });
    await loginAs(caller, "caller");

    const res = await grantSmsConsentAction({
      clientId: client.id,
      kind: "express",
      source: "phone_call",
      note: "a dit oui pendant l'appel",
    });
    expect(res).toEqual({ ok: true });

    const [row] = await testDb.select().from(consents).where(eq(consents.clientId, client.id));
    expect(row.channel).toBe("sms");
    expect(row.kind).toBe("express");
    expect(row.source).toBe("manual:phone_call");
    expect((row.evidence as { recordedById: string }).recordedById).toBe(caller.id);
    expect((row.evidence as { note: string }).note).toBe("a dit oui pendant l'appel");
    // Politique par défaut : illimité.
    expect(row.expiresAt).toBeNull();

    const state = await readSmsConsent(client.id);
    expect(state.status).toBe("valid");
    expect(state.kind).toBe("express");

    const audit = await testDb.select().from(auditLogs);
    expect(audit.some((a) => a.action === "consent.grant")).toBe(true);
  });

  it("la durée suit le réglage SMS — un consentement implicite à 6 mois expire", async () => {
    const admin = await makeUser({ role: "admin", email: "a@x.test" });
    const client = await makeClient({ phone: "+15145550143" });
    await loginAs(admin, "admin");
    await setSetting("sms", { consentValidity: "6m" } as never);

    await grantSmsConsentAction({ clientId: client.id, kind: "implied_inquiry", source: "form" });
    const [row] = await testDb.select().from(consents).where(eq(consents.clientId, client.id));
    expect(row.expiresAt).not.toBeNull();
    const months = (row.expiresAt!.getTime() - row.grantedAt.getTime()) / (30 * 24 * 3600 * 1000);
    expect(months).toBeGreaterThan(5.5);
    expect(months).toBeLessThan(6.5);

    // Vue depuis un « maintenant » postérieur à l'échéance : expiré, pas absent.
    const later = new Date(row.expiresAt!.getTime() + 1000);
    expect((await readSmsConsent(client.id, later)).status).toBe("expired");
  });

  it("révoquer pose une date sur TOUS les consentements SMS actifs, sans rien effacer", async () => {
    const admin = await makeUser({ role: "admin", email: "a2@x.test" });
    const client = await makeClient({ phone: "+15145550144" });
    await loginAs(admin, "admin");
    await grantSmsConsentAction({ clientId: client.id, kind: "express", source: "in_person" });
    await grantSmsConsentAction({ clientId: client.id, kind: "implied_inquiry", source: "form" });

    expect(await revokeSmsConsentAction(client.id)).toEqual({ ok: true });
    const rows = await testDb.select().from(consents).where(eq(consents.clientId, client.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect((await readSmsConsent(client.id)).status).toBe("none");
  });

  it("sans session : refusé ; entrée invalide : refusée ; client inconnu : introuvable", async () => {
    const client = await makeClient({ phone: "+15145550145" });
    expect(
      await grantSmsConsentAction({ clientId: client.id, kind: "express", source: "phone_call" }),
    ).toEqual({ ok: false, error: "forbidden" });
    const admin = await makeUser({ role: "admin", email: "a3@x.test" });
    await loginAs(admin, "admin");
    expect(
      await grantSmsConsentAction({ clientId: "pas-un-uuid", kind: "express", source: "phone_call" }),
    ).toEqual({ ok: false, error: "invalid" });
    expect(
      await grantSmsConsentAction({
        clientId: "00000000-0000-4000-8000-000000000000",
        kind: "express",
        source: "phone_call",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await testDb.select().from(consents)).toHaveLength(0);
  });
});
