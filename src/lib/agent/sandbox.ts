import "server-only";
import { eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";
import { assistantRowToConfig } from "@/lib/assistants/schema";
import { resolvedRulesFor } from "@/lib/assistants/service";
import { blockingFailures, evaluateOutputRules } from "@/lib/guardrails/filter";
import { judgeWithLlm } from "@/lib/guardrails/judge";
import { enabledRules } from "@/lib/guardrails/resolve";
import type { RuleVerdict } from "@/lib/guardrails/types";
import { getLlmProvider } from "@/lib/llm-server";
import { APP_TZ } from "@/components/clients/timezone";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";
import { classifyInbound } from "./classify";
import { applyRefusal, requiredFieldsFor, resolveRung } from "./goal";
import { renderTemplate } from "./render";
import { DEFAULT_TURN_INSTRUCTIONS } from "./templates";
import { isTerminalTool, simulatedToolResults } from "./tool-simulation";
import { toolDefsFor } from "./tools";

/**
 * Bac à sable — parler à un assistant comme si on était le client.
 *
 * Il exerce les MÊMES pièces que la production : le prompt compilé, la couche
 * d'exécution rendue par le même gabarit, le même classifieur, les mêmes outils
 * offerts au modèle, le même filtre de garde-fous et les mêmes juges. C'est ce
 * qui rend l'aperçu utile : voir « à peu près » ce que dirait l'assistant
 * n'aiderait personne à régler une persistance ou un ton.
 *
 * Ce qu'il ne fait PAS, délibérément : il n'écrit rien, n'envoie rien, ne
 * réserve rien. Les appels d'outils sont RAPPORTÉS, jamais exécutés — un aperçu
 * qui bloquerait une vraie plage d'agenda serait un piège. C'est aussi pourquoi
 * il ne touche ni aux conversations ni aux clients : un essai ne doit pas
 * apparaître dans la boîte de réception de l'équipe.
 */

export interface SandboxTurnInput {
  assistantId: string;
  /** L'historique déjà échangé dans le bac à sable. */
  history: { role: "assistant" | "user"; content: string }[];
  /**
   * Ce que le client écrit. VIDE = c'est l'assistant qui ouvre.
   *
   * Un assistant ne répond pas seulement : il est aussi déclenché par un
   * nouveau lead ou un changement de catégorie, et doit alors écrire le
   * PREMIER message. Sans ce cas, l'essai attendait éternellement que le
   * client parle — un comportement que la production n'a pas.
   */
  inbound: string;
  /** Ce qui a déclenché le tour — nourrit la couche d'exécution. */
  trigger?: "inbound" | "lead_created" | "category_changed" | "manual";
  /** Contexte du faux client — ce que la couche d'exécution recevrait. */
  lead?: { firstName?: string; city?: string; budget?: string; projectType?: string };
  /** Qualification accumulée au fil de l'essai. */
  qualification?: Record<string, unknown>;
  softRefusals?: number;
  /**
   * Une ouverture a-t-elle déjà été envoyée à ce client?
   *
   * Par défaut OUI, parce que c'est la situation réelle : l'assistant reprend
   * une conversation ouverte par une campagne. Sans cette hypothèse, le premier
   * essai part comme un PREMIER message sortant, la règle LCAP exige d'y nommer
   * l'organisation, et tout est bloqué — un essai trompeur qui ferait chercher
   * un bogue là où il n'y en a pas.
   */
  openerSent?: boolean;
}

/**
 * Ce que la PRODUCTION ferait de ce tour. Un brouillon vide n'est pas un bogue
 * d'aperçu : c'est un tour qui, en vrai, part en escalade — le dire évite de
 * chercher une panne là où il y a un comportement.
 */
export type SandboxOutcome = "sent" | "blocked" | "stopped" | "handoff" | "no_text" | "error";

export interface SandboxTurnResult {
  /** Le message que l'assistant enverrait, ou "" s'il a été bloqué. */
  draft: string;
  outcome: SandboxOutcome;
  blocked: boolean;
  /** Verdicts de TOUTES les règles évaluées — c'est ce qu'on vient régler. */
  verdicts: RuleVerdict[];
  toolCalls: { name: string; args: unknown }[];
  classification: {
    optOut: boolean;
    refusal: "none" | "soft" | "hard";
    wantsHuman: boolean;
    qualification: Record<string, unknown>;
  };
  /** Cran d'objectif courant après application d'un éventuel refus mou. */
  rung: string;
  requiredFields: string[];
  /** Le bloc L7 réellement envoyé — pour comprendre ce que le modèle a lu. */
  runtimeBlock: string;
  softRefusals: number;
  qualification: Record<string, unknown>;
  error: string | null;
}

export async function simulateTurn(input: SandboxTurnInput): Promise<SandboxTurnResult> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, input.assistantId) });
  if (!row) throw new Error("assistant_not_found");
  if (!row.compiledPrompt) throw new Error("assistant_not_compiled");

  const config = assistantRowToConfig(row);
  const rules = await resolvedRulesFor(input.assistantId);

  const generator = getLlmProvider(config.model.provider);
  const classifierProvider = getLlmProvider(config.model.classifier.provider);
  const classifierCall = async (p: { system: string; user: string }) => {
    const out = await classifierProvider.generate({
      system: p.system,
      messages: [{ role: "user", content: p.user }],
      model: config.model.classifier.model,
      maxTokens: 300,
      temperature: 0,
    });
    return out.text;
  };

  const empty: Omit<SandboxTurnResult, "error"> = {
    draft: "",
    outcome: "error",
    blocked: false,
    verdicts: [],
    toolCalls: [],
    classification: { optOut: false, refusal: "none", wantsHuman: false, qualification: {} },
    rung: "primary",
    requiredFields: [],
    runtimeBlock: "",
    softRefusals: input.softRefusals ?? 0,
    qualification: input.qualification ?? {},
  };

  const opening = input.inbound.trim() === "";

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
    };
  } else {
    try {
      classified = await classifyInbound(input.inbound, classifierCall);
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

  const softBefore = input.softRefusals ?? 0;
  const downgrade = applyRefusal(config.goal, softBefore, classification.refusal);
  const rung = downgrade.exhausted ? resolveRung(config.goal, softBefore) : downgrade.rung;

  const qualification = { ...(input.qualification ?? {}), ...classification.qualification };

  // Aucune disponibilité réelle n'est consultée : un aperçu ne doit pas donner
  // au modèle des heures qu'il proposerait à quelqu'un.
  const slotsText = "(bac à sable — aucune disponibilité réelle)";

  const runtimeBlock = row.includeRuntimeLayer
    ? renderTemplate(row.turnInstructions ?? DEFAULT_TURN_INSTRUCTIONS, {
        "lead.prenom": input.lead?.firstName ?? "",
        "lead.source": input.lead?.projectType ?? "",
        "lead.besoin": input.lead?.projectType ?? "",
        "lead.secteur": input.lead?.city ?? "",
        "lead.budget": input.lead?.budget ?? "",
        qualification:
          Object.entries(qualification)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(", ") || "aucune",
        "goal.type": rung.goal.type,
        "goal.rung": rung.key,
        "goal.required_fields": requiredFieldsFor(rung).join(", ") || "aucune",
        slots: slotsText,
        turns_used:
          input.history.filter((m) => m.role === "assistant").length +
          (input.openerSent === false ? 0 : 1),
        max_turns: config.approach.maxTurns,
        soft_refusals: downgrade.softRefusals,
        now_local: formatInTimeZone(new Date(), APP_TZ, "EEEE HH'h'mm"),
        send_window: `${DEFAULT_QUIET_HOURS.weekday[0]}h-${DEFAULT_QUIET_HOURS.weekday[1]}h`,
        "assistant.name": config.name,
        org: config.identity.orgName,
      }).text
    : "";

  const system =
    runtimeBlock === "" ? row.compiledPrompt : `${row.compiledPrompt}\n\n${runtimeBlock}`;

  /**
   * À l'ouverture, il n'y a pas de message entrant. On donne au modèle une
   * consigne de tour explicite plutôt qu'un tour vide : les fournisseurs
   * exigent au moins un message, et « écris l'ouverture » est exactement ce
   * que la production demande quand un barreau de campagne n'a pas de texte.
   */
  const openingInstruction =
    input.trigger === "category_changed"
      ? "Ce contact vient de changer d'étape dans le pipeline. Écris le PREMIER message de la conversation."
      : "Ce contact vient d'arriver comme nouveau lead. Écris le PREMIER message de la conversation.";

  const turnMessages: { role: "assistant" | "user"; content: string }[] = [
    ...input.history,
    { role: "user", content: opening ? openingInstruction : input.inbound },
  ];
  const tools = toolDefsFor(config.tools);
  const toolCalls: { name: string; args: unknown }[] = [];
  const sideEffectsDone = new Set<string>();

  let out;
  // MÊME aller-retour qu'en production. Sans lui, un modèle qui appelle un
  // outil renvoie un texte VIDE : l'aperçu montrerait des réponses vides là où
  // la production répond normalement. C'est la leçon de la phase 4, et la
  // démonstration l'a reproduite ici avant que ce code n'existe.
  for (let round = 0; round < 2; round += 1) {
    try {
      out = await generator.generate({
        system,
        messages: turnMessages,
        model: config.model.model,
        maxTokens: config.model.maxTokens,
        temperature: config.model.temperature,
        routing: config.model.routing as unknown as Record<string, unknown>,
        // Les outils DOIVENT être offerts : sans eux, le modèle ne peut jamais
        // en appeler un et l'aperçu ne montrerait pas le comportement réel.
        tools,
      });
    } catch (err) {
      return {
        ...empty,
        classification,
        rung: rung.key,
        runtimeBlock,
        qualification,
        softRefusals: downgrade.softRefusals,
        error: err instanceof Error ? err.message : "model_failed",
      };
    }

    toolCalls.push(...out.toolCalls.map((c) => ({ name: c.name, args: c.arguments })));
    // « stop » et « handoff » terminent le tour en production : rappeler le
    // modèle après coup ne changerait rien et ferait un appel de plus.
    if (out.toolCalls.some((c) => isTerminalTool(c.name))) break;
    if (out.toolCalls.length === 0 || round === 1) break;

    // Résultats SIMULÉS : aucun outil n'est exécuté. On répond au modèle de
    // façon plausible pour qu'il rédige, en disant clairement que les
    // disponibilités ne sont pas réelles.
    turnMessages.push({ role: "assistant", content: out.text || "(appel d'outil)" });
    turnMessages.push({
      role: "user",
      content: simulatedToolResults(out.toolCalls, sideEffectsDone),
    });
  }

  const draft = (out?.text ?? "").trim();

  // Mêmes règles, même filtre, mêmes juges qu'en production.
  const active = enabledRules(rules);
  let verdicts: RuleVerdict[] = [];
  try {
    verdicts = evaluateOutputRules(draft, active, {
      toolCallNames: toolCalls.map((c) => c.name),
    });
  } catch (err) {
    verdicts = [
      {
        key: "config",
        label: "garde-fou illisible",
        severity: "block",
        passed: false,
        reason: err instanceof Error ? err.message : "config_error",
      },
    ];
  }

  if (blockingFailures(verdicts).length === 0) {
    for (const rule of active) {
      if (rule.kind !== "llm_judge") continue;
      const criterion = (rule.config as { criterion?: unknown }).criterion;
      if (typeof criterion !== "string" || criterion.trim() === "") continue;
      const verdict = await judgeWithLlm(
        {
          criterion,
          output: draft,
          context: opening ? "(ouverture — aucun message entrant)" : input.inbound,
          // Une ouverture supposée envoyée compte comme un sortant : sinon la
          // règle LCAP exige de nommer l'organisation à chaque essai.
          // Une ouverture EST le premier sortant : la règle LCAP doit
          // s'appliquer, c'est justement le message qui doit nommer l'organisation.
          isFirstOutbound:
            opening || (input.openerSent === false && input.history.every((m) => m.role !== "assistant")),
        },
        classifierCall,
      );
      verdicts.push({
        key: rule.key,
        label: rule.label,
        severity: rule.severity,
        passed: verdict.passed,
        reason: verdict.passed ? undefined : verdict.reason,
      });
    }
  }

  const blocked = blockingFailures(verdicts).length > 0;
  const calledStop = toolCalls.some((c) => c.name === "stop");
  const calledHandoff = toolCalls.some((c) => c.name === "handoff");
  const outcome: SandboxOutcome = calledStop
    ? "stopped"
    : calledHandoff
      ? "handoff"
      : blocked
        ? "blocked"
        : draft === ""
          ? "no_text"
          : "sent";

  return {
    draft,
    outcome,
    blocked,
    verdicts,
    toolCalls,
    classification,
    rung: rung.key,
    requiredFields: requiredFieldsFor(rung),
    runtimeBlock,
    softRefusals: downgrade.softRefusals,
    qualification,
    error: null,
  };
}
