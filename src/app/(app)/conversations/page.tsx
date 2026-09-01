import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { MessageCircle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ConversationsInbox,
  type BlockedNumber,
  type FailedJob,
  type FailedMessage,
  type InboxRow,
  type QueueItem,
} from "@/components/conversations/conversations-inbox";
import {
  deedOf,
  CONVERSATION_DEEDS,
  UNREACHED_SEND_STATUSES,
  type ConversationDeed,
} from "@/components/conversations/state";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories, clients, users } from "@/db/schema";
import {
  agentEvents,
  assistants,
  campaignEnrollments,
  campaigns,
  conversations,
  messages,
  scheduledJobs,
  suppressions,
} from "@/db/schema-sms";
import { previousOutboundByConversation } from "@/lib/conversations/thread-preview";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requirePerm, withVisibility } from "@/lib/permissions/server";
import { settingsSendGate } from "@/lib/sms-server";
import { resolveSmsMode } from "@/lib/sms/provider";
import { DEFAULT_QUIET_HOURS, isWithinSendWindow } from "@/lib/sms/quiet-hours";

/**
 * Boîte de réception des conversations — ouverte à qui détient
 * `conversations.view`.
 *
 * L'écran répond à une seule question : à quoi dois-je répondre maintenant?
 * D'où le tri par « à traiter » d'abord, et la bande d'état en haut : savoir
 * que les envois sont suspendus AVANT de taper une réponse évite de croire
 * qu'on a répondu.
 *
 * Un fil PARLE d'une fiche : il se cache donc avec elle. Toute requête de cet
 * écran passe par `withVisibility` — la même matrice que les listes de fiches,
 * et non un filtre d'affichage. Une rangée envoyée au navigateur est une
 * rangée fuitée, même si l'écran choisit de ne pas la dessiner.
 *
 * Voir un fil n'est pas le LIRE. La case `visible` dit quelles rangées
 * existent ; ce que chacune emporte se règle case par case — `contact` pour le
 * numéro, `history` pour le dernier message et les actes de l'assistant. Sans
 * cette seconde question, un téléphoniste lisait dans sa propre boîte le
 * numéro et la conversation du client d'un collègue : la fiche est visible
 * (pour ne pas la rappeler), son contenu ne l'est pas.
 *
 * Un fil ARCHIVÉ quitte cette boucle et TOUS les comptes qui en descendent :
 * l'écran ne montre pas ce qu'il ne compte pas, et ne compte pas ce qu'il ne
 * montre pas. Rien n'est détruit — l'onglet « Archivées » les garde entiers, et
 * le prochain message du client ramène le fil ici de lui-même.
 */
/** Combien d'envois perdus la vue « Échecs » dessine — elle DIT ce qu'elle coupe. */
const FAILURES_SHOWN = 100;
/**
 * Même discipline pour les tâches mortes du MOTEUR : la liste est bornée aux
 * plus récentes et le compte réel voyage à part (`jobsTotal`). Une liste qui
 * s'arrête à cent sans le dire jurerait qu'il n'y a jamais eu plus de cent
 * pannes — et c'est précisément le nombre que la bande d'état annonce.
 */
const JOBS_SHOWN = 100;
/**
 * Et pour l'ARCHIVE : un fil rangé ne cesse pas d'exister, il cesse d'être
 * demandé. La vue montre les plus récemment archivés, et le compte réel voyage
 * à part (`archivedTotal`) — une pile qui s'arrête à cent sans le dire ferait
 * croire qu'on a tout retrouvé, et c'est justement là qu'on cherche le fil
 * archivé par erreur.
 */
const ARCHIVED_SHOWN = 100;

export default async function ConversationsPage() {
  const actor = await requirePerm("conversations.view");
  const t = await getTranslations("conversations");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = await getTranslations("clients");

  const lastMessage = db
    .select({
      conversationId: messages.conversationId,
      body: sql<string>`(array_agg(${messages.body} order by ${messages.createdAt} desc))[1]`.as(
        "last_body",
      ),
      // QUI a parlé en dernier : sans ça, « Parfait, je vous confirme jeudi »
      // se lit comme une phrase du client alors que c'est l'assistant — et on
      // ne peut pas trier ce qui attend une réponse de ce qui en a déjà une.
      direction: sql<string>`(array_agg(${messages.direction} order by ${messages.createdAt} desc))[1]`.as(
        "last_direction",
      ),
      source: sql<string>`(array_agg(${messages.source} order by ${messages.createdAt} desc))[1]`.as(
        "last_source",
      ),
      at: sql<Date>`max(${messages.createdAt})`.as("last_at"),
    })
    .from(messages)
    .groupBy(messages.conversationId)
    .as("last_message");

  // Les fils sans aucun message n'ont rien à traiter (ils encombreraient la
  // liste sans jamais rien demander), et ceux dont la fiche échappe à ce regard
  // n'existent pas pour lui — la jointure sur `clients` porte la visibilité.
  //
  // Les fils ARCHIVÉS sortent ICI, dans la condition partagée, et jamais au
  // dessin : tout ce que l'écran annonce à côté de la boucle — la pastille
  // « à traiter », le compte de chaque onglet, l'ordre des cartes — se dérive
  // de ces rangées-là. Les écarter plus loin laisserait des chiffres qui
  // parlent encore de fils que plus personne ne voit, et « Archiver »
  // paraîtrait cassé au moment même où il vient de faire exactement son
  // travail.
  const threadsWhere = await withVisibility(
    actor,
    and(
      isNull(conversations.archivedAt),
      or(eq(conversations.needsAttention, true), isNotNull(lastMessage.at)),
    ),
  );

  // L'archive : la même liste prise par l'autre bout. Aucune condition sur les
  // messages — ce qu'on a rangé doit pouvoir se retrouver, fût-ce un fil resté
  // muet ; c'est la seule vue où il existe encore.
  const archivedWhere = await withVisibility(actor, isNotNull(conversations.archivedAt));

  // Ce qu'on avait envoyé AVANT la dernière réponse du client — le contexte
  // sans lequel « Oui toujours! » ne veut rien dire (voir le module).
  const previousOutbound = previousOutboundByConversation();

  // ── Une carte de la boîte, en colonnes ───────────────────────────────────
  // La boucle et l'archive dessinent la MÊME carte : elles tirent donc la même
  // liste de colonnes, écrite une seule fois. Deux requêtes qui décrivent la
  // même rangée avec deux listes de colonnes finissent par ne plus montrer la
  // même chose selon l'onglet où on la regarde.
  const threadColumns = {
    id: conversations.id,
    clientId: conversations.clientId,
    clientName: clients.fullName,
    clientPhone: conversations.clientPhone,
    needsAttention: conversations.needsAttention,
    attentionReason: conversations.attentionReason,
    aiEnabled: conversations.aiEnabled,
    assignedToId: conversations.assignedToId,
    assignedToName: users.name,
    assistantName: assistants.name,
    lastInboundAt: conversations.lastInboundAt,
    // QUAND le fil a été rangé : c'est ce que la carte archivée date, et la
    // seule chose qui distingue les deux listes une fois dessinées.
    archivedAt: conversations.archivedAt,
    // Le DÉTENTEUR de la fiche : c'est lui, et lui seul, qui décide du
    // compartiment — donc de ce que cette rangée a le droit d'emporter.
    holderId: clients.assignedToId,
    lastBody: lastMessage.body,
    lastDirection: lastMessage.direction,
    lastSource: lastMessage.source,
    lastAt: lastMessage.at,
  };

  /** La requête complète, contexte compris — elle sert aussi de source au type. */
  const threadsWithContext = (where: SQL | undefined, order: SQL[], limit: number) =>
    db
      .select({
        ...threadColumns,
        previousBody: previousOutbound.body,
        previousSource: previousOutbound.source,
      })
      .from(conversations)
      .leftJoin(clients, eq(clients.id, conversations.clientId))
      .leftJoin(users, eq(users.id, conversations.assignedToId))
      .leftJoin(assistants, eq(assistants.id, conversations.activeAssistantId))
      .leftJoin(lastMessage, eq(lastMessage.conversationId, conversations.id))
      .leftJoin(previousOutbound, eq(previousOutbound.conversationId, conversations.id))
      .where(where)
      .orderBy(...order)
      .limit(limit);

  /**
   * La rangée que les deux listes rendent. Le contexte y est déclaré NULLABLE :
   * drizzle type une colonne de sous-requête comme toujours présente, alors que
   * la jointure est GAUCHE — un fil sans message précédent en revient vide, et
   * l'archive n'en demande pas du tout. Mieux vaut le dire ici que le découvrir
   * au dessin.
   */
  type ThreadRow = Omit<
    Awaited<ReturnType<typeof threadsWithContext>>[number],
    "previousBody" | "previousSource"
  > & { previousBody: string | null; previousSource: string | null };

  /**
   * Une liste de fils : `where` la borne, `order` la trie, `limit` la coupe.
   *
   * `context` dit si on paie « ce qu'on avait envoyé avant la réponse » — deux
   * passes groupées de plus sur `messages`, à CHAQUE ouverture de la page. La
   * boucle les paie : c'est là qu'on répond, et « Oui toujours! » ne veut rien
   * dire sans la question qui l'a provoqué. L'archive ne les paie pas : on n'y
   * compose rien, on y cherche un fil à ressortir. Les deux colonnes existent
   * quand même, vides — la carte est la même des deux côtés, elle n'a
   * simplement rien à citer.
   */
  const threadList = async (
    where: SQL | undefined,
    order: SQL[],
    limit: number,
    context: boolean,
  ): Promise<ThreadRow[]> => {
    if (context) return threadsWithContext(where, order, limit);
    const plain = await db
      .select(threadColumns)
      .from(conversations)
      .leftJoin(clients, eq(clients.id, conversations.clientId))
      .leftJoin(users, eq(users.id, conversations.assignedToId))
      .leftJoin(assistants, eq(assistants.id, conversations.activeAssistantId))
      .leftJoin(lastMessage, eq(lastMessage.conversationId, conversations.id))
      .where(where)
      .orderBy(...order)
      .limit(limit);
    return plain.map((r) => ({ ...r, previousBody: null, previousSource: null }));
  };

  // Les deux listes et le COMPTE réel de l'archive en un seul aller-retour : la
  // page en fait déjà beaucoup, et ces trois lectures ne se doivent rien.
  //
  // Le compte est sa propre requête, comme pour les échecs, et il porte la
  // MÊME condition (`archivedWhere`, visibilité comprise, règle 13) : une
  // pastille qui afficherait la longueur de la liste jurerait qu'il n'y a
  // jamais eu plus de cent fils rangés.
  const [rows, archivedRows, [archivedTotalRow]] = await Promise.all([
    threadList(threadsWhere, [desc(conversations.needsAttention), desc(lastMessage.at)], 200, true),
    // Le plus récemment rangé d'abord : ce qu'on vient chercher dans une
    // archive, c'est presque toujours ce qu'on vient d'y mettre par erreur.
    threadList(archivedWhere, [desc(conversations.archivedAt)], ARCHIVED_SHOWN, false),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .leftJoin(clients, eq(clients.id, conversations.clientId))
      .where(archivedWhere),
  ]);

  // ── Ce que chaque rangée a le droit d'emporter ───────────────────────────
  // Le compartiment ne dépend que du DÉTENTEUR de la fiche : on le résout une
  // fois par détenteur et non une fois par ligne — 200 fils ne coûtent donc
  // pas 200 questions de plus à la matrice.
  const { cfg, roleOf } = await loadDirectory();
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  // ── Ce que l'assistant a FAIT sur chaque fil ─────────────────────────────
  // La conclusion de son travail, pas son journal : seuls les outils REUSSIS
  // qui laissent une trace pour le client (rendez-vous, classement,
  // qualification, rappel, note, transfert) — jamais les lectures.
  //
  // « Rendez-vous réservé », « fiche classée » : c'est l'historique de la
  // fiche. On ne le DEMANDE donc que pour les fils dont la case `history` est
  // ouverte — ce qu'on ne charge pas ne peut pas partir dans le HTML.
  //
  // Les fils ARCHIVÉS entrent dans la MÊME question : c'est un seul `in (…)`,
  // donc pas un aller-retour de plus — et une carte archivée sans son
  // « Rendez-vous réservé » laisserait croire qu'il ne s'est rien passé sur ce
  // fil, alors que c'est précisément ce qu'on relit quand on rouvre l'archive.
  const historyIds = [...rows, ...archivedRows]
    .filter((r) => grantsOfHolder(r.holderId).history)
    .map((r) => r.id);
  const deedsByConversation = new Map<string, ConversationDeed[]>();
  if (historyIds.length > 0) {
    const eventRows = await db
      .selectDistinct({
        conversationId: agentEvents.conversationId,
        item: sql<string>`coalesce(${agentEvents.payload}->>'name', ${agentEvents.type})`,
      })
      .from(agentEvents)
      .where(
        and(
          inArray(agentEvents.conversationId, historyIds),
          or(
            and(eq(agentEvents.type, "tool_call"), sql`${agentEvents.payload}->>'ok' = 'true'`),
            inArray(agentEvents.type, ["auto_categorized", "followup_created", "transfer"]),
          ),
        ),
      );
    for (const event of eventRows) {
      const deed = deedOf(event.item);
      if (!deed) continue;
      const list = deedsByConversation.get(event.conversationId) ?? [];
      if (!list.includes(deed)) deedsByConversation.set(event.conversationId, [...list, deed]);
    }
  }
  // L'ordre d'affichage est celui du modèle (le rendez-vous d'abord), pas
  // l'ordre d'arrivée des événements.
  const deedRank = new Map(CONVERSATION_DEEDS.map((d, i) => [d, i]));
  for (const [id, list] of deedsByConversation) {
    deedsByConversation.set(
      id,
      [...list].sort((a, b) => (deedRank.get(a) ?? 0) - (deedRank.get(b) ?? 0)),
    );
  }

  // ── Échecs : les textos qui ne sont PAS arrivés ──────────────────────────
  // Des MESSAGES, pas des fils : trois échecs sur la même fiche sont trois
  // lignes, parce que c'est le nombre d'envois perdus qu'on vient chercher.
  //
  // Pas de garde `admin.settings` ici, contrairement à la file d'envoi : un
  // texto perdu vers SON client est le travail d'un téléphoniste, pas la
  // conduite du moteur — et la pastille « Envoi en échec » lui est déjà visible
  // dans « à traiter ». La visibilité des FICHES borne la liste, comme partout.
  //
  // « Retirer » ÉCARTE l'échec de cette vue — il ne détruit rien : la rangée
  // reste dans le fil du client et dans /admin/deliverability. La condition est
  // donc écrite UNE fois et partagée par la liste et par le compte : deux
  // requêtes qui décrivent le même ensemble avec deux textes différents
  // finissent par diverger, et la pastille annoncerait des échecs que la liste
  // en dessous ne montre plus.
  const failuresWhere = await withVisibility(
    actor,
    and(
      eq(messages.direction, "out"),
      isNull(messages.dismissedAt),
      // Le statut dit l'échec ; `skipReason` dit qu'il n'est jamais parti — un
      // message peut porter le second sans que le premier soit encore écrit
      // (le répartiteur pose la rangée AVANT d'appeler Twilio).
      or(inArray(messages.status, [...UNREACHED_SEND_STATUSES]), isNotNull(messages.skipReason)),
    ),
  );
  const failureRows = await db
    .select({
      id: messages.id,
      clientId: conversations.clientId,
      clientName: clients.fullName,
      clientPhone: conversations.clientPhone,
      holderId: clients.assignedToId,
      at: messages.createdAt,
      body: messages.body,
      status: messages.status,
      errorCode: messages.errorCode,
      skipReason: messages.skipReason,
      source: messages.source,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .where(failuresWhere)
    .orderBy(desc(messages.createdAt))
    .limit(FAILURES_SHOWN);

  // Le COMPTE réel, la liste ne portant que les plus récents : une pastille qui
  // affiche son propre plafond jurerait qu'il n'y a jamais eu plus de cent
  // envois perdus.
  const [failuresTotalRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .where(failuresWhere);

  const failures: FailedMessage[] = failureRows.map((r) => {
    const open = grantsOfHolder(r.holderId);
    return {
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName ?? (open.contact ? r.clientPhone : tAccess("access.masked")),
      at: r.at.toISOString(),
      // Le TEXTE du message est de la conversation : il suit la case `history`,
      // comme le dernier message d'une carte de la boîte.
      body: open.history ? r.body : null,
      historyHidden: !open.history,
      status: r.status,
      errorCode: r.errorCode,
      skipReason: r.skipReason,
      source: r.source,
      // Une rangée d'échec porte maintenant des GESTES, fiche par fiche :
      // réessayer et retirer touchent à ce qu'on envoie à ce client (case
      // `sms`), « Classer » range le pipeline (case `category`). Le serveur
      // revérifie les deux — ceci évite d'offrir un bouton qui répondra
      // « introuvable ».
      smsOpen: open.sms,
      categoryOpen: open.category,
    };
  });

  // ── File d'envoi : qui va recevoir un texto, et quand ────────────────────
  // Trois sources, une seule ligne du temps : les envois déjà écrits qui
  // attendent leur heure (annulables), les réponses que l'assistant est en
  // train de composer, et les barreaux de campagne planifiés — parfois à des
  // jours d'ici (campaign_enrollments.next_touch_at, la vraie source des
  // relances futures : le job n'existe qu'au moment dû).
  // Réservé au droit `admin.settings`, et pas seulement à l'écran : la file
  // d'envoi et la bande d'état exposent la santé du moteur — ce qui attend, ce
  // qui a échoué, combien de numéros se sont désabonnés. C'est la conduite de
  // l'entreprise, pas le travail d'un téléphoniste. On ne les CALCULE donc pas
  // pour lui : une donnée qu'on n'envoie pas ne peut pas fuir par le HTML.
  const canEngine = actor.can("admin.settings");
  // Conduire le moteur n'est pas voir toutes les fiches : un rôle peut recevoir
  // `admin.settings` sans ouvrir le compartiment de l'administrateur. La file
  // d'envoi reste donc bornée à la même visibilité que la liste — elle nomme
  // des fiches et montre le TEXTE des messages à venir.
  const touchesWhere = canEngine
    ? await withVisibility(
        actor,
        and(
          inArray(campaignEnrollments.status, ["pending", "active"]),
          isNotNull(campaignEnrollments.nextTouchAt),
        ),
      )
    : undefined;
  const [sendJobs, turnJobs, upcomingTouches, failedJobRows] = canEngine
    ? await Promise.all([
    db
      .select({ id: scheduledJobs.id, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.type, "send_sms"), eq(scheduledJobs.status, "pending")))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(100),
    db
      .select({ id: scheduledJobs.id, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.type, "agent_turn"), eq(scheduledJobs.status, "pending")))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(100),
    db
      .select({
        id: campaignEnrollments.id,
        nextTouchAt: campaignEnrollments.nextTouchAt,
        step: campaignEnrollments.step,
        campaignName: campaigns.name,
        clientId: clients.id,
        clientName: clients.fullName,
      })
      .from(campaignEnrollments)
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .innerJoin(clients, eq(clients.id, campaignEnrollments.clientId))
      .where(touchesWhere)
      .orderBy(asc(campaignEnrollments.nextTouchAt))
      .limit(100),
    // ── Ce que le moteur a définitivement ABANDONNÉ ──────────────────────
    // La bande d'état annonce ce nombre depuis toujours (« 175 tâches en
    // échec ») et il ne menait NULLE PART : un chiffre sans écran derrière
    // ne se vérifie pas, il s'endure. La liste part d'ici, dans le même
    // aller-retour que la file d'envoi — la page en fait déjà beaucoup.
    //
    // Pas de jointure sur les fiches : une tâche est une rangée du MOTEUR.
    // Un balayage d'enregistrement ou un barreau de campagne ne cite aucun
    // fil, et une panne qu'on cacherait faute de fiche resterait une panne.
    //
    // Tri par heure DUE décroissante : à l'abandon définitif, `failJob` ne
    // retouche pas `run_at`, qui porte donc l'heure de la dernière
    // tentative — « les échecs les plus récents d'abord », et l'index
    // (statut, heure due) rend la coupe à cent gratuite.
    db
      .select({
        id: scheduledJobs.id,
        type: scheduledJobs.type,
        at: scheduledJobs.createdAt,
        runAt: scheduledJobs.runAt,
        attempts: scheduledJobs.attempts,
        lastError: scheduledJobs.lastError,
        payload: scheduledJobs.payload,
      })
      .from(scheduledJobs)
      .where(eq(scheduledJobs.status, "failed"))
      .orderBy(desc(scheduledJobs.runAt))
      .limit(JOBS_SHOWN),
      ])
    : [[], [], [], []];

  // Les jobs ne portent qu'un conversationId : résoudre le client une fois —
  // ceux qui attendent leur tour comme ceux qui ont échoué, en une requête.
  const jobConversationIds = [
    ...new Set(
      [...sendJobs, ...turnJobs, ...failedJobRows]
        .map((j) => (j.payload as { conversationId?: string }).conversationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const jobThreads = jobConversationIds.length
    ? await db
        .select({
          id: conversations.id,
          clientId: conversations.clientId,
          clientName: clients.fullName,
          clientPhone: conversations.clientPhone,
          holderId: clients.assignedToId,
        })
        .from(conversations)
        .leftJoin(clients, eq(clients.id, conversations.clientId))
        .where(await withVisibility(actor, inArray(conversations.id, jobConversationIds)))
    : [];
  const threadById = new Map(jobThreads.map((c) => [c.id, c]));

  const queue: QueueItem[] = [
    // Un job dont le fil n'est pas revenu de la requête ci-dessus porte sur une
    // fiche invisible : il DISPARAÎT au lieu de s'afficher anonyme, parce que
    // la carte montre le texte du message et pas seulement un nom.
    ...sendJobs.flatMap((job): QueueItem[] => {
      const payload = job.payload as { conversationId?: string; body?: string; source?: string };
      const thread = payload.conversationId ? threadById.get(payload.conversationId) : undefined;
      if (!thread) return [];
      // Conduire le moteur n'ouvre pas les fiches des autres : le nom de
      // secours et le TEXTE du message à venir suivent les mêmes cases que la
      // boîte — `contact` pour le numéro, `history` pour la conversation.
      const open = grantsOfHolder(thread.holderId);
      return [
        {
          id: job.id,
          kind: "send",
          clientId: thread.clientId,
          clientName:
            thread.clientName ?? (open.contact ? thread.clientPhone : tAccess("access.masked")),
          when: job.runAt.toISOString(),
          body: open.history ? (payload.body ?? null) : null,
          source: payload.source ?? null,
          campaignName: null,
          step: null,
          jobId: job.id,
        },
      ];
    }),
    ...turnJobs.flatMap((job): QueueItem[] => {
      const payload = job.payload as { conversationId?: string };
      const thread = payload.conversationId ? threadById.get(payload.conversationId) : undefined;
      if (!thread) return [];
      return [
        {
          id: job.id,
          kind: "turn",
          clientId: thread.clientId,
          clientName: thread.clientName ?? thread.clientPhone,
          when: job.runAt.toISOString(),
          body: null,
          source: null,
          campaignName: null,
          step: null,
          jobId: null,
        },
      ];
    }),
    ...upcomingTouches.map(
      (touch): QueueItem => ({
        id: touch.id,
        kind: "touch",
        clientId: touch.clientId,
        clientName: touch.clientName,
        when: (touch.nextTouchAt as Date).toISOString(),
        body: null,
        source: null,
        campaignName: touch.campaignName,
        // `step` est l'index du PROCHAIN barreau — l'humain compte à partir de 1.
        step: touch.step + 1,
        jobId: null,
      }),
    ),
  ].sort((a, b) => Date.parse(a.when) - Date.parse(b.when));

  // Une tâche morte ne DISPARAÎT pas quand sa fiche échappe à ce regard — au
  // contraire de la file d'envoi juste au-dessus, qui montre le texte du
  // message et n'a donc rien à dire sans lui. Ici le compte annoncé par la
  // bande d'état est celui de TOUTES les tâches en échec : une liste qui en
  // escamoterait la moitié sous ce total dirait le contraire de ce qu'elle
  // montre (règle 13). La rangée reste donc, et c'est le NOM qui se ferme.
  const jobs: FailedJob[] = failedJobRows.map((job): FailedJob => {
    // `agent_turn` et `send_sms` portent le fil dans leur charge utile ;
    // `campaign_touch` (une inscription) et `call_transcript` (un appel) n'en
    // portent pas — ces tâches-là ne nomment personne, et c'est correct.
    const wanted = (job.payload as { conversationId?: string }).conversationId ?? null;
    // `threadById` est BORNÉ par la visibilité (requête ci-dessus) : un fil
    // demandé qui n'en revient pas est un fil que ce regard ne tient pas.
    const thread = wanted ? threadById.get(wanted) : undefined;
    const open = thread ? grantsOfHolder(thread.holderId) : null;
    return {
      id: job.id,
      type: job.type,
      at: job.at.toISOString(),
      runAt: job.runAt.toISOString(),
      attempts: job.attempts,
      // La trace du moteur, telle quelle : traduire un message d'erreur, c'est
      // le rendre incherchable le jour où on le cherche.
      lastError: job.lastError,
      // Ni identifiant de fil ni identifiant de fiche quand la fiche est
      // fermée : une poignée suffit à ouvrir ce que la matrice a clos.
      conversationId: thread?.id ?? null,
      clientId: thread?.clientId ?? null,
      // Le nom : celui de la fiche quand ce regard la tient, le mot qui dit le
      // masque quand un fil existe mais lui échappe, RIEN quand la tâche ne
      // parle d'aucun fil — « masqué » sur une tâche sans fiche inventerait un
      // secret là où il n'y a personne.
      clientName: thread
        ? (thread.clientName ?? (open?.contact ? thread.clientPhone : tAccess("access.masked")))
        : wanted
          ? tAccess("access.masked")
          : null,
      // « Réessayer » ne vaut que pour un tour d'agent dont le fil existe ET
      // que ce regard a le droit de conduire (case `sms`, comme la vue des
      // échecs d'envoi). Le reste offrirait un bouton qui répond « introuvable ».
      retryable: job.type === "agent_turn" && thread !== undefined && (open?.sms ?? false),
    };
  });

  // ── Bande d'état ─────────────────────────────────────────────────────────
  const [sendingAllowed, queueCounts, blockedRows] = canEngine
    ? await Promise.all([
    // On réutilise la PORTE d'envoi plutôt que de relire la rangée ici : elle
    // échoue fermé sur un réglage illisible, et réécrire cette règle à côté la
    // condamnerait à diverger — l'écran dirait « actif » pendant que le moteur
    // refuse d'envoyer.
    settingsSendGate.isSendingAllowed(),
    db
      .select({
        pending: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'pending'))::int`,
        failed: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'failed'))::int`,
      })
      .from(scheduledJobs),
    // ── Les lignes FERMÉES : ce CRM ne textera plus ces numéros ───────────
    // La bande d'état comptait ces rangées (« 23 désabonnés ») sans que rien
    // ne les montre. Or elles ne disent pas toutes la même chose : cinq
    // viennent d'un STOP du contact, dix-huit d'un refus d'opérateur que
    // NOTRE moteur a transformé en fermeture définitive. Un compte qui mêle
    // les deux fait passer une décision de machine pour une décision humaine.
    //
    // Ni borne ni compte séparé, et c'est délibéré : `suppressions` a une
    // rangée PAR NUMÉRO (le téléphone est la clé primaire), donc la table est
    // petite par construction et cette lecture EST le compte de la bande.
    // Le jour où il faudrait la borner, ce compte devrait redevenir sa propre
    // requête — sinon la pastille afficherait son propre plafond.
    //
    // Jointure GAUCHE sur le numéro (E.164 des deux côtés, règle 3) : une
    // suppression survit à la fiche (elle est justement là pour ça), et un
    // numéro fermé sans fiche reste une ligne fermée qu'il faut voir.
    db
      .select({
        phone: suppressions.phoneE164,
        reason: suppressions.reason,
        note: suppressions.note,
        at: suppressions.createdAt,
        clientId: clients.id,
        clientName: clients.fullName,
        holderId: clients.assignedToId,
      })
      .from(suppressions)
      .leftJoin(clients, eq(clients.phone, suppressions.phoneE164))
      .orderBy(desc(suppressions.createdAt)),
      ])
    : [false, [], []];

  // Le compartiment décide ligne à ligne, comme au journal d'appels : un
  // numéro que porte une fiche est une COORDONNÉE de cette fiche et se ferme
  // avec elle ; un numéro que plus aucune fiche ne porte n'a rien à protéger.
  // Confondre les deux ferait de cet écran un oracle — « ce numéro est-il chez
  // vous? » se lit alors dans le masque lui-même.
  const seenNumbers = new Set<string>();
  const blocked: BlockedNumber[] = [];
  for (const row of blockedRows) {
    // Deux fiches peuvent porter le même numéro (un ménage, une réimportation)
    // et la jointure rendrait alors deux rangées : la ligne fermée est UNE.
    if (seenNumbers.has(row.phone)) continue;
    seenNumbers.add(row.phone);
    const open = row.clientId ? grantsOfHolder(row.holderId) : null;
    const named = open?.visible ?? false;
    const contact = open ? open.visible && open.contact : true;
    blocked.push({
      phone: contact ? row.phone : tAccess("access.masked"),
      phoneHidden: !contact,
      reason: row.reason,
      // Le détail écrit à la fermeture (« code 30003 ») : la trace du moteur,
      // jamais traduite — c'est elle qui dit QUI a fermé la ligne.
      note: row.note,
      at: row.at.toISOString(),
      clientId: named ? row.clientId : null,
      clientName: named ? row.clientName : null,
      // Un STOP ne se lève JAMAIS d'ici (règle 12) : seul un START du contact
      // rouvre sa ligne, et la rangée le DIT au lieu d'offrir un bouton mort.
      // Le reste — un refus d'opérateur, une fermeture à la main — a été
      // décidé de ce côté-ci et peut donc être défait de ce côté-ci.
      //
      // Numéro masqué, pas de « Rétablir » non plus : le geste se nomme par le
      // numéro, et un bouton sans rien à nommer ne peut que répondre
      // « introuvable ». Le serveur revérifie les deux, comme toujours.
      liftable: row.reason !== "sms_stop" && contact,
    });
  }

  const locale = await getLocale();
  // Les catégories du pipeline — pour classer une fiche sans quitter la boîte.
  // Ranger une fiche n'est pas un geste d'admin, c'est le travail
  // d'après-conversation : le droit `clients.category` seul en décide.
  const pipeline = await db.query.categories.findMany({
    orderBy: [asc(categories.sortOrder), asc(categories.id)],
  });
  const categoryOptions = pipeline.map((c) => ({
    id: c.id,
    label: locale === "en" ? c.nameEn : c.nameFr,
  }));

  // La MÊME carte des deux côtés : la boucle et l'archive ne se distinguent que
  // par `archivedAt`. Une rangée traduite deux fois finirait par se fermer d'un
  // côté et pas de l'autre — l'archive deviendrait la porte de service.
  const toInboxRow = (r: ThreadRow): InboxRow => {
    const open = grantsOfHolder(r.holderId);
    return {
      id: r.id,
      clientId: r.clientId,
      // Le numéro sert de nom de secours quand la fiche n'en a pas — mais un
      // secours qui DIT le numéro n'en est pas un ici : sans la case
      // `contact`, la carte porte le mot qui le dit.
      clientName: r.clientName ?? (open.contact ? r.clientPhone : tAccess("access.masked")),
      clientPhone: open.contact ? r.clientPhone : null,
      contactHidden: !open.contact,
      needsAttention: r.needsAttention,
      attentionReason: r.attentionReason,
      aiEnabled: r.aiEnabled,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedToName,
      assistantName: r.assistantName,
      // Fil fermé : ni le dernier message, ni les actes de l'assistant. Reste
      // ce qu'il faut pour que la rangée EXISTE — un nom, un état, une heure.
      did: open.history ? (deedsByConversation.get(r.id) ?? []) : [],
      lastBody: open.history ? (r.lastBody ?? null) : null,
      // Le message précédent est de la CONVERSATION : il suit la case
      // `history`, exactement comme le dernier. Ce qu'on n'envoie pas ne peut
      // pas fuir par le HTML.
      previousBody: open.history ? (r.previousBody ?? null) : null,
      previousSource: open.history ? (r.previousSource ?? null) : null,
      historyHidden: !open.history,
      lastDirection: r.lastDirection === "in" || r.lastDirection === "out" ? r.lastDirection : null,
      lastSource: r.lastSource ?? null,
      lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
      // Rangé ou non — un ÉTAT du fil, comme « à traiter », et pas un secret :
      // il ne se ferme avec aucune case. C'est lui qui permet à l'écran de
      // dater la carte archivée et d'offrir « Désarchiver » là, et seulement là.
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      // Les gestes de la carte, fiche par fiche : conduire l'assistant change
      // ce que le robot ENVERRA à ce client (case `sms`), ranger la fiche
      // touche au pipeline (case `category`). Le serveur revérifie les deux —
      // ceci évite d'offrir un bouton qui répondra « introuvable ».
      smsOpen: open.sms,
      categoryOpen: open.category,
    };
  };

  const items: InboxRow[] = rows.map(toInboxRow);
  const archived: InboxRow[] = archivedRows.map(toInboxRow);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 pb-safe md:p-6">
      <PageHeader
        icon={<MessageCircle />}
        title={t("inbox.title")}
        subtitle={t("inbox.subtitle")}
      />
      <ConversationsInbox
        rows={items}
        queue={queue}
        failures={failures}
        failuresTotal={failuresTotalRow?.n ?? failures.length}
        archived={archived}
        // Combien de fils sont rangés EN TOUT — même discipline que
        // `failuresTotal` : la liste s'arrête aux plus récents, le compte dit
        // ce qu'elle coupe. Sans lui, l'archive se lirait comme complète.
        archivedTotal={archivedTotalRow?.n ?? archived.length}
        jobs={jobs}
        // Le MÊME compte que la bande d'état affiche : il est déjà calculé
        // pour elle, et deux requêtes qui comptent la même chose finissent par
        // ne plus dire pareil — c'est alors la pastille qu'on croit.
        jobsTotal={queueCounts[0]?.failed ?? jobs.length}
        blocked={blocked}
        currentUserId={actor.user.id}
        // Ce que ce regard peut FAIRE ici. L'écran s'en sert pour ne pas
        // promettre un geste que le serveur refusera — chaque action revérifie
        // de son côté, l'affichage n'est jamais la garde.
        abilities={{
          engine: canEngine,
          control: actor.can("conversations.control"),
          // Brancher un robot sur un fil est son propre droit : un rôle peut
          // reprendre la main partout sans choisir QUI parle à sa place.
          assistant: actor.can("conversations.assistant"),
          reply: actor.can("conversations.reply"),
          classify: actor.can("clients.category"),
          // Le rejeu après panne passe par une route d'API gardée par
          // `admin.settings` : l'offrir sans ce droit serait offrir un échec.
          replay: actor.can("admin.settings"),
        }}
        categories={categoryOptions}
        health={
          canEngine
            ? {
                killSwitch: !sendingAllowed,
                mode: resolveSmsMode(process.env),
                sendWindowOpen: isWithinSendWindow(new Date(), DEFAULT_QUIET_HOURS),
                queued: queueCounts[0]?.pending ?? 0,
                failed: queueCounts[0]?.failed ?? 0,
                // La liste des lignes fermées n'est pas bornée : elle EST le
                // compte. Une pastille et sa liste tirées de deux lectures
                // divergent tôt ou tard, et l'écran contredit alors le chiffre
                // sur lequel on venait de cliquer.
                suppressed: blocked.length,
              }
            : null
        }
      />
    </div>
  );
}

