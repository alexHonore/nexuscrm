import {
  ActivityIcon,
  ArchiveIcon,
  BadgeQuestionMarkIcon,
  BookOpenTextIcon,
  BracesIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClipboardCheckIcon,
  ClipboardXIcon,
  ClockIcon,
  CpuIcon,
  EyeIcon,
  FileCheckIcon,
  FilterIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  HandIcon,
  HourglassIcon,
  IdCardIcon,
  LinkIcon,
  ListChecksIcon,
  ListOrderedIcon,
  MailIcon,
  MessageCircleQuestionMarkIcon,
  MessageSquareReplyIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  UserSearchIcon,
  PauseIcon,
  PencilLineIcon,
  PhoneCallIcon,
  PlayIcon,
  PowerIcon,
  QuoteIcon,
  RefreshCwIcon,
  RegexIcon,
  RulerIcon,
  ScaleIcon,
  ScrollTextIcon,
  SearchCheckIcon,
  ShieldIcon,
  SignpostIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  SplitIcon,
  SquareArrowOutUpRightIcon,
  SquarePenIcon,
  TargetIcon,
  UsersIcon,
  VideoIcon,
  WholeWordIcon,
  WrenchIcon,
  XOctagonIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
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
