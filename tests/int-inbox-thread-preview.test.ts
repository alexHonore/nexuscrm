/**
 * Intégration — la ligne de contexte d'une carte de la boîte.
 *
 * Ce qu'on affiche au-dessus de la réponse du client doit être le message
 * qu'on lui avait ENVOYÉ juste avant — pas l'avant-dernier message du fil, pas
 * un autre entrant, et pas un sortant postérieur. La requête est jointe et
 * groupée : le typage n'en dit rien, seule une vraie base tranche.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, makeClient, makeConversation, makeSmsNumber, resetDb, testDb } from "./helpers/db";
import { conversations, messages } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));
const { previousOutboundByConversation } = await import("@/lib/conversations/thread-preview");

afterAll(closeDb);

const T = (min: number) => new Date(Date.UTC(2026, 7, 30, 12, min));

/** Le fil, tel que la boîte le lit : contexte + dernier message. */
async function preview(conversationId: string) {
  const previous = previousOutboundByConversation();
  const [row] = await testDb
    .select({ body: previous.body, source: previous.source })
    .from(conversations)
    .leftJoin(previous, eq(previous.conversationId, conversations.id))
    .where(eq(conversations.id, conversationId));
  return row ?? { body: null, source: null };
}

describe("le message qui précède la réponse du client", () => {
  let numberId: string;
  beforeEach(async () => {
    await resetDb();
    numberId = (await makeSmsNumber()).id;
  });

  /** Écrit un fil message par message : [direction, texte, source, minute]. */
  async function thread(script: [("in" | "out"), string, string, number][]) {
    const client = await makeClient();
    const row = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });
    for (const [direction, body, source, min] of script) {
      await testDb.insert(messages).values({
        conversationId: row.id,
        direction,
        body,
        source,
        createdAt: T(min),
        status: direction === "in" ? "received" : "delivered",
      });
    }
    return row.id;
  }

  it("c'est le dernier SORTANT d'avant, pas l'avant-dernier message", async () => {
    // Trois entrants d'affilée : l'avant-dernier message est un entrant, et
    // c'est pourtant l'ouverture de campagne qu'il faut montrer.
    const id = await thread([
      ["out", "Bonjour, un projet immobilier en vue?", "opener", 0],
      ["in", "Peut-être", "human", 10],
      ["in", "En fait oui", "human", 11],
      ["in", "Je peux visiter cette semaine?", "human", 12],
    ]);
    expect(await preview(id)).toEqual({
      body: "Bonjour, un projet immobilier en vue?",
      source: "opener",
    });
  });

  it("un sortant POSTÉRIEUR à la réponse du client ne la précède pas", async () => {
    // On a répondu depuis. Le contexte de la réponse du client reste ce qu'on
    // avait dit AVANT elle — l'écran, lui, cachera la ligne (c'est nous qui
    // avons parlé en dernier), mais la requête ne doit pas mentir.
    const id = await thread([
      ["out", "Toujours un projet?", "opener", 0],
      ["in", "Oui!", "human", 10],
      ["out", "Parfait, jeudi 14 h?", "agent", 20],
    ]);
    expect((await preview(id)).body).toBe("Toujours un projet?");
  });

  it("le plus RÉCENT des sortants d'avant, quand il y en a plusieurs", async () => {
    const id = await thread([
      ["out", "Premier contact", "opener", 0],
      ["out", "Petite relance", "ladder", 5],
      ["in", "Ok, rappelez-moi", "human", 10],
    ]);
    expect(await preview(id)).toEqual({ body: "Petite relance", source: "ladder" });
  });

  it("un fil sans aucune réponse du client n'a pas de contexte", async () => {
    const id = await thread([["out", "Bonjour!", "opener", 0]]);
    expect(await preview(id)).toEqual({ body: null, source: null });
  });

  it("un fil qui commence par un entrant n'en a pas non plus", async () => {
    // Rien ne précède : inventer une ligne serait pire que de n'en montrer
    // aucune.
    const id = await thread([["in", "Bonjour, j'ai vu votre annonce", "human", 0]]);
    expect(await preview(id)).toEqual({ body: null, source: null });
  });
});
