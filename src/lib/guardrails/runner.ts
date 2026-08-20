import { judgeWithLlm, type JudgeGenerate } from "./judge";
import { evaluateOutputRules } from "./filter";
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
  toolCalls: { name: string }[];
}

export interface RunnerDeps {
  /** Appel du générateur, déjà lié au modèle et aux outils de l'assistant. */
  generate: (input: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
  }) => Promise<FixtureTurnOutput>;
  /** Appel du classifieur pour les critères `judge`. */
  judge: JudgeGenerate;
  /** Règles résolues — permet d'appliquer AUSSI le filtre de sortie à la suite. */
  rules?: RuleData[];
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
  for (const [index, pattern] of e.mustMatch.entries()) {
    if (!new RegExp(pattern, "iu").test(output.text)) failures.push(`motif requis #${index + 1}`);
  }
  for (const [index, pattern] of e.mustNotMatch.entries()) {
    if (new RegExp(pattern, "iu").test(output.text)) failures.push(`motif interdit #${index + 1}`);
  }
  if (e.maxChars !== null && output.text.length > e.maxChars) {
    failures.push(`${output.text.length} caractères (max ${e.maxChars})`);
  }
  return failures;
}

/** Rejoue UNE fixture et rend son verdict. Ne touche jamais la base. */
export async function runFixture(
  fixture: FixtureData,
  compiledPrompt: string,
  runtimeBlock: string,
  deps: RunnerDeps,
): Promise<FixtureResult> {
  const system = runtimeBlock === "" ? compiledPrompt : `${compiledPrompt}\n\n${runtimeBlock}`;

  let output: FixtureTurnOutput;
  try {
    output = await deps.generate({ system, messages: fixtureMessages(fixture) });
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
    const verdicts = evaluateOutputRules(output.text, deps.rules, {
      toolCallNames: output.toolCalls.map((c) => c.name),
    });
    for (const verdict of verdicts) {
      if (!verdict.passed && verdict.severity === "block") {
        failures.push(`garde-fou « ${verdict.label} » : ${verdict.reason ?? "échec"}`);
      }
    }
  }

  if (fixture.expectations.judge !== null) {
    const verdict = await judgeWithLlm(
      {
        criterion: fixture.expectations.judge,
        output: output.text,
        context: fixture.inbound,
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
