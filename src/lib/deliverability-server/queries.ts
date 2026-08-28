import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  conversations,
  messages,
  scheduledJobs,
  smsNumbers,
  suppressions,
} from "@/db/schema-sms";
import { formatInTimeZone } from "date-fns-tz";
import { COUNTED, startOfTorontoDay } from "@/lib/sms-server/daily-cap";
import { destinationOf } from "@/lib/deliverability/npa";
import {
  NEVER_LEFT_STATUSES,
  NO_DLR_STATUS,
  STALE_IN_FLIGHT_STATUSES,
} from "@/lib/deliverability/status-classes";
import { isHostileReply } from "@/lib/deliverability/content";
import type {
  DeliverabilityRange,
  ErrorCount,
  EvidenceSample,
  LeakSample,
  NumberFacts,
  SkipCount,
  StatusCounts,
} from "@/lib/deliverability/types";

/**
 * Les lectures du tableau de bord de délivrabilité.
 *
 * Trois décisions gouvernent tout ce fichier, et chacune a coûté un chiffre
 * faux ailleurs avant d'être écrite ici :
 *
 *  · **Le dénominateur, c'est ce qui est PARTI.** Un sortant sans `twilio_sid`
 *    n'a jamais atteint le transporteur : le compter dans un taux de remise
 *    ferait chuter le taux à chaque essai à blanc et à chaque interrupteur
 *    d'arrêt. Ce qui n'est pas parti se lit à part, dans son propre tableau.
 *  · **Le numéro expéditeur ne vit PAS sur le message.** Il vit sur le fil
 *    (`conversations.sms_number_id`). Toute requête par expéditeur passe donc
 *    par une jointure — il n'y a pas de raccourci.
 *  · **« Aujourd'hui » se compte comme l'exécutant le compte.** Le plafond
 *    quotidien est relu avec la liste de statuts et la borne de journée de
 *    `sms-server/daily-cap.ts`, importées et non recopiées. Un tableau de bord
 *    qui dit « il reste de la place » pendant que l'envoi reporte au lendemain
 *    est pire que pas de tableau de bord.
 *
 * Aucune extension Postgres n'est requise (ni `unaccent`, ni `pg_trgm`) : le
 * pliage d'accents se fait en TypeScript, là où le reste du moteur le fait
 * déjà. En installer une serait une migration de production.
 */

const TORONTO = "America/Toronto";

/** Exemples ramenés pour l'écran — jamais le total, qui se compte à part. */
const SENDER_SAMPLE_LIMIT = 50;

/**
 * L'étiquette d'une pièce à conviction — heure de Québec, jamais un ISO en Z.
 *
 * Règle du dépôt : ce qui s'affiche se lit en `America/Toronto`. Un
 * « 2026-08-27T06:16:42.500Z » posé sous un extrait de message oblige
 * l'opérateur à faire la conversion de tête au moment précis où il essaie de
 * comprendre à quelle heure le message est parti.
 */
export function stamp(at: Date): string {
  return formatInTimeZone(at, TORONTO, "d MMM, HH:mm");
}

/**
 * Un instant prêt à être interpolé dans un `sql` ÉCRIT À LA MAIN.
 *
 * `drizzle-orm/postgres-js` remplace, à la construction du client, le
 * sérialiseur du pilote pour les OID de date (1184, 1114, 1082…) par l'identité
 * — il mappe lui-même les valeurs de colonne et n'attend plus rien du pilote.
 * Conséquence : un objet `Date` interpolé tel quel dans un gabarit `sql` arrive
 * intact jusqu'à postgres.js, qui le passe à son écrivain d'octets et lève
 * « The "string" argument must be of type string […] Received an instance of
 * Date ». La requête ne part JAMAIS.
 *
 * Les comparaisons bâties avec `gte`/`lt` passent par le mappeur de la colonne
 * et n'ont pas ce problème ; celles écrites à la main doivent convertir
 * elles-mêmes, exactement comme le fait ce mappeur (ISO 8601 en UTC).
 * `tests/int-deliverability-queries.test.ts` exécute ces trois requêtes contre
 * un vrai Postgres pour que l'oubli se voie.
 */
function ts(instant: Date): string {
  return instant.toISOString();
}

/**
 * Une liste de littéraux prête pour un `in (…)` écrit à la main.
 *
 * Un tableau interpolé tel quel dans un gabarit `sql` devient UN paramètre, pas
 * une liste : la condition ne filtre alors plus rien. `sql.join` produit les
 * emplacements un par un — donc toujours des paramètres liés, jamais du texte
 * concaténé.
 */
function inList(values: readonly string[]) {
  return sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

/** Le sortant a-t-il atteint Twilio ? Le seul dénominateur honnête. */
function sentPredicate(range: DeliverabilityRange) {
  return and(
    eq(messages.direction, "out"),
    isNotNull(messages.twilioSid),
    gte(messages.createdAt, range.fromUtc),
    lt(messages.createdAt, range.toUtcExclusive),
  );
}

// ── A · Histogramme des statuts, par numéro ─────────────────────────────────

interface StatusRow {
  smsNumberId: string;
  status: string | null;
  msgs: number;
  segs: number;
}

async function statusHistogram(range: DeliverabilityRange): Promise<StatusRow[]> {
  return db
    .select({
      smsNumberId: conversations.smsNumberId,
      status: messages.status,
      msgs: sql<number>`count(*)::int`,
      segs: sql<number>`coalesce(sum(${messages.segments}), 0)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range))
    .groupBy(conversations.smsNumberId, messages.status);
}

/**
 * Le même volume, sur la période PRÉCÉDENTE. C'est le dénominateur de la
 * dérive : un taux de « injoignable » comparé à rien ne dit rien, et le
 * comparer à un volume différent inventerait la hausse qu'on cherche.
 */
async function previousVolume(range: DeliverabilityRange): Promise<Map<string, number>> {
  const rows = await db
    .select({
      smsNumberId: conversations.smsNumberId,
      msgs: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, "out"),
        isNotNull(messages.twilioSid),
        gte(messages.createdAt, range.previousFromUtc),
        lt(messages.createdAt, range.fromUtc),
      ),
    )
    .groupBy(conversations.smsNumberId);
  return new Map(rows.map((r) => [r.smsNumberId, r.msgs]));
}

/**
 * Les deux angles morts de la livraison, mesurés à la même barre que la
 * réconciliation REST : un `sent` sans accusé après 24 h, et un envoi encore
 * « en vol » après une heure. L'incident du 25 août 2026 est né exactement là
 * — les messages partaient, les rappels de statut ne revenaient plus, et rien
 * n'avait l'air cassé.
 */
async function inFlightHistogram(range: DeliverabilityRange, now: Date) {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return db
    .select({
      smsNumberId: conversations.smsNumberId,
      // Les listes de statuts viennent de `status-classes.ts`, jamais du SQL :
      // recopier « queued, sending, accepted » ici, c'est signer la divergence
      // du jour où Twilio en ajoute un.
      staleInFlight: sql<number>`(count(*) filter (
        where ${messages.status} in ${inList(STALE_IN_FLIGHT_STATUSES)}
          and ${messages.createdAt} < ${ts(oneHourAgo)}))::int`,
      noDlr: sql<number>`(count(*) filter (
        where ${messages.status} = ${NO_DLR_STATUS}
          and ${messages.createdAt} < ${ts(oneDayAgo)}))::int`,
      // Le DÉNOMINATEUR du taux « sans accusé » : seuls les messages assez
      // vieux pour qu'un accusé ait eu le temps d'arriver. Diviser par toute
      // la fenêtre diluait le taux avec les envois d'hier — plus on écrit
      // aujourd'hui, plus la panne d'accusé d'avant-hier a l'air petite.
      dlrEligible: sql<number>`(count(*) filter (
        where ${messages.createdAt} < ${ts(oneDayAgo)}))::int`,
      ucs2: sql<number>`(count(*) filter (where ${messages.encoding} = 'UCS-2'))::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range))
    .groupBy(conversations.smsNumberId);
}

// ── B · Histogramme des codes d'erreur, par numéro ──────────────────────────

interface ErrorRow {
  smsNumberId: string;
  errorCode: number | null;
  msgs: number;
  segs: number;
}

async function errorHistogram(from: Date, toExclusive: Date): Promise<ErrorRow[]> {
  return db
    .select({
      smsNumberId: conversations.smsNumberId,
      errorCode: messages.errorCode,
      msgs: sql<number>`count(*)::int`,
      segs: sql<number>`coalesce(sum(${messages.segments}), 0)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, "out"),
        isNotNull(messages.twilioSid),
        isNotNull(messages.errorCode),
        gte(messages.createdAt, from),
        lt(messages.createdAt, toExclusive),
      ),
    )
    .groupBy(conversations.smsNumberId, messages.errorCode);
}

// ── H · Le compteur du plafond quotidien ────────────────────────────────────

async function sentTodayByNumber(now: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({
      smsNumberId: conversations.smsNumberId,
      n: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, "out"),
        gte(messages.createdAt, startOfTorontoDay(now)),
        sql`${messages.status} in ${sql.raw(`(${COUNTED.map((s) => `'${s}'`).join(", ")})`)}`,
      ),
    )
    .groupBy(conversations.smsNumberId);
  return new Map(rows.map((r) => [r.smsNumberId, r.n]));
}

/** Tout ce qui se mesure par numéro expéditeur, assemblé en une passe. */
export async function numberFacts(
  range: DeliverabilityRange,
  now: Date,
): Promise<NumberFacts[]> {
  const [numbers, statuses, inFlight, errors, previousErrors, today, previous] = await Promise.all([
    db
      .select({
        id: smsNumbers.id,
        e164: smsNumbers.e164,
        label: smsNumbers.label,
        active: smsNumbers.active,
        dailyCap: smsNumbers.dailyCap,
        messagingServiceSid: smsNumbers.messagingServiceSid,
      })
      .from(smsNumbers)
      .orderBy(smsNumbers.e164),
    statusHistogram(range),
    inFlightHistogram(range, now),
    errorHistogram(range.fromUtc, range.toUtcExclusive),
    errorHistogram(range.previousFromUtc, range.fromUtc),
    sentTodayByNumber(now),
    previousVolume(range),
  ]);

  const statusByNumber = new Map<string, { counts: StatusCounts; msgs: number; segs: number }>();
  for (const row of statuses) {
    const entry = statusByNumber.get(row.smsNumberId) ?? { counts: {}, msgs: 0, segs: 0 };
    // Un statut null est un vrai cas (rangée écrite avant le premier rappel) :
    // il est rangé sous « unknown » plutôt que jeté, sinon les totaux par
    // statut et le total tout court ne s'additionnent plus.
    const key = row.status ?? "unknown";
    entry.counts[key] = (entry.counts[key] ?? 0) + row.msgs;
    entry.msgs += row.msgs;
    entry.segs += row.segs;
    statusByNumber.set(row.smsNumberId, entry);
  }

  const inFlightByNumber = new Map(inFlight.map((r) => [r.smsNumberId, r]));

  const groupErrors = (rows: ErrorRow[]) => {
    const map = new Map<string, ErrorCount[]>();
    for (const row of rows) {
      if (row.errorCode === null) continue;
      const list = map.get(row.smsNumberId) ?? [];
      list.push({ errorCode: row.errorCode, messages: row.msgs, segments: row.segs });
      map.set(row.smsNumberId, list);
    }
    return map;
  };
  const errorsByNumber = groupErrors(errors);
  const previousByNumber = groupErrors(previousErrors);

  return numbers.map((n) => {
    const s = statusByNumber.get(n.id);
    const f = inFlightByNumber.get(n.id);
    return {
      smsNumberId: n.id,
      e164: n.e164,
      label: n.label,
      active: n.active,
      dailyCap: n.dailyCap,
      messagingServiceSid: n.messagingServiceSid,
      statusCounts: s?.counts ?? {},
      messages: s?.msgs ?? 0,
      segments: s?.segs ?? 0,
      staleInFlight: f?.staleInFlight ?? 0,
      noDlr: f?.noDlr ?? 0,
      dlrEligible: f?.dlrEligible ?? 0,
      errors: errorsByNumber.get(n.id) ?? [],
      previousErrors: previousByNumber.get(n.id) ?? [],
      previousMessages: previous.get(n.id) ?? 0,
      ucs2Messages: f?.ucs2 ?? 0,
      sentToday: today.get(n.id) ?? 0,
    };
  });
}

// ── C · Ce qui n'est jamais parti ───────────────────────────────────────────

/**
 * Un dénominateur DIFFÉRENT, gardé à part exprès. « Bloqué par l'interrupteur
 * d'arrêt » et « refusé par l'opérateur » ne se comparent pas : le premier est
 * une décision de la maison, le second un jugement du réseau. Les additionner
 * ferait passer un arrêt volontaire pour un problème de réputation.
 */
export async function skipHistogram(range: DeliverabilityRange): Promise<SkipCount[]> {
  /**
   * Le motif vient du `skip_reason`, préfixe avant `:` — sauf pour l'essai à
   * blanc, qui n'en écrit AUCUN.
   *
   * `handleSendSms` traite `dry_run` à part : la rangée reçoit le statut
   * `dry_run`, pas de motif, pas de sid Twilio. Sans le repêchage ci-dessous
   * elle échappait aux deux tableaux — au taux de remise (qui exige un sid) ET
   * à celui-ci (qui exigeait un motif). Autrement dit, basculer le moteur en
   * mode essai vidait tout l'écran de conformité sans dire pourquoi, et
   * l'écran répondait « aucun message envoyé » à quelqu'un qui venait d'en
   * envoyer cent.
   */
  const reason = sql<string>`coalesce(nullif(split_part(coalesce(${messages.skipReason}, ''), ':', 1), ''), ${messages.status})`;
  const rows = await db
    .select({ reason, msgs: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, "out"),
        or(isNotNull(messages.skipReason), inArray(messages.status, [...NEVER_LEFT_STATUSES])),
        gte(messages.createdAt, range.fromUtc),
        lt(messages.createdAt, range.toUtcExclusive),
      ),
    )
    .groupBy(reason)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ reason: r.reason, messages: r.msgs }));
}

// ── D · Désabonnements ──────────────────────────────────────────────────────

/**
 * Le taux de désabonnement, sur les téléphones RÉELLEMENT texté dans la
 * fenêtre. Rapporter les STOP au nombre de messages donnerait un chiffre qui
 * baisse quand on écrit plus — l'exact contraire du signal recherché.
 *
 * Qualificateur explicite `suppressions.phone_e164` dans le `exists` : drizzle
 * n'aurait pas qualifié la référence, et une colonne homonyme ajoutée un jour
 * à `conversations` ou `messages` capturerait silencieusement la corrélation.
 *
 * `sms_stop` est le seul motif interrogé : c'est le seul qu'un chemin de code
 * écrive (`inbound.ts`, et les deux sorties de l'agent). `manual` et
 * `complaint` existent dans la colonne mais rien ne les produit.
 */
export async function optOutFacts(
  range: DeliverabilityRange,
): Promise<{ stopped: number; reached: number }> {
  const [stopped] = await db
    .select({ n: sql<number>`count(distinct ${suppressions.phoneE164})::int` })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "sms_stop"),
        gte(suppressions.createdAt, range.fromUtc),
        lt(suppressions.createdAt, range.toUtcExclusive),
        sql`exists (
          select 1 from conversations c
          join messages m on m.conversation_id = c.id
          where c.client_phone = suppressions.phone_e164
            and m.direction = 'out' and m.twilio_sid is not null
            and m.created_at >= ${ts(range.fromUtc)} and m.created_at < ${ts(range.toUtcExclusive)})`,
      ),
    );

  const [reached] = await db
    .select({ n: sql<number>`count(distinct ${conversations.clientPhone})::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range));

  return { stopped: stopped?.n ?? 0, reached: reached?.n ?? 0 };
}

/** Suppressions écrites par un échec transporteur, dont celles du code 30003. */
export async function carrierSuppressionFacts(
  range: DeliverabilityRange,
): Promise<{ total: number; code30003: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      code30003: sql<number>`(count(*) filter (where ${suppressions.note} = 'code 30003'))::int`,
    })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "carrier_error"),
        gte(suppressions.createdAt, range.fromUtc),
        lt(suppressions.createdAt, range.toUtcExclusive),
      ),
    );
  return { total: row?.total ?? 0, code30003: row?.code30003 ?? 0 };
}

// ── E · Fuite de suppression ────────────────────────────────────────────────

/**
 * Un message parti APRÈS que le numéro soit entré en liste de suppression.
 * Tolérance zéro, avec UNE grâce documentée : l'assistant a le droit à un seul
 * tour de clôture après un refus (« bonne journée », puis arrêt), et les
 * bonnes pratiques CTIA §5.1.3 permettent exactement ce message de
 * confirmation. Le deuxième, lui, n'a plus d'excuse.
 */
export async function suppressionLeaks(
  range: DeliverabilityRange,
): Promise<{ samples: LeakSample[]; total: number }> {
  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: conversations.id,
      clientId: conversations.clientId,
      clientPhone: conversations.clientPhone,
      suppressedAt: suppressions.createdAt,
      sentAt: messages.createdAt,
      source: messages.source,
      excerpt: sql<string>`left(${messages.body}, 160)`,
      rn: sql<number>`(row_number() over (
        partition by ${conversations.id} order by ${messages.createdAt}))::int`,
      gapSeconds: sql<number>`(extract(epoch from (${messages.createdAt} - ${suppressions.createdAt})))::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(suppressions, eq(suppressions.phoneE164, conversations.clientPhone))
    .where(
      and(
        eq(messages.direction, "out"),
        isNotNull(messages.twilioSid),
        gte(messages.createdAt, range.fromUtc),
        lt(messages.createdAt, range.toUtcExclusive),
        sql`${messages.createdAt} > ${suppressions.createdAt}`,
      ),
    )
    .orderBy(desc(messages.createdAt));

  const offending = rows.filter((r) => !(r.rn === 1 && r.gapSeconds <= 300));
  return {
    total: offending.length,
    samples: offending.slice(0, 5).map((r) => ({
      messageId: r.messageId,
      conversationId: r.conversationId,
      clientId: r.clientId,
      clientPhone: r.clientPhone,
      suppressedAt: r.suppressedAt,
      sentAt: r.sentAt,
      source: r.source,
      excerpt: r.excerpt,
    })),
  };
}

// ── G · Engagement ──────────────────────────────────────────────────────────

/**
 * L'engagement est le contrepoids du volume : un trafic que personne ne lit
 * finit filtré même sans un mot de travers. Les trois chiffres se lisent
 * ensemble — un bon taux de réponse avec beaucoup de désabonnements n'est pas
 * un succès.
 */
export async function engagementFacts(range: DeliverabilityRange) {
  const [reach] = await db
    .select({
      reached: sql<number>`count(distinct ${messages.conversationId})::int`,
      outbound: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range));

  // Le numérateur DOIT être un sous-ensemble du dénominateur, sinon le taux
  // de réponse dépasse 100 % et, pire, il monte tout seul : un fil ouvert la
  // semaine d'avant qui répond aujourd'hui comptait comme une réponse sans
  // jamais compter comme un envoi. Le taux gonflé n'alarme jamais à tort — il
  // ÉTOUFFE une vraie alerte, ce qui est le mauvais sens pour cet écran.
  // Même garde que `optOutFacts` juste au-dessus.
  const [inbound] = await db
    .select({
      inbound: sql<number>`count(*)::int`,
      // Qualificateur EXPLICITE `messages.conversation_id` : dans la liste des
      // champs d'un select, drizzle rend `${messages.conversationId}` comme
      // « "conversation_id" » tout court — que la sous-requête résout alors sur
      // SA propre table, rendant la condition toujours vraie. Le piège est déjà
      // documenté dans `sms-server/numbers.ts` ; il coûte ici un taux de
      // réponse qui ne descend jamais.
      replied: sql<number>`(count(distinct ${messages.conversationId}) filter (
        where exists (
          select 1 from messages out_m
           where out_m.conversation_id = messages.conversation_id
             and out_m.direction = 'out'
             and out_m.twilio_sid is not null
             and out_m.created_at >= ${ts(range.fromUtc)}
             and out_m.created_at <  ${ts(range.toUtcExclusive)})))::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "in"),
        gte(messages.createdAt, range.fromUtc),
        lt(messages.createdAt, range.toUtcExclusive),
      ),
    );

  // Fils où l'on a parlé quatre fois sans jamais recevoir un mot. C'est le
  // profil que les opérateurs lisent comme du démarchage à froid.
  const [tail] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(
      db
        .select({
          conversationId: messages.conversationId,
          outs: sql<number>`(count(*) filter (where ${messages.direction} = 'out'
            and ${messages.twilioSid} is not null))::int`.as("outs"),
          ins: sql<number>`(count(*) filter (where ${messages.direction} = 'in'))::int`.as("ins"),
        })
        .from(messages)
        .where(
          and(gte(messages.createdAt, range.fromUtc), lt(messages.createdAt, range.toUtcExclusive)),
        )
        .groupBy(messages.conversationId)
        .as("per_conversation"),
    )
    .where(sql`outs >= 4 and ins = 0`);

  return {
    conversationsReached: reach?.reached ?? 0,
    conversationsReplied: inbound?.replied ?? 0,
    outbound: reach?.outbound ?? 0,
    inbound: inbound?.inbound ?? 0,
    unansweredTail: tail?.n ?? 0,
  };
}

// ── M · Réponses hostiles (PROXY de plainte) ────────────────────────────────

/**
 * Ce n'est PAS le taux de plainte, et le texte de l'écran le dit.
 *
 * Un signalement au 7726 part chez l'agrégateur, jamais sur la rangée du
 * message : il est structurellement hors de portée de ce dépôt. Ce qu'on peut
 * voir, c'est quelqu'un qui répond « c'est du spam » ou « arrêtez de
 * m'écrire ». Présenter cette approximation comme la mesure serait pire que
 * l'absence — on croirait surveiller les plaintes.
 *
 * Le tri se fait en TypeScript : le repli d'accents du français vit là (et
 * `unaccent` n'est pas installé). Les entrants sont donc bornés — les réponses
 * hostiles sont courtes, on ne lit que ce qui peut en être une.
 */
const HOSTILE_SCAN_LIMIT = 3000;
const HOSTILE_MAX_LENGTH = 240;

export async function hostileReplyFacts(range: DeliverabilityRange) {
  const rows = await db
    .select({
      body: messages.body,
      conversationId: messages.conversationId,
      clientId: conversations.clientId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direction, "in"),
        gte(messages.createdAt, range.fromUtc),
        lt(messages.createdAt, range.toUtcExclusive),
        sql`length(${messages.body}) <= ${HOSTILE_MAX_LENGTH}`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(HOSTILE_SCAN_LIMIT);

  const hostile = rows.filter((r) => isHostileReply(r.body));
  const samples: EvidenceSample[] = hostile.slice(0, 5).map((r) => ({
    label: stamp(r.createdAt),
    excerpt: r.body.slice(0, 160),
    href: `/clients/${r.clientId}`,
  }));
  return { replies: hostile.length, inboundScanned: rows.length, samples };
}

// ── I · Forme du trafic (rafales) ───────────────────────────────────────────

/**
 * Un envoi régulier et un envoi en rafale peuvent avoir le même total du jour
 * et une réputation opposée. Le rapport p99/médiane par minute est ce qui les
 * distingue : c'est la forme, pas le volume.
 */
export async function burstFacts(range: DeliverabilityRange) {
  const perMinute = db
    .select({
      minute: sql<string>`date_trunc('minute', ${messages.createdAt})`.as("minute"),
      segs: sql<number>`coalesce(sum(${messages.segments}), 0)::int`.as("segs"),
    })
    .from(messages)
    .where(sentPredicate(range))
    .groupBy(sql`1`)
    .as("per_minute");

  const [row] = await db
    .select({
      median: sql<number>`coalesce(percentile_cont(0.5) within group (order by segs), 0)::float8`,
      p99: sql<number>`coalesce(percentile_cont(0.99) within group (order by segs), 0)::float8`,
      peak: sql<number>`coalesce(max(segs), 0)::int`,
      minutes: sql<number>`count(*)::int`,
    })
    .from(perMinute)
    .where(sql`segs > 0`);

  return {
    medianSegments: row?.median ?? 0,
    p99Segments: row?.p99 ?? 0,
    peakSegments: row?.peak ?? 0,
    minutes: row?.minutes ?? 0,
  };
}

// ── J · Cohérence de l'expéditeur ───────────────────────────────────────────

/**
 * Un fil est épinglé à un seul numéro par `conversations_phone_number_uq` :
 * l'essaimage par expéditeur ne peut donc apparaître qu'au niveau du CLIENT,
 * joint depuis deux fils portés par deux numéros. C'est la seule requête qui
 * le montre.
 */
export async function senderInconsistency(range: DeliverabilityRange) {
  const rows = await db
    .select({
      clientId: conversations.clientId,
      clientName: clients.fullName,
      senders: sql<number>`count(distinct ${conversations.smsNumberId})::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .where(sentPredicate(range))
    .groupBy(conversations.clientId, clients.fullName)
    .having(sql`count(distinct ${conversations.smsNumberId}) > 1`)
    .limit(SENDER_SAMPLE_LIMIT);

  // Le compte EXACT, à part. La liste ci-dessus est plafonnée pour ne pas
  // ramener dix mille lignes dans une page ; s'en servir aussi comme valeur de
  // l'indicateur affichait « 50 » comme un total le jour où il y en avait
  // douze mille.
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(
      db
        .select({ clientId: conversations.clientId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(sentPredicate(range))
        .groupBy(conversations.clientId)
        .having(sql`count(distinct ${conversations.smsNumberId}) > 1`)
        .as("multi_sender_clients"),
    );

  return { rows, total: total?.n ?? 0 };
}

// ── K · Heures de politesse ─────────────────────────────────────────────────

/**
 * Compté en heure de TORONTO, et l'écran le dit.
 *
 * La vraie fenêtre est un réglage PAR ASSISTANT, et la fenêtre qui compte
 * légalement est celle du DESTINATAIRE — qu'on ne connaît pas sans résoudre
 * l'indicatif en fuseau, ce qui demanderait une colonne. Mesurer à Toronto et
 * l'écrire est honnête ; mesurer à Toronto en laissant croire que c'est
 * l'heure du client ne le serait pas.
 *
 * Les envois `human` sont exclus : un téléphoniste qui répond à 21 h répond à
 * quelqu'un qui vient d'écrire.
 */
export async function quietHoursFacts(range: DeliverabilityRange) {
  const [row] = await db
    .select({
      automated: sql<number>`(count(*) filter (where ${messages.source} <> 'human'))::int`,
      violations: sql<number>`(count(*) filter (
        where ${messages.source} <> 'human'
          and extract(hour from (${messages.createdAt} at time zone ${TORONTO})) not between 9 and 19))::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range));
  return { violations: row?.violations ?? 0, automated: row?.automated ?? 0 };
}

// ── N · Destinations ────────────────────────────────────────────────────────

/**
 * L'inscription A2P 10DLC se déclenche sur la DESTINATION. Un seul mobile
 * américain dans la liste change la question posée à l'opérateur — et rien
 * d'autre dans ce dépôt ne le lui dirait.
 */
export async function destinationFacts(range: DeliverabilityRange) {
  const rows = await db
    .selectDistinct({ phone: conversations.clientPhone })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sentPredicate(range));

  let usBound = 0;
  for (const row of rows) {
    if (destinationOf(row.phone) === "us") usBound += 1;
  }
  return { total: rows.length, usBound };
}

// ── L · État du moteur ──────────────────────────────────────────────────────

export async function queueFacts(now: Date) {
  const [row] = await db
    .select({
      backlog: sql<number>`count(*)::int`,
      // `.mapWith` et non un `sql<Date>` nu : le client Drizzle remplace le
      // LECTEUR de dates du pilote par l'identité (il décode lui-même les
      // colonnes), si bien qu'une agrégation écrite à la main revient en
      // CHAÎNE. Le type mentirait, et le premier appel à `.getTime()` en aval
      // lèverait — sur un écran de conformité, longtemps après l'écriture.
      oldest: sql`min(${scheduledJobs.runAt})`.mapWith(scheduledJobs.runAt),
    })
    .from(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.type, "send_sms"),
        eq(scheduledJobs.status, "pending"),
        lt(scheduledJobs.runAt, now),
      ),
    );
  return { backlog: row?.backlog ?? 0, oldestPendingAt: row?.oldest ?? null };
}

// ── O · Les premiers messages d'un fil ──────────────────────────────────────

/**
 * L'obligation de s'identifier et d'indiquer comment arrêter porte sur le
 * PREMIER message d'un fil, pas sur chaque réplique. Rappeler « STOP » à
 * chaque tour transformerait une conversation en formulaire — et gonflerait
 * chaque message d'un segment.
 *
 * `distinct on` est du SQL brut : c'est la façon la plus courte en Postgres de
 * prendre une ligne par groupe, et Drizzle ne l'exprime pas.
 */
export async function openerBodies(
  range: DeliverabilityRange,
  limit = 1000,
): Promise<{
  rows: { conversationId: string; clientId: string; body: string; createdAt: Date }[];
  truncated: boolean;
}> {
  /**
   * `not exists` est ce qui fait la différence entre « le premier message du
   * FIL » et « le premier message de la FENÊTRE ».
   *
   * Sans lui, tout fil ouvert avant la fenêtre livrait sa première réplique du
   * moment — une réponse d'agent, qui ne contient évidemment ni marque ni
   * mention d'arrêt. Sur une fenêtre de sept jours, où la plupart des fils
   * actifs sont plus vieux que ça, presque CHAQUE conversation devenait une
   * ouverture non conforme : un constat entièrement faux, sur l'obligation
   * légale la plus sérieuse de l'écran.
   *
   * `order by created_at desc` sur le résultat : quand le plafond coupe, il
   * coupe les fils les plus ANCIENS, pas un échantillon arbitraire d'identifiants.
   */
  /**
   * `db.execute` rend les horodatages en TEXTE, pas en `Date` : le pilote
   * postgres-js voit ses convertisseurs de date remplacés par drizzle, qui
   * mappe lui-même les colonnes — sauf en SQL brut, où il n'y a pas de colonne
   * à mapper. On demande donc à Postgres un ISO 8601 UTC explicite plutôt que
   * de compter sur la tolérance de `new Date()` face au format « 2026-08-23
   * 06:00:00-04 », que rien ne garantit.
   */
  const rows = await db.execute<{
    conversation_id: string;
    client_id: string;
    body: string;
    created_at: string;
  }>(sql`
    select o.conversation_id, o.client_id, o.body,
           to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
      from (
        select distinct on (m.conversation_id)
               m.conversation_id, c.client_id, m.body, m.created_at
          from messages m
          join conversations c on c.id = m.conversation_id
         where m.direction = 'out'
           and m.twilio_sid is not null
           and m.created_at >= ${ts(range.fromUtc)}
           and m.created_at <  ${ts(range.toUtcExclusive)}
           and not exists (
             select 1 from messages earlier
              where earlier.conversation_id = m.conversation_id
                and earlier.direction = 'out'
                and earlier.twilio_sid is not null
                and earlier.created_at < m.created_at)
         order by m.conversation_id, m.created_at
      ) o
     order by o.created_at desc
     limit ${limit + 1}
  `);
  const all = Array.from(rows).map((r) => ({
    conversationId: r.conversation_id,
    clientId: r.client_id,
    body: r.body,
    createdAt: new Date(r.created_at),
  }));
  const truncated = all.length > limit;
  return { rows: truncated ? all.slice(0, limit) : all, truncated };
}
