/**
 * Vocabulaire de la délivrabilité — le contrat que partagent le calcul, le
 * registre de constats et l'écran.
 *
 * Module PUR (règle du dossier) : aucun import Next.js, aucun accès base,
 * aucune lecture d'environnement, aucun `next-intl`. La langue arrive en
 * paramètre, les chiffres arrivent déjà lus. `tests/unit-deliverability-purity.test.ts`
 * fait échouer le build si l'un de ces interdits entre ici.
 *
 * Pourquoi un contrat séparé plutôt que des objets ad hoc : le tableau de bord
 * ne dit pas « voici des chiffres », il dit « voici ce qui va mal et voici où
 * le corriger ». Cette promesse ne tient que si un indicateur, son seuil, sa
 * provenance et le lien qui mène à la correction sont UN SEUL objet — sinon un
 * seuil bouge d'un côté et le texte du constat continue d'affirmer l'ancien.
 */

// ── Verdicts ────────────────────────────────────────────────────────────────

/**
 * QUATRE lectures, jamais trois.
 *
 * « Tout va bien » et « on n'a pas pu savoir » se ressemblent dangereusement
 * sur un tableau de bord. Un indicateur calculé sur onze messages n'est pas
 * vert : il est inconnu. Confondre les deux, c'est croire qu'on surveille une
 * chose qu'on ne surveille pas.
 */
export const VERDICTS = ["ok", "warn", "danger", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Ordre de gravité — sert au tri et à l'escalade (jamais à l'adoucissement). */
export const VERDICT_RANK: Record<Verdict, number> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  danger: 3,
};

/**
 * D'où vient le seuil. Affiché à côté du chiffre, et ce n'est pas décoratif :
 * presque aucun opérateur téléphonique ne publie ses seuils. Faire passer un
 * repère de fournisseur pour une règle d'opérateur, c'est fabriquer une
 * fausse certitude — et le jour où le chiffre est contesté, plus personne ne
 * sait lequel était sourcé.
 */
export const PROVENANCES = ["carrier", "vendor", "operational", "context"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Unité d'une valeur — le composant décide du formatage, jamais le calcul. */
export const METRIC_UNITS = ["rate", "count", "segments", "minutes", "ratio"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

// ── Indicateurs ─────────────────────────────────────────────────────────────

/**
 * Les indicateurs suivis. L'ordre est celui de lecture : est-ce arrivé, qui a
 * dit stop, quelle forme a le trafic, que dit le texte, la machine tourne-t-elle.
 */
export const METRIC_IDS = [
  // Est-ce arrivé ?
  "delivered_rate",
  "no_dlr_rate",
  "stale_in_flight",
  "filtered_rate",
  "blocked_rate",
  "hard_invalid_rate",
  "unreachable_delta",
  "total_error_rate",
  "registration_blocks",
  "throughput_blocks",
  // Qui a dit stop ?
  "optout_rate",
  "suppression_leak",
  "carrier_suppressions",
  "hostile_reply_rate",
  // Quelle forme a le trafic ?
  "reply_rate",
  "out_per_in",
  "unanswered_tail",
  "ucs2_rate",
  "segments_per_message",
  "template_spread",
  "duplication_rate",
  "reach_concentration",
  "sender_consistency",
  "daily_cap_headroom",
  "burst_factor",
  "quiet_hours_violations",
  "us_bound_share",
  // La machine tourne-t-elle ?
  "dispatcher_age",
  "queue_backlog",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** Un indicateur mesuré : sa valeur, ce sur quoi elle porte, et son verdict. */
export interface Metric {
  id: MetricId;
  /** null = pas mesurable (dénominateur vide, sonde muette). */
  value: number | null;
  /** Sur combien de messages / téléphones / minutes la valeur porte. */
  denominator: number;
  verdict: Verdict;
  unit: MetricUnit;
  provenance: Provenance;
  /** Le seuil franchi, quand il y en a un — sert à écrire « 4 % (seuil 2 %) ». */
  threshold: number | null;
}

// ── Constats ────────────────────────────────────────────────────────────────

/**
 * Ce qui est en cause. La FAMILLE n'est pas la gravité : un contenu
 * perfectible et un compte suspendu appartiennent à deux familles et ont deux
 * gravités indépendantes. Les mélanger ferait clignoter la page en rouge pour
 * une apostrophe courbe, et l'opérateur cesserait de regarder.
 */
export const FINDING_FAMILIES = ["delivery", "consent", "shape", "content", "engine"] as const;
export type FindingFamily = (typeof FINDING_FAMILIES)[number];

export const FINDING_SEVERITIES = ["danger", "warn", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const SEVERITY_RANK: Record<FindingSeverity, number> = { danger: 0, warn: 1, info: 2 };

/**
 * Le catalogue des constats. Un identifiant = un problème nommé, une raison,
 * une correction. Ajouter une entrée ici oblige à écrire les trois textes en
 * français ET en anglais — `tests/unit-docs-locale.test.ts` le vérifie.
 */
export const FINDING_IDS = [
  // ── delivery ──
  "low_delivery_rate",
  "no_dlr_backlog",
  "stuck_in_flight",
  "carrier_filtered",
  "carrier_blocked",
  "hard_invalid_numbers",
  "unreachable_spike",
  "error_rate_high",
  "registration_block",
  "us_bound_traffic",
  "throughput_block",
  // ── consent ──
  "optout_rate_high",
  "suppression_leak",
  "carrier_suppressions",
  "harsh_suppression_30003",
  "missing_optout_language",
  "hostile_replies",
  // ── shape ──
  "template_spread",
  "sender_inconsistency",
  "daily_cap_pressure",
  "burst_traffic",
  "quiet_hours_violation",
  "low_reply_rate",
  "unanswered_tail",
  "reach_concentration",
  // ── content ──
  "merge_field_leak",
  "public_shortener",
  "link_in_opener",
  "missing_brand",
  "caps_and_punctuation",
  "promo_language",
  "shaft_language",
  "evasion_characters",
  "ucs2_inflation",
  "ladder_body_unguarded",
  // ── engine ──
  "dispatcher_stale",
  "dispatch_cron_daily",
  "queue_backlog",
  "kill_switch_on",
  "smart_encoding_off",
  "sender_pool_mismatch",
  "status_callback_missing",
  "twilio_key_scope",
  "a2p_campaign_problem",
  "account_suspended",
] as const;
export type FindingId = (typeof FINDING_IDS)[number];

/**
 * Où l'on va pour corriger. Une cible TYPÉE, jamais une chaîne d'URL écrite
 * dans un composant : la route change un jour, et un lien mort sur un écran de
 * conformité est pire qu'aucun lien — il fait croire que le geste a été fait.
 * `src/lib/deliverability/links.ts` est le seul endroit qui écrit un chemin.
 */
export type DeepLinkTarget =
  | { kind: "campaign"; id: string; tab: CampaignTab }
  | { kind: "assistant"; id: string; tab: AssistantTab }
  | { kind: "guardrails"; ruleKey?: string }
  | { kind: "client"; id: string }
  | { kind: "conversation"; id: string }
  | { kind: "settings" }
  | { kind: "goLive" }
  | { kind: "external"; url: string }
  | { kind: "none" };

export type DeepLinkKind = DeepLinkTarget["kind"];

/** Onglets réels de `src/components/admin/campaign-editor/index.tsx`. */
export const CAMPAIGN_TABS = [
  "basics",
  "trigger",
  "audience",
  "ladder",
  "variants",
  "enrollments",
] as const;
export type CampaignTab = (typeof CAMPAIGN_TABS)[number];

/** Onglets réels de l'éditeur d'assistant que ce tableau de bord vise. */
export const ASSISTANT_TABS = ["identity", "goal", "approach", "guardrails", "knowledge"] as const;
export type AssistantTab = (typeof ASSISTANT_TABS)[number];

/** Une pièce à conviction : de quoi reconnaître le cas sans quitter l'écran. */
export interface EvidenceSample {
  label: string;
  /** Extrait de message, TOUJOURS tronqué — ce n'est pas une messagerie. */
  excerpt?: string;
  count?: number;
  /** Lien vers la pièce elle-même (une fiche client, une conversation). */
  href?: string;
}

export interface FindingEvidence {
  metric: MetricId | null;
  /** Jamais préformatée : le composant possède `Intl`, le calcul non. */
  value: number | null;
  threshold: number | null;
  unit: MetricUnit;
  /** Au plus 5 — au-delà on montre un compteur, pas une liste. */
  samples: EvidenceSample[];
  /** Vrai quand des cas existent au-delà de ce qui est montré. */
  truncated?: boolean;
}

/** Ce que l'écran rend. Les textes sont DÉJÀ résolus dans une seule langue. */
export interface Finding {
  id: FindingId;
  /** Gravité CALCULÉE — le registre donne une base, le calcul peut l'escalader. */
  severity: FindingSeverity;
  family: FindingFamily;
  title: string;
  why: string;
  fix: string;
  /** Chemin prêt à poser dans un `<Link href>`, ou null quand rien à ouvrir. */
  deepLink: string | null;
  /** `true` quand le lien sort de l'application (console Twilio). */
  external: boolean;
  evidence: FindingEvidence;
  /**
   * Ce que le constat vise, quand il vise quelque chose de nommé : un numéro,
   * une campagne, un assistant. Deux campagnes fautives = deux constats.
   */
  subject?: string;
  sourceUrl?: string;
}

// ── Les faits ───────────────────────────────────────────────────────────────

/** Bornes de la période observée, déjà résolues en UTC. */
export interface DeliverabilityRange {
  fromUtc: Date;
  /** Borne HAUTE exclusive — jamais `<=`, sinon la dernière minute compte deux fois. */
  toUtcExclusive: Date;
  days: number;
  /** Même durée, juste avant — sert aux indicateurs de dérive (30003). */
  previousFromUtc: Date;
}

/** Comptes par statut Twilio, tels qu'ils sont ÉCRITS en base. */
export type StatusCounts = Record<string, number>;

export interface ErrorCount {
  errorCode: number;
  messages: number;
  segments: number;
}

/** Tout ce qui se mesure par numéro expéditeur (le bac de score du carrier). */
export interface NumberFacts {
  smsNumberId: string;
  e164: string;
  label: string | null;
  active: boolean;
  dailyCap: number;
  messagingServiceSid: string;
  statusCounts: StatusCounts;
  /** Segments facturés sur la période — la base des taux pondérés. */
  segments: number;
  messages: number;
  /** `queued`/`sending`/`accepted` immobiles depuis plus d'une heure. */
  staleInFlight: number;
  /** `sent` sans accusé de remise après 24 h — l'angle mort du 25 août. */
  noDlr: number;
  /**
   * Messages assez VIEUX pour qu'un accusé ait eu le temps d'arriver (plus de
   * 24 h). C'est le dénominateur de `no_dlr_rate` : diviser par toute la
   * fenêtre diluait la panne d'avant-hier dans les envois d'aujourd'hui.
   */
  dlrEligible: number;
  errors: ErrorCount[];
  /** Idem, sur la période PRÉCÉDENTE — pour la dérive du 30003. */
  previousErrors: ErrorCount[];
  /** Sortants partis sur la période précédente — le dénominateur de la dérive. */
  previousMessages: number;
  ucs2Messages: number;
  /** Envoyés depuis minuit à Toronto — même définition que `outboundCountToday`. */
  sentToday: number;
}

/** Ce qui n'est JAMAIS parti : un autre dénominateur, jamais mélangé. */
export interface SkipCount {
  /** Préfixe avant `:` — même découpe que la carte de fil du client. */
  reason: string;
  messages: number;
}

export interface LeakSample {
  messageId: string;
  conversationId: string;
  clientId: string;
  clientPhone: string;
  suppressedAt: Date;
  sentAt: Date;
  source: string;
  excerpt: string;
}

export interface TemplateCluster {
  /** Le corps RÉEL le plus fréquent du groupe — pas un gabarit reconstruit. */
  representativeBody: string;
  messages: number;
  distinctRecipients: number;
  /** ≥ 2 = essaimage. C'est le seul chiffre de cet onglet qui alarme. */
  distinctSendingNumbers: number;
}

/** Un corps de message écrit à la main dans une campagne, analysé au repos. */
export interface CampaignBodyIssue {
  campaignId: string;
  campaignName: string;
  /** `ladder` = barreau de relance, `variant` = variante A/B. */
  origin: "ladder" | "variant";
  /** Index du barreau, ou clé de la variante. */
  slot: string;
  excerpt: string;
  flags: ContentFlags;
}

/**
 * Ce qu'une analyse de contenu constate. Des FAITS, jamais de prose : le texte
 * qui explique vit dans le registre, en deux langues.
 */
export interface ContentFlags {
  /** Champs de fusion non remplacés — `{{prenom}}` part tel quel au contact. */
  mergeFields: string[];
  links: string[];
  /** Sous-ensemble de `links` hébergé par un raccourcisseur public. */
  shorteners: string[];
  hasOptOut: boolean;
  hasBrand: boolean;
  capsRatio: number;
  exclamations: number;
  promoTerms: string[];
  shaftTerms: string[];
  /** Caractères invisibles ou mélange d'alphabets — de l'évasion, pas du style. */
  evasion: string[];
  emoji: number;
  encoding: "GSM-7" | "UCS-2";
  segments: number;
  /** Caractères qui forcent l'UCS-2, avec leur substitut ASCII quand il existe. */
  ucs2Offenders: { char: string; suggestion?: string }[];
  length: number;
}

export interface EngineFacts {
  lastDispatchAt: Date | null;
  killSwitch: boolean;
  killSwitchReason: string | null;
  /** Jobs `send_sms` en attente dont l'heure est passée. */
  backlog: number;
  oldestPendingAt: Date | null;
  /** Cadence déclarée dans `vercel.json`, telle quelle. */
  cronSchedule: string | null;
}

export interface DeliverabilityFacts {
  now: Date;
  range: DeliverabilityRange;
  numbers: NumberFacts[];
  skipped: SkipCount[];
  /** Désabonnements : téléphones ayant dit STOP / téléphones réellement texté. */
  optOut: { stopped: number; reached: number };
  /** Suppressions écrites par un échec transporteur, dont celles du code 30003. */
  carrierSuppressions: { total: number; code30003: number };
  suppressionLeaks: LeakSample[];
  suppressionLeakTotal: number;
  engagement: {
    conversationsReached: number;
    conversationsReplied: number;
    outbound: number;
    inbound: number;
    /** Fils à ≥ 4 sortants et 0 entrant — on parle tout seul. */
    unansweredTail: number;
  };
  /** Réponses hostiles : PROXY de plainte, jamais présenté comme la plainte. */
  hostile: { replies: number; inboundScanned: number; samples: EvidenceSample[] };
  burst: { medianSegments: number; p99Segments: number; peakSegments: number; minutes: number };
  /**
   * Clients joints depuis plus d'un numéro expéditeur. La liste est bornée
   * (on n'affiche que des exemples) ; `senderInconsistencyTotal` porte le
   * compte EXACT — sans lui, « 50 » se lisait comme un total alors qu'il était
   * un plafond.
   */
  senderInconsistency: { clientId: string; clientName: string; senders: number }[];
  senderInconsistencyTotal: number;
  quietHours: { violations: number; automated: number };
  /** Destinations hors Canada, d'après l'indicatif régional. */
  destinations: { total: number; usBound: number };
  templates: { clusters: TemplateCluster[]; scanned: number; truncated: boolean };
  campaignIssues: CampaignBodyIssue[];
  /** Barreaux écrits à la main : ils échappent aux garde-fous. */
  unguardedLadderRungs: { campaignId: string; campaignName: string; rungs: number }[];
  engine: EngineFacts;
  /**
   * Premiers messages d'un fil sans mention d'arrêt ni de marque.
   * `truncated` : le balayage a été plafonné — l'écran le dit plutôt que de
   * laisser lire un compte partiel comme un total.
   */
  openers: {
    scanned: number;
    missingOptOut: number;
    missingBrand: number;
    samples: EvidenceSample[];
    truncated: boolean;
  };
}

// ── Sondes Twilio ───────────────────────────────────────────────────────────

/**
 * QUATRE états, jamais deux.
 *
 * « Pas configuré », « configuré mais injoignable », « demandé, et Twilio dit
 * que ça n'existe pas » et « répondu » sont quatre situations avec quatre
 * gestes différents. Les rendre toutes en gris « indisponible » apprend à
 * l'opérateur à ignorer le gris.
 */
export type Probe<T> =
  | { state: "ok"; data: T }
  | { state: "unconfigured"; missing: string[] }
  | { state: "unavailable"; reason: "http" | "timeout" | "scope" | "parse"; status?: number }
  | { state: "absent" };

export interface TwilioAccountProbe {
  status: string;
  friendlyName: string;
}

export interface TwilioServiceProbe {
  sid: string;
  friendlyName: string;
  smartEncoding: boolean;
  stickySender: boolean;
  validityPeriod: number | null;
  statusCallback: string | null;
  useCase: string | null;
}

export interface TwilioSenderPoolProbe {
  /** E.164 réellement attachés au service de messagerie. */
  numbers: string[];
}

export interface TwilioA2pProbe {
  campaignStatus: string;
  errors: { code: number | null; description: string }[];
  usAppToPersonUsecase: string | null;
}

export interface TwilioAlertsProbe {
  errors: { code: string; count: number; mostRecent: string }[];
}

export interface TwilioProbes {
  account: Probe<TwilioAccountProbe>;
  service: Probe<TwilioServiceProbe>;
  senderPool: Probe<TwilioSenderPoolProbe>;
  a2p: Probe<TwilioA2pProbe>;
  alerts: Probe<TwilioAlertsProbe>;
  /** E.164 actifs côté CRM — sert au diff avec le bassin d'expéditeurs. */
  crmNumbers: string[];
}

// ── Le rapport ──────────────────────────────────────────────────────────────

export interface NumberReport {
  smsNumberId: string;
  e164: string;
  label: string | null;
  active: boolean;
  messages: number;
  segments: number;
  metrics: Partial<Record<MetricId, Metric>>;
  verdict: Verdict;
  /**
   * Les codes d'erreur les plus fréquents de CE numéro, du plus lourd au plus
   * léger. Sans eux, plusieurs corrections disaient « ouvrez l'onglet Numéros
   * et traitez le code le plus fréquent » devant un tableau qui n'affichait
   * aucun code : l'opérateur n'avait nulle part où aller.
   */
  topErrors: { errorCode: number; messages: number; name: string; doc: string }[];
}

export interface DeliverabilityReport {
  now: Date;
  range: DeliverabilityRange;
  /** Le verdict de l'ensemble = le pire verdict d'un indicateur qui alarme. */
  verdict: Verdict;
  /** Indicateurs globaux, dans l'ordre de `METRIC_IDS`. */
  metrics: Metric[];
  findings: Finding[];
  /** Constats au-delà du plafond d'affichage — comptés, pas rendus. */
  moreFindings: number;
  numbers: NumberReport[];
  skipped: SkipCount[];
  templates: { clusters: TemplateCluster[]; scanned: number; truncated: boolean };
  /** Vrai quand AUCUN message n'est parti sur la période : rien n'est mesurable. */
  empty: boolean;
}
