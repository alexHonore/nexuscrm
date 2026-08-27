import "server-only";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  campaigns,
  conversations,
  smsNumbers,
  suppressions,
} from "@/db/schema-sms";
import { resolveQuietHours } from "@/lib/assistants/quiet-hours";
import { LIVE_CONVERSATION_WINDOW_MS, targetsCategory } from "@/lib/campaigns/eligibility";
import {
  LADDER_EXHAUSTED_REASON,
  enrollmentReopenable,
  type ReopenRefusal,
} from "@/lib/campaigns/enrollment-status";
import { MAX_REOPEN, planReopen } from "@/lib/campaigns/reopen";
import { campaignRowToConfig, type CampaignConfig } from "@/lib/campaigns/schema";
import { settingsSendGate } from "@/lib/sms-server";
import type { QuietHours } from "@/lib/sms/quiet-hours";
import { outboundCountToday } from "@/lib/sms-server/daily-cap";

/**
 * RELANCE des inscriptions terminées d'une campagne.
 *
 * Le problème qu'elle résout : une échelle qui grandit ne rattrape personne.
 * Les fiches qui ont fini l'ancienne échelle sont closes (« Terminée »), et
 * rien ne les rouvre — ni l'inscription de l'audience, qui exclut quiconque est
 * DÉJÀ inscrit (`audience.ts`), ni l'index unique `(campagne, client)`, qui
 * refuse une deuxième inscription. Ajouter des barreaux ne profitait donc
 * qu'aux nouveaux venus, en silence.
 *
 * Ce module remet ces inscriptions en vol AU BARREAU OÙ ELLES SE SONT
 * ARRÊTÉES. Il ne rembobine jamais `step` : les barreaux déjà tracés ne
 * repartent pas, et un `step` rembobiné se ferait de toute façon refuser
 * « déjà envoyé » — un refus qui REPOUSSE d'une heure au lieu de clore, donc
 * une inscription qui tournerait en rond pour toujours.
 *
 * **Rien n'est écrit quand la relance est refusée.** C'est la propriété
 * centrale. La tentation est de rouvrir et de laisser le moteur trancher au
 * prochain barreau — sauf que `handleRefusal` ne se contente pas de refuser :
 * il RÉÉCRIT le statut. Un numéro désabonné avant la clôture deviendrait un
 * « arrêt » daté d'aujourd'hui, et le taux d'arrêts — la mesure que tout ce
 * dépôt protège — grimperait pour un refus vieux de trois mois. Une réponse
 * hors fenêtre d'attribution serait recréditée à une variante, déplaçant le
 * résultat d'un test A/B terminé. On vérifie donc AVANT, et un refus laisse la
 * ligne exactement telle qu'elle était.
 */

/** Ce qui empêche TOUTE relance sur cette campagne — évalué une fois. */
export type ReopenGateError =
  | "campaign_not_found"
  /** Interrupteur d'arrêt global levé : mettre du travail en file irait contre. */
  | "kill_switch"
  | "campaign_not_active"
  /** Fenêtre de vie de la campagne dépassée (ou pas encore ouverte). */
  | "outside_window"
  | "empty_ladder"
  /** Aucun numéro expéditeur actif — chaque barreau se repousserait d'une heure, sans fin. */
  | "no_sender";

/** Ce qui écarte UNE inscription. */
export type ReopenRowRefusal =
  | ReopenRefusal
  | "not_found"
  | "no_phone"
  | "suppressed"
  | "do_not_call"
  | "replied_since"
  | "live_conversation"
  | "ai_paused"
  | "left_audience"
  /**
   * Le prochain barreau laisse l'assistant rédiger, et celui qui prendrait CE
   * fil n'est pas prêt. Un refus par LIGNE et non une porte de campagne : le
   * fil garde l'assistant qu'un transfert ou un humain lui a épinglé, et c'est
   * lui que l'envoi ira chercher — pas celui de la campagne.
   */
  | "assistant_inactive"
  /** La ligne a bougé entre la vérification et l'écriture. */
  | "conflict";

export interface ReopenPlanned {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  /** Barreau qui repartira — celui où l'inscription s'était arrêtée. */
  step: number;
  dueAt: Date;
}

export interface ReopenReport {
  ok: true;
  /** Vrai : rien n'a été écrit, c'est l'aperçu. */
  dryRun: boolean;
  planned: ReopenPlanned[];
  reopened: number;
  refused: Partial<Record<ReopenRowRefusal, number>>;
  /** Candidats laissés pour un prochain geste (plafond du lot). */
  remaining: number;
}

export type ReopenResult = ReopenReport | { ok: false; error: ReopenGateError };

export interface ReopenOptions {
  /** Restreint le geste à ces inscriptions. Absent = toute la campagne. */
  enrollmentIds?: string[];
  /** Aperçu : calcule tout, n'écrit rien. */
  dryRun?: boolean;
  now?: Date;
  limit?: number;
  /** Injecté par les tests pour que l'étalement soit reproductible. */
  random?: () => number;
}

type CandidateRow = {
  id: string;
  clientId: string;
  conversationId: string | null;
  status: string;
  step: number;
  enrolledAt: Date;
  lastTouchAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  clientName: string;
  phone: string;
  doNotCall: boolean;
  categoryId: number | null;
};

const CANDIDATE_FIELDS = {
  id: campaignEnrollments.id,
  clientId: campaignEnrollments.clientId,
  conversationId: campaignEnrollments.conversationId,
  status: campaignEnrollments.status,
  step: campaignEnrollments.step,
  enrolledAt: campaignEnrollments.enrolledAt,
  lastTouchAt: campaignEnrollments.lastTouchAt,
  endedAt: campaignEnrollments.endedAt,
  endReason: campaignEnrollments.endReason,
  clientName: clients.fullName,
  phone: clients.phone,
  doNotCall: clients.doNotCall,
  categoryId: clients.categoryId,
};

/**
 * Le prédicat des candidats, en SQL — la MÊME question que le prédicat pur
 * `enrollmentReopenable`, posée à la base pour ne pas rapatrier dix mille
 * lignes closes afin d'en garder trois.
 */
function candidateWhere(campaignId: string, ladderLength: number) {
  return and(
    eq(campaignEnrollments.campaignId, campaignId),
    eq(campaignEnrollments.status, "completed"),
    eq(campaignEnrollments.endReason, LADDER_EXHAUSTED_REASON),
    sql`${campaignEnrollments.endedAt} is not null`,
    lt(campaignEnrollments.step, ladderLength),
  )!;
}

/**
 * Combien d'inscriptions terminées attendent les nouveaux barreaux ?
 *
 * Compte les CANDIDATS (le prédicat pur), pas les relançables : les refus
 * individuels — désabonnement, réponse tardive, fil repris par un humain — se
 * découvrent à l'aperçu, qui les nomme un par un. Annoncer d'emblée un chiffre
 * déjà filtré coûterait la même requête complète à chaque affichage de page.
 */
export async function countReopenCandidates(
  campaignId: string,
  ladderLength: number,
): Promise<number> {
  if (ladderLength === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignEnrollments)
    .where(candidateWhere(campaignId, ladderLength));
  return row?.n ?? 0;
}

/**
 * Clé de tri TOTALE. Le plus longtemps sans nouvelles d'abord : une relance
 * commence par ceux qui attendent depuis le plus longtemps. `last_touch_at`
 * peut être nul, la pagination non — d'où le `coalesce`, qui range ces
 * anomalies en tête plutôt que de casser le curseur.
 */
const SORT_KEY = sql`coalesce(${campaignEnrollments.lastTouchAt}, timestamptz 'epoch')`;
const sortKeyOf = (row: CandidateRow): Date => row.lastTouchAt ?? new Date(0);

/**
 * Plafond de BALAYAGE, distinct du plafond du geste.
 *
 * Le plafond du geste (`MAX_REOPEN`) borne ce qu'on RELANCE ; celui-ci borne ce
 * qu'on EXAMINE pour y arriver. Sans cette distinction, les refus permanents
 * — désabonnés, « ne pas appeler », gens qui ont répondu — occupaient les
 * premières places du tri (leur `last_touch_at` ne bouge jamais, et un refus
 * n'écrit rien), consommaient tout le lot, et la campagne finissait par ne plus
 * rien pouvoir relancer du tout : chaque clic rechargeait le même mur.
 */
const SCAN_CAP = MAX_REOPEN * 10;

function candidatePage(
  campaignId: string,
  ladderLength: number,
  cursor: { key: Date; id: string } | null,
  pageSize: number,
) {
  return db
    .select(CANDIDATE_FIELDS)
    .from(campaignEnrollments)
    .innerJoin(clients, eq(clients.id, campaignEnrollments.clientId))
    .where(
      and(
        candidateWhere(campaignId, ladderLength),
        // Pagination par clé, pas par OFFSET : le lot précédent a pu changer de
        // statut entre deux pages, et un OFFSET sauterait alors des lignes.
        cursor
          ? sql`(${SORT_KEY}, ${campaignEnrollments.id}) > (${cursor.key}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(SORT_KEY, campaignEnrollments.id)
    .limit(pageSize);
}

async function loadByIds(campaignId: string, ids: string[]): Promise<CandidateRow[]> {
  if (ids.length === 0) return [];
  // Portée explicite : on charge les lignes SANS le prédicat, pour pouvoir dire
  // à l'administrateur POURQUOI celle qu'il a désignée ne se relance pas.
  // L'appartenance à la campagne est vérifiée ici — un identifiant d'une autre
  // campagne est « introuvable », jamais une action croisée.
  return db
    .select(CANDIDATE_FIELDS)
    .from(campaignEnrollments)
    .innerJoin(clients, eq(clients.id, campaignEnrollments.clientId))
    .where(
      and(eq(campaignEnrollments.campaignId, campaignId), inArray(campaignEnrollments.id, ids)),
    );
}

type ThreadRow = {
  id: string;
  clientPhone: string;
  smsNumberId: string;
  lastInboundAt: Date | null;
  aiEnabled: boolean;
  activeAssistantId: string | null;
};

/** Une inscription qui a passé tous les refus, avec ce qu'on a appris d'elle. */
interface ScreenedRow {
  row: CandidateRow;
  /** L'assistant qui prendra ce barreau — la MÊME résolution que `runTouch`. */
  assistantId: string | null;
}

/**
 * Passe une page de candidats au crible. Écrit zéro ligne : elle compte des
 * refus et rend les survivants.
 */
async function screen(
  rows: CandidateRow[],
  ctx: {
    config: CampaignConfig;
    campaignAssistantId: string | null;
    senderId: string;
    now: Date;
    deny: (refusal: ReopenRowRefusal) => void;
  },
): Promise<ScreenedRow[]> {
  if (rows.length === 0) return [];
  const { config, deny, now } = ctx;

  const phones = [...new Set(rows.map((r) => r.phone).filter((p) => p.trim() !== ""))];
  // Les fils sont cherchés par téléphone ET par identifiant. `conversations.
  // client_phone` est figé à la création et ne suit pas une correction du
  // numéro de la fiche : sans la seconde clé, le fil de l'inscription devenait
  // invisible et les garde-fous « a répondu » / « repris par un humain »
  // sautaient exactement sur les fiches dont quelqu'un a corrigé le numéro.
  const convIds = [...new Set(rows.map((r) => r.conversationId).filter((id) => id !== null))];

  const [suppressedSet, threads] = await Promise.all([
    phones.length
      ? db
          .select({ phone: suppressions.phoneE164 })
          .from(suppressions)
          .where(inArray(suppressions.phoneE164, phones))
          .then((s) => new Set(s.map((r) => r.phone)))
      : Promise.resolve(new Set<string>()),
    phones.length || convIds.length
      ? (db
          .select({
            id: conversations.id,
            clientPhone: conversations.clientPhone,
            smsNumberId: conversations.smsNumberId,
            lastInboundAt: conversations.lastInboundAt,
            aiEnabled: conversations.aiEnabled,
            activeAssistantId: conversations.activeAssistantId,
          })
          .from(conversations)
          .where(
            or(
              phones.length ? inArray(conversations.clientPhone, phones) : undefined,
              convIds.length ? inArray(conversations.id, convIds) : undefined,
            ),
          ) as Promise<ThreadRow[]>)
      : Promise.resolve([] as ThreadRow[]),
  ]);

  const threadById = new Map(threads.map((t) => [t.id, t]));
  const threadByLine = new Map(threads.map((t) => [`${t.clientPhone}|${t.smsNumberId}`, t]));
  /** Dernier entrant sur N'IMPORTE QUELLE ligne : c'est la personne qui est occupée. */
  const lastInboundByPhone = new Map<string, Date>();
  for (const t of threads) {
    if (t.lastInboundAt === null) continue;
    const known = lastInboundByPhone.get(t.clientPhone);
    if (known === undefined || t.lastInboundAt > known) {
      lastInboundByPhone.set(t.clientPhone, t.lastInboundAt);
    }
  }

  const liveSince = now.getTime() - LIVE_CONVERSATION_WINDOW_MS;
  const kept: ScreenedRow[] = [];

  for (const row of rows) {
    const decision = enrollmentReopenable(row, { ladderLength: config.ladder.length });
    if (!decision.allowed) {
      deny(decision.refusal);
      continue;
    }
    if (row.phone.trim() === "") {
      deny("no_phone");
      continue;
    }
    // L'ordre suit la gravité, comme `canSendTouch` : un refus EXPRIMÉ passe
    // avant tout le reste. Un désabonnement postérieur à la clôture n'a pas
    // touché à l'inscription — `markEnrollmentsStopped` ne ferme que les
    // inscriptions en vol — mais il est bien inscrit au registre, et c'est ici
    // qu'il doit être vu.
    if (suppressedSet.has(row.phone)) {
      deny("suppressed");
      continue;
    }
    // Volontairement PLUS STRICT que le moteur, qui subordonne ce refus à
    // `audience.excludeDoNotCall` : relancer est une décision prise
    // AUJOURD'HUI sur une fiche dormante, pas la suite d'une décision prise à
    // l'inscription, et « ne pas appeler » est absolu.
    if (row.doNotCall) {
      deny("do_not_call");
      continue;
    }

    const thread =
      (row.conversationId !== null ? threadById.get(row.conversationId) : undefined) ??
      threadByLine.get(`${row.phone}|${ctx.senderId}`);
    // Un fil retrouvé par identifiant porte peut-être un ancien numéro : son
    // entrant ne serait alors indexé sous aucun téléphone connu. On prend le
    // plus récent des deux.
    const lastInbound = [lastInboundByPhone.get(row.phone) ?? null, thread?.lastInboundAt ?? null]
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null);

    // Une réponse arrivée APRÈS notre dernier barreau a rendu la main à
    // l'assistant. Elle n'a pas toujours reclassé l'inscription : passé la
    // fenêtre d'attribution (30 jours), le fil est resté « Terminée » avec un
    // entrant plus récent que le dernier envoi.
    if (thread?.lastInboundAt != null && row.lastTouchAt !== null && thread.lastInboundAt > row.lastTouchAt) {
      deny("replied_since");
      continue;
    }
    if (lastInbound !== null && lastInbound.getTime() >= liveSince) {
      deny("live_conversation");
      continue;
    }
    if (thread !== undefined && !thread.aiEnabled) {
      deny("ai_paused");
      continue;
    }
    // La catégorie SEULE, comme le moteur (`targetsCategory`). Rejouer toute
    // l'audience serait tentant — l'inscription dort depuis des mois — mais
    // `notContactedForDays` se compare à `clients.lastContactedAt`, que
    // l'envoi d'un SMS met à jour : une campagne de réactivation exclurait
    // alors exactement les gens à qui elle vient d'écrire, et la relance ne
    // rouvrirait plus jamais personne.
    if (!targetsCategory(config, row.categoryId)) {
      deny("left_audience");
      continue;
    }

    // La MÊME résolution que `runTouch` : l'assistant épinglé sur le fil
    // d'abord, celui de la campagne ensuite.
    kept.push({ row, assistantId: thread?.activeAssistantId ?? ctx.campaignAssistantId });
  }

  return withReadyAssistants(kept, ctx.config, deny);
}

/**
 * Écarte les lignes dont le prochain barreau doit être RÉDIGÉ par un assistant
 * qui n'est pas en état d'écrire.
 *
 * Sans ce refus, chacune de ces lignes se ferait repousser d'une heure par
 * l'envoi, éternellement : un job par heure et par inscription, aucun message,
 * et rien à l'écran pour le dire.
 */
async function withReadyAssistants(
  kept: ScreenedRow[],
  config: CampaignConfig,
  deny: (refusal: ReopenRowRefusal) => void,
): Promise<ScreenedRow[]> {
  const needsAgent = (s: ScreenedRow) => config.ladder[s.row.step]?.body == null;
  const waiting = kept.filter(needsAgent);
  // Aucun barreau à rédiger dans cette page : rien à vérifier, rien à charger.
  if (waiting.length === 0) return kept;

  const ids = [...new Set(waiting.map((s) => s.assistantId).filter((id) => id !== null))];
  const ready = new Set(
    ids.length
      ? await db
          .select({ id: assistants.id, status: assistants.status, compiled: assistants.compiledPrompt })
          .from(assistants)
          .where(inArray(assistants.id, ids))
          .then((rows) =>
            rows.filter((a) => a.status === "active" && a.compiled).map((a) => a.id),
          )
      : [],
  );

  return kept.filter((s) => {
    if (!needsAgent(s)) return true;
    // Aucun assistant désigné : le barreau serait réveillé sans personne pour
    // l'écrire. C'est une configuration incomplète, pas une décision.
    if (s.assistantId === null || !ready.has(s.assistantId)) {
      deny("assistant_inactive");
      return false;
    }
    return true;
  });
}

/**
 * Relance — aperçu ou pour de vrai.
 *
 * L'aperçu (`dryRun`) et le geste passent par le MÊME chemin, aux mêmes
 * requêtes : si les deux comptaient différemment, l'administrateur
 * confirmerait 640 et en verrait partir 700.
 */
export async function reopenEnrollments(
  campaignId: string,
  opts: ReopenOptions = {},
): Promise<ReopenResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? MAX_REOPEN, MAX_REOPEN);
  const refused: Partial<Record<ReopenRowRefusal, number>> = {};
  const deny = (row: ReopenRowRefusal) => {
    refused[row] = (refused[row] ?? 0) + 1;
  };

  const campaignRow = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaignRow) return { ok: false, error: "campaign_not_found" };
  const config = campaignRowToConfig(campaignRow);

  // ── Portes de campagne ────────────────────────────────────────────────────
  // Elles abattent le geste entier, parce qu'aucune ne dépend de la personne :
  // les évaluer ligne par ligne rendrait un rapport de 500 fois le même refus.
  if (!(await settingsSendGate.isSendingAllowed())) return { ok: false, error: "kill_switch" };
  if (campaignRow.status !== "active") return { ok: false, error: "campaign_not_active" };
  if (config.ladder.length === 0) return { ok: false, error: "empty_ladder" };
  // Volontairement PLUS STRICT que le moteur : `endsAt` borne les INSCRIPTIONS
  // et rien ne le relit au moment d'envoyer un barreau. Mais déterrer des
  // inscriptions dormantes dans une campagne dont la fenêtre s'est refermée
  // n'est pas la continuation d'un envoi en cours — c'est une décision prise
  // aujourd'hui, contre une date que l'administrateur a lui-même posée. Il la
  // repousse, ou il l'efface.
  if (config.startsAt !== null && now < config.startsAt) return { ok: false, error: "outside_window" };
  if (config.endsAt !== null && now >= config.endsAt) return { ok: false, error: "outside_window" };

  // Le numéro expéditeur, résolu comme à l'envoi d'un barreau : celui épinglé
  // sur la campagne s'il est actif, sinon le premier actif.
  const sender = campaignRow.smsNumberId
    ? await db.query.smsNumbers.findFirst({
        where: and(eq(smsNumbers.id, campaignRow.smsNumberId), eq(smsNumbers.active, true)),
      })
    : await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) });
  if (!sender) return { ok: false, error: "no_sender" };

  const screenCtx = {
    config,
    campaignAssistantId: campaignRow.assistantId,
    senderId: sender.id,
    now,
    deny,
  };
  const eligible: ScreenedRow[] = [];
  let remaining = 0;

  if (opts.enrollmentIds !== undefined) {
    const rows = await loadByIds(campaignId, opts.enrollmentIds);
    const found = new Set(rows.map((r) => r.id));
    // Un identifiant désigné qui n'existe pas (ou pas dans cette campagne) est
    // un refus comme un autre : il doit apparaître au rapport, pas disparaître.
    const missing = opts.enrollmentIds.filter((id) => !found.has(id)).length;
    if (missing > 0) refused.not_found = missing;
    eligible.push(...(await screen(rows, screenCtx)));
  } else {
    // Balayage PAGINÉ : le plafond du geste borne les inscriptions relancées,
    // pas les lignes examinées. Trancher l'inverse — la première page de
    // candidats, refus compris — laissait les refus permanents (désabonnés,
    // « ne pas appeler », gens qui ont répondu) squatter la tête du tri : leur
    // clé de tri ne bouge jamais, un refus n'écrit rien, et au bout de
    // quelques centaines la campagne ne pouvait plus rien relancer du tout.
    const total = await countReopenCandidates(campaignId, config.ladder.length);
    let cursor: { key: Date; id: string } | null = null;
    let scanned = 0;
    while (eligible.length < limit && scanned < SCAN_CAP) {
      const page = await candidatePage(campaignId, config.ladder.length, cursor, limit);
      if (page.length === 0) break;
      scanned += page.length;
      const last = page[page.length - 1];
      cursor = { key: sortKeyOf(last), id: last.id };
      eligible.push(...(await screen(page, screenCtx)));
      if (page.length < limit) break;
    }
    // Ce qui dépasse le plafond du geste n'est pas refusé : il attend le clic
    // suivant, et le rapport le dit.
    const overflow = eligible.splice(limit).length;
    remaining = Math.max(0, total - scanned) + overflow;
  }

  // Les heures de travail sont celles de l'assistant qui prendra CHAQUE fil —
  // la même résolution que l'envoi. Une seule fenêtre pour tout le lot
  // replierait sur la même ouverture tous les fils dont l'assistant travaille
  // à d'autres heures, et l'étalement disparaîtrait précisément là.
  const windows = new Map<string | null, QuietHours>();
  for (const id of new Set(eligible.map((s) => s.assistantId))) {
    windows.set(id, await resolveQuietHours(id));
  }
  const fallback = windows.get(campaignRow.assistantId) ?? (await resolveQuietHours(campaignRow.assistantId));

  const slots = planReopen(
    eligible.map((s) => ({
      id: s.row.id,
      step: s.row.step,
      enrolledAt: s.row.enrolledAt,
      lastTouchAt: s.row.lastTouchAt,
      quietHours: windows.get(s.assistantId),
    })),
    {
      ladder: config.ladder,
      quietHours: fallback,
      dailyCap: sender.dailyCap,
      sentToday: await outboundCountToday(sender.id, now),
      now,
      random: opts.random,
    },
  );
  const byId = new Map(eligible.map((s) => [s.row.id, s.row]));
  const planned: ReopenPlanned[] = slots.map((slot) => {
    const row = byId.get(slot.enrollmentId)!;
    return {
      enrollmentId: slot.enrollmentId,
      clientId: row.clientId,
      clientName: row.clientName,
      step: row.step,
      dueAt: slot.dueAt,
    };
  });

  if (opts.dryRun === true) {
    return { ok: true, dryRun: true, planned, reopened: 0, refused, remaining };
  }

  // ── Écriture ──────────────────────────────────────────────────────────────
  // Le `where` REPREND le prédicat au lieu de viser l'identifiant seul : si un
  // cycle de dispatch, ou un second onglet, a fait bouger la ligne entre la
  // vérification et ici, zéro rangée est mise à jour et on le dit. C'est aussi
  // ce qui rend un double-clic inoffensif.
  const written: ReopenPlanned[] = [];
  for (const slot of planned) {
    const [updated] = await db
      .update(campaignEnrollments)
      .set({
        status: "active",
        // `end_reason` et `ended_at` repartent à zéro : sans ça, la colonne
        // « Terminé » de l'écran continuerait d'annoncer « Échelle terminée »
        // sur une inscription qui vient de repartir.
        endReason: null,
        endedAt: null,
        nextTouchAt: slot.dueAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(campaignEnrollments.id, slot.enrollmentId),
          eq(campaignEnrollments.campaignId, campaignId),
          eq(campaignEnrollments.status, "completed"),
          eq(campaignEnrollments.endReason, LADDER_EXHAUSTED_REASON),
          eq(campaignEnrollments.step, slot.step),
        ),
      )
      .returning({ id: campaignEnrollments.id });
    if (updated) written.push(slot);
    else deny("conflict");
  }

  return { ok: true, dryRun: false, planned: written, reopened: written.length, refused, remaining };
}
