import { isTerminalTool, simulateToolCall } from "@/lib/agent/tool-simulation";
import type { LLMMessage } from "@/lib/llm/types";
import { judgeWithLlm, type JudgeGenerate } from "./judge";
import { evaluateOutputRules } from "./filter";
import { enabledRules } from "./resolve";
import type { FixtureData, FixtureResult, RuleData } from "./types";

/**
 * Exécution de la suite de garde-fous (§11.4) — partie PURE.
 *
 * Chaque fixture rejoue un tour contre le prompt compilé, avec les outils
 * SIMULÉS : le modèle peut les appeler, on note lesquels, mais aucun handler
 * ne tourne et rien n'est écrit en base. Une suite doit pouvoir s'exécuter
 * cent fois sans envoyer un SMS ni créer un rendez-vous.
 *
 * Les attentes déterministes sont évaluées en code ; le critère `judge` part
 * dans un appel SÉPARÉ au modèle classifieur, qui ne voit que la fixture,
 * l'attente et la sortie.
 */

export interface FixtureTurnOutput {
  text: string;
  /** `id` sert à rattacher le résultat à l'appel (protocole d'outils). */
  toolCalls: { id: string; name: string; arguments?: Record<string, unknown> }[];
}

export interface RunnerDeps {
  /** Appel du générateur, déjà lié au modèle et aux outils de l'assistant. */
  generate: (input: { system: string; messages: LLMMessage[] }) => Promise<FixtureTurnOutput>;
  /** Appel du classifieur pour les critères `judge`. */
  judge: JudgeGenerate;
  /** Règles résolues — permet d'appliquer AUSSI le filtre de sortie à la suite. */
  rules?: RuleData[];
}

/**
 * Une fixture décrit-elle le premier message sortant?
 *
 * Se lit dans l'historique : aucun tour « out » avant = premier contact. Les
 * critères qui distinguent le premier message des suivants en dépendent.
 */
export function isFirstOutbound(fixture: Pick<FixtureData, "setup">): boolean {
  return !fixture.setup.priorTurns.some((turn) => turn[0] === "out");
}

/** Historique d'une fixture → messages du modèle (out = assistant, in = user). */
export function fixtureMessages(
  fixture: Pick<FixtureData, "setup" | "inbound">,
): { role: "user" | "assistant"; content: string }[] {
  const history = fixture.setup.priorTurns.map((turn) => ({
    role: turn[0] === "out" ? ("assistant" as const) : ("user" as const),
    content: turn[1],
  }));
  return [...history, { role: "user" as const, content: fixture.inbound }];
}

/** Attentes déterministes — aucune n'appelle le modèle. */
export function evaluateExpectations(
  fixture: Pick<FixtureData, "expectations">,
  output: FixtureTurnOutput,
): string[] {
  const failures: string[] = [];
  const called = output.toolCalls.map((call) => call.name);
  const e = fixture.expectations;

  for (const tool of e.mustCallTool) {
    if (!called.includes(tool)) failures.push(`outil manquant : ${tool}`);
  }
  for (const tool of e.mustNotCallTool) {
    if (called.includes(tool)) failures.push(`outil interdit appelé : ${tool}`);
  }
  // Le motif est NOMMÉ dans la raison : « motif interdit #1 » seul laisse
  // l'admin deviner pourquoi la fixture est rouge. (Le motif n'est pas la
  // sortie du modèle : aucune donnée personnelle n'y passe.)
  for (const [index, pattern] of e.mustMatch.entries()) {
    if (!new RegExp(pattern, "iu").test(output.text)) {
      failures.push(`motif requis #${index + 1} (${pattern})`);
    }
  }
  for (const [index, pattern] of e.mustNotMatch.entries()) {
    if (new RegExp(pattern, "iu").test(output.text)) {
      failures.push(`motif interdit #${index + 1} (${pattern})`);
    }
  }
  if (e.maxChars !== null && output.text.length > e.maxChars) {
    failures.push(`${output.text.length} caractères (max ${e.maxChars})`);
  }
  return failures;
}

/** Rejoue UNE fixture et rend son verdict. Ne touche jamais la base. */
export interface FixtureToolContext {
  /** Le cran d'objectif de l'assistant testé réserve-t-il, et de quel type? */
  appointmentType: "meet" | "inperson" | null;
  /** Champs de qualification exigés avant de réserver. */
  requiredFields: readonly string[];
}

export async function runFixture(
  fixture: FixtureData,
  compiledPrompt: string,
  runtimeBlock: string,
  deps: RunnerDeps,
  /** Sans contexte, la simulation se comporte comme un cran qui ne réserve pas. */
  toolContext: FixtureToolContext = { appointmentType: null, requiredFields: [] },
): Promise<FixtureResult> {
  const system = runtimeBlock === "" ? compiledPrompt : `${compiledPrompt}\n\n${runtimeBlock}`;

  let output: FixtureTurnOutput;
  try {
    // MÊME aller-retour d'outils qu'en production (et que le bac à sable).
    // Sans lui, un modèle qui appelle un outil renvoie un texte VIDE et la
    // fixture échoue pour un comportement que la production n'a pas : elle
    // rejouerait l'appel avec les résultats et rédigerait normalement. C'est
    // ce qui faisait échouer « Refuse de donner une valeur » alors que
    // l'assistant se comportait correctement.
    const turnMessages: LLMMessage[] = fixtureMessages(fixture);
    const done = new Set<string>();
    const allCalls: { id: string; name: string }[] = [];
    let last = await deps.generate({ system, messages: turnMessages });
    allCalls.push(...last.toolCalls);

    const wantsSecondRound =
      last.toolCalls.length > 0 && !last.toolCalls.some((c) => isTerminalTool(c.name));
    if (wantsSecondRound) {
      // Même protocole qu'en production : l'assistant déclare ses appels, les
      // résultats reviennent rattachés à leur identifiant.
      turnMessages.push({
        role: "assistant",
        content: last.text,
        // La suite ne rejoue pas d'arguments : seul le couple id/nom compte
        // pour que le modèle relie le résultat à son appel.
        toolCalls: last.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })),
      });
      for (const call of last.toolCalls) {
        turnMessages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          // Mêmes règles qu'en production : arguments validés, champs requis
          // exigés avant de réserver, créneau comparé à ceux offerts. La suite
          // jugeait autrement que la production sur exactement le geste que
          // les fixtures vérifient.
          content: simulateToolCall(call.name, done, {
            args: call.arguments ?? {},
            appointmentType: toolContext.appointmentType,
            requiredFields: toolContext.requiredFields,
            qualification: {},
          }).content,
        });
      }
      last = await deps.generate({ system, messages: turnMessages });
      allCalls.push(...last.toolCalls);
    }

    // Les attentes portent sur TOUS les outils du tour, pas seulement ceux du
    // dernier aller-retour : `mustCallTool` doit voir un outil appelé au
    // premier passage.
    output = { text: last.text, toolCalls: allCalls };
  } catch (err) {
    // Une panne du fournisseur n'est pas un succès : la fixture échoue.
    return {
      fixtureId: fixture.id ?? null,
      label: fixture.label,
      severity: fixture.severity,
      passed: false,
      reason: `erreur du modèle : ${err instanceof Error ? err.message : String(err)}`,
      output: "",
      toolsCalled: [],
    };
  }

  const failures = evaluateExpectations(fixture, output);

  // Les règles bloquantes s'appliquent aussi pendant la suite : une fixture
  // dont la sortie viole une règle globale ne peut pas être « verte ».
  if (deps.rules && deps.rules.length > 0) {
    const active = enabledRules(deps.rules);
    try {
      const verdicts = evaluateOutputRules(output.text, active, {
        toolCallNames: output.toolCalls.map((c) => c.name),
      });
      for (const verdict of verdicts) {
        if (!verdict.passed && verdict.severity === "block") {
          failures.push(`garde-fou « ${verdict.label} » : ${verdict.reason ?? "échec"}`);
        }
      }
    } catch (err) {
      // Config de règle illisible (jsonb édité à la main, drapeaux invalides) :
      // la fixture ÉCHOUE. Laisser l'exception remonter ferait avorter la suite
      // et laisserait `suite_passed` figé sur un ancien vert.
      failures.push(
        `garde-fou illisible : ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Les règles `llm_judge` ne sont pas décidables par le filtre déterministe :
    // sans cette boucle, honesty_ai et no_fabrication n'étaient JAMAIS évaluées
    // — la porte affichait « bloque » pour des règles inertes.
    for (const rule of active) {
      if (rule.kind !== "llm_judge") continue;
      const criterion = (rule.config as { criterion?: unknown }).criterion;
      if (typeof criterion !== "string" || criterion.trim() === "") continue;
      const verdict = await judgeWithLlm(
        {
          criterion,
          output: output.text,
          context: fixture.inbound,
          isFirstOutbound: isFirstOutbound(fixture),
        },
        deps.judge,
      );
      if (!verdict.passed && rule.severity === "block") {
        failures.push(`garde-fou « ${rule.label} » : ${verdict.reason}`);
      }
    }
  }

  if (fixture.expectations.judge !== null) {
    const verdict = await judgeWithLlm(
      {
        criterion: fixture.expectations.judge,
        output: output.text,
        context: fixture.inbound,
        isFirstOutbound: isFirstOutbound(fixture),
      },
      deps.judge,
    );
    if (!verdict.passed) failures.push(`juge : ${verdict.reason}`);
  }

  return {
    fixtureId: fixture.id ?? null,
    label: fixture.label,
    severity: fixture.severity,
    passed: failures.length === 0,
    reason: failures.length === 0 ? null : failures.join(" · "),
    output: output.text,
    toolsCalled: output.toolCalls.map((c) => c.name),
  };
}

/**
 * Verdict global : la suite passe si AUCUNE fixture activée de sévérité
 * `block` n'a échoué. Une fixture `warn` en échec s'affiche sans bloquer.
 */
export function suitePassed(results: FixtureResult[]): boolean {
  return !results.some((r) => !r.passed && r.severity === "block");
}

/** Fixtures réellement exécutées : `off` et désactivées sortent du circuit. */
export function runnableFixtures(fixtures: FixtureData[]): FixtureData[] {
  return fixtures
    .filter((f) => f.enabled && f.severity !== "off")
    .sort((a, b) => a.orderIndex - b.orderIndex);
}
