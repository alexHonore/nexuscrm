/**
 * Des faits au verdict — le seul endroit où un chiffre devient un constat.
 *
 * Module PUR : aucune base, aucun réseau, aucune horloge implicite
 * (`facts.now` est fourni). C'est ce qui rend l'écran testable sans Postgres,
 * et c'est délibéré : la règle « 30007 au-dessus de 1 % = danger » doit
 * pouvoir être vérifiée sans monter un serveur.
 *
 * Trois principes, appris chacun d'un tableau de bord qui n'a pas servi :
 *
 *  · **Un constat porte un GESTE.** Pas « votre taux de remise est bas » tout
 *    seul : le registre `findings.ts` fournit le pourquoi et le quoi-faire, et
 *    `links.ts` fournit l'écran qui corrige. Un chiffre rouge sans destination
 *    se regarde une fois.
 *  · **Le calcul peut ESCALADER la gravité de base, jamais l'adoucir.** Un
 *    constat rangé « avertissement » dans le registre peut devenir « danger »
 *    quand la mesure le mérite ; l'inverse effacerait un problème réel pour
 *    faire une page plus verte.
 *  · **Un constat par identifiant et par SUJET.** Trois campagnes fautives
 *    donnent trois lignes ; trois barreaux fautifs de la MÊME campagne en
 *    donnent une, avec trois pièces à conviction. Sinon un seul gabarit mal
 *    écrit noie les quarante autres constats.
 */
import type { DocLocale } from "@/lib/docs/types";
import {
  BLOCKED_CODES,
  classifyErrorCode,
  FILTERED_CODES,
  HARD_INVALID_CODES,
  REGISTRATION_CODES,
  THROUGHPUT_CODES,
  TOTAL_ERROR_CODES,
  UNREACHABLE_CODES,
} from "./error-classes";
import { FINDING_DOCS, findingText } from "./findings";
import { deepLinkFor, isExternal } from "./links";
import { THRESHOLDS, thresholdFor, verdictFor, worstVerdict } from "./thresholds";
import type {
  ContentFlags,
  DeepLinkTarget,
  DeliverabilityFacts,
  DeliverabilityReport,
  ErrorCount,
  EvidenceSample,
  Finding,
  FindingId,
  FindingSeverity,
  Metric,
  MetricId,
  NumberFacts,
  NumberReport,
  TemplateCluster,
  TwilioProbes,
  Verdict,
} from "./types";
import { METRIC_IDS, SEVERITY_RANK } from "./types";

/** Au-delà, la liste cesse d'être une liste de tâches et devient un mur. */
export const MAX_RENDERED_FINDINGS = 40;

// ── Petits outils ───────────────────────────────────────────────────────────

/** Somme d'un histogramme d'erreurs, restreinte à un jeu de codes. */
function sumCodes(
  errors: ErrorCount[],
  codes: readonly number[],
  field: "messages" | "segments" = "messages",
): number {
  let total = 0;
  for (const e of errors) {
    if (codes.includes(e.errorCode)) total += e[field];
  }
  return total;
}

/**
 * Un ratio qui ne ment pas quand il n'y a rien à diviser. `0/0` n'est pas 0 :
 * c'est « on ne sait pas », et c'est ce que rend `null`.
 */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

interface MetricInput {
  value: number | null;
  denominator: number;
  /** Verdict imposé — réservé aux cas où l'absence de valeur EST le problème. */
  force?: Verdict;
}

function metricOf(id: MetricId, input: MetricInput): Metric {
  const threshold = THRESHOLDS[id];
  const computed = verdictFor(id, input.value, input.denominator);
  const verdict = input.force ? worstVerdict(computed, input.force) : computed;
  return {
    id,
    value: input.value,
    denominator: input.denominator,
    verdict,
    unit: threshold.unit,
    provenance: threshold.provenance,
    threshold: thresholdFor(id, verdict),
  };
}

// ── Agrégation ──────────────────────────────────────────────────────────────

interface Totals {
  messages: number;
  segments: number;
  delivered: number;
  undelivered: number;
  failed: number;
  noDlr: number;
  /** Messages assez vieux pour qu'un accusé ait pu arriver — le dénominateur. */
  dlrEligible: number;
  staleInFlight: number;
  ucs2: number;
  errors: ErrorCount[];
  previousErrors: ErrorCount[];
  previousMessages: number;
}

function aggregate(numbers: NumberFacts[]): Totals {
  const totals: Totals = {
    messages: 0,
    segments: 0,
    delivered: 0,
    undelivered: 0,
    failed: 0,
    noDlr: 0,
    dlrEligible: 0,
    staleInFlight: 0,
    ucs2: 0,
    errors: [],
    previousErrors: [],
    previousMessages: 0,
  };
  const merge = (into: ErrorCount[], from: ErrorCount[]) => {
    for (const e of from) {
      const existing = into.find((x) => x.errorCode === e.errorCode);
      if (existing) {
        existing.messages += e.messages;
        existing.segments += e.segments;
      } else {
        into.push({ ...e });
      }
    }
  };
  for (const n of numbers) {
    totals.messages += n.messages;
    totals.segments += n.segments;
    totals.delivered += n.statusCounts.delivered ?? 0;
    totals.undelivered += n.statusCounts.undelivered ?? 0;
    totals.failed += n.statusCounts.failed ?? 0;
    totals.noDlr += n.noDlr;
    totals.dlrEligible += n.dlrEligible;
    totals.staleInFlight += n.staleInFlight;
    totals.ucs2 += n.ucs2Messages;
    totals.previousMessages += n.previousMessages;
    merge(totals.errors, n.errors);
    merge(totals.previousErrors, n.previousErrors);
  }
  return totals;
}

// ── Indicateurs ─────────────────────────────────────────────────────────────

function computeMetrics(facts: DeliverabilityFacts, totals: Totals): Map<MetricId, Metric> {
  const sent = totals.messages;
  // Le dénominateur du taux de remise EXCLUT ce qui vole encore : compter un
  // message parti il y a dix secondes comme « non remis » ferait chuter le
  // taux à chaque rafraîchissement.
  const settled = totals.delivered + totals.undelivered + totals.failed;

  const currentUnreachable = ratio(sumCodes(totals.errors, UNREACHABLE_CODES), sent);
  const previousUnreachable = ratio(
    sumCodes(totals.previousErrors, UNREACHABLE_CODES),
    totals.previousMessages,
  );
  const unreachableDelta =
    currentUnreachable === null || previousUnreachable === null
      ? null
      : currentUnreachable - previousUnreachable;

  const clusters = facts.templates.clusters;
  const spread = clusters.reduce((max, c) => Math.max(max, c.distinctSendingNumbers), 0);
  // Le taux de répétition se lit sur ce qui a été RÉELLEMENT balayé, pas sur
  // le total envoyé : au-delà du plafond de balayage, l'écran dit « tronqué »
  // plutôt que de diviser par un nombre qu'il n'a pas mesuré.
  const clusteredMessages = clusters.reduce((sum, c) => sum + c.messages, 0);
  const duplication =
    clusteredMessages > 0 ? 1 - clusters.length / clusteredMessages : null;
  // Un groupe de vingt messages ou plus : en deçà, « les mêmes personnes en
  // boucle » n'est qu'un fil de conversation normal.
  // La grappe la PIRE, et son propre volume comme dénominateur : passer la
  // somme de toutes les grappes ouvrait la porte du verdict avec un chiffre
  // qui ne portait pas sur elle. Un groupe de 25 messages était alors jugé sur
  // la foi des 5 000 autres.
  const wide = clusters.filter((c) => c.messages >= 20);
  const worstCluster = wide.reduce<TemplateCluster | null>(
    (worstSoFar, c) =>
      worstSoFar === null ||
      c.distinctRecipients / c.messages < worstSoFar.distinctRecipients / worstSoFar.messages
        ? c
        : worstSoFar,
    null,
  );
  const concentration = worstCluster
    ? worstCluster.distinctRecipients / worstCluster.messages
    : null;

  const capPressure = facts.numbers
    .filter((n) => n.active && n.dailyCap > 0)
    .reduce((max, n) => Math.max(max, n.sentToday / n.dailyCap), 0);

  const dispatchMinutes =
    facts.engine.lastDispatchAt === null
      ? null
      : (facts.now.getTime() - facts.engine.lastDispatchAt.getTime()) / 60_000;

  const entries: [MetricId, MetricInput][] = [
    ["delivered_rate", { value: ratio(totals.delivered, settled), denominator: settled }],
    ["no_dlr_rate", { value: ratio(totals.noDlr, totals.dlrEligible), denominator: totals.dlrEligible }],
    ["stale_in_flight", { value: totals.staleInFlight, denominator: sent }],
    [
      "filtered_rate",
      {
        value: ratio(sumCodes(totals.errors, FILTERED_CODES, "segments"), totals.segments),
        denominator: totals.segments,
      },
    ],
    ["blocked_rate", { value: ratio(sumCodes(totals.errors, BLOCKED_CODES), sent), denominator: sent }],
    [
      "hard_invalid_rate",
      { value: ratio(sumCodes(totals.errors, HARD_INVALID_CODES), sent), denominator: sent },
    ],
    ["unreachable_delta", { value: unreachableDelta, denominator: Math.min(sent, totals.previousMessages) }],
    [
      "total_error_rate",
      { value: ratio(sumCodes(totals.errors, TOTAL_ERROR_CODES), sent), denominator: sent },
    ],
    [
      "registration_blocks",
      { value: sumCodes(totals.errors, REGISTRATION_CODES), denominator: sent },
    ],
    ["throughput_blocks", { value: sumCodes(totals.errors, THROUGHPUT_CODES), denominator: sent }],

    [
      "optout_rate",
      { value: ratio(facts.optOut.stopped, facts.optOut.reached), denominator: facts.optOut.reached },
    ],
    ["suppression_leak", { value: facts.suppressionLeakTotal, denominator: sent }],
    ["carrier_suppressions", { value: facts.carrierSuppressions.total, denominator: sent }],
    [
      "hostile_reply_rate",
      {
        value: ratio(facts.hostile.replies, facts.hostile.inboundScanned),
        denominator: facts.hostile.inboundScanned,
      },
    ],

    [
      "reply_rate",
      {
        value: ratio(facts.engagement.conversationsReplied, facts.engagement.conversationsReached),
        denominator: facts.engagement.conversationsReached,
      },
    ],
    [
      "out_per_in",
      {
        value: ratio(facts.engagement.outbound, Math.max(facts.engagement.inbound, 1)),
        denominator: facts.engagement.outbound,
      },
    ],
    [
      "unanswered_tail",
      {
        value: ratio(facts.engagement.unansweredTail, facts.engagement.conversationsReached),
        denominator: facts.engagement.conversationsReached,
      },
    ],
    ["ucs2_rate", { value: ratio(totals.ucs2, sent), denominator: sent }],
    ["segments_per_message", { value: ratio(totals.segments, sent), denominator: sent }],
    ["template_spread", { value: spread, denominator: clusteredMessages }],
    ["duplication_rate", { value: duplication, denominator: clusteredMessages }],
    ["reach_concentration", { value: concentration, denominator: worstCluster?.messages ?? 0 }],
    [
      "sender_consistency",
      { value: facts.senderInconsistencyTotal, denominator: sent },
    ],
    ["daily_cap_headroom", { value: capPressure, denominator: sent }],
    [
      "burst_factor",
      {
        value: facts.burst.medianSegments > 0 ? facts.burst.p99Segments / facts.burst.medianSegments : null,
        denominator: facts.burst.minutes,
      },
    ],
    [
      "quiet_hours_violations",
      { value: facts.quietHours.violations, denominator: facts.quietHours.automated },
    ],
    [
      "us_bound_share",
      {
        value: ratio(facts.destinations.usBound, facts.destinations.total),
        denominator: facts.destinations.total,
      },
    ],

    [
      "dispatcher_age",
      {
        value: dispatchMinutes,
        denominator: 1,
        // Aucun battement enregistré n'est pas « on ne sait pas » : c'est un
        // répartiteur qui n'a jamais tourné, ou un réglage effacé. Dans les
        // deux cas rien ne s'écoule.
        force: facts.engine.lastDispatchAt === null && sent > 0 ? "danger" : undefined,
      },
    ],
    ["queue_backlog", { value: facts.engine.backlog, denominator: 1 }],
  ];

  const map = new Map<MetricId, Metric>();
  for (const [id, input] of entries) map.set(id, metricOf(id, input));
  return map;
}

// ── Des indicateurs aux constats ────────────────────────────────────────────

/** Quel constat porte quel indicateur. Trois indicateurs n'en portent aucun : ils se lisent, ils n'alarment pas. */
const METRIC_FINDING: Partial<Record<MetricId, FindingId>> = {
  delivered_rate: "low_delivery_rate",
  no_dlr_rate: "no_dlr_backlog",
  stale_in_flight: "stuck_in_flight",
  filtered_rate: "carrier_filtered",
  blocked_rate: "carrier_blocked",
  hard_invalid_rate: "hard_invalid_numbers",
  unreachable_delta: "unreachable_spike",
  total_error_rate: "error_rate_high",
  registration_blocks: "registration_block",
  throughput_blocks: "throughput_block",
  optout_rate: "optout_rate_high",
  suppression_leak: "suppression_leak",
  carrier_suppressions: "carrier_suppressions",
  hostile_reply_rate: "hostile_replies",
  reply_rate: "low_reply_rate",
  unanswered_tail: "unanswered_tail",
  ucs2_rate: "ucs2_inflation",
  template_spread: "template_spread",
  reach_concentration: "reach_concentration",
  sender_consistency: "sender_inconsistency",
  daily_cap_headroom: "daily_cap_pressure",
  burst_factor: "burst_traffic",
  quiet_hours_violations: "quiet_hours_violation",
  us_bound_share: "us_bound_traffic",
  dispatcher_age: "dispatcher_stale",
  queue_backlog: "queue_backlog",
};

/** Un avertissement mesuré ne peut pas adoucir un constat déclaré dangereux. */
function severityOf(base: FindingSeverity, verdict: Verdict): FindingSeverity {
  const measured: FindingSeverity = verdict === "danger" ? "danger" : verdict === "warn" ? "warn" : "info";
  return SEVERITY_RANK[measured] < SEVERITY_RANK[base] ? measured : base;
}

interface EmitInput {
  id: FindingId;
  locale: DocLocale;
  severity?: FindingSeverity;
  metric?: Metric;
  target?: DeepLinkTarget;
  samples?: EvidenceSample[];
  truncated?: boolean;
  subject?: string;
  value?: number | null;
  threshold?: number | null;
}

function emit(input: EmitInput): Finding {
  const doc = FINDING_DOCS[input.id];
  const text = findingText(doc, input.locale);
  const target: DeepLinkTarget = input.target ?? { kind: "none" };
  const metric = input.metric;
  return {
    id: doc.id,
    severity: input.severity ?? (metric ? severityOf(doc.severity, metric.verdict) : doc.severity),
    family: doc.family,
    title: text.label,
    why: text.why,
    fix: text.fix,
    deepLink: deepLinkFor(target),
    external: isExternal(target),
    subject: input.subject,
    sourceUrl: doc.sourceUrl,
    evidence: {
      metric: doc.metric,
      value: input.value !== undefined ? input.value : (metric?.value ?? null),
      threshold: input.threshold !== undefined ? input.threshold : (metric?.threshold ?? null),
      unit: metric?.unit ?? "count",
      samples: input.samples ?? [],
      truncated: input.truncated,
    },
  };
}

// ── Constats de contenu ─────────────────────────────────────────────────────

/**
 * Ce qu'un corps de message déclenche. Une entrée par drapeau, dans l'ordre de
 * gravité : un lien raccourci et une apostrophe courbe ne se valent pas.
 */
const CONTENT_RULES: { id: FindingId; hit: (f: ContentFlags, isOpener: boolean) => boolean }[] = [
  { id: "merge_field_leak", hit: (f) => f.mergeFields.length > 0 },
  { id: "evasion_characters", hit: (f) => f.evasion.length > 0 },
  { id: "public_shortener", hit: (f) => f.shorteners.length > 0 },
  { id: "shaft_language", hit: (f) => f.shaftTerms.length > 0 },
  { id: "missing_optout_language", hit: (f, isOpener) => isOpener && !f.hasOptOut },
  { id: "missing_brand", hit: (f, isOpener) => isOpener && !f.hasBrand },
  {
    id: "link_in_opener",
    hit: (f, isOpener) => isOpener && f.links.length > 0 && f.shorteners.length === 0,
  },
  { id: "promo_language", hit: (f) => f.promoTerms.length > 0 },
  { id: "caps_and_punctuation", hit: (f) => f.capsRatio > 0.35 || f.exclamations >= 3 },
  { id: "ucs2_inflation", hit: (f) => f.encoding === "UCS-2" && f.segments > 1 },
];

/**
 * Les textes de campagne, groupés PAR CAMPAGNE et par constat.
 *
 * Un gabarit fautif répété sur six barreaux ferait six lignes identiques et
 * noierait les trente-neuf autres constats de la page. Une ligne, six pièces à
 * conviction : c'est la même information, et elle reste lisible.
 */
function campaignFindings(facts: DeliverabilityFacts, locale: DocLocale): Finding[] {
  const grouped = new Map<string, { id: FindingId; campaignId: string; campaignName: string; samples: EvidenceSample[]; tab: "ladder" | "variants" }>();

  for (const issue of facts.campaignIssues) {
    const isOpener = issue.origin === "variant" || issue.slot === "0";
    for (const rule of CONTENT_RULES) {
      if (!rule.hit(issue.flags, isOpener)) continue;
      const key = `${rule.id}::${issue.campaignId}`;
      const entry =
        grouped.get(key) ??
        {
          id: rule.id,
          campaignId: issue.campaignId,
          campaignName: issue.campaignName,
          samples: [] as EvidenceSample[],
          tab: (issue.origin === "ladder" ? "ladder" : "variants") as "ladder" | "variants",
        };
      if (entry.samples.length < 5) {
        entry.samples.push({
          label:
            issue.origin === "ladder" ? `Barreau ${issue.slot}` : `Variante ${issue.slot}`,
          excerpt: issue.excerpt,
        });
      }
      grouped.set(key, entry);
    }
  }

  return [...grouped.values()].map((g) =>
    emit({
      id: g.id,
      locale,
      target: { kind: "campaign", id: g.campaignId, tab: g.tab },
      subject: g.campaignName,
      samples: g.samples,
      value: g.samples.length,
    }),
  );
}

// ── Le rapport ──────────────────────────────────────────────────────────────

/**
 * Une cadence de cron est « à la minute » quand son champ des minutes est un
 * pas (`*` ou `*​/n`). `"30 12 * * *"` ne l'est pas : la file ne s'écoule alors
 * que sur les relances en cours de processus, et une application au repos
 * cesse d'envoyer sans qu'aucune erreur ne se lève.
 */
function cronIsFrequent(schedule: string | null): boolean {
  if (!schedule) return false;
  const minutes = schedule.trim().split(/\s+/)[0];
  return minutes === "*" || /^\*\/\d+$/.test(minutes);
}

export function assess(facts: DeliverabilityFacts, locale: DocLocale): DeliverabilityReport {
  const totals = aggregate(facts.numbers);
  const metrics = computeMetrics(facts, totals);
  const findings: Finding[] = [];

  // 1 · Ce que les indicateurs disent.
  for (const [metricId, findingId] of Object.entries(METRIC_FINDING) as [MetricId, FindingId][]) {
    const metric = metrics.get(metricId);
    if (!metric) continue;
    if (metric.verdict !== "warn" && metric.verdict !== "danger") continue;
    const samples = findingSamples(findingId, facts);
    findings.push(
      emit({
        id: findingId,
        locale,
        metric,
        target: findingTarget(findingId, facts),
        samples,
        // Le compte peut dépasser ce qu'on montre. Le taire ferait corriger
        // cinq cas à quelqu'un qui croit en avoir corrigé quarante.
        //
        // Seulement quand la valeur EST un nombre de cas : « 8 902 » minutes
        // depuis le dernier passage du répartiteur n'est pas « 8 902 cas dont
        // on n'en montre que zéro ».
        truncated:
          metric.unit === "count" &&
          samples.length > 0 &&
          metric.value !== null &&
          metric.value > samples.length,
      }),
    );
  }

  // 2 · Ce que les textes de campagne disent, avant même d'être envoyés.
  findings.push(...campaignFindings(facts, locale));

  // 3 · Ce que les ouvertures RÉELLEMENT parties disent. Distinct du point 2 :
  //     là c'est un gabarit au repos, ici c'est ce que les gens ont reçu.
  //
  //     Les deux manquements comptent, et pour la même raison : la LCAP exige
  //     qu'un message commercial identifie son expéditeur ET dise comment
  //     s'arrêter. N'en signaler qu'un laissait la moitié de l'obligation
  //     mesurée mais jamais rapportée.
  //
  //     Aucun `subject` ici : ce champ s'affiche tel quel, et une chaîne
  //     française écrite dans ce module apparaîtrait en anglais à l'écran —
  //     tout le texte visible vient du registre ou du fichier de traductions.
  if (facts.openers.scanned > 0) {
    for (const [id, count] of [
      ["missing_optout_language", facts.openers.missingOptOut],
      ["missing_brand", facts.openers.missingBrand],
    ] as [FindingId, number][]) {
      if (count === 0) continue;
      findings.push(
        emit({
          id,
          locale,
          severity: "warn",
          samples: facts.openers.samples,
          value: count,
          threshold: 0,
          truncated: facts.openers.truncated,
        }),
      );
    }
  }

  // 4 · Les constats STRUCTURELS — ils ne dépendent d'aucune mesure, et ce
  //     sont ceux qui valent le plus le temps de l'opérateur.
  if (facts.engine.killSwitch) {
    findings.push(emit({ id: "kill_switch_on", locale, target: { kind: "settings" } }));
  }
  if (facts.carrierSuppressions.code30003 > 0) {
    findings.push(
      emit({
        id: "harsh_suppression_30003",
        locale,
        value: facts.carrierSuppressions.code30003,
        threshold: 0,
      }),
    );
  }
  if (!cronIsFrequent(facts.engine.cronSchedule)) {
    findings.push(
      emit({
        id: "dispatch_cron_daily",
        locale,
        target: { kind: "goLive" },
        samples: facts.engine.cronSchedule
          ? [{ label: "vercel.json", excerpt: facts.engine.cronSchedule }]
          : [],
      }),
    );
  }
  for (const campaign of facts.unguardedLadderRungs) {
    findings.push(
      emit({
        id: "ladder_body_unguarded",
        locale,
        subject: campaign.campaignName,
        target: { kind: "campaign", id: campaign.campaignId, tab: "ladder" },
        value: campaign.rungs,
        threshold: 0,
      }),
    );
  }

  // 5 · Tri : le plus grave d'abord, puis l'ordre du registre — qui est
  //     l'ordre de lecture voulu, pas l'ordre alphabétique.
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byOrder = FINDING_DOCS[a.id].orderIndex - FINDING_DOCS[b.id].orderIndex;
    if (byOrder !== 0) return byOrder;
    return (a.subject ?? "").localeCompare(b.subject ?? "", "fr");
  });

  const rendered = findings.slice(0, MAX_RENDERED_FINDINGS);

  return {
    now: facts.now,
    range: facts.range,
    verdict: overallVerdict(metrics, rendered, totals.messages),
    metrics: METRIC_IDS.map((id) => metrics.get(id)).filter((m): m is Metric => m !== undefined),
    findings: rendered,
    moreFindings: Math.max(0, findings.length - rendered.length),
    numbers: facts.numbers.map((n) => numberReport(n)),
    skipped: facts.skipped,
    templates: facts.templates,
    empty: totals.messages === 0,
  };
}

/**
 * Les quatre indicateurs sur lesquels le bandeau engage sa parole.
 *
 * Tant qu'AUCUN d'eux n'est mesurable, la page ne sait rien de la
 * délivrabilité : elle sait seulement que rien n'a franchi un seuil, ce qui
 * n'est pas la même chose. Dire « rien à signaler » dans ce cas est le
 * mensonge le plus coûteux que cet écran puisse produire.
 */
const HEADLINE_METRICS: MetricId[] = [
  "delivered_rate",
  "filtered_rate",
  "optout_rate",
  "total_error_rate",
];

/**
 * Le verdict du bandeau — sur les INDICATEURS, pas seulement sur les constats.
 *
 * Le piège corrigé ici : trois indicateurs (`out_per_in`,
 * `segments_per_message`, `duplication_rate`) n'ont volontairement aucun
 * constat attaché, et un indicateur peut franchir son seuil pendant que son
 * constat est repoussé au-delà du plafond d'affichage. Fonder le bandeau sur
 * les seuls constats rendus affichait alors un bandeau vert au-dessus d'une
 * tuile rouge — exactement l'inverse de ce qu'un écran de conformité doit
 * faire.
 */
function overallVerdict(
  metrics: Map<MetricId, Metric>,
  findings: Finding[],
  sent: number,
): Verdict {
  if (sent === 0) return "unknown";

  let worst: Verdict = "ok";
  for (const metric of metrics.values()) {
    // « inconnu » ne dégrade pas le bandeau : il y a toujours un indicateur
    // sous son échantillon minimal. C'est l'absence TOTALE de mesure qui
    // compte, traitée juste en dessous.
    if (metric.verdict === "warn" || metric.verdict === "danger") {
      worst = worstVerdict(worst, metric.verdict);
    }
  }
  for (const finding of findings) {
    if (finding.severity === "danger") worst = worstVerdict(worst, "danger");
    else if (finding.severity === "warn") worst = worstVerdict(worst, "warn");
  }
  if (worst !== "ok") return worst;

  const measurable = HEADLINE_METRICS.some((id) => metrics.get(id)?.verdict === "ok");
  return measurable ? "ok" : "unknown";
}

/** Où mène un constat né d'un indicateur global. */
function findingTarget(id: FindingId, facts: DeliverabilityFacts): DeepLinkTarget {
  switch (id) {
    case "suppression_leak": {
      const leak = facts.suppressionLeaks[0];
      return leak ? { kind: "client", id: leak.clientId } : { kind: "none" };
    }
    case "sender_inconsistency": {
      const client = facts.senderInconsistency[0];
      return client ? { kind: "client", id: client.clientId } : { kind: "none" };
    }
    case "daily_cap_pressure":
    case "kill_switch_on":
      return { kind: "settings" };
    case "dispatcher_stale":
    case "queue_backlog":
    case "stuck_in_flight":
      return { kind: "goLive" };
    default:
      return { kind: "none" };
  }
}

/** Les pièces à conviction qu'un constat global peut montrer. */
function findingSamples(id: FindingId, facts: DeliverabilityFacts): EvidenceSample[] {
  switch (id) {
    case "suppression_leak":
      return facts.suppressionLeaks.map((leak) => ({
        label: `…${leak.clientPhone.slice(-4)} · ${leak.source}`,
        excerpt: leak.excerpt,
        href: `/clients/${leak.clientId}`,
      }));
    case "sender_inconsistency":
      return facts.senderInconsistency.slice(0, 5).map((c) => ({
        label: c.clientName,
        count: c.senders,
        href: `/clients/${c.clientId}`,
      }));
    case "hostile_replies":
      return facts.hostile.samples;
    case "template_spread":
      return facts.templates.clusters
        .filter((c) => c.distinctSendingNumbers > 1)
        .slice(0, 5)
        .map((c) => ({
          label: `${c.messages} envois · ${c.distinctSendingNumbers} numéros`,
          excerpt: c.representativeBody.slice(0, 160),
          count: c.distinctSendingNumbers,
        }));
    case "reach_concentration":
      return facts.templates.clusters
        .filter((c) => c.messages >= 20 && c.distinctRecipients / c.messages < 0.9)
        .slice(0, 5)
        .map((c) => ({
          label: `${c.messages} envois · ${c.distinctRecipients} destinataires`,
          excerpt: c.representativeBody.slice(0, 160),
        }));
    case "daily_cap_pressure":
      return facts.numbers
        .filter((n) => n.active && n.dailyCap > 0 && n.sentToday / n.dailyCap > 0.7)
        .slice(0, 5)
        .map((n) => ({ label: n.e164, count: n.sentToday }));
    default:
      return [];
  }
}

/**
 * Le bulletin d'UN numéro. C'est l'unité que l'opérateur téléphonique note :
 * un numéro sain et un numéro grillé sur le même compte ne se compensent pas,
 * et une moyenne les cacherait tous les deux.
 */
function numberReport(n: NumberFacts): NumberReport {
  const settled =
    (n.statusCounts.delivered ?? 0) + (n.statusCounts.undelivered ?? 0) + (n.statusCounts.failed ?? 0);
  const metrics: Partial<Record<MetricId, Metric>> = {
    delivered_rate: metricOf("delivered_rate", {
      value: ratio(n.statusCounts.delivered ?? 0, settled),
      denominator: settled,
    }),
    filtered_rate: metricOf("filtered_rate", {
      value: ratio(sumCodes(n.errors, FILTERED_CODES, "segments"), n.segments),
      denominator: n.segments,
    }),
    total_error_rate: metricOf("total_error_rate", {
      value: ratio(sumCodes(n.errors, TOTAL_ERROR_CODES), n.messages),
      denominator: n.messages,
    }),
    no_dlr_rate: metricOf("no_dlr_rate", {
      value: ratio(n.noDlr, n.dlrEligible),
      denominator: n.dlrEligible,
    }),
    ucs2_rate: metricOf("ucs2_rate", {
      value: ratio(n.ucs2Messages, n.messages),
      denominator: n.messages,
    }),
    daily_cap_headroom: metricOf("daily_cap_headroom", {
      value: n.dailyCap > 0 ? n.sentToday / n.dailyCap : null,
      denominator: n.messages,
    }),
  };
  const verdict = Object.values(metrics).reduce<Verdict>(
    (worst, m) => worstVerdict(worst, m.verdict),
    n.messages === 0 ? "unknown" : "ok",
  );
  return {
    smsNumberId: n.smsNumberId,
    e164: n.e164,
    label: n.label,
    active: n.active,
    messages: n.messages,
    segments: n.segments,
    metrics,
    verdict,
    // Trois codes suffisent : au-delà, la queue de codes rares ne pèse rien et
    // encombre la ligne. Le nom vient du catalogue, jamais d'une traduction —
    // c'est le libellé officiel de Twilio, celui qu'on retrouve dans sa doc.
    topErrors: [...n.errors]
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 3)
      .map((e) => {
        const cls = classifyErrorCode(e.errorCode);
        return { errorCode: e.errorCode, messages: e.messages, name: cls.name, doc: cls.doc };
      }),
  };
}

// ── Ce que Twilio dit ───────────────────────────────────────────────────────

/**
 * Les constats venus des sondes, calculés à part.
 *
 * L'écran rend d'abord tout ce que la base sait — instantané, complet, sans
 * réseau — puis l'îlot Twilio ajoute les siens quand ils arrivent. Une clé
 * Twilio absente ne doit pas retarder ni vider une page dont neuf dixièmes
 * n'en dépendent pas.
 */
export function assessTwilio(probes: TwilioProbes, locale: DocLocale): Finding[] {
  const findings: Finding[] = [];
  const twilioConsole: DeepLinkTarget = {
    kind: "external",
    url: "https://console.twilio.com/us1/develop/sms/services",
  };

  if (probes.account.state === "ok" && probes.account.data.status !== "active") {
    findings.push(
      emit({
        id: "account_suspended",
        locale,
        target: { kind: "external", url: "https://console.twilio.com" },
        samples: [{ label: probes.account.data.friendlyName, excerpt: probes.account.data.status }],
      }),
    );
  }

  if (probes.service.state === "ok") {
    const service = probes.service.data;
    if (!service.smartEncoding) {
      findings.push(emit({ id: "smart_encoding_off", locale, target: twilioConsole }));
    }
    if (!service.statusCallback) {
      findings.push(emit({ id: "status_callback_missing", locale, target: twilioConsole }));
    }
  }

  if (probes.senderPool.state === "ok") {
    const pool = new Set(probes.senderPool.data.numbers);
    const orphans = probes.crmNumbers.filter((n) => !pool.has(n));
    if (orphans.length > 0) {
      findings.push(
        emit({
          id: "sender_pool_mismatch",
          locale,
          target: twilioConsole,
          samples: orphans.slice(0, 5).map((n) => ({ label: n })),
          value: orphans.length,
          threshold: 0,
        }),
      );
    }
  }

  if (probes.a2p.state === "ok") {
    const a2p = probes.a2p.data;
    const bad = ["FAILED", "SUSPENDED", "IN_PROGRESS", "PENDING"].includes(
      a2p.campaignStatus.toUpperCase(),
    );
    if (bad || a2p.errors.length > 0) {
      findings.push(
        emit({
          id: "a2p_campaign_problem",
          locale,
          target: twilioConsole,
          samples: [
            { label: a2p.campaignStatus },
            ...a2p.errors.slice(0, 4).map((e) => ({
              label: e.code === null ? "?" : String(e.code),
              excerpt: e.description,
            })),
          ],
        }),
      );
    }
  }

  // Une clé « restreinte » qui n'emporte pas Monitor ou TrustHub échoue
  // exactement comme une panne. C'est la confusion la plus coûteuse de cette
  // carte, donc elle est nommée plutôt que grisée.
  const scoped = Object.values(probes).some(
    (p) => typeof p === "object" && p !== null && "state" in p && p.state === "unavailable" && p.reason === "scope",
  );
  if (scoped) {
    findings.push(
      emit({
        id: "twilio_key_scope",
        locale,
        target: { kind: "external", url: "https://console.twilio.com/us1/account/keys-credentials/api-keys" },
      }),
    );
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return findings;
}
