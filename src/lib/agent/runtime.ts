import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db";
import { clients, followups, users } from "@/db/schema";
import {
  agentEvents,
  agentTurnTraces,
  assistants,
  campaignEnrollments,
  campaigns,
  conversations,
  messages,
} from "@/db/schema-sms";
import { assistantRowToConfig, type AssistantConfig } from "@/lib/assistants/schema";
import { resolvedRulesFor } from "@/lib/assistants/service";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import { getInternalBookingProvider } from "@/lib/booking/internal";
import type { SlotPreference } from "@/lib/booking/provider";
import { blockingFailures, evaluateOutputRules } from "@/lib/guardrails/filter";
import { judgeWithLlm } from "@/lib/guardrails/judge";
import { enabledRules } from "@/lib/guardrails/resolve";
import type { RuleData, RuleVerdict } from "@/lib/guardrails/types";
import { enqueueJob } from "@/lib/jobs/queue";
import { LlmUnconfiguredError, getLlmProvider } from "@/lib/llm-server";
import type { LLMMessage } from "@/lib/llm/types";
import type { LLMResult, ToolCall } from "@/lib/llm/types";
import { suppressPhone } from "@/lib/sms-server";
import { notifyHumans } from "@/lib/sms-server/notify";
import { detectOptOut } from "@/lib/sms/optout";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";
import { classifyInbound, type Classification } from "./classify";
import { applyRefusal, requiredFieldsFor, rungNeedsSlots, type Rung } from "./goal";
import { renderTemplate } from "./render";
import { DEFAULT_TURN_INSTRUCTIONS } from "./templates";
import { outreachInstructionText } from "./opening";
import { missingFieldsError, parseToolArgs, toolDefsFor } from "./tools";

/**
 * Boucle d'un tour d'agent (§12), en TROIS temps.
 *
 * Le découpage n'est pas cosmétique, il porte deux garanties :
 *
 *  · **Réfléchir hors transaction.** Un tour enchaîne un appel classifieur,
 *    jusqu'à deux appels générateur et plusieurs appels juge — des secondes de
 *    réseau. Les tenir dans une transaction ouverte immobiliserait une des dix
 *    connexions du pool ET le verrou, sans une seule requête SQL entre-temps :
 *    c'est exactement le « idle in transaction » que Supavisor coupe. Toute la
 *    réflexion se fait donc hors transaction.
 *
 *  · **Écrire d'un seul bloc.** L'écriture prend le verrou consultatif,
 *    RE-VÉRIFIE que les entrants n'ont pas déjà été traités par un tour
 *    concurrent, puis valide message, état, trace, évènements et mise en file
 *    ENSEMBLE. Sans cela, une mise en file validée hors transaction survivrait
 *    à un rollback : le client recevrait une réponse dont l'état a été annulé,
 *    et la reprise du job en enverrait une deuxième.
 *
 * Le reste des promesses du cahier :
 *  · `ai_enabled = false` ⇒ sortie immédiate, aucun message ;
 *  · désabonnement ⇒ suppression + arrêt, jamais de relance ;
 *  · refus ferme ⇒ clôture, la chaîne d'objectifs n'est PAS touchée ;
 *  · une règle bloquante ⇒ UNE régénération, puis escalade — jamais d'envoi ;
 *  · UN SEUL message sortant par tour ;
 *  · une trace dans TOUS les cas, surtout bloqué, escaladé ou en erreur.
 */

const APP_TZ = process.env.APP_TIMEZONE ?? "America/Toronto";

/** Outils dont l'effet est irréversible : joués une seule fois par tour. */
const SIDE_EFFECT_TOOLS = new Set(["book_meeting", "stop", "handoff", "schedule_followup"]);

export type TurnOutcome =
  | "sent"
  | "blocked"
  | "handoff"
  | "stopped"
  | "error"
  | "skipped_ai_disabled"
  | "skipped_no_inbound"
  | "skipped_no_assistant"
  | "skipped_superseded";

export interface TurnResult {
  outcome: TurnOutcome;
  conversationId: string;
  traceId?: string;
  reason?: string;
}

/**
 * Contexte d'un tour PROACTIF : un barreau de campagne sans texte, que
 * l'assistant doit rédiger lui-même. Le tour n'a alors aucun entrant à
 * traiter — c'est lui qui ouvre, ou qui relance.
 */
export interface OutreachContext {
  enrollmentId: string;
  step: number;
}

export interface TurnOptions {
  outreach?: OutreachContext;
  /**
   * Dernière tentative de la file : une panne du modèle consomme alors les
   * entrants et passe la main. Avant, on laisse les entrants NON traités pour
   * que la reprise avec temporisation ait quelque chose à reprendre — sinon la
   * reprise ne trouvait rien et la panne devenait définitive au premier essai.
   */
  finalAttempt?: boolean;
}

/**
 * Consigne de tour quand l'assistant écrit EN PREMIER.
 *
 * Les fournisseurs exigent au moins un message ; « écris l'ouverture » est
 * exactement ce que demande un barreau sans texte. Le nom et la description de
 * la campagne donnent au modèle le POURQUOI du message (réactivation, nouveau
 * lead…) — marqués « à ne pas citer » pour qu'il n'écrive pas « dans le cadre
 * de notre campagne ». La consigne n'est jamais stockée comme message : le
 * contact ne la voit pas et l'historique des tours suivants ne la contient pas.
 */
async function outreachInstruction(
  outreach: OutreachContext,
  historyLength: number,
): Promise<string> {
  const enrollment = await db.query.campaignEnrollments.findFirst({
    where: eq(campaignEnrollments.id, outreach.enrollmentId),
  });
  const campaignRow = enrollment
    ? await db.query.campaigns.findFirst({ where: eq(campaigns.id, enrollment.campaignId) })
    : null;
  const ladderLength = campaignRow ? campaignRowToConfig(campaignRow).ladder.length : 0;
  // Le TEXTE vit dans ./opening, partagé avec le bac à sable : ce que l'on
  // teste à l'écran est mot pour mot ce que la production demande.
  return outreachInstructionText({
    step: outreach.step,
    historyLength,
    campaignName: campaignRow?.name ?? null,
    campaignDescription: campaignRow?.description ?? null,
    ladderLength,
  });
}

/** Délai humanisé avant l'envoi (approach.reply_speed). */
function replyDelayMs(speed: AssistantConfig["approach"]["replySpeed"]): number {
  switch (speed) {
    case "instant":
      return 0;
    case "deliberate":
      return 90_000;
    case "natural":
    default:
      // Un humain ne répond pas en 400 ms ; ~30 s se lit comme quelqu'un
      // d'occupé mais attentif.
      return 30_000;
  }
}

// ── Outils ───────────────────────────────────────────────────────────────────

interface ToolEffect {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ToolRunResult {
  /** Ce que le modèle lit au tour suivant. */
  resultsForModel: string;
  /**
   * Un résultat PAR APPEL, rattaché à son identifiant.
   *
   * C'est ce qui permet de renvoyer de vrais messages `tool` : sans le lien
   * avec `tool_call_id`, le modèle ne relie pas le résultat à sa demande, la
   * réémet au tour suivant et n'écrit rien.
   */
  results: { id: string; name: string; content: string }[];
  terminated: "stop" | "handoff" | null;
  /** Vrai si une réservation a ÉCHOUÉ — le brouillon ne peut alors rien confirmer. */
  bookingFailed: boolean;
  /** Une réservation a RÉUSSI : l'inscription de campagne devient « booked ». */
  booked: boolean;
  /** close_conversation : le fil se ferme avec ce résultat après l'envoi. */
  closedOutcome: "goal_reached" | "disqualified" | "not_interested" | null;
  /** transfer_assistant : le prochain tour est à cet assistant. */
  transferTo: string | null;
}

/**
 * Exécute les appels d'outils, dans l'ordre. Rien n'agit sans avoir passé zod :
 * un modèle hallucine ses arguments aussi facilement que son texte.
 *
 * `book_meeting` refuse tant qu'un champ requis manque et renvoie une erreur
 * STRUCTURÉE que le modèle doit lire, plutôt que de réserver à l'aveugle.
 */
async function executeTools(input: {
  calls: ToolCall[];
  rung: Rung;
  clientId: string;
  clientAssignedToId: string | null;
  conversationId: string;
  currentAssistantId: string;
  qualification: Record<string, unknown>;
  effects: ToolEffect[];
  sideEffectsDone: Set<string>;
}): Promise<ToolRunResult> {
  const perCall: { id: string; name: string; content: string }[] = [];
  let terminated: "stop" | "handoff" | null = null;
  let bookingFailed = false;
  let booked = false;
  let closedOutcome: ToolRunResult["closedOutcome"] = null;
  let transferTo: string | null = null;

  for (const call of input.calls) {
    /** Consigne le résultat de CET appel, rattaché à son identifiant. */
    const record = (content: string) =>
      perCall.push({ id: call.id, name: call.name, content });
    const parsed = parseToolArgs(call.name, call.arguments);
    if (!parsed.ok) {
      input.effects.push({ name: call.name, ok: false, detail: parsed.error });
      record(`${call.name} : ${parsed.error}`);
      continue;
    }
    const name = parsed.name;
    if (SIDE_EFFECT_TOOLS.has(name) && input.sideEffectsDone.has(name)) {
      record(`${name} : déjà exécuté à ce tour`);
      continue;
    }

    switch (name) {
      case "get_slots": {
        const { count, preference } = parsed.args as { count: number; preference: SlotPreference };
        if (!input.rung.goal.appointmentType) {
          record("get_slots : ce cran d'objectif ne réserve pas de rencontre");
          break;
        }
        try {
          const { slots, googleConnected, preferenceUnavailable } = await getInternalBookingProvider().getSlots({
            type: input.rung.goal.appointmentType,
            count,
            preference,
          });
          // Le libellé ET l'ISO : book_meeting exige le créneau « exactement tel
          // que retourné par get_slots », et le modèle ne voyait que le libellé —
          // chaque réservation partait avec une heure reformulée, refusée.
          const offered = slots.map((s) => `${s.label} (${s.iso})`).join(", ");
          record(
            !googleConnected || slots.length === 0
              ? "get_slots : aucune disponibilité confirmée — ne propose AUCUNE heure précise."
              : preferenceUnavailable
                ? // Le repli est NOMMÉ comme tel : le modèle doit dire que la
                  // contrainte n'a rien donné, pas offrir ces heures comme si
                  // elles y répondaient.
                  `get_slots : RIEN ne correspond à « ${preference} » dans les 14 prochains jours. Dis-le honnêtement, puis propose ces autres heures : ${offered}`
                : `get_slots : ${offered}`,
          );
        } catch {
          record("get_slots : agenda injoignable — ne propose aucune heure.");
        }
        break;
      }

      case "book_meeting": {
        const args = parsed.args as { slotIso: string; email?: string };
        const missing = requiredFieldsFor(input.rung).filter((field) => {
          const value = input.qualification[field];
          return typeof value !== "string" || value.trim() === "";
        });
        if (missing.length > 0) {
          record(missingFieldsError(missing));
          bookingFailed = true;
          break;
        }
        if (!input.rung.goal.appointmentType) {
          record("book_meeting : ce cran ne réserve pas de rencontre");
          bookingFailed = true;
          break;
        }
        const bookedResult = await getInternalBookingProvider().book({
          clientId: input.clientId,
          conversationId: input.conversationId,
          type: input.rung.goal.appointmentType,
          slotIso: args.slotIso,
          ...(args.email ? { email: args.email } : {}),
        });
        input.sideEffectsDone.add(name);
        if (bookedResult.ok) {
          booked = true;
          record(`book_meeting : confirmé pour ${args.slotIso}`);
        } else {
          record(
            `book_meeting : ÉCHEC (${bookedResult.error}) — ne confirme RIEN, propose autre chose.`,
          );
          bookingFailed = true;
        }
        break;
      }

      case "stop":
        input.sideEffectsDone.add(name);
        terminated = "stop";
        break;

      case "handoff":
        input.sideEffectsDone.add(name);
        terminated = "handoff";
        break;

      // Les quatre outils ci-dessous étaient « pris en compte » sans rien
      // faire : le modèle croyait avoir enregistré, planifié, transféré ou
      // clos, et rien n'existait derrière. Ils agissent maintenant ; leur effet
      // est validé au même moment que le message, dans la transaction du tour.
      case "update_qualification": {
        const { fields } = parsed.args as { fields: Record<string, string> };
        const entries = Object.entries(fields).filter(([, v]) => typeof v === "string" && v.trim() !== "");
        for (const [k, v] of entries) input.qualification[k] = v.trim();
        record(
          entries.length > 0
            ? `update_qualification : enregistré (${entries.map(([k]) => k).join(", ")})`
            : "update_qualification : rien à enregistrer",
        );
        break;
      }
      case "schedule_followup": {
        const args = parsed.args as { whenIso: string; note?: string };
        const when = new Date(args.whenIso);
        if (Number.isNaN(when.getTime()) || when.getTime() < Date.now()) {
          input.effects.push({ name, ok: false, detail: "invalid_when" });
          record("schedule_followup : date invalide ou passée — demande une date précise à venir.");
          continue;
        }
        // Un rappel a toujours un destinataire : l'assigné de la fiche, sinon
        // un administrateur — un rappel que personne ne voit n'en est pas un.
        let assigneeId = input.clientAssignedToId;
        if (!assigneeId) {
          const admin = await db.query.users.findFirst({
            where: and(eq(users.role, "admin"), eq(users.isActive, true)),
            columns: { id: true },
          });
          assigneeId = admin?.id ?? null;
        }
        if (!assigneeId) {
          input.effects.push({ name, ok: false, detail: "no_assignee" });
          record("schedule_followup : aucun destinataire pour le rappel — propose un autre moyen.");
          continue;
        }
        input.sideEffectsDone.add(name);
        await db.insert(followups).values({
          clientId: input.clientId,
          assignedToId: assigneeId,
          dueAt: when,
          note: args.note ?? "Rappel demandé par SMS (assistant)",
          createdById: null,
        });
        record(`schedule_followup : rappel posé pour ${args.whenIso}`);
        break;
      }
      case "transfer_assistant": {
        const args = parsed.args as { assistantId: string; reason?: string };
        const target = await db.query.assistants.findFirst({
          where: eq(assistants.id, args.assistantId),
          columns: { id: true, status: true, compiledPrompt: true, name: true },
        });
        if (!target || target.status !== "active" || !target.compiledPrompt) {
          input.effects.push({ name, ok: false, detail: "target_unavailable" });
          record("transfer_assistant : assistant cible introuvable ou inactif — continue toi-même.");
          continue;
        }
        if (target.id === input.currentAssistantId) {
          record("transfer_assistant : c'est déjà toi — continue.");
          break;
        }
        transferTo = target.id;
        record(`transfer_assistant : le prochain tour sera pris par « ${target.name} ».`);
        break;
      }
      case "close_conversation": {
        const args = parsed.args as {
          outcome: "goal_reached" | "disqualified" | "not_interested";
          note?: string;
        };
        closedOutcome = args.outcome;
        record(`close_conversation : fil clos (${args.outcome}) après ce message.`);
        break;
      }
      default:
        record(`${name} : pris en compte`);
        if (SIDE_EFFECT_TOOLS.has(name)) input.sideEffectsDone.add(name);
        break;
    }

    input.effects.push({ name, ok: true });
    if (terminated) break;
  }

  return {
    resultsForModel: perCall.map((r) => r.content).join("\n") || "(aucun résultat)",
    results: perCall,
    terminated,
    bookingFailed,
    booked,
    closedOutcome,
    transferTo,
  };
}

// ── Garde-fous ───────────────────────────────────────────────────────────────

async function evaluateAllRules(
  draft: string,
  rules: RuleData[],
  ctx: { toolCallNames: string[]; inbound: string; isFirstOutbound: boolean; intents: string[] },
  judge: (p: { system: string; user: string }) => Promise<string>,
): Promise<RuleVerdict[]> {
  const verdicts = evaluateOutputRules(draft, rules, {
    toolCallNames: ctx.toolCallNames,
    intents: ctx.intents,
  });
  // Une règle déterministe a déjà tranché : inutile de payer des appels juge
  // pour confirmer un refus. On économise la latence ET le coût.
  if (blockingFailures(verdicts).length > 0) return verdicts;

  for (const rule of enabledRules(rules)) {
    if (rule.kind !== "llm_judge") continue;
    const criterion = (rule.config as { criterion?: unknown }).criterion;
    if (typeof criterion !== "string" || criterion.trim() === "") continue;
    // La position dans la conversation VOYAGE avec le critère : plusieurs
    // critères distinguent le premier message des suivants, et un juge qui ne
    // peut pas trancher échoue fermé — donc bloque tout.
    const verdict = await judgeWithLlm(
      {
        criterion,
        output: draft,
        context: ctx.inbound,
        isFirstOutbound: ctx.isFirstOutbound,
      },
      judge,
    );
    verdicts.push({
      key: rule.key,
      label: rule.label,
      severity: rule.severity,
      passed: verdict.passed,
      reason: verdict.passed ? undefined : verdict.reason,
    });
  }
  return verdicts;
}

// ── Le tour ──────────────────────────────────────────────────────────────────

export async function runTurn(
  conversationId: string,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const outreach = options.outreach ?? null;
  // ═══ 1. LECTURE (hors transaction) ═══════════════════════════════════════
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) return { outcome: "error", conversationId, reason: "conversation_not_found" };

  // Un humain a le contrôle : aucun chemin automatisé ne parle.
  if (!conversation.aiEnabled) return { outcome: "skipped_ai_disabled", conversationId };

  const inbound = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "in"),
        isNull(messages.processedAt),
      ),
    )
    .orderBy(asc(messages.createdAt));
  // Tour PROACTIF : aucun entrant, mais un barreau de campagne à rédiger.
  // Si le contact a écrit entre-temps, ce n'est plus une ouverture — on
  // répond à son message, et le barreau est considéré satisfait par la réponse.
  const proactive = inbound.length === 0 && outreach !== null;
  if (inbound.length === 0 && !proactive) return { outcome: "skipped_no_inbound", conversationId };

  if (!conversation.activeAssistantId) return { outcome: "skipped_no_assistant", conversationId };
  const assistantRow = await db.query.assistants.findFirst({
    where: eq(assistants.id, conversation.activeAssistantId),
  });
  if (!assistantRow?.compiledPrompt) {
    return { outcome: "skipped_no_assistant", conversationId, reason: "assistant_not_compiled" };
  }
  // Seul un assistant ACTIF parle. Un brouillon ou un assistant archivé qui
  // reste « actif » sur d'anciens fils contournerait la porte d'activation —
  // suite rouge, prompt périmé — exactement ce qu'elle empêche.
  if (assistantRow.status !== "active") {
    return { outcome: "skipped_no_assistant", conversationId, reason: "assistant_inactive" };
  }

  const config = assistantRowToConfig(assistantRow);
  const client = await db.query.clients.findFirst({ where: eq(clients.id, conversation.clientId) });
  const rules = await resolvedRulesFor(assistantRow.id);

  const inboundIds = inbound.map((m) => m.id);
  const historyCount = proactive
    ? ((
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      )[0]?.n ?? 0)
    : 0;
  // Un MMS sans texte donne un corps vide ; Anthropic et Google refusent un
  // message utilisateur vide et le tour partait en panne. On dit au modèle ce
  // qui est arrivé plutôt que rien.
  const joinedInbound = inbound.map((m) => m.body).join("\n").trim();
  const userTurn = proactive
    ? await outreachInstruction(outreach as OutreachContext, historyCount)
    : joinedInbound === ""
      ? "(message sans texte — pièce jointe ou MMS vide)"
      : joinedInbound;
  const inboundBatch = inbound.map((m) => ({
    id: m.id,
    body: m.body,
    receivedAt: m.createdAt.toISOString(),
  }));

  // Une clé manquante lançait AVANT tout filet : pas de trace, pas de pastille,
  // entrants laissés en l'air. On la traite comme une panne de modèle, plus bas.
  let providerInitError: string | null = null;
  let generator: ReturnType<typeof getLlmProvider> | null = null;
  let classifierProvider: ReturnType<typeof getLlmProvider> | null = null;
  try {
    generator = getLlmProvider(config.model.provider);
    classifierProvider = getLlmProvider(config.model.classifier.provider);
  } catch (err) {
    providerInitError =
      err instanceof LlmUnconfiguredError ? "llm_unconfigured" : err instanceof Error ? err.message : "llm_init_failed";
  }
  const classifierCall = async ({ system, user }: { system: string; user: string }) => {
    if (!classifierProvider) throw new Error(providerInitError ?? "llm_unconfigured");
    const out = await classifierProvider.generate({
      system,
      messages: [{ role: "user", content: user }],
      model: config.model.classifier.model,
      maxTokens: 300,
      temperature: 0,
      // Mêmes exigences de confidentialité que le générateur : le classifieur
      // et les juges lisent les mêmes messages du client.
      routing: config.model.routing as unknown as Record<string, unknown>,
    });
    return out.text;
  };

  const traceBase = {
    conversationId,
    assistantId: assistantRow.id,
    assistantVersion: assistantRow.version,
    coreVersion: assistantRow.compiledCoreVersion,
    inboundBatch,
    systemPrompt: assistantRow.compiledPrompt,
    provider: config.model.provider,
    modelRequested: config.model.model,
  };

  /**
   * Valide le tour : re-vérifie sous verrou que les entrants sont toujours à
   * traiter (sinon un tour concurrent a gagné), puis écrit TOUT d'un bloc.
   */
  const commit = async (input: {
    outcome: TurnOutcome;
    trace: Record<string, unknown>;
    conversationPatch?: Partial<typeof conversations.$inferInsert>;
    events?: { type: string; payload?: Record<string, unknown> }[];
    send?: { body: string; delayMs: number };
    qualification?: Record<string, unknown>;
    reason?: string;
    /**
     * Faux = les entrants restent NON traités (panne passagère du modèle : la
     * file réessaie avec temporisation et doit retrouver de quoi reprendre).
     */
    consume?: boolean;
    /** Sort des inscriptions de campagne de ce fil (réservation, clôture). */
    enrollmentOutcome?: { status: "booked" | "completed" | "stopped"; endReason: string };
    /** Prévenir les humains, et pourquoi (texte lisible). */
    alert?: { kind: "handoff" | "blocked" | "error" | "stopped" | "closed"; reason: string };
  }): Promise<TurnResult> => {
    const consume = input.consume !== false;
    const traceId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`);

      const stillPending = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.direction, "in"),
            isNull(messages.processedAt),
          ),
        );
      const pendingIds = new Set(stillPending.map((m) => m.id));
      // Un autre tour a déjà consommé ces messages : on abandonne le nôtre
      // plutôt que de répondre deux fois.
      if (!inboundIds.every((id) => pendingIds.has(id))) return null;
      // Ouverture proactive alors que le contact vient d'écrire : on s'efface.
      // Le tour de réponse (déjà en file par le webhook) parlera à sa place —
      // sinon le contact recevrait une ouverture APRÈS sa propre question.
      if (proactive && stillPending.length > 0 && input.outcome === "sent") return null;

      const now = new Date();
      // On ne marque QUE les entrants que ce tour a réellement lus. Un message
      // arrivé pendant la réflexion n'a pas été vu par le modèle : le consommer
      // ici le ferait disparaître sans réponse.
      if (consume && inboundIds.length > 0) {
        await tx
          .update(messages)
          .set({ processedAt: now })
          .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, inboundIds)));
      }
      if (input.enrollmentOutcome) {
        await tx
          .update(campaignEnrollments)
          .set({
            status: input.enrollmentOutcome.status,
            endReason: input.enrollmentOutcome.endReason,
            endedAt: now,
            nextTouchAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignEnrollments.conversationId, conversationId),
              inArray(campaignEnrollments.status, ["pending", "active", "replied"]),
            ),
          );
      }

      if (input.conversationPatch || input.qualification) {
        await tx
          .update(conversations)
          .set({
            ...(input.conversationPatch ?? {}),
            ...(input.qualification ? { qualification: input.qualification } : {}),
          })
          .where(eq(conversations.id, conversationId));
      }

      for (const event of input.events ?? []) {
        await tx
          .insert(agentEvents)
          .values({ conversationId, type: event.type, payload: event.payload ?? {} });
      }

      const [trace] = await tx
        .insert(agentTurnTraces)
        .values({
          ...traceBase,
          ...input.trace,
          outcome: input.outcome,
        } as typeof agentTurnTraces.$inferInsert)
        .returning({ id: agentTurnTraces.id });

      if (input.send) {
        await enqueueJob(
          {
            type: "send_sms",
            runAt: new Date(now.getTime() + input.send.delayMs),
            payload: {
              conversationId,
              to: conversation.clientPhone,
              body: input.send.body,
              source: "agent",
              automated: true,
              aiGenerated: true,
              sentById: null,
            },
          },
          tx,
        );
      }
      return trace.id;
    });

    if (traceId !== null && input.alert) {
      // Hors transaction : une notification qui échoue ne doit pas annuler le
      // tour, et rien ne dépend d'elle.
      await notifyHumans({
        conversationId,
        clientId: conversation.clientId,
        kind: input.alert.kind,
        reason: input.alert.reason,
      }).catch(() => 0);
    }

    if (traceId === null) {
      // Ouverture effacée par un entrant : on s'assure qu'un tour de RÉPONSE
      // existe. Le webhook en a normalement posé un ; la clé absorbe le doublon.
      if (proactive) {
        await enqueueJob({
          type: "agent_turn",
          runAt: new Date(Date.now() + 5_000),
          payload: { conversationId },
          dedupeKey: `turn:${conversationId}`,
        });
      }
      return { outcome: "skipped_superseded", conversationId };
    }

    // Un message arrivé PENDANT le tour n'a pas été consommé : la clé de
    // dédoublonnage l'aurait absorbé dans le job en cours et il resterait sans
    // réponse. On reprogramme donc explicitement — sauf quand ce tour a LAISSÉ
    // les entrants exprès (panne passagère) : c'est la reprise de la file qui
    // les reprendra, un second job ferait deux réponses.
    if (input.outcome !== "stopped" && consume) {
      const leftover = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.direction, "in"),
            isNull(messages.processedAt),
          ),
        )
        .limit(1);
      if (leftover.length > 0) {
        // Clé DISTINCTE de celle du webhook : `turn:<conv>` désigne encore le
        // job EN COURS (le nôtre) et absorberait cette mise en file — le
        // message arrivé pendant la réflexion n'aurait alors jamais de tour.
        await enqueueJob({
          type: "agent_turn",
          runAt: new Date(Date.now() + 5_000),
          payload: { conversationId },
          dedupeKey: `turn:${conversationId}:next`,
        });
      }
    }

    return { outcome: input.outcome, conversationId, traceId, reason: input.reason };
  };

  // Clé de modèle absente : même contrat qu'une panne du modèle, avant même de
  // réfléchir. Tant qu'il reste des tentatives, les entrants restent à traiter.
  if (providerInitError !== null || generator === null) {
    const reason = providerInitError ?? "llm_unconfigured";
    const final = options.finalAttempt === true;
    return commit({
      outcome: "error",
      reason,
      trace: { runtimeBlock: "", rawResponse: { error: reason } },
      consume: final,
      ...(final
        ? {
            conversationPatch: { needsAttention: true, attentionReason: "llm_error" },
            alert: { kind: "error" as const, reason },
          }
        : {}),
      events: [{ type: "llm_error", payload: { stage: "init", error: reason } }],
    });
  }
  const generatorProvider = generator;

  // ═══ 2. RÉFLEXION (hors transaction, hors verrou) ════════════════════════

  // Rien à classer quand c'est l'assistant qui ouvre : la consigne n'est pas
  // un message du contact, et la passer au classifieur coûterait un appel pour
  // un verdict sans objet.
  const { classification: rawClassification, error: classifyError } = proactive
    ? {
        classification: {
          optOut: false,
          refusal: "none" as const,
          qualification: {},
          wantsHuman: false,
          unintelligible: false,
        },
        error: undefined,
      }
    : await classifyInbound(userTurn, classifierCall);
  // Un STOP DANS une rafale : le détecteur exige que le message ENTIER soit le
  // mot-clé, donc « on se voit quand? » + « STOP » concaténés ne matchent pas.
  // On teste chaque entrant séparément — un STOP noyé reste un STOP.
  const burstOptOut = inbound.some((m) => detectOptOut(m.body).optOut);
  const classification: Classification = burstOptOut
    ? { ...rawClassification, optOut: true, refusal: "hard" }
    : rawClassification;

  // Désabonnement : suppression, arrêt, AUCUN message.
  if (classification.optOut) {
    await suppressPhone(conversation.clientPhone, "sms_stop", "agent_runtime");
    return commit({
      outcome: "stopped",
      reason: "optout",
      trace: { runtimeBlock: "", rawResponse: {} },
      conversationPatch: { aiEnabled: false, needsAttention: true, attentionReason: "optout" },
      events: [{ type: "stop", payload: { source: burstOptOut ? "keyword" : "classifier" } }],
      enrollmentOutcome: { status: "stopped", endReason: "opted_out" },
      alert: { kind: "stopped", reason: "désabonnement" },
    });
  }

  const softBefore = conversation.softRefusals;
  const downgrade = applyRefusal(config.goal, softBefore, classification.refusal);

  // Refus ferme : la chaîne n'est PAS touchée — on ne propose pas de repli à
  // quelqu'un qui vient de dire non.
  if (classification.refusal === "hard") {
    return commit({
      outcome: "stopped",
      reason: "hard_refusal",
      trace: { runtimeBlock: "", rawResponse: {} },
      conversationPatch: {
        aiEnabled: false,
        needsAttention: true,
        attentionReason: "hard_refusal",
      },
      events: [{ type: "hard_refusal" }],
      enrollmentOutcome: { status: "stopped", endReason: "hard_refusal" },
      alert: { kind: "stopped", reason: "refus clair du contact" },
    });
  }

  // Budget de tours : seuls les messages de l'AGENT comptent — la réponse
  // manuelle d'un téléphoniste ne doit pas grignoter le budget de l'assistant.
  const [turnCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "out"),
        eq(messages.source, "agent"),
      ),
    );
  const turnsUsed = turnCount?.n ?? 0;

  if (turnsUsed >= config.approach.maxTurns || downgrade.exhausted || classification.wantsHuman) {
    const reason = classification.wantsHuman
      ? "client_wants_human"
      : downgrade.exhausted
        ? "goal_chain_exhausted"
        : "max_turns";
    return commit({
      outcome: "handoff",
      reason,
      trace: { runtimeBlock: "", rawResponse: {} },
      conversationPatch: { aiEnabled: false, needsAttention: true, attentionReason: reason },
      events: [{ type: "escalation", payload: { reason } }],
      alert: { kind: "handoff", reason },
    });
  }

  const rung = downgrade.rung;
  const qualification: Record<string, unknown> = {
    ...((conversation.qualification as Record<string, unknown> | null) ?? {}),
    ...classification.qualification,
  };

  let slotsText = "aucune";
  if (rungNeedsSlots(rung) && rung.goal.appointmentType) {
    try {
      const { slots, googleConnected } = await getInternalBookingProvider().getSlots({
        type: rung.goal.appointmentType,
        count: rung.goal.slotOfferCount,
      });
      slotsText =
        googleConnected && slots.length > 0 ? slots.map((s) => s.label).join(", ") : "aucune";
    } catch {
      // L'agenda est injoignable : on n'invente pas d'heures.
      slotsText = "aucune";
    }
  }

  const runtimeBlock = assistantRow.includeRuntimeLayer
    ? renderTemplate(assistantRow.turnInstructions ?? DEFAULT_TURN_INSTRUCTIONS, {
        "lead.prenom": (client?.fullName ?? "").split(/\s+/)[0] ?? "",
        "lead.source": client?.projectType ?? "",
        "lead.besoin": client?.projectType ?? "",
        "lead.secteur": client?.city ?? "",
        "lead.budget": client?.budget ?? "",
        qualification:
          Object.entries(qualification)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(", ") || "aucune",
        "goal.type": rung.goal.type,
        "goal.rung": rung.key,
        "goal.required_fields": requiredFieldsFor(rung).join(", ") || "aucune",
        slots: slotsText,
        turns_used: turnsUsed,
        max_turns: config.approach.maxTurns,
        soft_refusals: downgrade.softRefusals,
        now_local: formatInTimeZone(new Date(), APP_TZ, "EEEE HH'h'mm"),
        send_window: `${DEFAULT_QUIET_HOURS.weekday[0]}h-${DEFAULT_QUIET_HOURS.weekday[1]}h`,
        "assistant.name": config.name,
        org: config.identity.orgName,
      }).text
    : "";

  const system =
    runtimeBlock === ""
      ? assistantRow.compiledPrompt
      : `${assistantRow.compiledPrompt}\n\n${runtimeBlock}`;

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  const consumed = new Set(inboundIds);
  const messageArray: LLMMessage[] = [
    ...history
      .filter((m) => !consumed.has(m.id))
      .map((m) => ({
        role: m.direction === "out" ? ("assistant" as const) : ("user" as const),
        content: m.body,
      })),
    { role: "user" as const, content: userTurn },
  ];

  const tools = toolDefsFor(config.tools);
  const effects: ToolEffect[] = [];
  const sideEffectsDone = new Set<string>();

  let result: LLMResult | null = null;
  let draft = "";
  let verdicts: RuleVerdict[] = [];
  let regenerations = 0;
  let llmError: string | null = null;
  let terminatedByTool: "stop" | "handoff" | null = null;
  let bookingFailed = false;
  let bookedNow = false;
  let closedOutcome: ToolRunResult["closedOutcome"] = null;
  let transferTo: string | null = null;
  let fallbackUsed = false;
  let extraParagraphs = 0;
  const intents = [
    ...(classification.wantsHuman ? ["handoff"] : []),
    ...(classification.unintelligible ? ["unintelligible"] : []),
  ];

  /**
   * Un appel au générateur, avec repli configuré. Le repli n'était jamais
   * utilisé : le modèle principal en panne, le tour finissait en erreur alors
   * qu'un second fournisseur était réglé exactement pour ça.
   */
  const generateWithFallback = async (
    input: Omit<Parameters<typeof generatorProvider.generate>[0], "model">,
  ): Promise<LLMResult> => {
    try {
      return await generatorProvider.generate({ ...input, model: config.model.model });
    } catch (primaryErr) {
      const fallback = config.model.fallback;
      if (!fallback) throw primaryErr;
      const out = await getLlmProvider(fallback.provider).generate({ ...input, model: fallback.model });
      fallbackUsed = true;
      return out;
    }
  };
  /** Refus successifs — journalises meme quand la regeneration finit par passer. */
  const blockedAttempts: string[][] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction =
      attempt === 0
        ? ""
        : `\n\nCONSIGNE DE CORRECTION : ta réponse précédente a été refusée par un garde-fou (${blockingFailures(
            verdicts,
          )
            .map((v) => v.label)
            .join(" · ")}). Réécris-la en respectant strictement cette règle.`;

    const turnMessages: LLMMessage[] = [...messageArray];

    // Deux allers-retours d'outils au maximum : assez pour « je consulte
    // l'agenda puis je propose », borné pour ne pas laisser un modèle boucler.
    // Le TROISIÈME passage n'offre plus d'outils : un modèle qui appelait
    // encore un outil au deuxième tour produisait un brouillon vide, et le fil
    // passait à l'humain alors que l'assistant avait fait son travail.
    for (let round = 0; round < 3; round += 1) {
      const offerTools = round < 2;
      try {
        result = await generateWithFallback({
          system: system + correction,
          messages: turnMessages,
          tools: offerTools ? tools : [],
          maxTokens: config.model.maxTokens,
          temperature: config.model.temperature,
          routing: config.model.routing as unknown as Record<string, unknown>,
            ...(config.model.reasoningEffort === "none"
              ? {}
              : { reasoningEffort: config.model.reasoningEffort }),
        });
      } catch (err) {
        llmError = err instanceof Error ? err.message : String(err);
        break;
      }

      if (result.toolCalls.length === 0 || !offerTools) break;

      const ran = await executeTools({
        calls: result.toolCalls,
        rung,
        clientId: conversation.clientId,
        clientAssignedToId: client?.assignedToId ?? null,
        conversationId,
        currentAssistantId: assistantRow.id,
        qualification,
        effects,
        sideEffectsDone,
      });
      if (ran.bookingFailed) bookingFailed = true;
      if (ran.booked) bookedNow = true;
      if (ran.closedOutcome) closedOutcome = ran.closedOutcome;
      if (ran.transferTo) transferTo = ran.transferTo;
      if (ran.terminated) {
        terminatedByTool = ran.terminated;
        break;
      }
      // VRAI protocole d'outils : l'assistant déclare ses appels, puis chaque
      // résultat lui revient rattaché à son identifiant. Maquillé en message
      // `user`, le modèle ne reliait pas le résultat à sa demande : il la
      // réémettait et n'écrivait rien — le tour partait en escalade alors que
      // l'assistant avait fait son travail.
      turnMessages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });
      for (const r of ran.results) {
        turnMessages.push({ role: "tool", toolCallId: r.id, name: r.name, content: r.content });
      }
    }

    if (llmError !== null || terminatedByTool !== null || result === null) break;

    // UN SEUL message par tour : le premier paragraphe part, le reste est noté.
    const paragraphs = result.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    draft = paragraphs[0] ?? "";
    extraParagraphs = Math.max(0, paragraphs.length - 1);

    verdicts = await evaluateAllRules(
      draft,
      rules,
      {
        toolCallNames: effects.filter((e) => e.ok).map((e) => e.name),
        inbound: proactive ? "(ouverture — aucun message entrant)" : userTurn,
        // Aucun message de l'agent avant celui-ci = premier contact.
        isFirstOutbound: turnsUsed === 0,
        intents,
      },
      classifierCall,
    );
    if (blockingFailures(verdicts).length === 0) break;
    blockedAttempts.push(blockingFailures(verdicts).map((v) => v.label));
    regenerations = attempt + 1;
  }

  // ═══ 3. ÉCRITURE ═════════════════════════════════════════════════════════

  const events: { type: string; payload?: Record<string, unknown> }[] = blockedAttempts.map(
    (rules_, index) => ({
      type: "blocked_output",
      payload: { attempt: index + 1, rules: rules_ },
    }),
  );
  events.push(...effects.map((effect) => ({
    type: "tool_call",
    payload: {
      name: effect.name,
      ok: effect.ok,
      ...(effect.detail ? { error: effect.detail } : {}),
    },
  })));
  if (fallbackUsed) {
    events.push({ type: "fallback_used", payload: { model: config.model.fallback?.model ?? null } });
  }
  if (proactive && outreach) {
    events.push({
      type: "outreach",
      payload: { enrollmentId: outreach.enrollmentId, step: outreach.step },
    });
  }
  if (downgrade.downgraded) {
    events.push({
      type: "goal_downgrade",
      payload: { softRefusals: downgrade.softRefusals, to: downgrade.rung.key },
    });
  }
  if (extraParagraphs > 0) {
    events.push({ type: "extra_paragraphs_dropped", payload: { count: extraParagraphs } });
  }
  if (classifyError) {
    events.push({ type: "llm_error", payload: { stage: "classifier", error: classifyError } });
  }

  const baseState = { goalRung: downgrade.rung.key, softRefusals: downgrade.softRefusals };
  const modelFacts = result
    ? {
        modelServed: result.modelServed,
        upstreamProvider: result.upstreamProvider ?? null,
        rawResponse: result.raw as Record<string, unknown>,
        latencyMs: result.latencyMs,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        costUsd: result.usage.costUsd?.toString(),
      }
    : {};
  const traceCommon = {
    runtimeBlock,
    messageArray,
    toolsOffered: tools,
    toolCalls: effects,
    regenerations,
  };

  // Outil terminal : la conversation est close, rien de plus ne part.
  if (terminatedByTool !== null) {
    if (terminatedByTool === "stop") {
      await suppressPhone(conversation.clientPhone, "sms_stop", "agent_tool");
    }
    events.push({
      type: terminatedByTool === "stop" ? "stop" : "escalation",
      payload: { source: "tool" },
    });
    return commit({
      outcome: terminatedByTool === "stop" ? "stopped" : "handoff",
      reason: `tool_${terminatedByTool}`,
      trace: { ...traceCommon, ...modelFacts },
      conversationPatch: {
        ...baseState,
        aiEnabled: false,
        needsAttention: true,
        attentionReason: terminatedByTool === "stop" ? "optout" : "handoff",
      },
      events,
      qualification,
      ...(terminatedByTool === "stop"
        ? { enrollmentOutcome: { status: "stopped" as const, endReason: "opted_out" } }
        : {}),
      alert:
        terminatedByTool === "stop"
          ? { kind: "stopped", reason: "arrêt demandé par l'assistant" }
          : { kind: "handoff", reason: "l'assistant passe la main" },
    });
  }

  // Panne du fournisseur : trace, jamais d'envoi. Tant qu'il reste des
  // tentatives, les entrants restent NON traités pour que la reprise les
  // retrouve ; à la dernière, on passe la main et on prévient.
  if (llmError !== null || result === null) {
    events.push({ type: "llm_error", payload: { error: llmError } });
    const final = options.finalAttempt === true;
    return commit({
      outcome: "error",
      reason: llmError ?? "no_result",
      trace: { ...traceCommon, rawResponse: { error: llmError } },
      consume: final,
      conversationPatch: final
        ? { ...baseState, needsAttention: true, attentionReason: "llm_error" }
        : baseState,
      events,
      qualification,
      ...(final ? { alert: { kind: "error" as const, reason: llmError ?? "no_result" } } : {}),
    });
  }

  const guardrailJson = verdicts.map((v) => ({
    key: v.key,
    label: v.label,
    severity: v.severity,
    passed: v.passed,
    reason: v.reason ?? null,
  }));

  // Toujours bloqué après la régénération : on n'envoie RIEN.
  if (blockingFailures(verdicts).length > 0) {
    // Un juge injoignable bloque tout (fermeture par défaut, voulue) — mais
    // l'opérateur doit distinguer « l'assistant a mal écrit » d'une panne de
    // notre côté, sinon il cherche au mauvais endroit.
    const allJudgeErrors = blockingFailures(verdicts).every(
      (v) => v.reason === "judge_error" || v.reason === "judge_unparseable",
    );
    events.push({ type: "escalation", payload: { reason: "blocked_after_regeneration" } });
    return commit({
      outcome: "blocked",
      trace: { ...traceCommon, guardrailResults: guardrailJson, ...modelFacts },
      conversationPatch: {
        ...baseState,
        needsAttention: true,
        attentionReason: allJudgeErrors ? "guardrail_unavailable" : "blocked_output",
      },
      events,
      qualification,
      alert: {
        kind: "blocked",
        reason: allJudgeErrors
          ? "juge indisponible"
          : blockingFailures(verdicts).map((v) => v.label).join(", "),
      },
    });
  }

  // Une réservation a ÉCHOUÉ : le brouillon peut annoncer un rendez-vous qui
  // n'existe pas. On n'envoie rien et on passe la main — mieux vaut un humain
  // qui rappelle qu'un client convaincu d'avoir un rendez-vous fantôme.
  if (bookingFailed) {
    events.push({ type: "escalation", payload: { reason: "booking_failed" } });
    return commit({
      outcome: "handoff",
      reason: "booking_failed",
      trace: { ...traceCommon, guardrailResults: guardrailJson, ...modelFacts },
      conversationPatch: {
        ...baseState,
        needsAttention: true,
        attentionReason: "booking_failed",
      },
      events,
      qualification,
      alert: { kind: "handoff", reason: "réservation échouée" },
    });
  }

  if (draft === "") {
    events.push({ type: "escalation", payload: { reason: "no_text" } });
    return commit({
      outcome: "handoff",
      reason: "no_text",
      trace: { ...traceCommon, guardrailResults: guardrailJson, ...modelFacts },
      conversationPatch: { ...baseState, needsAttention: true, attentionReason: "no_text" },
      events,
      qualification,
      alert: { kind: "handoff", reason: "l'assistant n'a rien écrit" },
    });
  }

  // Le fournisseur a coupé la réponse (max_tokens) ou l'a filtrée : un SMS
  // tronqué au milieu d'une phrase ne part pas — un humain reprend.
  if (result.truncated) events.push({ type: "truncated", payload: { finishReason: result.finishReason ?? null } });
  if (result.truncated || result.finishReason === "content_filter") {
    const reason = result.finishReason === "content_filter" ? "content_filter" : "truncated";
    events.push({ type: "escalation", payload: { reason } });
    return commit({
      outcome: "handoff",
      reason,
      trace: { ...traceCommon, guardrailResults: guardrailJson, ...modelFacts },
      conversationPatch: { ...baseState, needsAttention: true, attentionReason: reason },
      events,
      qualification,
      alert: { kind: "handoff", reason: reason === "truncated" ? "réponse coupée par le modèle" : "réponse filtrée par le fournisseur" },
    });
  }

  if (bookedNow) events.push({ type: "booked" });
  if (closedOutcome) events.push({ type: "closed", payload: { outcome: closedOutcome } });
  if (transferTo) events.push({ type: "transfer", payload: { to: transferTo } });

  // La réponse part : la pastille « nouveau message » tombe d'elle-même —
  // sinon l'inbox « à traiter » se remplissait de fils que l'assistant avait
  // déjà traités. Une raison plus grave (passage humain, blocage) n'est jamais
  // effacée ici : l'IA serait en pause et ce tour n'aurait pas lieu.
  const clearInbound =
    conversation.needsAttention &&
    (conversation.attentionReason === "inbound" || conversation.attentionReason === null);
  const closedReason =
    closedOutcome === "goal_reached"
      ? "objectif atteint"
      : closedOutcome === "disqualified"
        ? "contact non qualifié"
        : closedOutcome === "not_interested"
          ? "contact pas intéressé"
          : null;

  return commit({
    outcome: "sent",
    trace: { ...traceCommon, guardrailResults: guardrailJson, ...modelFacts },
    conversationPatch: {
      ...baseState,
      ...(clearInbound ? { needsAttention: false, attentionReason: null } : {}),
      ...(transferTo ? { activeAssistantId: transferTo } : {}),
      // Fil clos par l'assistant : l'IA se tait après ce message et un humain
      // voit le résultat dans l'inbox.
      ...(closedOutcome
        ? { aiEnabled: false, needsAttention: true, attentionReason: `closed_${closedOutcome}` }
        : {}),
    },
    events,
    qualification,
    send: { body: draft, delayMs: replyDelayMs(config.approach.replySpeed) },
    ...(bookedNow
      ? { enrollmentOutcome: { status: "booked" as const, endReason: "booked" } }
      : closedOutcome === "goal_reached"
        ? { enrollmentOutcome: { status: "completed" as const, endReason: "goal_reached" } }
        : closedOutcome
          ? { enrollmentOutcome: { status: "stopped" as const, endReason: closedOutcome } }
          : {}),
    ...(closedReason ? { alert: { kind: "closed" as const, reason: closedReason } } : {}),
  });
}
