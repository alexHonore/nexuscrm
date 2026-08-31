/**
 * Intégration — le tableau de bord et la boîte de réception comptent la MÊME
 * chose.
 *
 * Le moteur laisse `needs_attention` à vrai en closant un fil : il s'en sert
 * pour dater le verdict. Le tableau de bord comptait la colonne nue et
 * proposait donc de « reprendre » un désabonnement — le geste exactement
 * interdit. Ce test compare la condition SQL partagée à la règle d'affichage.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and } from "drizzle-orm";
import { closeDb, makeClient, makeConversation, makeSmsNumber, resetDb, testDb } from "./helpers/db";
import { conversations } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));
const { needsHumanCondition } = await import("@/lib/conversations/attention");
const { conversationStateOf } = await import("@/components/conversations/state");

afterAll(closeDb);

describe("« à reprendre » veut dire la même chose partout", () => {
  beforeEach(resetDb);

  it("un verdict n'est pas du travail : refus, désabonnement et fil clos sortent du compte", async () => {
    const numberId = (await makeSmsNumber()).id;
    /** [motif, needsAttention, aiEnabled] tels que le moteur les écrit. */
    const cases: [string | null, boolean, boolean][] = [
      ["inbound", true, true],
      ["handoff", true, false],
      ["llm_error", true, true],
      // Le moteur laisse la pastille allumée pour DATER le verdict.
      ["optout", true, false],
      ["hard_refusal", true, false],
      ["closed_goal_reached", true, false],
      ["closed_by_human", false, false],
      // Signalé sans motif : il compte, sinon un fil disparaîtrait en silence.
      [null, true, true],
      // Tenu par un humain : du travail, mais pas « rendu par l'assistant ».
      [null, false, false],
    ];
    const expected: string[] = [];
    for (const [reason, needsAttention, aiEnabled] of cases) {
      const client = await makeClient();
      const thread = await makeConversation({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: numberId,
        needsAttention,
        attentionReason: reason,
        aiEnabled,
      });
      // La règle d'AFFICHAGE, celle que la boîte de réception applique.
      if (conversationStateOf({ needsAttention, attentionReason: reason, aiEnabled }) === "attention") {
        expected.push(thread.id);
      }
    }

    const rows = await testDb
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(needsHumanCondition()));

    expect(rows.map((r) => r.id).sort()).toEqual(expected.sort());
    // Et le garde-fou du bug d'origine : la colonne nue en compte davantage.
    expect(await testDb.select().from(conversations)).toHaveLength(cases.length);
    expect(rows).toHaveLength(4);
  });
});
