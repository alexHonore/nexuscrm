/**
 * Intégration — battement du répartiteur et contrôle avant mise en service.
 *
 * Le battement touche la MÊME rangée de réglages que l'interrupteur d'arrêt.
 * Un cycle par minute qui réécrirait tout l'objet pourrait ressusciter un
 * interrupteur qu'un administrateur vient de relever — le contrôle de sécurité
 * le plus important du moteur ne doit pas dépendre d'une course.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, resetDb, testDb } from "./helpers/db";
import { settings } from "@/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { runDispatchCycle } = await import("@/lib/jobs/dispatch");
const { settingsSendGate } = await import("@/lib/sms-server");
const { getSetting } = await import("@/lib/settings");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe("battement du répartiteur", () => {
  it("un cycle écrit le battement, même sans aucun job", async () => {
    // Se fier au dernier job réclamé dirait « arrêté » chaque fois que la file
    // est simplement vide.
    await runDispatchCycle();

    const row = await testDb.query.settings.findFirst({ where: eq(settings.key, "sms") });
    const value = row!.value as { lastDispatchAt: string };
    expect(value.lastDispatchAt).toBeTruthy();
    expect(Date.now() - new Date(value.lastDispatchAt).getTime()).toBeLessThan(60_000);
  });

  it("le battement NE RESSUSCITE PAS un interrupteur d'arrêt relevé", async () => {
    await testDb.insert(settings).values({
      key: "sms",
      value: { killSwitch: true, killSwitchReason: "incident" },
    });
    expect(await settingsSendGate.isSendingAllowed()).toBe(false);

    await runDispatchCycle();

    // L'interrupteur tient, et la raison n'a pas été effacée.
    const after = await getSetting("sms");
    expect(after.killSwitch).toBe(true);
    expect(after.killSwitchReason).toBe("incident");
    expect(after.lastDispatchAt).toBeTruthy();
    expect(await settingsSendGate.isSendingAllowed()).toBe(false);
  });

  it("le battement ne réarme pas non plus un interrupteur BAISSÉ", async () => {
    await testDb.insert(settings).values({
      key: "sms",
      value: { killSwitch: false },
    });
    await runDispatchCycle();

    const after = await getSetting("sms");
    expect(after.killSwitch).toBe(false);
    // Et les autres réglages sont intacts.
    expect(await settingsSendGate.isSendingAllowed()).toBe(true);
  });

  it("deux cycles successifs avancent le battement", async () => {
    await runDispatchCycle();
    const first = (await getSetting("sms")).lastDispatchAt;
    await new Promise((r) => setTimeout(r, 15));
    await runDispatchCycle();
    const second = (await getSetting("sms")).lastDispatchAt;
    expect(new Date(second!).getTime()).toBeGreaterThanOrEqual(new Date(first!).getTime());
  });
});
