"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  EyeOffIcon,
  MessageCircleIcon,
  MoonIcon,
  PencilLineIcon,
  PowerOffIcon,
  RotateCcwIcon,
  SunIcon,
  TagIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignConversationAction,
  cancelQueuedSmsAction,
  classifyConversationClientAction,
  closeConversationAction,
  closeHeldConversationsAction,
  handBackToAiAction,
  markConversationHandledAction,
  retryAiTurnAction,
  setConversationAiAction,
} from "@/app/(app)/conversations/actions";
import {
  ATTENTION_KIND_LOOK,
  ATTENTION_LOOK,
  CONVERSATION_STATE_LOOK,
  QUEUE_KIND_LOOK,
  TOOL_LOOK,
  LookGlyph,
  LookIcon,
  lookTint,
  type Look,
} from "@/components/look";
import {
  attentionKindOf,
  conversationStateOf,
  HUMAN_CLOSED_REASON,
  type ConversationDeed,
  type ConversationState,
} from "@/components/conversations/state";
import { RelativeTime } from "@/components/relative-time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { emitDataChange, useDataChange, useVisiblePolling } from "@/lib/live";
import { cn } from "@/lib/utils";

export type InboxRow = {
  id: string;
  clientId: string | null;
  clientName: string;
  /**
   * Le numéro du fil — `null` quand la case `contact` de la fiche est fermée.
   * Ce qui ne doit pas se voir ne s'ENVOIE pas : une rangée partie au
   * navigateur est une rangée lue, même si aucune carte ne la dessine.
   */
  clientPhone: string | null;
  /** Coordonnées fermées sur cette fiche — la carte porte la pastille « Masqué ». */
  contactHidden?: boolean;
  /** Fil fermé : ni dernier message, ni actes de l'assistant, sur cette fiche. */
  historyHidden?: boolean;
  /**
   * Cases de CETTE fiche pour ce regard (le serveur revérifie les deux) :
   * `sms` commande l'assistant sur ce fil — reprendre, rendre, réessayer,
   * marquer traité, s'attribuer —, `category` range la fiche. Absentes =
   * ouvertes, pour ne pas fermer une carte construite sans ces champs.
   */
  smsOpen?: boolean;
  categoryOpen?: boolean;
  needsAttention: boolean;
  attentionReason: string | null;
  aiEnabled: boolean;
  assignedToId: string | null;
  assignedToName: string | null;
  /** Nom de l'assistant qui tient le fil — null si un humain répond. */
  assistantName: string | null;
  /** Ce que l'assistant a FAIT (rendez-vous, classement, rappel…) — sa conclusion visible. */
  did: ConversationDeed[];
  lastBody: string | null;
  /**
   * Ce que NOUS avions envoyé juste avant la dernière réponse du client — la
   * question dont on lisait la réponse seule.
   *
   * Optionnel, comme les cases arrivées après coup : un producteur écrit avant
   * ce champ continue de compiler, et il compile du bon côté — non dit vaut
   * « pas de contexte », donc la ligne ne s'affiche pas. Absent aussi quand la
   * case `history` de la fiche est fermée.
   */
  previousBody?: string | null;
  /** opener | ladder | agent | human | system — qui avait écrit ce message-là. */
  previousSource?: string | null;
  /** QUI a parlé en dernier : sans ça, impossible de savoir si on attend le client ou s'il nous attend. */
  lastDirection: "in" | "out" | null;
  lastSource: string | null;
  lastAt: string | null;
};

/**
 * Une entrée de la FILE D'ENVOI — un texto à venir, sous l'une de ses trois
 * formes : un envoi déjà écrit qui attend son heure (`send`, annulable), une
 * réponse que l'assistant compose (`turn`), un barreau de campagne planifié
 * (`touch`).
 */
export type QueueItem = {
  id: string;
  kind: "send" | "turn" | "touch";
  clientId: string | null;
  clientName: string;
  /** ISO — quand ça part. */
  when: string;
  /** Le texte, quand il existe déjà (envois en file seulement). */
  body: string | null;
  /** opener | ladder | agent | human | system — pour les envois en file. */
  source: string | null;
  campaignName: string | null;
  /** Numéro HUMAIN du barreau (1-based) — relances de campagne seulement. */
  step: number | null;
  /** Job annulable tant qu'il est en file — envois seulement. */
  jobId: string | null;
};

/**
 * Un texto SORTANT qui n'a pas atteint le client — la matière de la vue
 * « Échecs ».
 *
 * C'est une ligne de MESSAGE, pas de fil : le même client peut en compter
 * trois, et regrouper par fil cacherait justement ce qu'on vient voir. La
 * raison est toujours dite — refus de l'opérateur (`errorCode`), ou message
 * jamais parti (`skipReason`) : « mis en file » puis plus rien est la pire
 * réponse qu'on puisse faire à un téléphoniste.
 */
export type FailedMessage = {
  id: string;
  clientId: string | null;
  clientName: string;
  /** ISO — quand l'envoi a été tenté. */
  at: string;
  /** Le texte — `null` quand la case `history` est fermée sur cette fiche. */
  body: string | null;
  /** Fil fermé sur cette fiche : le texte n'est même pas parti au navigateur. */
  historyHidden?: boolean;
  /** failed | undelivered | skipped | unknown — vocabulaire `thread.status.*`. */
  status: string | null;
  /** Code Twilio (30007 « filtré par l'opérateur », 21610 « désabonné »…). */
  errorCode: number | null;
  /** Pourquoi il n'est jamais PARTI (kill_switch, suppressed, invalid_to…). */
  skipReason: string | null;
  /** opener | ladder | agent | human | system */
  source: string | null;
};

export type EngineHealth = {
  killSwitch: boolean;
  mode: "live" | "sandbox" | "dry_run";
  sendWindowOpen: boolean;
  queued: number;
  failed: number;
  suppressed: number;
};

/**
 * Les SIX vues (demandes d'Alex, 2026-08-25/26, 2026-08-30) :
 *
 *  · « À traiter » — tout ce qui repose sur un humain : les fils qui
 *    réclament une décision ET ceux qu'un humain tient déjà en main.
 *  · « En attente du client » — l'assistant a écrit, la réponse n'est pas
 *    arrivée. Rien à faire, mais on veut le VOIR.
 *  · « File d'envoi » — qui va recevoir un texto, et quand : envois écrits
 *    en attente de leur heure, réponses en préparation, relances planifiées.
 *  · « Échecs » — les textos qui ne sont PAS arrivés. Seule vue faite de
 *    messages et non de fils : trois échecs sur la même fiche sont trois
 *    lignes, parce que c'est le nombre d'envois perdus qu'on vient chercher.
 *  · « Refus » — les non explicites, en deux sections : les DÉSABONNÉS (STOP,
 *    la porte fermée par la loi) et les refus de vive voix, qui ne sont pas
 *    la même chose et n'appellent pas les mêmes gestes.
 *  · « Toutes » — chaque fil, RANGÉ par situation, avec un en-tête par
 *    groupe — pas une pile plate à déchiffrer.
 */
type Tab = "attention" | "waiting" | "queue" | "failed" | "refused" | "all";
const TABS: Tab[] = ["attention", "waiting", "queue", "failed", "refused", "all"];

/**
 * Les vues faites de MESSAGES et non de fils : « les miennes » (qui filtre sur
 * le titulaire d'un fil) n'y veut rien dire, et un bouton qui ne fait rien est
 * pire qu'un bouton absent.
 */
const THREADLESS_TABS: Tab[] = ["queue", "failed"];

/**
 * Ce que CE regard peut faire ici — un droit par geste, plus deux rôles en dur.
 *
 * Ces booléens ne GARDENT rien : chaque action serveur revérifie le droit ET la
 * fiche derrière le fil. Ils évitent seulement d'offrir un bouton dont on sait
 * qu'il sera refusé — une promesse qu'on ne tient pas est pire qu'un bouton
 * absent.
 */
export type InboxAbilities = {
  /**
   * File d'envoi et bande d'état : la santé du MOTEUR — ce qui attend, ce qui a
   * échoué, combien de numéros se sont désabonnés. La conduite de l'entreprise
   * (`admin.settings`), pas le travail d'un téléphoniste. Le serveur ne calcule
   * même pas ces données pour les autres (voir la page) ; ici, ça évite en plus
   * un onglet qui s'ouvrirait sur le vide.
   */
  engine: boolean;
  /** Reprendre, rendre à l'IA, réessayer, marquer traité, s'attribuer un fil. */
  control: boolean;
  /**
   * CHOISIR l'assistant qui tient un fil — l'y brancher, en changer, l'en
   * retirer (`conversations.assistant`).
   *
   * Distinct de `control` : rendre un fil à l'assistant DÉJÀ branché est le
   * geste du téléphoniste, décider LEQUEL parle au nom de l'entreprise ne
   * l'est pas.
   *
   * Optionnel — seul de la liste — parce qu'il arrive après elle : un
   * producteur écrit avant ce droit continue de compiler, et il compile du
   * bon côté. Non dit vaut FAUX (le sélecteur disparaît), jamais vrai : la
   * seule direction dans laquelle un oubli soit sans danger.
   */
  assistant?: boolean;
  /** Écrire — et donc RETENIR un envoi encore en file (`conversations.reply`). */
  reply: boolean;
  /** Ranger la fiche sans quitter la boîte (`clients.category`). */
  classify: boolean;
  /** Rejeu après panne — route d'API réservée à l'administrateur. */
  replay: boolean;
};

const NO_ABILITIES: InboxAbilities = {
  engine: false,
  control: false,
  assistant: false,
  reply: false,
  classify: false,
  replay: false,
};

/**
 * Quels états chaque vue montre. `all` les montre tous, en sections ; `queue`
 * et `failed` ont leur propre matière (des envois, pas des fils).
 */
const TAB_STATES: Record<Exclude<Tab, "all" | "queue" | "failed">, ConversationState[]> = {
  attention: ["attention", "human"],
  waiting: ["ai"],
  refused: ["refused"],
};

/** L'ordre des sections de « Toutes » : l'urgent d'abord, le clos à la fin. */
const ALL_SECTIONS: ConversationState[] = ["attention", "human", "ai", "refused", "concluded"];

const POLL_MS = 25_000;

/**
 * Chaque acte de l'assistant reprend le pictogramme de l'OUTIL qui l'a posé
 * (`TOOL_LOOK`) : la même image dans l'éditeur d'assistant, dans les traces
 * et ici — un vocabulaire, pas trois.
 */
const DEED_LOOK: Record<ConversationDeed, Look> = {
  booked: TOOL_LOOK.book_meeting,
  categorized: TOOL_LOOK.set_category,
  qualified: TOOL_LOOK.update_qualification,
  followup: TOOL_LOOK.schedule_followup,
  note: TOOL_LOOK.add_client_comment,
  transferred: TOOL_LOOK.transfer_assistant,
};

/**
 * Le pictogramme de « clore » est celui du motif que le bouton ÉCRIT
 * (`closed_by_human`), et non un second choisi ici : le geste et la pastille
 * qu'il laisse derrière lui doivent être la même image.
 */
const CLOSE_LOOK = ATTENTION_LOOK[HUMAN_CLOSED_REASON];

/**
 * Boîte de réception.
 *
 * Une seule règle d'architecture : un fil est TOUJOURS dans exactement un
 * état (`conversationStateOf`), et chaque vue est une liste d'états — les
 * vues ne se recoupent jamais (« les miennes » reste un filtre transversal).
 *
 * La bande d'état reste en HAUT et non repliée : découvrir après avoir tapé
 * trois réponses que les envois sont suspendus, ou qu'on est en simulation,
 * est la pire manière de l'apprendre.
 */
export function ConversationsInbox({
  rows,
  queue = [],
  failures = [],
  failuresTotal,
  categories = [],
  currentUserId,
  health,
  abilities = NO_ABILITIES,
  initialTab = "attention",
}: {
  rows: InboxRow[];
  /** La file d'envoi — les textos à venir (voir `QueueItem`). */
  queue?: QueueItem[];
  /** Les textos qui ne sont pas arrivés (voir `FailedMessage`). */
  failures?: FailedMessage[];
  /**
   * Combien il y en a EN TOUT — la liste est bornée aux plus récents. Sans ce
   * nombre, la pastille affichait le plafond et jurait que 100 était le compte
   * des envois perdus. Non dit vaut « rien de caché ».
   */
  failuresTotal?: number;
  currentUserId: string;
  /** `null` sans le droit `admin.settings` : la donnée n'est pas envoyée. */
  health: EngineHealth | null;
  /** Catégories du pipeline — pour classer une fiche sans quitter la boîte. */
  categories?: { id: number; label: string }[];
  /** Ce que ce regard peut faire — voir `InboxAbilities`. */
  abilities?: InboxAbilities;
  initialTab?: Tab;
}) {
  const t = useTranslations("conversations");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Un onglet qu'on n'a pas le droit d'ouvrir ne s'ouvre pas, même demandé par
  // la propriété : on retombe sur « à traiter ».
  const [tab, setTab] = useState<Tab>(
    initialTab === "queue" && !abilities.engine ? "attention" : initialTab,
  );
  const [mineOnly, setMineOnly] = useState(false);

  useDataChange(["sms"], () => router.refresh());
  useVisiblePolling(POLL_MS, () => router.refresh());

  // « Les miennes » est un CONFORT, pas une frontière : les rangées reçues ont
  // déjà été triées par la visibilité des fiches côté serveur (voir la page).
  // Ce bouton range un écran, il ne protège rien.
  const base = useMemo(
    () => (mineOnly ? rows.filter((r) => r.assignedToId === currentUserId) : rows),
    [rows, mineOnly, currentUserId],
  );

  // Les onglets suivent les droits : la file d'envoi n'existe que pour qui
  // conduit le moteur — sans elle, l'onglet s'ouvrirait sur du vide.
  const tabs = useMemo(() => TABS.filter((k) => k !== "queue" || abilities.engine), [
    abilities.engine,
  ]);

  const byState = useMemo(() => {
    const groups: Record<ConversationState, InboxRow[]> = {
      attention: [],
      human: [],
      ai: [],
      refused: [],
      concluded: [],
    };
    for (const row of base) groups[conversationStateOf(row)].push(row);
    // « À traiter » est une FILE : le client qui attend depuis le plus
    // longtemps passe en premier. Les autres vues sont des journaux : le
    // plus récent d'abord.
    const time = (r: InboxRow) => (r.lastAt ? Date.parse(r.lastAt) : 0);
    groups.attention.sort((a, b) => time(a) - time(b));
    for (const state of ["human", "ai", "refused", "concluded"] as const) {
      groups[state].sort((a, b) => time(b) - time(a));
    }
    return groups;
  }, [base]);

  const counts = useMemo(
    () => ({
      attention: byState.attention.length + byState.human.length,
      waiting: byState.ai.length,
      // La file et les échecs ignorent « les miennes » : un envoi programmé
      // n'est à personne, et un envoi perdu n'appartient plus à personne.
      queue: queue.length,
      failed: failuresTotal ?? failures.length,
      refused: byState.refused.length,
      all: base.length,
    }),
    [byState, base, queue, failures, failuresTotal],
  );

  /**
   * Combien de fils de CETTE vue vous reviennent.
   *
   * Le compte était global : le rail affichait « Les miennes · 12 » au-dessus
   * d'un onglet « Refus » qui n'en contenait qu'un — et une fois le filtre
   * pressé, la liste se vidait sous une pastille qui promettait douze. Une
   * pastille de filtre annonce ce que le filtre va LAISSER, sinon elle ne
   * répond à aucune question. Elle se lit donc dans l'univers de la vue
   * ouverte, exactement comme les comptes des onglets.
   */
  const mineCount = useMemo(() => {
    if (THREADLESS_TABS.includes(tab)) return 0;
    const shown = new Set<ConversationState>(
      tab === "all" ? ALL_SECTIONS : TAB_STATES[tab as Exclude<Tab, "all" | "queue" | "failed">],
    );
    return rows.filter(
      (r) => r.assignedToId === currentUserId && shown.has(conversationStateOf(r)),
    ).length;
  }, [rows, currentUserId, tab]);

  // Dans « à traiter », répondre et réparer ne sont pas le même métier.
  const replyRows = useMemo(
    () => byState.attention.filter((r) => attentionKindOf(r.attentionReason ?? "") === "reply"),
    [byState],
  );
  const engineRows = useMemo(
    () => byState.attention.filter((r) => attentionKindOf(r.attentionReason ?? "") === "engine"),
    [byState],
  );

  /**
   * Dans « Refus », un DÉSABONNEMENT n'est pas un « non merci ».
   *
   * Le premier est une porte fermée à clé — la loi interdit d'y frapper encore,
   * et la table `suppressions` s'en charge sans nous demander notre avis. Le
   * second est une conversation qui s'est mal terminée : elle peut se rouvrir
   * dans six mois, par téléphone, par une autre campagne. Les mélanger dans une
   * pile plate faisait perdre les premiers — et c'est la seule liste où l'on ne
   * doit jamais se tromper.
   */
  const optoutRows = useMemo(
    () => byState.refused.filter((r) => r.attentionReason === "optout"),
    [byState],
  );
  const refusalRows = useMemo(
    () => byState.refused.filter((r) => r.attentionReason !== "optout"),
    [byState],
  );

  // Ce que « Tout clore » clora VRAIMENT : les DEUX questions, comme sur chaque
  // carte — le droit du rôle (plafond) ET la case `sms` de la fiche (robinet).
  // Le serveur revérifie ; ce compte sert à ne pas annoncer un nombre qu'on ne
  // tiendra pas, et cette liste vide fait disparaître le bouton.
  const closableHeld = useMemo(
    () =>
      abilities.control
        ? byState.human.filter((r) => r.smsOpen !== false).map((r) => r.id)
        : [],
    [byState, abilities.control],
  );

  const act = (fn: () => Promise<boolean>) => {
    startTransition(async () => {
      const ok = await fn();
      if (!ok) return;
      emitDataChange("sms");
      router.refresh();
    });
  };

  /**
   * Classer la fiche depuis la boîte — « il n'est plus intéressé » se décide
   * en lisant le fil, pas en ouvrant la fiche dans un autre onglet.
   *
   * Ranger une fiche a un effet au-delà du pipeline : une campagne qui ne vise
   * plus sa nouvelle catégorie la LIBÈRE (voir `releaseCategoryMismatches`).
   * C'est le « terminer la campagne » qu'on cherche ici, et c'est pour ça que
   * ce geste-là est le bon plutôt qu'un retrait manuel campagne par campagne.
   */
  const classify = (row: InboxRow, categoryId: number) =>
    act(async () => {
      if (!row.clientId) return false;
      const result = await classifyConversationClientAction(row.clientId, categoryId);
      if (!result.ok) {
        toast.error(t("error"));
        return false;
      }
      toast.success(t("inbox.classified"));
      return true;
    });

  const handle = (row: InboxRow) =>
    act(async () => {
      const result = await markConversationHandledAction(row.id);
      if (!result.ok) {
        toast.error(t("error"));
        return false;
      }
      toast.success(t("inbox.handled"));
      return true;
    });

  /**
   * « Clore » — la sortie qui manquait à « Entre vos mains ».
   *
   * Ni « Marquer traité » (la pastille est déjà tombée) ni « Rendre à l'IA »
   * (impossible sans assistant) ne vidaient cette section : elle grossissait
   * sans fin. Clore ne réveille pas la machine — l'IA reste coupée — et ne fait
   * taire personne : le prochain message du client ramène le fil ici.
   */
  const close = (row: InboxRow) =>
    act(async () => {
      const result = await closeConversationAction(row.id);
      if (!result.ok) {
        toast.error(t("error"));
        // Rafraîchir quand même : si le fil n'était plus entre des mains
        // humaines, l'écran doit montrer où il est passé.
        return true;
      }
      toast.success(t("inbox.close.one"));
      return true;
    });

  // « Tout clore » : le même geste sur la pile AFFICHÉE — « les miennes »
  // compris. Vider ce qu'on voit et vider ce qui existe ne sont pas la même
  // promesse, et c'est la première qu'on tient.
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const closeAll = () => {
    if (closableHeld.length === 0) return;
    act(async () => {
      const result = await closeHeldConversationsAction(closableHeld);
      setConfirmCloseAll(false);
      if (!result.ok) {
        toast.error(t("error"));
        return true;
      }
      // Le compte rendu est celui des fils RÉELLEMENT clos, jamais celui des
      // identifiants envoyés.
      toast.success(t("inbox.close.done", { count: result.closed ?? 0 }));
      return true;
    });
  };

  // « Rendre à l'IA » : l'assistant reprend le fil ET répond tout de suite à
  // l'entrant qui attend — la décision vaut traitement.
  const handBack = (row: InboxRow) =>
    act(async () => {
      const result = await handBackToAiAction(row.id);
      if (!result.ok) {
        toast.error(
          result.error === "assistantUnavailable" ? t("thread.assistantUnavailable") : t("error"),
        );
        return false;
      }
      toast.success(t("inbox.handedBack"));
      return true;
    });

  // « Réessayer » : rejouer le tour d'UN fil en panne — entrants rouverts,
  // ouverture de campagne remise en file, IA remise en selle. Le toast dit
  // honnêtement si quelque chose est reparti.
  const retry = (row: InboxRow) =>
    act(async () => {
      const result = await retryAiTurnAction(row.id);
      if (!result.ok) {
        toast.error(
          result.error === "assistantUnavailable" ? t("thread.assistantUnavailable") : t("error"),
        );
        return false;
      }
      if (result.relaunched) toast.success(t("inbox.retried"));
      else toast.info(t("inbox.retriedNothing"));
      return true;
    });

  // « Je réponds » : prendre le fil (IA coupée, fil attribué) et atterrir
  // directement dans la zone de rédaction de la fiche. La pastille « à
  // traiter » ne tombe QUE lorsque la réponse part vraiment (l'envoi manuel
  // la retire) — cliquer n'est pas répondre.
  const respond = (row: InboxRow) => {
    startTransition(async () => {
      if (row.aiEnabled) {
        const paused = await setConversationAiAction({
          conversationId: row.id,
          enabled: false,
          reason: null,
        });
        if (!paused.ok) {
          toast.error(t("error"));
          return;
        }
      }
      if (row.assignedToId !== currentUserId) {
        const assigned = await assignConversationAction({
          conversationId: row.id,
          userId: currentUserId,
        });
        // Le fil peut REFUSER de changer de main (plafond de fiches atteint,
        // verrou d'un collègue) sans que la prise de contrôle échoue. Le taire
        // laissait croire que le fil était à soi : « les miennes » ne le
        // montrait pas, et personne ne comprenait pourquoi.
        if (!assigned.ok) toast.warning(t("inbox.notAssigned"));
      }
      emitDataChange("sms");
      if (row.clientId) router.push(`/clients/${row.clientId}`);
      else router.refresh();
    });
  };

  // Annuler un envoi encore EN FILE — la seule fenêtre où « annuler » veut
  // dire quelque chose. Trop tard = on le dit, jamais on ne fait semblant.
  const cancelQueued = (item: QueueItem) => {
    if (!item.jobId) return;
    act(async () => {
      const result = await cancelQueuedSmsAction(item.jobId!);
      if (!result.ok) {
        toast.error(result.error === "alreadySent" ? t("thread.tooLate") : t("error"));
        // Rafraîchir quand même : l'état a changé sous nos pieds.
        return true;
      }
      toast.success(t("thread.cancelled"));
      return true;
    });
  };

  // Après une panne de modèle, les tours morts ne repartent pas seuls : ce
  // bouton rejoue tout ce qui peut l'être (réponses, ouvertures de campagne,
  // entrants orphelins). Idempotent — le presser « pour rien » ne fait rien.
  const [replaying, setReplaying] = useState(false);
  const replay = async () => {
    setReplaying(true);
    try {
      const res = await fetch("/api/admin/sms/replay-llm-errors", { method: "POST" });
      if (!res.ok) throw new Error(`replay_${res.status}`);
      const d = (await res.json()) as {
        replayedInbound: number;
        replayedOutreach: number;
        replayedOrphans: number;
      };
      toast.success(
        t("inbox.replay.done", {
          count: d.replayedInbound + d.replayedOutreach + d.replayedOrphans,
        }),
      );
      emitDataChange("sms");
      router.refresh();
    } catch {
      toast.error(t("error"));
    } finally {
      setReplaying(false);
    }
  };

  const rowProps = {
    currentUserId,
    pending,
    onHandle: handle,
    onClose: close,
    onHandBack: handBack,
    onRetry: retry,
    onRespond: respond,
    onClassify: classify,
    canControl: abilities.control,
    canClassify: abilities.classify,
    categories,
    dfnsLocale,
  };

  const renderRows = (list: InboxRow[]) =>
    list.map((row) => (
      <InboxRowCard key={row.id} row={row} state={conversationStateOf(row)} {...rowProps} />
    ));

  const visibleCount = tab === "all" ? counts.all : counts[tab];

  return (
    <div className="space-y-4">
      {health ? <HealthStrip health={health} /> : null}

      {/*
        Le rail des vues. Sur écran large il tient sur une ligne et ne bouge
        pas.
        Sur téléphone il débordait : « File d'envoi » se coupait net au bord
        droit, et « Refus », « Toutes » et « Les miennes » n'existaient plus —
        un rail qui défile sans le DIRE est un rail qu'on ne fait pas défiler.
        On l'empile donc plutôt que de le couper : les six comptes se lisent
        d'un coup d'œil, et « 6 à traiter » est précisément le chiffre pour
        lequel on ouvre cet écran. Trois lignes de pastilles coûtent moins que
        deux vues invisibles.
      */}
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex w-max items-center gap-2 max-md:w-full max-md:flex-wrap">
          {tabs.map((key) => (
            <Button
              key={key}
              variant={tab === key ? "default" : "outline"}
              size="sm"
              className="min-h-11 md:min-h-9"
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                // La file et les échecs n'ont pas de titulaire : leur ouvrir
                // l'écran décroche « les miennes ». Sinon le filtre restait
                // allumé sans bouton pour le voir ni l'éteindre, et les
                // pastilles des autres vues continuaient de rétrécir sans que
                // rien à l'écran ne dise pourquoi.
                if (THREADLESS_TABS.includes(key)) setMineOnly(false);
              }}
            >
              {t(`inbox.tabs.${key}`)}
              <Badge
                variant="secondary"
                className="ml-1"
                // Le compte « à traiter » reste teinté même quand l'onglet
                // n'est pas actif : c'est LE chiffre de l'écran.
                style={
                  key === "attention" && counts.attention > 0 && tab !== key
                    ? lookTint(CONVERSATION_STATE_LOOK.attention)
                    : undefined
                }
              >
                {counts[key]}
              </Badge>
            </Button>
          ))}
          {/* Le trait qui sépare les VUES du filtre « les miennes ». Empilé,
              il tomberait en bout de ligne comme une poussière : sur
              téléphone, la pastille grise du filtre suffit à le distinguer
              des onglets.

              Le filtre disparaît sur les vues faites d'envois et non de fils
              (file, échecs) : il n'y a personne à qui les attribuer, et le
              bouton restait là, pressé, sans rien changer à l'écran. */}
          {THREADLESS_TABS.includes(tab) ? null : (
            <>
              <span className="mx-1 h-5 w-px shrink-0 bg-border max-md:hidden" aria-hidden />
              <Button
                variant={mineOnly ? "secondary" : "ghost"}
                size="sm"
                className="min-h-11 md:min-h-9"
                aria-pressed={mineOnly}
                onClick={() => setMineOnly((v) => !v)}
              >
                <UserRoundIcon aria-hidden />
                {t("inbox.mine")}
                <Badge variant="secondary" className="ml-1">
                  {mineCount}
                </Badge>
              </Button>
            </>
          )}
        </div>
      </div>

      {visibleCount === 0 ? (
        <EmptyState
          icon={<MessageCircleIcon />}
          title={t(`inbox.empty.${tab}.title`)}
          hint={
            mineOnly && !THREADLESS_TABS.includes(tab)
              ? t("inbox.empty.mine")
              : t(`inbox.empty.${tab}.desc`)
          }
        />
      ) : tab === "attention" ? (
        <div className="space-y-5">
          {replyRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={ATTENTION_KIND_LOOK.reply}
                label={t("inbox.sections.reply")}
                count={replyRows.length}
              />
              {renderRows(replyRows)}
            </section>
          ) : null}
          {engineRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={ATTENTION_KIND_LOOK.engine}
                label={t("inbox.sections.engine")}
                count={engineRows.length}
                action={
                  abilities.replay ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="relative z-10 min-h-11 md:min-h-8"
                      onClick={replay}
                      disabled={replaying}
                    >
                      <RotateCcwIcon aria-hidden />
                      {t("inbox.replay.button")}
                    </Button>
                  ) : null
                }
              />
              {renderRows(engineRows)}
            </section>
          ) : null}
          {/* Les fils qu'un humain tient déjà : pas urgents, mais ils sont du
              travail humain — c'est ICI qu'on doit les retrouver, pas dans un
              cinquième onglet. */}
          {byState.human.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={CONVERSATION_STATE_LOOK.human}
                label={t("inbox.sections.held")}
                count={byState.human.length}
                action={
                  closableHeld.length > 0 ? (
                    <AlertDialog open={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
                      <AlertDialogTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            className="relative z-10 min-h-11 md:min-h-8"
                          />
                        }
                      >
                        <CLOSE_LOOK.Icon aria-hidden />
                        {t("inbox.close.all")}
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("inbox.close.title")}</AlertDialogTitle>
                          {/* Le nombre annoncé est celui des fils qu'on peut
                              vraiment clore, pas celui de la section : la
                              fiche d'un collègue reste fermée. */}
                          <AlertDialogDescription>
                            {t("inbox.close.body", { count: closableHeld.length })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("inbox.close.cancel")}</AlertDialogCancel>
                          <AlertDialogAction disabled={pending} onClick={closeAll}>
                            {t("inbox.close.confirm")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null
                }
              />
              {renderRows(byState.human)}
            </section>
          ) : null}
          {/* Pas de panne visible mais un rejeu quand même possible (entrants
              orphelins, tours morts sans fil listé) : le geste reste offert,
              discrètement. */}
          {abilities.replay && engineRows.length === 0 ? (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 text-muted-foreground md:min-h-8"
                onClick={replay}
                disabled={replaying}
              >
                <RotateCcwIcon aria-hidden />
                {t("inbox.replay.button")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : tab === "queue" ? (
        <div className="space-y-2">
          {queue.map((item) => (
            <QueueRowCard
              key={`${item.kind}:${item.id}`}
              item={item}
              pending={pending}
              canCancel={abilities.reply}
              onCancel={cancelQueued}
              dfnsLocale={dfnsLocale}
            />
          ))}
        </div>
      ) : tab === "failed" ? (
        <div className="space-y-2">
          {failures.map((item) => (
            <FailureRowCard key={item.id} item={item} dfnsLocale={dfnsLocale} />
          ))}
          {/* Une liste tronquée qui ne le dit pas se lit comme une liste
              complète — et « 100 échecs » au lieu de 4 000 est le genre de
              chiffre sur lequel on prend une décision. */}
          {counts.failed > failures.length ? (
            <p className="pt-1 text-center text-xs text-muted-foreground">
              {t("inbox.failedCap", { shown: failures.length, total: counts.failed })}
            </p>
          ) : null}
        </div>
      ) : tab === "refused" ? (
        // Deux sections, pas une pile : un désabonnement ferme la porte à clé,
        // un « non merci » la laisse entrebâillée.
        <div className="space-y-5">
          {optoutRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={ATTENTION_LOOK.optout}
                label={t("inbox.sections.optout")}
                count={optoutRows.length}
              />
              {renderRows(optoutRows)}
            </section>
          ) : null}
          {refusalRows.length > 0 ? (
            <section className="space-y-2">
              <SectionHeader
                look={CONVERSATION_STATE_LOOK.refused}
                label={t("inbox.sections.refusal")}
                count={refusalRows.length}
              />
              {renderRows(refusalRows)}
            </section>
          ) : null}
        </div>
      ) : tab === "all" ? (
        // « Toutes » n'est pas une pile plate : chaque situation a son
        // en-tête, pour VOIR clairement — c'est toute sa raison d'être.
        <div className="space-y-5">
          {ALL_SECTIONS.map((state) =>
            byState[state].length > 0 ? (
              <section key={state} className="space-y-2">
                <SectionHeader
                  look={CONVERSATION_STATE_LOOK[state]}
                  label={t(`inbox.state.${state}`)}
                  count={byState[state].length}
                />
                {renderRows(byState[state])}
              </section>
            ) : null,
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {renderRows(TAB_STATES[tab].flatMap((state) => byState[state]))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  look,
  label,
  count,
  action,
}: {
  look: Look;
  label: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <LookGlyph look={look} className="size-3.5" />
        {label}
        <span className="font-normal">· {count}</span>
      </h2>
      <span className="flex-1" />
      {action}
    </div>
  );
}

/**
 * Une ligne de la boîte.
 *
 * Toute la carte est UN lien vers la fiche client. Les fils qui réclament une
 * décision offrent les TROIS réponses possibles, sur place : « Rendre à
 * l'IA » (l'assistant continue et répond tout de suite), « Je réponds »
 * (prise en main + la fiche s'ouvre sur la zone de rédaction), « Marquer
 * traité » (rien à faire). Décider ne doit pas demander d'ouvrir trois
 * écrans.
 *
 * Et chaque dernier message dit QUI l'a écrit : « Parfait, je vous confirme
 * jeudi » n'a pas le même sens selon que c'est le client ou l'assistant.
 */
function InboxRowCard({
  row,
  state,
  currentUserId,
  pending,
  onHandle,
  onClose,
  onHandBack,
  onRetry,
  onRespond,
  onClassify,
  canControl,
  canClassify,
  categories,
  dfnsLocale,
}: {
  row: InboxRow;
  state: ConversationState;
  currentUserId: string;
  pending: boolean;
  onHandle: (row: InboxRow) => void;
  onClose: (row: InboxRow) => void;
  onHandBack: (row: InboxRow) => void;
  onRetry: (row: InboxRow) => void;
  onRespond: (row: InboxRow) => void;
  onClassify: (row: InboxRow, categoryId: number) => void;
  /** Reprendre le fil, le rendre à l'IA, le marquer traité (`conversations.control`). */
  canControl: boolean;
  /** Ranger la fiche depuis la carte (`clients.category`). */
  canClassify: boolean;
  categories: { id: number; label: string }[];
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = useTranslations("clients");
  // Une PANNE se réessaie (entrants rouverts, tour rejoué) ; une demande du
  // client se REND à l'IA ou se répond — pas le même geste.
  const isEngine =
    state === "attention" && attentionKindOf(row.attentionReason ?? "") === "engine";
  const stateLook = CONVERSATION_STATE_LOOK[state];
  // La pastille de gauche porte le MOTIF quand il y en a un (à traiter,
  // refus, conclu), l'état sinon (assistant, main humaine).
  const reasonLook =
    row.attentionReason !== null ? (ATTENTION_LOOK[row.attentionReason] ?? stateLook) : stateLook;
  const rowLook = state === "human" || state === "ai" ? stateLook : reasonLook;

  // Le client a parlé en dernier et le fil est à traiter : c'est LUI qui
  // attend, et depuis l'heure affichée. Le texte reste en pleine couleur.
  const clientWaiting = state === "attention" && row.lastDirection === "in";

  // Les gestes réellement offerts sur CETTE carte, à ce regard. Le pied de
  // carte disparaît quand il n'en reste aucun et que personne ne tient le
  // fil : une barre vide n'apprend rien.
  //
  // Le droit du rôle est le PLAFOND, la case de la fiche le robinet : conduire
  // l'assistant change ce qu'il ENVERRA à ce client-là (case `sms`), ranger la
  // fiche touche à son pipeline (case `category`). Sans ce second filtre, la
  // carte offrirait sur la fiche d'un collègue des boutons que le serveur
  // refuse — une promesse qu'on ne tient pas.
  const mayControl = canControl && row.smsOpen !== false;
  const mayClassify = canClassify && row.categoryOpen !== false;
  const showHandBack =
    mayControl && (state === "attention" || state === "human") && row.assistantName !== null;
  const showClassify =
    mayClassify && state === "human" && row.clientId !== null && categories.length > 0;
  const showDecide = mayControl && state === "attention";
  // Clore est le geste des fils TENUS, et de ceux-là seulement : ailleurs, une
  // pastille tombe (« marquer traité ») ou la machine reprend (« rendre à
  // l'IA ») — clore n'y voudrait rien dire.
  const showClose = mayControl && state === "human";
  const showFooter =
    row.assignedToName !== null || showHandBack || showClassify || showDecide || showClose;

  // Qui a écrit un message — la MÊME règle pour le dernier et pour celui qui
  // le précède, sinon les deux lignes d'une même carte nommeraient
  // différemment le même assistant.
  const speakerOf = (direction: "in" | "out" | null, source: string | null) =>
    direction === "in"
      ? t("inbox.from.client")
      : source === "agent"
        ? t("inbox.from.assistant")
        : source === "opener" || source === "ladder"
          ? t("inbox.from.campaign")
          : source === "system"
            ? t("inbox.from.system")
            : t("inbox.from.team");

  const speaker = speakerOf(row.lastDirection, row.lastSource);

  /**
   * La ligne de contexte : ce qu'on avait envoyé avant que le client réponde.
   *
   * Elle ne s'affiche QUE si le client a parlé en dernier. Quand c'est nous,
   * la carte alignerait deux phrases de suite du même côté — le contexte se
   * lit alors comme un bégaiement, pas comme un échange.
   */
  const previous =
    row.lastDirection === "in" && row.previousBody ? row.previousBody : null;

  return (
    <article
      className={cn(
        "relative flex items-start gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors md:p-4",
        row.clientId && "hover:border-ring/60 hover:bg-accent/40",
        state === "attention" && "border-l-4",
      )}
      style={state === "attention" ? { borderLeftColor: rowLook.color } : undefined}
    >
      {row.clientId ? (
        <Link
          href={`/clients/${row.clientId}`}
          className="absolute inset-0 rounded-xl"
          aria-label={`${t("inbox.open")} — ${row.clientName}`}
        />
      ) : null}

      <LookIcon look={rowLook} className="mt-0.5" />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{row.clientName}</span>
          {row.attentionReason !== null ? (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(reasonLook)}>
              <reasonLook.Icon aria-hidden />
              {t(`inbox.reason.${row.attentionReason}` as never)}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(stateLook)}>
              <stateLook.Icon aria-hidden />
              {state === "ai" && row.assistantName ? row.assistantName : t(`inbox.state.${state}`)}
            </Badge>
          )}
          {/* Un fil à traiter dont l'IA est coupée : personne ne répondra
              automatiquement — ça se dit, même quand le motif dit autre chose. */}
          {state === "attention" && !row.aiEnabled ? (
            <Badge
              variant="outline"
              className="gap-1 font-normal"
              style={lookTint(CONVERSATION_STATE_LOOK.human)}
            >
              <CONVERSATION_STATE_LOOK.human.Icon aria-hidden />
              {t("ai.off")}
            </Badge>
          ) : null}
          <span className="flex-1" />
          {row.lastAt ? (
            <span
              className={cn(
                "text-xs whitespace-nowrap",
                clientWaiting ? "font-medium" : "text-muted-foreground",
              )}
              style={clientWaiting ? { color: CONVERSATION_STATE_LOOK.attention.color } : undefined}
            >
              <RelativeTime date={row.lastAt} locale={dfnsLocale} />
            </span>
          ) : null}
        </div>

        {/* Ce qu'on avait dit, puis ce qu'il a répondu — dans cet ordre, parce
            que c'est celui de la conversation. Plus petit et effacé : c'est le
            décor, la réplique du client reste le sujet. */}
        {previous ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            <span className="font-medium">
              {speakerOf("out", row.previousSource ?? null)}&nbsp;:{" "}
            </span>
            {previous}
          </p>
        ) : null}

        {row.lastBody ? (
          <p className="line-clamp-2 text-sm">
            <span className={cn("font-medium", clientWaiting ? undefined : "text-muted-foreground")}>
              {speaker}&nbsp;:{" "}
            </span>
            <span className={clientWaiting ? "text-foreground" : "text-muted-foreground"}>
              {row.lastBody}
            </span>
          </p>
        ) : row.historyHidden || row.contactHidden ? (
          /* Le serveur n'a envoyé ni le message ni le numéro : le dire vaut
             mieux qu'une carte muette qu'on croirait vide. La même pastille
             que dans la liste des fiches — un seul mot pour une seule idée. */
          <p>
            <span
              title={
                row.historyHidden
                  ? tAccess("access.historyHidden")
                  : tAccess("access.maskedHint")
              }
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <EyeOffIcon aria-hidden className="size-3" />
              {tAccess("access.masked")}
            </span>
          </p>
        ) : null}

        {/* La conclusion de l'assistant — ce qu'il a FAIT sur ce fil. Un
            rendez-vous réservé ou une fiche classée se voient ici, sans
            ouvrir la fiche pour le découvrir. */}
        {row.did.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {row.did.map((deed) => (
              <span key={deed} className="inline-flex items-center gap-1">
                <LookGlyph look={DEED_LOOK[deed]} className="size-3" />
                {t(`inbox.did.${deed}`)}
              </span>
            ))}
          </p>
        ) : null}

        {/* Sur les fils que l'assistant mène : dire si la balle est chez le
            client ou si la réponse de l'assistant est en route. */}
        {state === "ai" ? (
          <p className="text-xs text-muted-foreground">
            {row.lastDirection === "out" ? t("inbox.aiWaitingClient") : t("inbox.aiComposing")}
          </p>
        ) : null}

        {showFooter ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {row.assignedToName ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <UserRoundIcon aria-hidden className="size-3" />
                {row.assignedToId === currentUserId ? t("inbox.you") : row.assignedToName}
              </span>
            ) : null}
            <span className="flex-1" />
            {/* Les 2-3 décisions possibles, sur place. « Réessayer » sur une
                panne, « Rendre à l'IA » sur une demande — et seulement si un
                assistant tient réellement le fil. */}
            {showHandBack ? (
              <Button
                variant="outline"
                size="sm"
                className="relative z-10 min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => (isEngine ? onRetry(row) : onHandBack(row))}
              >
                {isEngine ? <RotateCcwIcon aria-hidden /> : <BotIcon aria-hidden />}
                {isEngine ? t("inbox.actions.retry") : t("inbox.actions.handBack")}
              </Button>
            ) : null}
            {/* Un fil qu'un humain tient déjà : la décision qui reste est
                souvent « il n'est plus intéressé ». La prendre ICI range la
                fiche dans le pipeline — et libère du même geste les campagnes
                qui ne visent plus sa nouvelle catégorie. */}
            {showClassify ? (
              <Select
                items={categories.map((c) => ({ value: String(c.id), label: c.label }))}
                value=""
                onValueChange={(v) => onClassify(row, Number(v))}
                disabled={pending}
              >
                <SelectTrigger
                  className="relative z-10 min-h-11 w-auto md:min-h-8"
                  aria-label={t("inbox.actions.classify")}
                >
                  <TagIcon aria-hidden />
                  <span>{t("inbox.actions.classify")}</span>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {/* Un fil tenu doit pouvoir SORTIR de la pile. Sans ce bouton,
                « Entre vos mains » n'avait aucune issue : sa pastille est déjà
                tombée, et rendre la main exige un assistant. */}
            {showClose ? (
              <Button
                variant="ghost"
                size="sm"
                className="relative z-10 min-h-11 md:min-h-8"
                disabled={pending}
                onClick={() => onClose(row)}
              >
                <CLOSE_LOOK.Icon aria-hidden /> {t("inbox.actions.close")}
              </Button>
            ) : null}
            {showDecide ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="relative z-10 min-h-11 md:min-h-8"
                  disabled={pending}
                  onClick={() => onRespond(row)}
                >
                  <PencilLineIcon aria-hidden /> {t("inbox.actions.respond")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative z-10 min-h-11 md:min-h-8"
                  disabled={pending}
                  onClick={() => onHandle(row)}
                >
                  <CheckIcon aria-hidden /> {t("inbox.markHandled")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Une entrée de la file d'envoi.
 *
 * Trois formes, une même carte : l'envoi déjà écrit montre SON texte et
 * s'annule tant qu'il est en file ; la réponse en préparation n'a pas encore
 * de texte — dire qu'elle arrive vaut mieux que faire semblant ; le barreau
 * de campagne dit sa campagne et son rang, parce que c'est là qu'on va s'il
 * faut le retenir.
 */
function QueueRowCard({
  item,
  pending,
  canCancel,
  onCancel,
  dfnsLocale,
}: {
  item: QueueItem;
  pending: boolean;
  /** Retenir l'envoi demande le droit d'écrire — voir `InboxAbilities.reply`. */
  canCancel: boolean;
  onCancel: (item: QueueItem) => void;
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  const look = QUEUE_KIND_LOOK[item.kind];

  return (
    <article className="relative flex items-start gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors md:p-4 hover:border-ring/60 hover:bg-accent/40">
      {item.clientId ? (
        <Link
          href={`/clients/${item.clientId}`}
          className="absolute inset-0 rounded-xl"
          aria-label={`${t("inbox.open")} — ${item.clientName}`}
        />
      ) : null}

      <LookIcon look={look} className="mt-0.5" />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{item.clientName}</span>
          <Badge variant="outline" className="gap-1 font-normal" style={lookTint(look)}>
            <look.Icon aria-hidden />
            {t(`inbox.queue.kind.${item.kind}`)}
          </Badge>
          {item.kind === "send" && item.source ? (
            <span className="text-xs text-muted-foreground">
              {t(`thread.source.${item.source}` as never)}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="text-xs font-medium whitespace-nowrap" style={{ color: look.color }}>
            <RelativeTime date={item.when} locale={dfnsLocale} />
          </span>
        </div>

        {item.kind === "send" && item.body ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">« {item.body} »</p>
        ) : null}
        {item.kind === "turn" ? (
          <p className="text-sm text-muted-foreground">{t("inbox.queue.turnHint")}</p>
        ) : null}
        {item.kind === "touch" ? (
          <p className="text-sm text-muted-foreground">
            {t("inbox.queue.touchHint", { campaign: item.campaignName ?? "—", step: item.step ?? 1 })}
          </p>
        ) : null}

        {canCancel && item.kind === "send" && item.jobId ? (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 min-h-11 text-muted-foreground md:min-h-8"
              disabled={pending}
              onClick={() => onCancel(item)}
            >
              {t("thread.cancelQueued")}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Une ligne de la vue « Échecs » — un texto qui n'est pas arrivé.
 *
 * La règle de l'écran : ne jamais montrer un échec sans sa RAISON. Un refus de
 * l'opérateur porte son code (30007 « filtré », 21610 « désabonné ») ; un
 * message jamais parti porte son motif (interrupteur baissé, numéro désabonné,
 * hors liste d'essai). « Mis en file » puis plus rien est exactement ce que
 * cette vue existe pour ne plus laisser arriver.
 *
 * Le vocabulaire est celui du fil (`thread.status.*`, `thread.skip.*`) : le
 * même mot pour le même fait, ici et sur la fiche.
 */
function FailureRowCard({
  item,
  dfnsLocale,
}: {
  item: FailedMessage;
  dfnsLocale: typeof fr;
}) {
  const t = useTranslations("conversations");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = useTranslations("clients");
  const look = ATTENTION_LOOK.send_failed;
  // `skipReason` peut porter un détail après deux-points (« provider_rejected:
  // … ») : le code seul a un libellé, le reste ne se traduit pas.
  const skipCode = item.skipReason ? item.skipReason.split(":")[0] : null;

  return (
    <article className="relative flex items-start gap-3 rounded-xl border bg-card p-3 shadow-xs transition-colors md:p-4 hover:border-ring/60 hover:bg-accent/40">
      {item.clientId ? (
        <Link
          href={`/clients/${item.clientId}`}
          className="absolute inset-0 rounded-xl"
          aria-label={`${t("inbox.open")} — ${item.clientName}`}
        />
      ) : null}

      <LookIcon look={look} className="mt-0.5" />

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{item.clientName}</span>
          {item.status ? (
            <Badge variant="outline" className="gap-1 font-normal" style={lookTint(look)}>
              <look.Icon aria-hidden />
              {t(`thread.status.${item.status}` as never)}
            </Badge>
          ) : null}
          {item.source ? (
            <span className="text-xs text-muted-foreground">
              {t(`thread.source.${item.source}` as never)}
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            <RelativeTime date={item.at} locale={dfnsLocale} />
          </span>
        </div>

        {item.body ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">« {item.body} »</p>
        ) : item.historyHidden ? (
          <p>
            <span
              title={tAccess("access.historyHidden")}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <EyeOffIcon aria-hidden className="size-3" />
              {tAccess("access.masked")}
            </span>
          </p>
        ) : null}

        {skipCode ? (
          <p className="text-xs font-medium text-destructive">
            {t("thread.skippedLabel", {
              reason: t.has(`thread.skip.${skipCode}`)
                ? t(`thread.skip.${skipCode}` as never)
                : skipCode,
            })}
          </p>
        ) : null}
        {item.errorCode ? (
          <p className="text-xs font-medium text-destructive">
            {t("thread.failedHint", { code: item.errorCode })}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function HealthStrip({ health }: { health: EngineHealth }) {
  const t = useTranslations("conversations");
  // Deux états méritent une ALERTE, pas une pastille : rien ne part, ou rien
  // ne part pour de vrai. Les confondre avec « 12 en file » serait les noyer.
  const suspended = health.killSwitch;
  const notLive = health.mode !== "live";

  return (
    <div className="space-y-2">
      {suspended ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
        >
          <PowerOffIcon className="size-4 shrink-0" />
          {t("health.killSwitch.on")}
        </div>
      ) : null}

      {notLive ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangleIcon className="size-4 shrink-0" />
          {t(`health.mode.${health.mode}`)}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {health.sendWindowOpen ? (
            <SunIcon className="size-3.5" aria-hidden />
          ) : (
            <MoonIcon className="size-3.5" aria-hidden />
          )}
          {t(health.sendWindowOpen ? "health.quiet.open" : "health.quiet.closed")}
        </span>
        <span>{t("health.queue", { count: health.queued })}</span>
        {health.failed > 0 ? (
          <span className="font-medium text-destructive">
            {t("health.failed", { count: health.failed })}
          </span>
        ) : null}
        <span>{t("health.suppressed", { count: health.suppressed })}</span>
      </div>
    </div>
  );
}
