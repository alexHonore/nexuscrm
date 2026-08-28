import "server-only";
import { eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";
import {
  assistantRowToConfig,
  classifierChain,
  customQualificationFields,
  modelChain,
  retryPolicyFor,
} from "@/lib/assistants/schema";
import { resolvedRulesFor } from "@/lib/assistants/service";
import { blockingFailures, evaluateOutputRules } from "@/lib/guardrails/filter";
import { judgeWithLlm } from "@/lib/guardrails/judge";
import { enabledRules } from "@/lib/guardrails/resolve";
import type { RuleData, RuleVerdict } from "@/lib/guardrails/types";
import type { LLMMessage, LLMResult } from "@/lib/llm/types";
import { generateWithChain } from "@/lib/llm/route";
import { getLlmProvider } from "@/lib/llm-server";
import { APP_TZ } from "@/components/clients/timezone";
import {
  applySegmentBudget,
  charBudgetFor,
  trimToSegments,
  type SegmentBudgetOutcome,
} from "@/lib/sms/budget";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";
import { analyzeSms } from "@/lib/sms/segments";
import { classifyInbound } from "./classify";
import { contactValue, qualificationText } from "./contact-data";
import { applyRefusal, requiredFieldsFor, rungNeedsSlots } from "./goal";
import { outreachInstructionText } from "./opening";
import { renderTemplate } from "./render";
import { CLOSING_INSTRUCTIONS, CLOSING_TOOL_NAMES, DEFAULT_TURN_INSTRUCTIONS } from "./templates";
import { getSetting } from "@/lib/settings";
import { simulateToolCall, simulatedSlotsText } from "./tool-simulation";
import { toolDefsFor } from "./tools";

/**
 * Bac à sable — parler à un assistant comme si on était le client.
 *
 * Il exerce les MÊMES pièces que la production (`runtime.ts`), dans le MÊME
 * ordre : le prompt compilé, la couche d'exécution rendue par le même gabarit,
 * le même classifieur, les mêmes portes AVANT le générateur (désabonnement,
 * refus ferme, budget de tours, chaîne épuisée, demande d'humain), la même
 * consigne d'ouverture, les mêmes outils offerts au modèle, le même aller-
 * retour d'outils, la même coupe au premier paragraphe, le même filtre de
 * garde-fous avec la même régénération unique, et le même verdict final.
 * C'est ce qui rend l'aperçu utile : voir « à peu près » ce que dirait
 * l'assistant n'aiderait personne à régler une persistance ou un ton — et un
 * aperçu qui montre « envoyé » là où la production se tairait est pire
 * qu'aucun aperçu.
 *
 * Ce qu'il ne fait PAS, délibérément : il n'écrit rien, n'envoie rien, ne
 * réserve rien. Les appels d'outils sont SIMULÉS (`tool-simulation.ts`),
 * jamais exécutés — un aperçu qui bloquerait une vraie plage d'agenda serait un
 * piège. C'est aussi pourquoi il ne touche ni aux conversations ni aux
 * clients : un essai ne doit pas apparaître dans la boîte de réception.
 *
 * Et surtout : RIEN de ce que lit le modèle ne dit qu'il est à l'essai. Une
 * version antérieure écrivait « bac à sable » dans la couche L7 ; le modèle
 * savait qu'il testait, contredisait ses propres disponibilités et se
 * comportait autrement qu'en production. L'avertissement s'adresse à l'humain,
 * à l'écran.
 */

export interface SandboxTurnInput {
  assistantId: string;
  /** L'historique déjà échangé dans le bac à sable — seulement ce qui serait réellement parti. */
  history: { role: "assistant" | "user"; content: string }[];
  /**
   * Ce que le client écrit. VIDE = c'est l'assistant qui ouvre (ou relance).
   *
   * Un assistant ne répond pas seulement : il est aussi déclenché par une
   * campagne et doit alors écrire le PREMIER message, ou relancer un contact
   * silencieux. Sans ce cas, l'essai attendait éternellement que le client
   * parle — un comportement que la production n'a pas.
   */
  inbound: string;
  /**
   * Ce qui a déclenché le tour. Conservé pour les appelants existants ; la
   * consigne d'ouverture ne dépend plus de lui (la production ne distingue pas
   * un nouveau lead d'un changement d'étape : les deux passent par la même
   * consigne, avec le contexte de la campagne).
   */
  trigger?: "inbound" | "lead_created" | "category_changed" | "manual";
  /** Contexte du faux client — ce que la couche d'exécution recevrait. */
  lead?: { firstName?: string; city?: string; budget?: string; projectType?: string };
  /** Qualification accumulée au fil de l'essai. */
  qualification?: Record<string, unknown>;
  softRefusals?: number;
  /**
   * Une ouverture a-t-elle déjà été envoyée à ce client, HORS de l'historique
   * fourni?
   *
   * Par défaut OUI, parce que c'est la situation la plus courante : l'assistant
   * reprend une conversation ouverte par une campagne. Sans cette hypothèse, le
   * premier essai part comme un PREMIER message sortant et la règle LCAP exige
   * d'y nommer l'organisation — ce qui est juste, mais surprend quand on veut
   * tester le milieu d'une conversation. Ignoré quand l'assistant ouvre
   * lui-même (`inbound` vide) : c'est alors l'historique qui fait foi.
   */
  openerSent?: boolean;
  /**
   * Tour PROACTIF : le barreau de campagne que l'assistant rédige lui-même.
   * `step` 0 = ouverture, n > 0 = n-ième relance. Absent avec un `inbound`
   * vide = ouverture sans contexte de campagne.
   */
  outreach?: {
    step: number;
    campaignName?: string;
    campaignDescription?: string;
    /** Longueur de l'échelle (ouverture comprise) — pour « relance n sur N ». */
    ladderLength?: number;
  };
}

/**
 * Ce que la PRODUCTION ferait de ce tour — mêmes valeurs que `TurnOutcome`
 * dans `runtime.ts`, restreintes à ce qu'un essai peut produire. Un brouillon
 * vide n'est pas un bogue d'aperçu : c'est un tour qui, en vrai, part en
 * escalade (`handoff` / `no_text`) — le dire évite de chercher une panne là
 * où il y a un comportement.
 */
export type SandboxOutcome = "sent" | "blocked" | "stopped" | "handoff" | "error";

/** Le détail du verdict — mêmes libellés que `reason` / `attentionReason` en production. */
export type SandboxReason =
  | "optout"
  | "hard_refusal"
  | "client_wants_human"
  | "goal_chain_exhausted"
  | "max_turns"
  | "tool_stop"
  | "tool_handoff"
  | "blocked_after_regeneration"
  | "guardrail_unavailable"
  | "booking_failed"
  | "no_text"
  | "llm_error";

export interface SandboxToolCall {
  name: string;
  args: unknown;
  /** Faux quand les arguments n'ont pas passé zod — l'appel ne compte pas. */
  ok: boolean;
  /** Ce que le modèle a lu en retour (vide pour stop / handoff). */
  result: string;
}

export interface SandboxUsage {
  /** Nombre d'appels modèle du tour : classifieur + générateur(s) + juges. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Somme des coûts rapportés par le fournisseur — null s'il n'en rapporte pas. */
  costUsd: number | null;
  latencyMs: number;
  /** Le modèle qui a RÉELLEMENT répondu au dernier appel générateur. */
  modelServed: string | null;
}

export interface SandboxTurnResult {
  /** Le message que l'assistant enverrait, ou "" si rien ne partirait. */
  draft: string;
  outcome: SandboxOutcome;
  reason: SandboxReason | null;
  blocked: boolean;
  /** Verdicts de TOUTES les règles évaluées — c'est ce qu'on vient régler. */
  verdicts: RuleVerdict[];
  toolCalls: SandboxToolCall[];
  classification: {
    optOut: boolean;
    refusal: "none" | "soft" | "hard";
    wantsHuman: boolean;
    qualification: Record<string, unknown>;
  };
  /**
   * Le classifieur a bafouillé ou était injoignable : la classification est
   * NEUTRE, pas absente. Le dire, sinon l'admin conclut que « pas cette
   * semaine » n'est pas un refus mou alors que personne n'a tranché.
   */
  classifierError: string | null;
  /** Cran d'objectif courant après application d'un éventuel refus mou. */
  rung: string;
  requiredFields: string[];
  /** Le bloc L7 réellement envoyé — pour comprendre ce que le modèle a lu. */
  runtimeBlock: string;
  /** La consigne donnée à la place d'un entrant quand l'assistant ouvre ou relance. */
  instruction: string | null;
  softRefusals: number;
  qualification: Record<string, unknown>;
  /** Messages de l'agent comptés AVANT ce tour — ce que lit « Messages utilisés ». */
  turnsUsed: number;
  /** 1 si un garde-fou a exigé une réécriture (la production en accorde une seule). */
  regenerations: number;
  /** Paragraphes que la production aurait COUPÉS : un seul message part. */
  droppedParagraphs: number;
  /** Le texte complet du modèle, avant la coupe — pour voir ce qui est tombé. */
  fullText: string;
  /**
   * Ce que le budget de segments a fait au brouillon, ou null s'il n'a rien
   * fait. L'aperçu doit le DIRE : un message raccourci sans explication se lit
   * comme un modèle qui écrit mal, et on va régler le ton au lieu du plafond.
   */
  segmentBudget: {
    /** Le plafond en vigueur — null quand aucun n'est posé. */
    max: number | null;
    /** Segments facturés pour le brouillon écrit par le modèle. */
    before: number;
    /** Segments facturés pour ce qui partirait. */
    after: number;
    /** « typography », « ascii », « trim » — dans l'ordre d'application. */
    applied: string[];
    /** Le message dépasse ENCORE le plafond. */
    overBudget: boolean;
  } | null;
  usage: SandboxUsage | null;
  error: string | null;
}

/** Accumule les appels modèle du tour — l'essai coûte, autant le dire. */
function usageTracker() {
  const usage: SandboxUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    latencyMs: 0,
    modelServed: null,
  };
  return {
    usage,
    add(result: LLMResult, generator: boolean) {
      usage.calls += 1;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      if (typeof result.usage.costUsd === "number") {
        usage.costUsd = (usage.costUsd ?? 0) + result.usage.costUsd;
      }
      usage.latencyMs += result.latencyMs;
      if (generator) usage.modelServed = result.modelServed;
    },
  };
}

export async function simulateTurn(input: SandboxTurnInput): Promise<SandboxTurnResult> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, input.assistantId) });
  if (!row) throw new Error("assistant_not_found");
  if (!row.compiledPrompt) throw new Error("assistant_not_compiled");

  const config = assistantRowToConfig(row);
  const rules = await resolvedRulesFor(input.assistantId);

  const tracker = usageTracker();
  // Mêmes chaînes de replis qu'en production : l'aperçu doit échouer et se
  // rattraper comme le vrai moteur, sinon il ment sur ce qui va se passer.
  const generatorRungs = modelChain(config.model);
  const classifierRungs = classifierChain(config.model);
  const retry = retryPolicyFor(config.model);
  const classifierCall = async (p: { system: string; user: string }) => {
    const { result } = await generateWithChain(
      classifierRungs,
      {
        system: p.system,
        messages: [{ role: "user", content: p.user }],
        maxTokens: 300,
        temperature: 0,
        retry,
      },
      { resolve: getLlmProvider },
    );
    tracker.add(result, false);
    return result.text;
  };

  // La production n'a jamais de message vide dans un fil : un brouillon bloqué
  // ou vide n'est pas stocké. On les écarte ici aussi, sinon le modèle lit un
  // fil qui n'a pas existé — et certains fournisseurs refusent un message
  // d'assistant vide.
  const history = input.history.filter((m) => m.content.trim() !== "");
  const opening = input.inbound.trim() === "";
  const inbound = input.inbound.trim();

  const empty: Omit<SandboxTurnResult, "error"> = {
    draft: "",
    outcome: "error",
    reason: null,
    blocked: false,
    verdicts: [],
    toolCalls: [],
    classification: { optOut: false, refusal: "none", wantsHuman: false, qualification: {} },
    classifierError: null,
    rung: "primary",
    requiredFields: [],
    runtimeBlock: "",
    instruction: null,
    softRefusals: input.softRefusals ?? 0,
    qualification: input.qualification ?? {},
    turnsUsed: 0,
    regenerations: 0,
    droppedParagraphs: 0,
    fullText: "",
    segmentBudget: null,
    usage: tracker.usage,
  };

  // Rien à classer quand personne n'a écrit : classer une chaîne vide
  // renverrait un refus ou un désabonnement imaginaire.
  let classified;
  if (opening) {
    classified = {
      classification: {
        optOut: false,
        refusal: "none" as const,
        wantsHuman: false,
        qualification: {},
        unintelligible: false,
      },
      modelUsed: false,
      error: undefined,
    };
  } else {
    try {
      classified = await classifyInbound(inbound, classifierCall);
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : "classifier_failed" };
    }
  }
  const classification = {
    optOut: classified.classification.optOut,
    refusal: classified.classification.refusal,
    wantsHuman: classified.classification.wantsHuman,
    qualification: classified.classification.qualification as Record<string, unknown>,
  };
  const classifierError = classified.error ?? null;

  const softBefore = input.softRefusals ?? 0;
  const downgrade = applyRefusal(config.goal, softBefore, classification.refusal);
  const rung = downgrade.rung;
  const qualification = { ...(input.qualification ?? {}), ...classification.qualification };

  /**
   * Budget de tours : la production compte les messages de l'AGENT déjà
   * partis. Ici, l'historique fourni, plus une ouverture supposée envoyée hors
   * historique — jamais quand c'est l'assistant qui ouvre : l'historique fait
   * alors foi, sinon on compterait un message qui n'existe pas.
   */
  const turnsUsed =
    history.filter((m) => m.role === "assistant").length +
    (!opening && input.openerSent !== false ? 1 : 0);

  const gated: Omit<SandboxTurnResult, "error" | "outcome" | "reason"> = {
    ...empty,
    classification,
    classifierError,
    rung: rung.key,
    requiredFields: requiredFieldsFor(rung),
    softRefusals: downgrade.softRefusals,
    qualification,
    turnsUsed,
  };

  // ═══ Les portes AVANT le générateur — même ordre qu'en production ═══════
  // Désabonnement : suppression, arrêt, AUCUN message — le modèle n'est pas appelé.
  if (classification.optOut) {
    return { ...gated, outcome: "stopped", reason: "optout", error: null };
  }
  // Refus ferme : comme en production, le tour CONTINUE pour un dernier
  // message de clôture courtoise ("hard_refusal"), la chaîne n'étant PAS
  // touchée — on ne propose pas de repli à quelqu'un qui vient de dire non,
  // et l'IA se tait après cet adieu.
  const closingHard = classification.refusal === "hard";
  if (!closingHard && (turnsUsed >= config.approach.maxTurns || downgrade.exhausted || classification.wantsHuman)) {
    const reason: SandboxReason = classification.wantsHuman
      ? "client_wants_human"
      : downgrade.exhausted
        ? "goal_chain_exhausted"
        : "max_turns";
    return { ...gated, outcome: "handoff", reason, error: null };
  }

  // Aucune disponibilité réelle n'est consultée : un aperçu ne doit pas donner
  // au modèle des heures qu'il proposerait à quelqu'un. L'agenda SIMULÉ répond
  // à la place — les mêmes libellés que `get_slots` renverra, pour que le
  // modèle ne lise pas deux vérités — et « aucune » exactement quand la
  // production dirait « aucune » (cran sans rendez-vous).
  // Les JOURS RÉSERVABLES viennent des vrais réglages : un essai « juste la
  // fin de semaine » doit refléter ce que la production ferait, pas un agenda
  // inventé qui n'ouvre jamais le samedi.
  const bookingSettings = await getSetting("booking").catch(() => null);
  const bookableDays = bookingSettings?.days;
  // Comme en production : un tour de clôture n'offre rien, donc pas d'heures.
  const slotsText =
    !closingHard && rungNeedsSlots(rung) && rung.goal.appointmentType
      ? simulatedSlotsText(rung.goal.slotOfferCount, undefined, { days: bookableDays })
      : "aucune";

  const runtimeBlock = row.includeRuntimeLayer
    ? renderTemplate(row.turnInstructions ?? DEFAULT_TURN_INSTRUCTIONS, {
        // Mêmes bornes et mêmes guillemets qu'en production (`contact-data.ts`) :
        // ce que le modèle lit à l'essai est ce qu'il lira en vrai.
        "lead.prenom": contactValue(input.lead?.firstName),
        "lead.source": contactValue(input.lead?.projectType),
        "lead.besoin": contactValue(input.lead?.projectType),
        "lead.secteur": contactValue(input.lead?.city),
        "lead.budget": contactValue(input.lead?.budget),
        qualification: qualificationText(qualification),
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

  const layered =
    runtimeBlock === "" ? row.compiledPrompt : `${row.compiledPrompt}\n\n${runtimeBlock}`;
  const system = closingHard ? `${layered}\n\n${CLOSING_INSTRUCTIONS}` : layered;

  // À l'ouverture (ou en relance), il n'y a pas de message entrant : la MÊME
  // consigne qu'en production tient lieu de tour — voir `opening.ts`.
  const instruction = opening
    ? outreachInstructionText({
        step: input.outreach?.step ?? 0,
        historyLength: history.length,
        campaignName: input.outreach?.campaignName,
        campaignDescription: input.outreach?.campaignDescription,
        ladderLength: input.outreach?.ladderLength,
      })
    : null;
  const userTurn = instruction ?? inbound;

  const messageArray: LLMMessage[] = [...history, { role: "user", content: userTurn }];
  // Mêmes outils qu'en production sur un tour de clôture : classer, consigner,
  // clore — jamais réserver, jamais `stop` (un refus n'est pas un désabonnement).
  const customFields = customQualificationFields(config.goal);
  const tools = closingHard
    ? toolDefsFor(config.tools, customFields).filter((t) => CLOSING_TOOL_NAMES.includes(t.name))
    : toolDefsFor(config.tools, customFields);
  const toolCalls: SandboxToolCall[] = [];
  const sideEffectsDone = new Set<string>();

  let result: LLMResult | null = null;
  let draft = "";
  let fullText = "";
  let verdicts: RuleVerdict[] = [];
  let regenerations = 0;
  let droppedParagraphs = 0;
  let llmError: string | null = null;
  let terminatedByTool: "stop" | "handoff" | null = null;
  let bookingFailed = false;
  const budget = config.approach.segmentBudget;
  let budgetOutcome: SegmentBudgetOutcome | null = null;
  let budgetTrimmed = false;

  // MÊME boucle qu'en production : une régénération au plus sur un brouillon
  // bloqué, avec la même consigne de correction ; et dans chaque tentative, un
  // aller-retour d'outils au maximum. Sans l'aller-retour, un modèle qui
  // appelle un outil renvoie un texte VIDE là où la production répond.
  const ATTEMPTS = 2;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const correction =
      attempt === 0
        ? ""
        : blockingFailures(verdicts).length > 0
          ? `\n\nCONSIGNE DE CORRECTION : ta réponse précédente a été refusée par un garde-fou (${blockingFailures(
              verdicts,
            )
              .map((v) => v.label)
              .join(" · ")}). Réécris-la en respectant strictement cette règle.`
          : `\n\nCONSIGNE DE CORRECTION : ta réponse précédente coûtait ${budgetOutcome?.after.segments ?? 0} segments SMS alors que le budget est de ${budget.maxSegments}. Récris le MÊME message en ${charBudgetFor(budget) ?? 0} caractères au maximum : garde la question et l'information utile, enlève les politesses, les redites et les détails.`;

    const turnMessages: LLMMessage[] = [...messageArray];

    for (let round = 0; round < 2; round += 1) {
      try {
        const outcome = await generateWithChain(
          generatorRungs,
          {
            system: system + correction,
            messages: turnMessages,
            // Les outils DOIVENT être offerts : sans eux, le modèle ne peut jamais
            // en appeler un et l'aperçu ne montrerait pas le comportement réel.
            tools,
            maxTokens: config.model.maxTokens,
            temperature: config.model.temperature,
            routing: config.model.routing as unknown as Record<string, unknown>,
            retry,
            ...(config.model.reasoningEffort === "none"
              ? {}
              : { reasoningEffort: config.model.reasoningEffort }),
          },
          { resolve: getLlmProvider },
        );
        result = outcome.result;
        tracker.add(result, true);
      } catch (err) {
        llmError = err instanceof Error ? err.message : String(err);
        break;
      }

      if (result.toolCalls.length === 0) break;

      // L'offre n'est pas la permission — même borne qu'en production : un
      // appel halluciné vers un outil non offert est écarté du tour entier.
      const offeredNames = new Set(tools.map((t) => t.name));
      const grantedCalls = result.toolCalls.filter((c) => offeredNames.has(c.name));
      if (grantedCalls.length === 0) break;

      // Résultats SIMULÉS, avec les règles de la production (zod, champs
      // requis, créneau offert, effets de bord joués une seule fois), dans
      // l'ordre des appels — un outil terminal arrête les suivants.
      const simulated: { id: string; name: string; content: string }[] = [];
      for (const call of grantedCalls) {
        const outcome = simulateToolCall(call.name, sideEffectsDone, {
          args: call.arguments,
          appointmentType: rung.goal.appointmentType,
          requiredFields: requiredFieldsFor(rung),
          qualification,
          customQualificationFields: customFields,
          bookableDays,
        });
        simulated.push({ id: call.id, name: call.name, content: outcome.content });
        toolCalls.push({ name: call.name, args: call.arguments, ok: outcome.ok, result: outcome.content });
        if (outcome.bookingFailed) bookingFailed = true;
        if (outcome.terminated) {
          terminatedByTool = outcome.terminated;
          break;
        }
      }
      // « stop » et « handoff » terminent le tour : rappeler le modèle après
      // coup ne changerait rien et ferait un appel de plus.
      if (terminatedByTool) break;
      if (round === 1) break;

      // Vrai protocole d'outils : l'assistant DÉCLARE ses appels, puis chaque
      // résultat revient rattaché à son identifiant. Maquillé en message
      // `user`, le modèle ne relie pas le résultat à sa demande et la réémet.
      turnMessages.push({ role: "assistant", content: result.text, toolCalls: grantedCalls });
      for (const r of simulated) {
        turnMessages.push({ role: "tool", toolCallId: r.id, name: r.name, content: r.content });
      }
    }

    if (llmError !== null || terminatedByTool !== null || result === null) break;

    // UN SEUL message par tour : le premier paragraphe part, le reste tombe —
    // et les garde-fous jugent CE qui part, pas le texte entier.
    fullText = result.text;
    const paragraphs = result.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    draft = paragraphs[0] ?? "";
    droppedParagraphs = Math.max(0, paragraphs.length - 1);

    // Budget de segments — MÊME étape, MÊME place qu'en production : après la
    // découpe, avant les garde-fous. Sans elle, l'aperçu montrerait un message
    // plus long que celui qui part réellement, et un aperçu qui ment sur le
    // texte envoyé est pire qu'aucun aperçu.
    const shaped = applySegmentBudget(draft, budget);
    budgetOutcome = shaped;
    draft = shaped.body;
    budgetTrimmed = false;
    if (
      shaped.overflow &&
      budget.onOverflow === "trim" &&
      budget.maxSegments !== null &&
      attempt === ATTEMPTS - 1
    ) {
      draft = trimToSegments(draft, budget.maxSegments);
      budgetTrimmed = draft !== shaped.body;
    }

    verdicts = await evaluateAllRules(
      draft,
      rules,
      {
        toolCallNames: toolCalls.filter((c) => c.ok).map((c) => c.name),
        inbound: opening ? "(ouverture — aucun message entrant)" : inbound,
        // Aucun message de l'agent avant celui-ci = premier contact.
        isFirstOutbound: turnsUsed === 0,
      },
      classifierCall,
    );
    const rewriteForBudget = shaped.overflow && budget.onOverflow !== "send";
    if (blockingFailures(verdicts).length === 0 && !rewriteForBudget) break;
    regenerations = attempt + 1;
  }

  // Le texte que le modèle a écrit À CÔTÉ d'un stop/handoff ne part jamais en
  // production, mais l'admin veut le voir : on le garde dans `fullText`.
  if (terminatedByTool !== null && result) fullText = result.text;

  const base: Omit<SandboxTurnResult, "outcome" | "reason" | "error"> = {
    ...gated,
    draft,
    blocked: false,
    verdicts,
    toolCalls,
    runtimeBlock,
    instruction,
    regenerations,
    droppedParagraphs,
    fullText,
    segmentBudget:
      budgetOutcome === null ||
      (budgetOutcome.applied.length === 0 && !budgetTrimmed && !budgetOutcome.overflow)
        ? null
        : {
            max: budget.maxSegments,
            before: budgetOutcome.before.segments,
            after: analyzeSms(draft).segments,
            applied: [...budgetOutcome.applied, ...(budgetTrimmed ? ["trim"] : [])],
            overBudget:
              budget.maxSegments !== null && analyzeSms(draft).segments > budget.maxSegments,
          },
    usage: tracker.usage,
  };

  // ═══ Le verdict — même ordre qu'en production ═══════════════════════════
  if (terminatedByTool !== null) {
    return {
      ...base,
      draft: "",
      outcome: terminatedByTool === "stop" ? "stopped" : "handoff",
      reason: terminatedByTool === "stop" ? "tool_stop" : "tool_handoff",
      error: null,
    };
  }
  if (llmError !== null || result === null) {
    return { ...base, draft: "", outcome: "error", reason: "llm_error", error: llmError ?? "no_result" };
  }
  if (blockingFailures(verdicts).length > 0) {
    // Sur un tour de clôture, la production n'escalade pas : arrêt silencieux.
    if (closingHard) {
      return { ...base, draft: "", blocked: true, outcome: "stopped", reason: "hard_refusal", error: null };
    }
    // Un juge injoignable bloque tout (fermeture par défaut, voulue) — mais
    // l'admin doit distinguer « l'assistant a mal écrit » d'une panne de notre
    // côté, sinon il cherche au mauvais endroit.
    const allJudgeErrors = blockingFailures(verdicts).every(
      (v) => v.reason === "judge_error" || v.reason === "judge_unparseable",
    );
    return {
      ...base,
      blocked: true,
      outcome: "blocked",
      reason: allJudgeErrors ? "guardrail_unavailable" : "blocked_after_regeneration",
      error: null,
    };
  }
  // Une réservation a ÉCHOUÉ : le brouillon peut annoncer un rendez-vous qui
  // n'existe pas. La production n'envoie rien et passe la main.
  if (bookingFailed) {
    return { ...base, draft: "", outcome: "handoff", reason: "booking_failed", error: null };
  }
  if (draft === "") {
    if (closingHard) return { ...base, outcome: "stopped", reason: "hard_refusal", error: null };
    return { ...base, outcome: "handoff", reason: "no_text", error: null };
  }
  // Après un refus ferme, l'adieu part puis l'IA se tait : « sent » avec le
  // motif « hard_refusal » — exactement le couple que la production écrit.
  return { ...base, outcome: "sent", reason: closingHard ? "hard_refusal" : null, error: null };
}

/**
 * Mêmes règles, même filtre, mêmes juges qu'en production : les règles
 * déterministes d'abord, et les juges seulement si aucune n'a déjà bloqué —
 * inutile de payer des appels pour confirmer un refus.
 */
async function evaluateAllRules(
  draft: string,
  rules: RuleData[],
  ctx: { toolCallNames: string[]; inbound: string; isFirstOutbound: boolean },
  judge: (p: { system: string; user: string }) => Promise<string>,
): Promise<RuleVerdict[]> {
  const active = enabledRules(rules);
  let verdicts: RuleVerdict[];
  try {
    verdicts = evaluateOutputRules(draft, active, { toolCallNames: ctx.toolCallNames });
  } catch (err) {
    // Config de règle illisible : on le DIT plutôt que de laisser l'exception
    // faire passer l'essai pour une panne du modèle.
    return [
      {
        key: "config",
        label: "garde-fou illisible",
        severity: "block",
        passed: false,
        reason: err instanceof Error ? err.message : "config_error",
      },
    ];
  }
  if (blockingFailures(verdicts).length > 0) return verdicts;

  for (const rule of active) {
    if (rule.kind !== "llm_judge") continue;
    const criterion = (rule.config as { criterion?: unknown }).criterion;
    if (typeof criterion !== "string" || criterion.trim() === "") continue;
    const verdict = await judgeWithLlm(
      {
        criterion,
        output: draft,
        context: ctx.inbound,
        // La position dans la conversation VOYAGE avec le critère : plusieurs
        // critères distinguent le premier message des suivants, et un juge qui
        // ne peut pas trancher échoue fermé — donc bloque tout.
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
