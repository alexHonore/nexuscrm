/**
 * Intégration — GET /api/cron/followup-reminders : UN rappel par fenêtre.
 *
 * Régression : le dédoublonnage ne regardait que les notifications NON LUES.
 * La route tourne toutes les 30 min (n8n) et la fenêtre d'un suivi dure 25 h :
 * dès que la téléphoniste lisait le rappel, le passage suivant en recréait un
 * — jusqu'à une cinquantaine pour un seul suivi ouvert. Désormais toute
 * notification (lue ou non) créée depuis l'entrée du suivi dans sa fenêtre
 * (dueAt − 1 h) suffit ; un suivi reprogrammé rouvre une fenêtre et se
 * rappelle de nouveau.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { NextRequest } from "next/server";
import { GET as followupCron } from "@/app/api/cron/followup-reminders/route";
import { followups, notifications } from "@/db/schema";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

function cronRequest(secret: string | null = "test-cron-secret") {
  return new NextRequest("http://localhost:3000/api/cron/followup-reminders", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

async function run() {
  return (await followupCron(cronRequest())).json() as Promise<{ scanned: number; created: number }>;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe("rappels de suivi — un seul par fenêtre, lu ou non", () => {
  it("lire le rappel ne le fait PAS renaître au passage suivant", async () => {
    const alice = await makeUser({ name: "Alice", email: "a@nexus.test" });
    const client = await makeClient({ fullName: "Jean Bouchard", phone: "+14185550001" });
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date(Date.now() + 30 * 60 * 1000), // dû dans 30 min
      note: "Rappeler",
    });

    expect(await run()).toEqual({ scanned: 1, created: 1 });
    // Non lue : toujours pas de doublon (comportement inchangé).
    expect(await run()).toEqual({ scanned: 1, created: 0 });

    // Lue : le passage suivant ne recrée RIEN — c'était la fuite (une
    // notification toutes les 30 min après chaque lecture).
    await testDb.update(notifications).set({ readAt: new Date() });
    expect(await run()).toEqual({ scanned: 1, created: 0 });
    expect(await testDb.select().from(notifications)).toHaveLength(1);
  });

  it("un rappel antérieur à la fenêtre ne supprime pas le nouveau (suivi reprogrammé)", async () => {
    const alice = await makeUser({ name: "Alice", email: "a2@nexus.test" });
    const client = await makeClient({ fullName: "Marie Roy", phone: "+14185550002" });
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date(Date.now() + 30 * 60 * 1000),
      note: "Relancer",
    });

    // Vestige d'une fenêtre PRÉCÉDENTE (suivi reprogrammé après son rappel) :
    // créé avant dueAt − 1 h, lu ou non, il ne compte plus.
    await testDb.insert(notifications).values({
      userId: alice.id,
      type: "followup_due",
      title: "Suivi à faire : Marie Roy",
      link: `/clients/${client.id}`,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      readAt: new Date(Date.now() - 90 * 60 * 1000),
    });

    expect(await run()).toEqual({ scanned: 1, created: 1 });
    expect(await testDb.select().from(notifications)).toHaveLength(2);
  });

  it("un suivi complété ne se rappelle jamais, même sans notification", async () => {
    const alice = await makeUser({ name: "Alice", email: "a3@nexus.test" });
    const client = await makeClient({ fullName: "Luc Gagnon", phone: "+14185550003" });
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date(Date.now() + 30 * 60 * 1000),
      note: "Fait",
      doneAt: new Date(),
    });

    expect(await run()).toEqual({ scanned: 0, created: 0 });
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });
});
