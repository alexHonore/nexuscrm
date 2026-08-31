import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MessageCircle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ConversationsInbox,
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
 */
/** Combien d'envois perdus la vue « Échecs » dessine — elle DIT ce qu'elle coupe. */
const FAILURES_SHOWN = 100;

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
  const threadsWhere = await withVisibility(
    actor,
    or(eq(conversations.needsAttention, true), isNotNull(lastMessage.at)),
  );

  // Ce qu'on avait envoyé AVANT la dernière réponse du client — le contexte
  // sans lequel « Oui toujours! » ne veut rien dire (voir le module).
  const previousOutbound = previousOutboundByConversation();

  const rows = await db
    .select({
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
      // Le DÉTENTEUR de la fiche : c'est lui, et lui seul, qui décide du
      // compartiment — donc de ce que cette rangée a le droit d'emporter.
      holderId: clients.assignedToId,
      lastBody: lastMessage.body,
      lastDirection: lastMessage.direction,
      lastSource: lastMessage.source,
      lastAt: lastMessage.at,
      previousBody: previousOutbound.body,
      previousSource: previousOutbound.source,
    })
    .from(conversations)
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .leftJoin(users, eq(users.id, conversations.assignedToId))
    .leftJoin(assistants, eq(assistants.id, conversations.activeAssistantId))
    .leftJoin(lastMessage, eq(lastMessage.conversationId, conversations.id))
    .leftJoin(previousOutbound, eq(previousOutbound.conversationId, conversations.id))
    .where(threadsWhere)
    .orderBy(desc(conversations.needsAttention), desc(lastMessage.at))
    .limit(200);

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
  const historyIds = rows.filter((r) => grantsOfHolder(r.holderId).history).map((r) => r.id);
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
  const failuresWhere = await withVisibility(
    actor,
    and(
      eq(messages.direction, "out"),
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
  const [sendJobs, turnJobs, upcomingTouches] = canEngine
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
      ])
    : [[], [], []];

  // Les jobs ne portent qu'un conversationId : résoudre le client une fois.
  const jobConversationIds = [
    ...new Set(
      [...sendJobs, ...turnJobs]
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

  // ── Bande d'état ─────────────────────────────────────────────────────────
  const [sendingAllowed, queueCounts, suppressedCount] = canEngine
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
    db.select({ n: sql<number>`count(*)::int` }).from(suppressions),
      ])
    : [false, [], []];

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

  const items: InboxRow[] = rows.map((r) => {
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
      // Les gestes de la carte, fiche par fiche : conduire l'assistant change
      // ce que le robot ENVERRA à ce client (case `sms`), ranger la fiche
      // touche au pipeline (case `category`). Le serveur revérifie les deux —
      // ceci évite d'offrir un bouton qui répondra « introuvable ».
      smsOpen: open.sms,
      categoryOpen: open.category,
    };
  });

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
                suppressed: suppressedCount[0]?.n ?? 0,
              }
            : null
        }
      />
    </div>
  );
}

