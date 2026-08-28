import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentTurnTraces, assistants, campaigns, conversations, messages } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { diffConfig } from "@/lib/assistants/changes";
import { apiPerm } from "@/lib/permissions/server";
import {
  assistantConfigInputSchema,
  assistantRowToConfig,
  withModelFallbackChain,
} from "@/lib/assistants/schema";

async function loadRow(id: string) {
  return db.query.assistants.findFirst({ where: eq(assistants.id, id) });
}

/**
 * GET /api/assistants/:id — configuration complète + état de compilation.
 *
 * Trois verbes ici, deux gardes : LIRE la fiche et son prompt compilé demande
 * `admin.assistants`, l'ENREGISTRER ou l'archiver demande
 * `admin.assistantsEdit`. Lire ne casse rien ; écrire change ce que
 * l'entreprise dit à des centaines de personnes.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    config: assistantRowToConfig(row),
    status: row.status,
    version: row.version,
    suitePassed: row.suitePassed,
    needsRecompile: row.needsRecompile,
    compiledAt: row.compiledAt,
    compiledPrompt: row.compiledPrompt,
  });
}

/**
 * PATCH /api/assistants/:id — enregistre la configuration.
 *
 * Deux choses arrivent ici, et la réponse les distingue :
 *
 *  · Le drapeau `needs_recompile` est posé. C'est le SEUL écrivain de ce
 *    drapeau côté application : sans lui, un prompt périmé passerait la porte
 *    d'activation.
 *  · La réponse dit quelles modifications s'appliquent DÈS le prochain message
 *    (outils, modèle, budgets — relus à chaque tour) et lesquelles attendent la
 *    recompilation (ton, faits, identité — rédigés dans le prompt). Sur un
 *    assistant actif, cette distinction n'est pas cosmétique.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // L'onglet « Configuration brute » accepte un JSON collé, qui peut venir
  // d'un export d'avant la chaîne de replis : `fallback` y devient `fallbacks`
  // au lieu de disparaître.
  const parsed = assistantConfigInputSchema.safeParse(
    raw !== null && typeof raw === "object" && !Array.isArray(raw) && "model" in raw
      ? { ...raw, model: withModelFallbackChain((raw as { model: unknown }).model) }
      : raw,
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const before = assistantRowToConfig(row);
  const config = parsed.data;
  const changes = diffConfig(before, config);

  if (changes.changed.length === 0) {
    return NextResponse.json({ saved: false, changes, needsRecompile: row.needsRecompile });
  }

  await db
    .update(assistants)
    .set({
      name: config.name,
      description: config.description,
      language: config.language,
      secondaryLanguage: config.secondaryLanguage,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      promptMode: config.promptMode,
      systemPromptOverride: config.systemPromptOverride,
      layerOverrides: config.layerOverrides,
      turnInstructions: config.turnInstructions,
      includeRuntimeLayer: config.includeRuntimeLayer,
      requireSuitePass: config.requireSuitePass,
      // La suite exerce la configuration ENTIÈRE — modèle, outils, objectif —
      // pas seulement le prompt. Un changement quelconque la périme donc, même
      // s'il ne force pas de recompilation : changer de modèle laisserait sinon
      // un vert obtenu avec un autre modèle. Le drapeau de recompilation, lui,
      // garde son sens étroit (le TEXTE du prompt).
      suitePassed: false,
      ...(changes.needsRecompile ? { needsRecompile: true } : {}),
      updatedAt: new Date(),
    })
    .where(eq(assistants.id, id));

  await logAudit({
    userId: actor.user.id,
    action: "assistant.update",
    entity: "assistant",
    entityId: id,
    detail: { changed: changes.changed, needsRecompile: changes.needsRecompile },
  });

  return NextResponse.json({
    saved: true,
    changes,
    needsRecompile: changes.needsRecompile || row.needsRecompile,
    /** Vrai quand des modifications s'appliquent déjà à des conversations en cours. */
    liveNow: row.status === "active" && changes.immediate.length > 0,
  });
}

/**
 * DELETE /api/assistants/:id — archive, ou supprime s'il n'a jamais servi.
 *
 * Un assistant qui a parlé à quelqu'un n'est pas supprimable. Les clés
 * étrangères de `messages` et `agent_turn_traces` sont en « set null » : une
 * suppression ne casserait rien, elle effacerait SILENCIEUSEMENT l'auteur de
 * chaque message qu'il a écrit. Un fil du mois dernier doit rester relisible
 * avec l'assistant qui l'a rédigé — on archive donc au lieu de supprimer.
 * Un assistant jamais utilisé mais choisi par une campagne n'est pas supprimé
 * non plus : 409 `in_use`, avec le nombre de campagnes à re-pointer d'abord.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await loadRow(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Trois traces possibles d'un usage réel. Un transfert d'assistant laisse
  // `active_assistant_id` sur le SUIVANT : ce sont les messages qui gardent le
  // souvenir de celui qui a parlé.
  const [[byMessage], [byConversation], [byTrace]] = await Promise.all([
    db.select({ id: messages.id }).from(messages).where(eq(messages.assistantId, id)).limit(1),
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.activeAssistantId, id))
      .limit(1),
    db
      .select({ id: agentTurnTraces.id })
      .from(agentTurnTraces)
      .where(eq(agentTurnTraces.assistantId, id))
      .limit(1),
  ]);

  if (byMessage || byConversation || byTrace) {
    await db
      .update(assistants)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(assistants.id, id));
    await logAudit({
      userId: actor.user.id,
      action: "assistant.archive",
      entity: "assistant",
      entityId: id,
      detail: {
        name: row.name,
        reason: byMessage ? "has_messages" : byConversation ? "has_conversations" : "has_traces",
      },
    });
    return NextResponse.json({ archived: true, deleted: false });
  }

  // Jamais utilisé, mais choisi par une campagne : la clé étrangère de
  // `campaigns.assistant_id` est en « restrict » — la suppression sauterait en
  // 500 sans rien dire. On refuse en nommant le nombre de campagnes, comme pour
  // un paquet d'objections encore rattaché : le geste suivant (re-pointer ou
  // retirer la campagne) devient évident.
  const [inCampaigns] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(eq(campaigns.assistantId, id));
  if ((inCampaigns?.n ?? 0) > 0) {
    return NextResponse.json({ error: "in_use", campaigns: inCampaigns.n }, { status: 409 });
  }

  await db.delete(assistants).where(eq(assistants.id, id));
  await logAudit({
    userId: actor.user.id,
    action: "assistant.delete",
    entity: "assistant",
    entityId: id,
    detail: { name: row.name },
  });
  return NextResponse.json({ archived: false, deleted: true });
}
