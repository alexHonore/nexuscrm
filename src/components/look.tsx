import {
  ActivityIcon,
  ArchiveIcon,
  AudioLinesIcon,
  BadgeQuestionMarkIcon,
  BanIcon,
  BookOpenTextIcon,
  BotIcon,
  BotOffIcon,
  BracesIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarXIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  ClipboardXIcon,
  ClockIcon,
  CpuIcon,
  EyeIcon,
  FileCheckIcon,
  FileWarningIcon,
  FilterIcon,
  FilterXIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  GaugeIcon,
  HandIcon,
  HourglassIcon,
  IdCardIcon,
  LayersIcon,
  LinkIcon,
  ListChecksIcon,
  ListOrderedIcon,
  MailIcon,
  MegaphoneIcon,
  MessageCircleQuestionMarkIcon,
  MessageSquareDotIcon,
  MessageSquareOffIcon,
  MessageSquareReplyIcon,
  MessageSquareTextIcon,
  MessageSquarePlusIcon,
  MessageSquareWarningIcon,
  MessageSquareXIcon,
  MessagesSquareIcon,
  PackageOpenIcon,
  UserRoundIcon,
  UserSearchIcon,
  PauseIcon,
  PencilLineIcon,
  PhoneCallIcon,
  PhoneOffIcon,
  PlayIcon,
  PowerIcon,
  QuoteIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RegexIcon,
  RulerIcon,
  ScaleIcon,
  ScissorsIcon,
  ScrollTextIcon,
  ServerCogIcon,
  ServerCrashIcon,
  SearchCheckIcon,
  SendIcon,
  ShieldCheckIcon,
  ShieldIcon,
  ShieldQuestionMarkIcon,
  ShieldXIcon,
  SignalZeroIcon,
  SignpostIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  SplitIcon,
  SquareArrowOutUpRightIcon,
  SquarePenIcon,
  TargetIcon,
  TriangleAlertIcon,
  UsersIcon,
  UnplugIcon,
  VideoIcon,
  WholeWordIcon,
  WrenchIcon,
  XOctagonIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { ErrorFamily } from "@/lib/deliverability/error-classes";
import type { GuardrailKind } from "@/lib/guardrails/types";
import { cn } from "@/lib/utils";

/**
 * Le vocabulaire visuel de la configuration — un pictogramme et une couleur
 * par concept, définis ICI et nulle part ailleurs.
 *
 * Régler un assistant, c'est parcourir douze onglets, sept objectifs, huit
 * outils et trois sévérités, tous rendus en texte gris de la même taille. On
 * lit tout, à chaque fois, pour retrouver la ligne qu'on cherchait. Un
 * pictogramme se reconnaît sans être lu.
 *
 * La COULEUR ne distingue pas chaque élément : elle les GROUPE. Douze couleurs
 * dans une barre d'onglets font des confettis et n'apprennent rien ; quatre
 * familles disent d'un coup d'œil ce qui règle la parole de l'assistant, ce
 * qui règle sa mécanique, et ce qui la vérifie. Le pictogramme, lui, est
 * unique — c'est lui qui identifie.
 */

export interface Look {
  color: string;
  Icon: LucideIcon;
}

/** Les quatre familles. Une couleur par famille, jamais par élément. */
export const TONE = {
  /** Ce que l'assistant DIT : identité, objectif, ton, connaissances. */
  speech: "#3B82F6",
  /** Ce qui le fait FONCTIONNER : outils, modèle, prompt. */
  machinery: "#8B5CF6",
  /** Ce qui le VÉRIFIE : garde-fous, bac à sable, suite. */
  scrutiny: "#F59E0B",
  /** La matière brute : JSON, import/export. */
  raw: "#64748B",
} as const;

/**
 * Le canal SMS a sa PROPRE couleur, qui ne sert à rien d'autre.
 *
 * Sur une fiche client, la carte SMS voisine des commentaires internes et de
 * l'historique. Toutes portaient la même bordure grise, et une note interne
 * envoyée par SMS à un vrai client ne se rattrape pas. Le violet ne dit pas
 * « important » — il dit « ceci sort de l'application ».
 */
export const CHANNEL_LOOK = {
  sms: { color: "#7C3AED", Icon: SmartphoneIcon },
} as const satisfies Record<string, Look>;

/**
 * Les trois portes de la création — le créateur IA, le formulaire court,
 * l'éditeur complet.
 *
 * Ce ne sont pas des concepts du produit : ce sont trois façons d'arriver au
 * même objet, et la teinte ne sert qu'à les séparer dans une pile de trois
 * tuiles illustrées. Elle vit ici quand même, parce qu'un hex écrit dans un
 * écran est un hex que personne ne retrouve le jour où la palette bouge — et
 * parce que les deux tuiles colorées empruntent des teintes qui ont déjà un
 * sens ailleurs : le vert du « rien à faire » pour la voie courte, le violet
 * de la mécanique pour celle qui ouvre les onze onglets.
 *
 * `ai` reprend la couleur du thème : c'est la porte recommandée, et elle doit
 * suivre la marque plutôt qu'une teinte de plus.
 */
export const CREATE_MODE_TONE: Record<"ai" | "simple" | "complex", string> = {
  ai: "var(--color-primary)",
  simple: "#10B981",
  complex: TONE.machinery,
};

/** Les onglets de l'éditeur d'assistant. */
export const EDITOR_TAB_LOOK: Record<string, Look> = {
  identity: { color: TONE.speech, Icon: IdCardIcon },
  goal: { color: TONE.speech, Icon: TargetIcon },
  approach: { color: TONE.speech, Icon: SlidersHorizontalIcon },
  knowledge: { color: TONE.speech, Icon: BookOpenTextIcon },
  objections: { color: TONE.speech, Icon: MessageCircleQuestionMarkIcon },
  tools: { color: TONE.machinery, Icon: WrenchIcon },
  model: { color: TONE.machinery, Icon: CpuIcon },
  prompt: { color: TONE.machinery, Icon: ScrollTextIcon },
  guardrails: { color: TONE.scrutiny, Icon: ShieldIcon },
  sandbox: { color: TONE.scrutiny, Icon: FlaskConicalIcon },
  test: { color: TONE.scrutiny, Icon: ClipboardCheckIcon },
  json: { color: TONE.raw, Icon: BracesIcon },
};

/**
 * Les sept objectifs.
 *
 * Ceux qui RÉSERVENT vraiment une plage d'agenda partagent le bleu ; ceux qui
 * ne font que recueillir sont en gris ; passer la main est ambre, parce que
 * c'est une sortie du parcours automatique et non une étape.
 */
export const GOAL_LOOK: Record<string, Look> = {
  video_meeting: { color: "#3B82F6", Icon: VideoIcon },
  in_person_meeting: { color: "#3B82F6", Icon: UsersIcon },
  phone_call: { color: "#3B82F6", Icon: PhoneCallIcon },
  collect_email: { color: "#0EA5E9", Icon: MailIcon },
  collect_callback_time: { color: "#0EA5E9", Icon: CalendarClockIcon },
  qualify_only: { color: "#64748B", Icon: SearchCheckIcon },
  handoff: { color: "#F59E0B", Icon: HandIcon },
};

/** Les outils de l'agent (voir `ASSISTANT_TOOLS`). */
export const TOOL_LOOK: Record<string, Look> = {
  // Lecture de la fiche et des notes internes : la même famille « je consulte
  // avant d'agir », une teinte indigo distincte des outils d'action.
  read_client: { color: "#6366F1", Icon: UserSearchIcon },
  read_client_comments: { color: "#4F46E5", Icon: MessagesSquareIcon },
  // Écrire une note interne : l'action sœur de la lecture des notes — même
  // famille visuelle, mais en ACTION (fuchsia), pas en consultation (indigo).
  add_client_comment: { color: "#D946EF", Icon: MessageSquarePlusIcon },
  get_slots: { color: "#0EA5E9", Icon: CalendarClockIcon },
  book_meeting: { color: "#3B82F6", Icon: CalendarCheckIcon },
  update_qualification: { color: "#10B981", Icon: ListChecksIcon },
  schedule_followup: { color: "#14B8A6", Icon: CalendarClockIcon },
  // Ranger une fiche : le même geste que déplacer une carte dans le pipeline.
  set_category: { color: "#0EA5E9", Icon: FolderTreeIcon },
  stop: { color: "#EF4444", Icon: XOctagonIcon },
  handoff: { color: "#F59E0B", Icon: HandIcon },
  transfer_assistant: { color: "#8B5CF6", Icon: SquareArrowOutUpRightIcon },
  close_conversation: { color: "#64748B", Icon: CircleSlashIcon },
};

/**
 * Les trois sévérités de garde-fou — un feu de circulation.
 *
 * « Bloque » et « laisse passer, mais le note » se lisent presque pareil en
 * texte, et le choix décide pourtant si un message part.
 */
export const SEVERITY_LOOK: Record<string, Look> = {
  block: { color: "#EF4444", Icon: ShieldIcon },
  warn: { color: "#F59E0B", Icon: EyeIcon },
  off: { color: "#64748B", Icon: CircleSlashIcon },
};

/**
 * La pastille : le pictogramme sur son fond teinté.
 *
 * `aria-hidden` sans exception — l'icône DOUBLE un libellé, elle ne le
 * remplace jamais. Une pastille seule, sans texte à côté, serait une
 * devinette pour tout le monde et un mur pour un lecteur d'écran.
 */
export function LookIcon({
  look,
  size = "md",
  className,
}: {
  look: Look;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { color, Icon } = look;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "sm" ? "size-5 rounded-md" : size === "lg" ? "size-10 rounded-xl" : "size-8 rounded-lg",
        className,
      )}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon className={size === "sm" ? "size-3" : size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}

/** Le pictogramme seul, à la couleur du concept — pour une ligne dense. */
export function LookGlyph({ look, className }: { look: Look; className?: string }) {
  const { color, Icon } = look;
  return <Icon aria-hidden className={cn("size-4 shrink-0", className)} style={{ color }} />;
}

/**
 * Les deux formes d'une entrée de connaissance.
 *
 * Un FAIT que l'assistant a le droit d'affirmer et une CONSIGNE de conduite
 * (« si on demande X, réponds Y ») s'écrivent dans la même liste, dans la même
 * zone de texte : rien ne les distinguait que la phrase elle-même, et on
 * écrivait des consignes en croyant lister des faits. Deux pictogrammes
 * séparent les deux intentions avant qu'on ait lu la phrase.
 */
export const KNOWLEDGE_LOOK: Record<"fact" | "rule", Look> = {
  fact: { color: "#3B82F6", Icon: QuoteIcon },
  rule: { color: "#0EA5E9", Icon: SignpostIcon },
};

/**
 * L'état d'un assistant dans sa liste — TROIS lectures, pas une.
 *
 * Une ligne de liste répond à trois questions qui n'ont rien à voir entre
 * elles : l'assistant écrit-il à de vrais clients (service), son texte final
 * correspond-il encore à sa configuration (compilation), et s'est-il bien tenu
 * au dernier essai (suite). Rendues en badges gris identiques, les trois se
 * lisent une par une, et le seul cas urgent — actif ET périmé — se noie entre
 * les deux autres.
 *
 * Les clés portent leur lecture en préfixe (`compiled_`, `suite_`) : ce sont
 * trois axes indépendants, pas une liste d'états qui s'excluraient.
 *
 * La couleur reprend le feu de circulation des sévérités — vert « rien à
 * faire », ambre « une action attend », rouge « ne pas mettre en service »,
 * gris « pas encore en jeu ». Elle ne dit jamais DE QUOI on parle : c'est le
 * pictogramme, doublé du libellé, qui distingue le prompt périmé de la suite
 * rouge.
 */
export const ASSISTANT_STATUS_LOOK: Record<string, Look> = {
  active: { color: "#10B981", Icon: PowerIcon },
  draft: { color: TONE.raw, Icon: PencilLineIcon },
  archived: { color: TONE.raw, Icon: ArchiveIcon },
  compiled_fresh: { color: "#10B981", Icon: FileCheckIcon },
  // Ambre plutôt que rouge : le prompt périmé n'est pas une faute, c'est une
  // recompilation qui attend — et c'est un geste, d'où la flèche.
  compiled_stale: { color: TONE.scrutiny, Icon: RefreshCwIcon },
  compiled_never: { color: TONE.raw, Icon: CircleDashedIcon },
  // Le même presse-papiers que l'onglet « Vérification » : la pastille de la
  // liste renvoie à l'écran où l'on va corriger.
  suite_passed: { color: "#10B981", Icon: ClipboardCheckIcon },
  suite_failed: { color: "#EF4444", Icon: ClipboardXIcon },
};

/**
 * Les six onglets de l'éditeur de campagne.
 *
 * Mêmes familles que l'assistant, transposées à une campagne : ce qu'elle DIT
 * (son identité, ses messages), la MÉCANIQUE qui la déclenche et choisit qui
 * la reçoit, et ce qui la VÉRIFIE une fois lancée. Six libellés gris de la
 * même taille se relisent à chaque visite ; trois familles se reconnaissent.
 */
export const CAMPAIGN_TAB_LOOK: Record<string, Look> = {
  basics: { color: TONE.speech, Icon: IdCardIcon },
  trigger: { color: TONE.machinery, Icon: ZapIcon },
  audience: { color: TONE.machinery, Icon: FilterIcon },
  ladder: { color: TONE.speech, Icon: ListOrderedIcon },
  variants: { color: TONE.scrutiny, Icon: SplitIcon },
  enrollments: { color: TONE.scrutiny, Icon: UsersIcon },
};

/**
 * Les quatre états d'une campagne.
 *
 * « Brouillon », « Active » et « En pause » sont trois mots de même longueur
 * dans la même pastille grise, et c'est pourtant la seule chose à l'écran qui
 * dise si des SMS partent en ce moment. Le vert et l'ambre le disent avant
 * qu'on ait lu.
 *
 * Mêmes teintes que les assistants — un objet actif est vert partout — mais
 * la paire lecture/pause reprend les pictogrammes des DEUX boutons qui font
 * basculer l'état, pour qu'on voie du premier coup lequel appuyer.
 * Brouillon et archivée partagent le gris inerte : ni l'une ni l'autre
 * n'écrit, seul le pictogramme les distingue.
 */
export const CAMPAIGN_STATUS_LOOK: Record<string, Look> = {
  draft: { color: TONE.raw, Icon: PencilLineIcon },
  active: { color: "#10B981", Icon: PlayIcon },
  paused: { color: TONE.scrutiny, Icon: PauseIcon },
  archived: { color: TONE.raw, Icon: ArchiveIcon },
};

/**
 * Les quatre compteurs d'une campagne.
 *
 * Alignés en gris, « 14 réponses » et « 3 arrêts » pèsent le même poids. Ils
 * ne pèsent pas le même : une réponse est le but, un arrêt est un
 * désabonnement et ne se rattrape pas. Un bon taux de réponse avec beaucoup
 * d'arrêts n'est pas un succès — les deux chiffres doivent se distinguer sans
 * être lus.
 */
export const CAMPAIGN_STAT_LOOK: Record<string, Look> = {
  enrolled: { color: TONE.raw, Icon: UsersIcon },
  active: { color: "#3B82F6", Icon: ActivityIcon },
  replied: { color: "#10B981", Icon: MessageSquareReplyIcon },
  stopped: { color: "#EF4444", Icon: XOctagonIcon },
};

/**
 * Un barreau de l'échelle : QUAND il part, et QUI écrit son texte.
 *
 * Empilés, huit barreaux sont huit cartes identiques. Ce qu'on cherche en les
 * parcourant, c'est le rang et le délai ; et un barreau au message vide n'est
 * pas un barreau muet — c'est l'assistant qui rédigera, ce qui n'est pas la
 * même chose et ne se voit nulle part.
 */
export const CAMPAIGN_RUNG_LOOK: Record<string, Look> = {
  when: { color: TONE.speech, Icon: ClockIcon },
  written: { color: TONE.speech, Icon: MessageSquareTextIcon },
  byAssistant: { color: TONE.machinery, Icon: SparklesIcon },
};

/**
 * Les sept états d'une inscription.
 *
 * La table des inscriptions est la seule vue qui dise, personne par personne,
 * ce que la campagne a réellement fait. Rendus en badges gris identiques,
 * « En cours » et « Arrêtée » se ressemblent alors qu'ils sont opposés : l'un
 * reçoit encore des SMS, l'autre n'en recevra plus jamais.
 *
 * Quatre lectures seulement : bleu « en vol », vert « ça a marché », rouge
 * « ça s'est arrêté net », gris « hors jeu ». Les états qui partagent une
 * teinte se distinguent par leur pictogramme, jamais par la couleur seule.
 */
export const ENROLLMENT_STATUS_LOOK: Record<string, Look> = {
  pending: { color: TONE.raw, Icon: HourglassIcon },
  active: { color: "#3B82F6", Icon: ActivityIcon },
  // Pause MANUELLE (admin) : inscrite mais retirée de la file — l'orange de la
  // vigilance, comme la pause d'une campagne entière.
  paused: { color: TONE.scrutiny, Icon: PauseIcon },
  replied: { color: "#10B981", Icon: MessageSquareReplyIcon },
  booked: { color: "#10B981", Icon: CalendarCheckIcon },
  completed: { color: TONE.raw, Icon: CircleCheckIcon },
  stopped: { color: "#EF4444", Icon: XOctagonIcon },
  excluded: { color: TONE.raw, Icon: CircleSlashIcon },
};

/**
 * Les huit types de règle de garde-fou.
 *
 * Choisir un type, c'est décider CE QUI est examiné — et « motif interdit »,
 * « termes interdits » et « politique de liens » décrivent tous les trois, en
 * une ligne de texte gris, quelque chose qui fouille le brouillon. La couleur
 * les range par ce qu'ils regardent : les mots écrits, ce qui se compte, les
 * outils appelés, l'avis d'un modèle.
 *
 * Le gris de « instruction personnalisée » n'est pas une couleur qui manque :
 * cette règle-là n'analyse rien, elle ajoute seulement son texte au prompt, et
 * ne peut donc refuser aucun envoi — c'est la confusion que l'écran doit
 * empêcher, pas une nuance de style.
 */
export const GUARDRAIL_KIND_LOOK: Record<GuardrailKind, Look> = {
  forbidden_regex: { color: "#3B82F6", Icon: RegexIcon },
  forbidden_terms: { color: "#3B82F6", Icon: WholeWordIcon },
  link_policy: { color: "#3B82F6", Icon: LinkIcon },
  max_chars: { color: "#0EA5E9", Icon: RulerIcon },
  max_questions: { color: "#0EA5E9", Icon: BadgeQuestionMarkIcon },
  // Le même outil que l'onglet « Outils » : la règle parle bien de ça.
  required_tool_on_intent: { color: "#10B981", Icon: WrenchIcon },
  llm_judge: { color: TONE.machinery, Icon: ScaleIcon },
  custom_instruction: { color: TONE.raw, Icon: ScrollTextIcon },
};

/**
 * Le résultat d'UNE mise en situation — passée ou échouée.
 *
 * Quatorze lignes où seule la teinte du texte change se lisent une par une, et
 * pas du tout pour un œil qui confond le rouge et le vert. La forme du
 * pictogramme (coche / croix) porte la même information que la couleur, à côté
 * du libellé de la fixture.
 *
 * Distinct de `ASSISTANT_STATUS_LOOK.suite_*`, qui résume la suite ENTIÈRE
 * dans la liste des assistants : ici on montre une ligne, là un verdict.
 */
export const RESULT_LOOK = {
  pass: { color: "#10B981", Icon: CircleCheckIcon },
  fail: { color: "#EF4444", Icon: CircleXIcon },
} as const satisfies Record<string, Look>;

/**
 * D'où vient un texte : produit par l'application, ou repris à la main.
 *
 * Sept couches nommées « L0 … L6 » avec « Généré » ou « Modifié » en petit
 * gris — rien ne disait lesquelles avaient été reprises, et c'est pourtant la
 * seule chose qu'on cherche en ouvrant l'onglet. Le violet est celui de la
 * mécanique : quelqu'un a mis la main dedans, l'app n'écrit plus cette
 * partie-là. Sert aussi à la puce « Modifié » d'une règle semée.
 */
export const ORIGIN_LOOK = {
  generated: { color: TONE.raw, Icon: SparklesIcon },
  handwritten: { color: TONE.machinery, Icon: SquarePenIcon },
} as const satisfies Record<string, Look>;

/**
 * L'état d'un fil de conversation — CINQ lectures exclusives.
 *
 * La boîte de réception mélangeait tout dans la même pastille bleue : un
 * client qui attend une réponse, une panne de Twilio, un fil que l'assistant
 * mène tranquillement et un refus définitif se lisaient pareil. Cinq états,
 * un pictogramme et une teinte chacun, et un fil est TOUJOURS dans exactement
 * un des cinq :
 *
 *  · `attention` — une action humaine attend : l'ambre du « quelque chose à
 *    faire », partout dans l'application.
 *  · `human` — un humain tient la plume (IA en pause) : le bleu de la parole.
 *  · `ai` — l'assistant a écrit, le client n'a pas répondu : le violet de la
 *    mécanique.
 *  · `refused` — le contact a dit non : l'octogone d'arrêt, en gris — le
 *    verdict est rendu, ce n'est plus une alerte (le rouge reste à la puce
 *    « Désabonnement », qui est un interdit d'envoi, pas une humeur).
 *  · `concluded` — conclu sans refus (objectif atteint, hors cible) : le vert
 *    « rien à faire ».
 */
export const CONVERSATION_STATE_LOOK: Record<string, Look> = {
  attention: { color: TONE.scrutiny, Icon: MessageSquareWarningIcon },
  human: { color: TONE.speech, Icon: HandIcon },
  ai: { color: TONE.machinery, Icon: BotIcon },
  refused: { color: TONE.raw, Icon: XOctagonIcon },
  concluded: { color: "#10B981", Icon: CircleCheckIcon },
};

/**
 * Le MOTIF pour lequel un fil réclame quelqu'un — ou est terminé.
 *
 * Vingt motifs dans la même pastille se lisent un par un ; la couleur les
 * range d'abord par ce qu'il y a À FAIRE, et le pictogramme identifie :
 *
 *  · ambre — RÉPONDRE : le client attend un humain (nouveau message, demande
 *    de parler à quelqu'un, budget de l'assistant épuisé…).
 *  · rouge — RÉPARER : une panne technique a laissé le client sans réponse
 *    (modèle en panne, envoi en échec, réponse bloquée…).
 *  · vert / gris — TERMINÉ : l'objectif est atteint, ou le fil est clos sans
 *    suite ; il n'y a rien à faire.
 *  · le rouge de l'arrêt (octogone) reste réservé au désabonnement : plus
 *    aucun message ne partira jamais vers ce numéro.
 */
/**
 * Les deux FAMILLES de motifs qui réclament quelqu'un — l'en-tête de section.
 *
 * « Répondre » et « réparer » ne sont pas le même métier : l'un se traite au
 * téléphone ou au clavier, l'autre se rejoue ou se signale. La boîte de
 * réception les sépare en deux sections plutôt que de les entremêler.
 */
export const ATTENTION_KIND_LOOK: Record<"reply" | "engine", Look> = {
  reply: { color: TONE.scrutiny, Icon: MessageSquareReplyIcon },
  engine: { color: "#EF4444", Icon: CircleAlertIcon },
};

export const ATTENTION_LOOK: Record<string, Look> = {
  // Répondre — le client attend un humain.
  inbound: { color: TONE.scrutiny, Icon: MessageSquareDotIcon },
  client_wants_human: { color: TONE.scrutiny, Icon: UserRoundIcon },
  handoff: { color: TONE.scrutiny, Icon: HandIcon },
  guardrail: { color: TONE.scrutiny, Icon: ShieldIcon },
  booking_failed: { color: TONE.scrutiny, Icon: CalendarXIcon },
  max_turns: { color: TONE.scrutiny, Icon: HourglassIcon },
  no_assistant: { color: TONE.scrutiny, Icon: BotOffIcon },
  goal_chain_exhausted: { color: TONE.scrutiny, Icon: PackageOpenIcon },
  // Réparer — une panne a laissé le client sans réponse.
  llm_error: { color: "#EF4444", Icon: CpuIcon },
  no_text: { color: "#EF4444", Icon: MessageSquareOffIcon },
  blocked_output: { color: "#EF4444", Icon: ShieldXIcon },
  guardrail_unavailable: { color: "#EF4444", Icon: ShieldQuestionMarkIcon },
  send_failed: { color: "#EF4444", Icon: UnplugIcon },
  truncated: { color: "#EF4444", Icon: ScissorsIcon },
  content_filter: { color: "#EF4444", Icon: FilterXIcon },
  // Terminé — le verdict est rendu.
  closed_goal_reached: { color: "#10B981", Icon: TargetIcon },
  closed_disqualified: { color: TONE.raw, Icon: CircleSlashIcon },
  // Le seul verdict qu'aucune machine ne rend : un humain a clos le fil.
  closed_by_human: { color: TONE.raw, Icon: CheckCheckIcon },
  closed_not_interested: { color: TONE.raw, Icon: CircleXIcon },
  hard_refusal: { color: TONE.raw, Icon: MessageSquareXIcon },
  optout: { color: "#EF4444", Icon: XOctagonIcon },
};

/**
 * POURQUOI un texto n'est pas arrivé — les dix familles d'erreur de Twilio
 * (`ERROR_FAMILIES`), telles qu'elles se portent sur une rangée d'échec.
 *
 * La vue « Échecs » disait « Ce message n'est pas parti. Code 30007. » Personne
 * dans le bureau ne lit un nombre à cinq chiffres : on rappelait la personne
 * pour lui demander si elle avait reçu le texto — précisément le travail que ce
 * CRM devait épargner. Le mot vient du catalogue
 * (`@/lib/deliverability/error-text`) ; c'est ICI que vit son image.
 *
 * La couleur ne dit pas la gravité — tout est déjà rouge sur cet écran, la
 * rangée entière est un échec. Elle dit CE QU'ON PEUT EN FAIRE, en quatre
 * lectures, et c'est la seule question qu'on se pose devant la liste :
 *
 *  · rouge — rien ne passera en l'état : le contenu est filtré, la ligne est
 *    fermée, ou le numéro n'existe pas. Il faut changer quelque chose (le
 *    texte, le téléphone de la fiche) avant de renvoyer.
 *  · ambre — ça repassera : le combiné n'a pas répondu, la file sature, Twilio
 *    a trébuché. « Réessayer » plus tard est exactement le bon geste.
 *  · violet — NOTRE machine : compte, numéro expéditeur ou campagne A2P mal
 *    inscrits chez Twilio. Le destinataire n'y est pour rien, et aucun renvoi
 *    n'y changera quoi que ce soit tant que la paperasse n'est pas faite.
 *  · gris — on ne sait pas : l'opérateur a refusé sans motif, ou le code est
 *    trop neuf pour le catalogue.
 *
 * Aucune teinte neuve, et surtout pas le violet réservé du canal SMS : le
 * pictogramme identifie la famille, la couleur ne fait que la ranger.
 */
export const FAILURE_FAMILY_LOOK: Record<ErrorFamily, Look> = {
  // Rien ne passera en l'état.
  filtered: { color: SEVERITY_LOOK.block.color, Icon: FilterXIcon },
  blocked: { color: SEVERITY_LOOK.block.color, Icon: BanIcon },
  invalid: { color: SEVERITY_LOOK.block.color, Icon: PhoneOffIcon },
  // Ça repassera tout seul, ou au prochain essai.
  unreachable: { color: TONE.scrutiny, Icon: SignalZeroIcon },
  throughput: { color: TONE.scrutiny, Icon: GaugeIcon },
  platform: { color: TONE.scrutiny, Icon: ServerCrashIcon },
  // Notre paperasse chez Twilio — le destinataire n'y est pour rien.
  registration: { color: TONE.machinery, Icon: IdCardIcon },
  content: { color: TONE.machinery, Icon: FileWarningIcon },
  // On ne sait pas.
  carrier_other: { color: TONE.raw, Icon: RadioTowerIcon },
  other: { color: TONE.raw, Icon: CircleHelpIcon },
};

/**
 * Les trois choses qui peuvent ATTENDRE dans la file d'envoi.
 *
 * « Qui va recevoir un texto, et quand ? » — un message déjà écrit qui attend
 * son heure, une réponse que l'assistant est en train de composer, et un
 * barreau de campagne planifié à des jours d'ici ne sont pas la même
 * promesse : le premier a un texte qu'on peut lire (et annuler), le deuxième
 * n'existe pas encore, le troisième dépend d'une campagne qu'on règle
 * ailleurs.
 */
export const QUEUE_KIND_LOOK: Record<"send" | "turn" | "touch", Look> = {
  send: { color: "#0EA5E9", Icon: SendIcon },
  turn: { color: TONE.machinery, Icon: SparklesIcon },
  touch: { color: "#3B82F6", Icon: MegaphoneIcon },
};

/**
 * Les cinq types de tâche du MOTEUR, tels qu'ils se portent sur une tâche qui a
 * définitivement échoué (`scheduled_jobs.status = 'failed'`).
 *
 * Le bandeau d'état annonçait « 175 tâches en échec » et ne menait nulle part :
 * un nombre à trois chiffres, sans un écran pour dire de QUOI il s'agit. Or
 * cinq travaux très différents se cachent derrière ce mot — une réponse
 * d'assistant jamais écrite, un texto jamais parti, une note d'appel jamais
 * rédigée — et on ne répare pas les trois de la même façon.
 *
 * Le couple est REPRIS de la file d'envoi (`QUEUE_KIND_LOOK`) quand le concept
 * y existe déjà : la même tâche doit se reconnaître qu'elle attende son heure
 * ou qu'elle ait échoué. La couleur ne dit pas la gravité — tout est en échec
 * sur cet écran — elle dit CE QUE la tâche devait produire :
 *
 *  · cyan — un message précis, adressé à quelqu'un qu'on peut nommer ;
 *  · bleu — une campagne qui avance d'un barreau ;
 *  · violet — le modèle au travail (une réponse à composer, un enregistrement
 *    à écouter). Le destinataire n'a rien vu passer, et rien ne partira tant
 *    que le modèle n'a pas rendu son texte.
 *
 * `send_ladder` n'a pas encore de gestionnaire (phase 6 du moteur) : sa place
 * est réservée ici pour qu'une rangée écrite par une version future ne
 * retombe pas en pastille grise sans nom.
 */
export const JOB_TYPE_LOOK: Record<string, Look> = {
  send_sms: { color: QUEUE_KIND_LOOK.send.color, Icon: SendIcon },
  campaign_touch: { color: QUEUE_KIND_LOOK.touch.color, Icon: MegaphoneIcon },
  // Le barreau d'échelle, distinct de la relance : même famille, l'ordonné en
  // plus — c'est le rang qui le caractérise.
  send_ladder: { color: QUEUE_KIND_LOOK.touch.color, Icon: ListOrderedIcon },
  agent_turn: { color: QUEUE_KIND_LOOK.turn.color, Icon: SparklesIcon },
  // La seule tâche qui ne parle pas SMS : le modèle écoute un enregistrement
  // d'appel et en tire une note. Même violet — c'est le même modèle qui peine.
  call_transcript: { color: QUEUE_KIND_LOOK.turn.color, Icon: AudioLinesIcon },
};

/**
 * POURQUOI ce CRM ne peut plus texter un numéro — QUI a fermé la ligne.
 *
 * Le bandeau annonçait « 23 désabonnés », et le mot était faux pour dix-huit
 * d'entre eux : ce n'est pas le contact qui s'est désabonné, c'est NOTRE moteur
 * qui a supprimé le numéro pour toujours après un refus de l'opérateur (le code
 * 30003 de Twilio veut dire « téléphone éteint » — voir la contradiction C7
 * dans `@/lib/deliverability/error-classes`). Confondre les deux, c'est croire
 * que vingt-trois personnes ont demandé qu'on les laisse tranquilles alors que
 * cinq seulement l'ont fait.
 *
 * La couleur dit donc l'AUTORITÉ, la seule question qui décide si la rangée se
 * lève ou non :
 *
 *  · rouge — LE CONTACT a tranché. Le STOP est absolu (règle 12) : rien dans
 *    cet écran ne le lève, seul un START venant de lui rouvre la ligne. Même
 *    octogone d'arrêt que `ATTENTION_LOOK.optout`, qui dit déjà ça partout
 *    ailleurs dans l'application.
 *  · violet — NOTRE MACHINE a tranché, et personne ne l'a décidé. La prise
 *    débranchée plutôt que l'octogone : ce qu'on a débranché se rebranche.
 *  · bleu — QUELQU'UN D'ICI l'a fait à la main. Le bleu de la parole et la main
 *    de `CONVERSATION_STATE_LOOK.human` : une décision humaine, réversible.
 */
export const SUPPRESSION_LOOK: Record<string, Look> = {
  sms_stop: { color: SEVERITY_LOOK.block.color, Icon: XOctagonIcon },
  // Une plainte vient aussi du contact — elle se traite avec le même respect
  // que le STOP, mais elle n'a pas sa force de loi : elle reste levable.
  complaint: { color: SEVERITY_LOOK.block.color, Icon: MessageSquareWarningIcon },
  carrier_error: { color: TONE.machinery, Icon: UnplugIcon },
  manual: { color: TONE.speech, Icon: HandIcon },
};

/**
 * La teinte douce d'un concept, pour un fond de puce ou de bloc.
 *
 * Même recette que la pastille (`LookIcon`), en style en ligne : une couleur
 * de concept ne peut pas devenir une classe Tailwind, et la seule autre issue
 * serait d'écrire un hex dans un écran — exactement ce que ce fichier existe
 * pour empêcher.
 */
export function lookTint(look: Look) {
  return {
    color: look.color,
    backgroundColor: `color-mix(in srgb, ${look.color} 12%, transparent)`,
    borderColor: `color-mix(in srgb, ${look.color} 30%, transparent)`,
  };
}

/**
 * Le verdict d'un indicateur de délivrabilité — QUATRE lectures, jamais trois.
 *
 * « Tout va bien » et « on n'a pas pu savoir » se ressemblent dangereusement
 * sur un tableau de bord. Un taux calculé sur onze messages n'est pas vert :
 * il est inconnu, et le peindre en vert fait croire qu'on surveille une chose
 * qu'on ne surveille pas. `unknown` a donc son propre pictogramme ET sa propre
 * teinte, partout où un verdict s'affiche.
 *
 * Aucune teinte neuve : le vert du « rien à faire », l'ambre de ce qui
 * vérifie, le rouge de ce qui bloque, le gris de la matière brute. Un écran de
 * surveillance n'a pas à inventer une sixième palette.
 */
export const VERDICT_LOOK = {
  ok: { color: RESULT_LOOK.pass.color, Icon: ShieldCheckIcon },
  warn: { color: TONE.scrutiny, Icon: TriangleAlertIcon },
  danger: { color: SEVERITY_LOOK.block.color, Icon: XOctagonIcon },
  unknown: { color: TONE.raw, Icon: CircleHelpIcon },
} as const satisfies Record<string, Look>;

/**
 * Les cinq familles d'un constat de délivrabilité — CE QUI EST EN CAUSE, pas
 * sa gravité.
 *
 * La gravité est portée par `VERDICT_LOOK` et par elle seule. Confondre les
 * deux ferait clignoter la page en rouge pour une apostrophe courbe, et
 * l'opérateur cesserait de la regarder — ce qui est exactement le contraire du
 * but : un écran de délivrabilité ne sert que s'il est encore ouvert le jour
 * où un vrai filtrage commence.
 */
export const DELIVERABILITY_LOOK = {
  /** Est-ce arrivé ? Remise, filtrage, codes d'erreur du transporteur. */
  delivery: { color: QUEUE_KIND_LOOK.send.color, Icon: RadioTowerIcon },
  /** Qui a dit stop ? Désabonnements, suppressions, réponses hostiles. */
  consent: { color: SEVERITY_LOOK.block.color, Icon: HandIcon },
  /** Quelle FORME a le trafic ? Volume, rafales, essaimage, plafonds. */
  shape: { color: TONE.machinery, Icon: LayersIcon },
  /** Que dit le TEXTE ? Liens, marque, mention d'arrêt, encodage. */
  content: { color: TONE.speech, Icon: MessageSquareTextIcon },
  /** La machine tourne-t-elle ? Répartiteur, file, interrupteur, Twilio. */
  engine: { color: TONE.raw, Icon: ServerCogIcon },
} as const satisfies Record<string, Look>;

/**
 * Les quatre pastilles d'AUTORITÉ.
 *
 * La pastille dit le NIVEAU, le nom dit le rôle. C'est délibéré : les rôles
 * sont créés par l'administrateur, ils peuvent être quinze, et quinze
 * pictogrammes dans une colonne ne se distinguent plus. Ce qu'un œil doit
 * saisir d'un coup, c'est « celui-là a les clés » ou « celui-là ne fait que
 * regarder » — pas lequel des trois superviseurs c'est.
 *
 * Aucune teinte neuve : le violet de la mécanique pour qui règle la machine,
 * le bleu de la parole pour qui mène l'équipe, le vert du « c'est passé » pour
 * qui décroche le téléphone, le gris de la matière brute pour qui regarde.
 */
export const ROLE_LOOK = {
  /** Les clés de la maison : réglages, comptes, facturation. */
  admin: { color: TONE.machinery, Icon: ShieldCheckIcon },
  /** Mène l'équipe : voit tout, redistribue, ne configure rien. */
  supervisor: { color: TONE.speech, Icon: UsersIcon },
  /** Appelle. Ses fiches et le bassin. */
  caller: { color: RESULT_LOOK.pass.color, Icon: PhoneCallIcon },
  /** Regarde, et rien d'autre. */
  observer: { color: TONE.raw, Icon: EyeIcon },
} as const satisfies Record<string, Look>;

export type RoleLookKey = keyof typeof ROLE_LOOK;

/** La pastille d'un rôle — un look inconnu retombe sur la plus modeste. */
export function roleLook(key: string): Look {
  return ROLE_LOOK[key as RoleLookKey] ?? ROLE_LOOK.observer;
}

/**
 * Les trois familles de droits, dans l'ordre de l'écran « Rôles et droits ».
 *
 * Elles ne colorent pas des concepts nouveaux : elles reprennent la teinte de
 * ce qu'elles gouvernent. Le vert de qui travaille les fiches, le bleu de la
 * parole pour ce qui s'écrit, le violet de la mécanique pour ce qui règle la
 * machine. Surtout PAS le violet réservé du canal SMS : il ne dit pas
 * « messages », il dit « ceci sort de l'application », et il ne le dit que sur
 * une fiche client.
 */
export const PERMISSION_GROUP_LOOK = {
  clients: { color: ROLE_LOOK.caller.color, Icon: UserRoundIcon },
  conversations: { color: TONE.speech, Icon: MessagesSquareIcon },
  admin: { color: ROLE_LOOK.admin.color, Icon: SlidersHorizontalIcon },
} as const satisfies Record<string, Look>;
