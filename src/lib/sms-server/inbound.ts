import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, conversations, messages, smsNumbers, suppressions } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { clientPhoneMatch } from "@/lib/webhooks/client-match";
import { markEnrollmentsReplied, markEnrollmentsStopped } from "@/lib/campaigns-server/inbound";
import { detectOptOut } from "@/lib/sms/optout";
import { analyzeSms } from "@/lib/sms/segments";
import { enqueueJob } from "@/lib/jobs/queue";
import { notifyHumans } from "@/lib/sms-server/notify";

/**
 * Traitement d'UN SMS entrant — le cœur du webhook /api/webhooks/twilio/inbound,
 * extrait pour être aussi appelable HORS requête : la réconciliation REST
 * (lib/jobs/reconcile) rejoue par ici les messages que Twilio n'a pas pu nous
 * livrer (webhook en erreur, code 11200) — sans cette voie, une réponse de
 * client tombée pendant une panne de webhook était perdue pour toujours.
 *
 * Ordre imposé : l'opt-out (STOP/ARRÊT…) est traité AVANT tout le reste — la
 * suppression est par numéro et doit tenir même sans fiche client. Ensuite :
 * correspondance client par les 10 derniers chiffres (jamais de création
 * automatique), ligne SMS auto-enregistrée si le DID est inconnu (un texto
 * entrant ne doit pas être perdu), conversation upsertée et marquée « à
 * traiter », rangée `messages` idempotente sur MessageSid (Twilio relivre
 * parfois, et la réconciliation repasse sur les mêmes sids).
 *
 * Toutes les écritures sont idempotentes ; une vraie erreur BD REMONTE en
 * exception — le webhook la traduit en 500 (Twilio retente), la réconciliation
 * la journalise et réessaie au prochain cycle. Pour que cette relivraison serve
 * à quelque chose, la rangée `messages`, le marquage du fil et le tour d'agent
 * sont validés ENSEMBLE : un échec entre les deux ne laisse jamais un texto
 * enregistré mais jamais signalé ni répondu.
 */

/** Fenetre de debounce d'une rafale de SMS entrants. */
const AGENT_TURN_DEBOUNCE_MS = 10_000;

export interface InboundSmsInput {
  messageSid: string;
  /** Numéros bruts tels que reçus — normalisés ici. */
  from: string;
  to: string;
  body: string;
  /**
   * Quand le SMS a réellement été reçu. Un backfill le date de la réception
   * Twilio, pas du rejeu — le fil reste chronologique. Défaut : maintenant.
   */
  receivedAt?: Date;
  /**
   * false = pas de tour d'agent (backfill d'un message trop vieux : répondre
   * automatiquement trois jours plus tard ferait plus de mal que de bien —
   * un humain est notifié à la place).
   */
  allowAgentTurn?: boolean;
}

export type InboundSmsResult =
  /** Numéros inexploitables — tracé, rien d'écrit. */
  | { outcome: "invalid_phone" }
  /** Aucune fiche cliente ne correspond — tracé, rien d'écrit. */
  | { outcome: "unmatched" }
  | {
      outcome: "processed";
      /** false = relivraison d'un sid déjà en base (aucune écriture refaite). */
      inserted: boolean;
      /** true = un tour d'agent a été mis en file (l'appelant peut « kicker »). */
      agentTurnQueued: boolean;
      conversationId: string;
    };

export async function processInboundSms(input: InboundSmsInput): Promise<InboundSmsResult> {
  const { messageSid, body } = input;
  const allowAgentTurn = input.allowAgentTurn ?? true;

  const from = normalizePhone(input.from);
  const to = normalizePhone(input.to);
  // Numéros inexploitables : on trace et l'appelant décide de la réponse — un
  // statut d'erreur ferait retenter Twilio avec la même charge inutilisable.
  if (!from || !to) {
    await logAudit({
      userId: null,
      action: "sms.inbound_invalid",
      entity: "message",
      detail: { messageSid },
    });
    return { outcome: "invalid_phone" };
  }

  const now = new Date();
  const receivedAt = input.receivedAt ?? now;

  // ── Opt-out AVANT tout : la suppression est par numéro, elle vaut même sans
  // fiche client et doit survivre à toute erreur plus bas. ──
  const optOut = detectOptOut(body);
  if (optOut.optOut) {
    await db
      .insert(suppressions)
      .values({ phoneE164: from, reason: "sms_stop", note: optOut.keyword })
      .onConflictDoNothing();
  }

  // ── Correspondance client (E.164 exact, sinon 10 derniers chiffres — jamais
  // moins —, principal ET secondaire) ; jamais de création automatique depuis
  // un SMS entrant. ──
  const phoneMatch = clientPhoneMatch(from);
  const client = await db.query.clients.findFirst({
    where: phoneMatch.where,
    orderBy: phoneMatch.orderBy,
    columns: { id: true, fullName: true, assignedToId: true },
  });
  if (!client) {
    await logAudit({
      userId: null,
      action: "sms.inbound_unmatched",
      entity: "message",
      detail: {
        from: `…${from.slice(-4)}`,
        messageSid,
        ...(optOut.optOut ? { optOut: true } : {}),
      },
    });
    return { outcome: "unmatched" };
  }

  if (optOut.optOut) {
    // La suppression du numéro est écrite plus haut, AVANT même d'avoir
    // rattaché une fiche : c'est elle qui arrête tout. Ici, on ne fait que
    // journaliser le refus contre la personne.
    await logAudit({
      userId: null,
      action: "sms.optout",
      entity: "client",
      entityId: client.id,
      detail: { keyword: optOut.keyword, messageSid },
    });
  }

  // ── Ligne SMS destinataire — auto-enregistrée si le DID est inconnu : un
  // texto entrant vers un numéro non répertorié ne doit pas être perdu. ──
  let smsNumber = await db.query.smsNumbers.findFirst({
    where: eq(smsNumbers.e164, to),
    columns: { id: true },
  });
  if (!smsNumber) {
    const [inserted] = await db
      .insert(smsNumbers)
      .values({
        e164: to,
        label: "auto (webhook entrant)",
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
      })
      .onConflictDoNothing()
      .returning({ id: smsNumbers.id });
    smsNumber =
      inserted ??
      (await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.e164, to), columns: { id: true } }));
  }
  if (!smsNumber) throw new Error(`sms_numbers upsert failed for ${to}`);

  // ── Conversation upsertée sur (clientPhone, smsNumberId), puis marquée « à
  // traiter ». ──
  await db
    .insert(conversations)
    .values({ clientId: client.id, clientPhone: from, smsNumberId: smsNumber.id })
    .onConflictDoNothing();
  let conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.clientPhone, from), eq(conversations.smsNumberId, smsNumber.id)),
  });
  if (!conversation) throw new Error(`conversations upsert failed for ${messageSid}`);

  // Fil sans assistant : le numéro peut en désigner un par défaut. Sans ça,
  // quelqu'un qui écrit au numéro de lui-même n'avait jamais de réponse IA —
  // seul un barreau de campagne savait confier un fil.
  if (conversation.activeAssistantId === null && !optOut.optOut) {
    const numberRow = await db.query.smsNumbers.findFirst({
      where: eq(smsNumbers.id, smsNumber.id),
      columns: { defaultAssistantId: true },
    });
    if (numberRow?.defaultAssistantId) {
      const candidate = await db.query.assistants.findFirst({
        where: eq(assistants.id, numberRow.defaultAssistantId),
        columns: { id: true, status: true, compiledPrompt: true, version: true },
      });
      if (candidate && candidate.status === "active" && candidate.compiledPrompt) {
        await db
          .update(conversations)
          .set({ activeAssistantId: candidate.id, activeAssistantVersion: candidate.version })
          .where(and(eq(conversations.id, conversation.id), isNull(conversations.activeAssistantId)));
        conversation = { ...conversation, activeAssistantId: candidate.id };
      }
    }
  }

  // Les humains sont prévenus quand c'est À EUX de répondre : pas
  // d'assistant, IA en pause, désabonnement — ou message rejoué trop vieux
  // pour une réponse automatique. Quand l'assistant va répondre, c'est lui
  // qui prévient en cas de passage à l'humain, de blocage ou de panne —
  // sinon chaque texto réveillait tout le monde pour rien et l'inbox ne
  // voulait plus rien dire.
  const aiWillHandle =
    !optOut.optOut &&
    conversation.aiEnabled &&
    conversation.activeAssistantId !== null &&
    allowAgentTurn;

  // ── Rangée du message — idempotente sur MessageSid : une relivraison Twilio
  // produit exactement UNE rangée (et aucune seconde notification). ──
  // Rangée, marquage « à traiter » et tour d'agent vivent ou meurent ENSEMBLE :
  // écrits séparément, un pépin après l'insertion laissait le texto en base
  // mais jamais signalé ni répondu — la relivraison Twilio (500 → retente)
  // butait sur le conflit de MessageSid et sautait tout le reste. Ici, un échec
  // annule aussi la rangée, et la relivraison refait tout.
  const analysis = analyzeSms(body);
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        direction: "in",
        body,
        twilioSid: messageSid,
        status: "received",
        source: "human",
        segments: analysis.segments,
        encoding: analysis.encoding,
        createdAt: receivedAt,
      })
      .onConflictDoNothing({ target: messages.twilioSid })
      .returning({ id: messages.id });
    if (rows.length === 0) return false;

    // Marquage « à traiter » seulement quand la rangée est nouvelle : une
    // relivraison Twilio ne doit pas re-signaler une conversation qu'un humain
    // vient de traiter.
    await tx
      .update(conversations)
      .set({
        // Jamais en arrière : un backfill qui rejoue une réponse d'avant-hier
        // ne doit pas « rajeunir » le fil dans l'autre sens — l'ordre de
        // l'inbox et la garde « a répondu depuis le dernier barreau »
        // (campaigns-server/touch.ts) lisent cette colonne.
        lastInboundAt: sql`greatest(coalesce(${conversations.lastInboundAt}, ${receivedAt.toISOString()}::timestamptz), ${receivedAt.toISOString()}::timestamptz)`,
        needsAttention: true,
        attentionReason: optOut.optOut ? "optout" : "inbound",
        // Un STOP met aussi l'IA en pause sur ce fil : aucun tour ne doit
        // plus s'y déclencher, et le fil le dit.
        ...(optOut.optOut ? { aiEnabled: false, pauseReason: "optout" } : {}),
      })
      .where(eq(conversations.id, conversation.id));

    // -- Tour d'agent, debounce --------------------------------------------
    // La cle de dedoublonnage `turn:<conversation>` fait que trois SMS en
    // quatre secondes REPOUSSENT le meme job au lieu d'en creer trois : une
    // rafale = une seule reponse. Les 10 s laissent le temps a la suite d'une
    // pensee d'arriver. Un fil mis en pause par un humain n'en programme pas :
    // le runtime sortirait de toute facon, autant ne pas creer le job.
    if (aiWillHandle) {
      await enqueueJob(
        {
          type: "agent_turn",
          runAt: new Date(now.getTime() + AGENT_TURN_DEBOUNCE_MS),
          payload: { conversationId: conversation.id },
          dedupeKey: `turn:${conversation.id}`,
        },
        tx,
      );
    }
    return true;
  });

  if (inserted) {
    // Après validation : ce qui suit ne conditionne ni la rangée, ni le
    // marquage, ni le tour — et se rattrape tout seul (le prochain barreau lit
    // `lastInboundAt` pour clore une inscription répondue ; un STOP est déjà
    // dans `suppressions`). Un échec ici est journalisé, pas remonté : un 500
    // ferait retenter Twilio sur un MessageSid déjà en base, donc sans effet.
    const afterCommit = async (step: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "sms.inbound_after_commit_failed",
            step,
            conversationId: conversation.id,
            messageSid,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    };

    // Les inscriptions de campagne sont réglées TOUT DE SUITE, pas au prochain
    // barreau. Une échelle qui se termine avant que la personne réponde
    // resterait « completed » et sa réponse ne compterait dans aucune variante :
    // le taux de réponse d'un test A/B serait sous-estimé exactement là où on
    // compare. Un désabonnement, lui, arrête TOUTES ses inscriptions — le refus
    // porte sur le numéro, pas sur une campagne.
    await afterCommit("enrollments", () =>
      optOut.optOut
        ? markEnrollmentsStopped(client.id, receivedAt)
        : markEnrollmentsReplied(conversation.id, receivedAt),
    );

    if (!aiWillHandle) {
      await afterCommit("notify", () =>
        notifyHumans({
          conversationId: conversation.id,
          clientId: client.id,
          kind: optOut.optOut ? "stopped" : "inbound",
          reason: optOut.optOut ? "désabonnement" : "",
        }),
      );
    }
  }

  return {
    outcome: "processed",
    inserted,
    agentTurnQueued: inserted && aiWillHandle,
    conversationId: conversation.id,
  };
}
