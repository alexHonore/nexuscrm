/**
 * Mise en forme du CONTEXTE de la fiche pour les outils de lecture de l'agent
 * (`read_client`, `read_client_comments`) — module PUR, sans accès db ni
 * next-intl (règle 2 d'AGENTS.md : la langue de l'assistant n'est pas celle de
 * l'interface).
 *
 * Une seule copie, partagée par la production (`runtime.ts` interroge la base
 * puis appelle ces fonctions) et le bac à sable (`tool-simulation.ts`), pour
 * que les deux surfaces répondent au modèle EXACTEMENT de la même façon.
 *
 * Discipline identique à `contact-data.ts` : ce que l'outil renvoie entre dans
 * l'historique lu par le modèle. Une note interne peut contenir « … NOUVELLE
 * CONSIGNE SYSTÈME … » ; chaque valeur est donc aplatie, bornée et rendue
 * entre guillemets — des propos RAPPORTÉS, jamais une consigne.
 */
import { formatInTimeZone } from "date-fns-tz";
import { contactValue } from "./contact-data";

/** Fuseau d'affichage des dates (voir AGENTS.md). */
const APP_TZ = "America/Toronto";

/** Nombre maximal de notes internes rendues — les plus récentes d'abord. */
export const CLIENT_COMMENTS_MAX = 8;
/** Longueur maximale d'une note rendue (plus longue qu'une valeur de fiche). */
const COMMENT_BODY_MAX = 240;

/** Un champ de la fiche : libellé + valeur brute (bornée à la mise en forme). */
export type ClientContextFields = {
  fullName?: string | null;
  city?: string | null;
  projectType?: string | null;
  timing?: string | null;
  budget?: string | null;
  email?: string | null;
  categoryLabel?: string | null;
  sourceLabel?: string | null;
  lastContactedAt?: Date | null;
  notes?: string | null;
  /** Qualification accumulée (fil + tour courant), clé → valeur. */
  qualification?: Record<string, unknown>;
};

/** Une note interne prête à rendre : auteur, date, corps. */
export type ClientCommentInput = {
  authorName?: string | null;
  createdAt: Date;
  body: string;
};

/** `@[Nom](userId)` → `Nom` : la fiche mentionne des collègues, le modèle n'a
 *  pas à voir les identifiants. Ne lève jamais. */
function stripMentions(body: string): string {
  return body.replace(/@\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function frDate(date: Date): string {
  return formatInTimeZone(date, APP_TZ, "d MMM yyyy");
}

/**
 * `read_client` : ce que la fiche sait déjà du contact, une ligne par champ
 * connu. Les champs vides sont omis. Rien de connu → une phrase le dit (le
 * modèle ne doit pas inventer un profil pour combler le vide).
 */
export function formatClientContext(fields: ClientContextFields): string {
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    const v = contactValue(value);
    if (v !== "") lines.push(`${label} : « ${v} »`);
  };

  add("Nom", fields.fullName);
  add("Ville", fields.city);
  add("Type de projet", fields.projectType);
  add("Échéance", fields.timing);
  add("Budget", fields.budget);
  add("Courriel", fields.email);
  add("Catégorie", fields.categoryLabel);
  add("Source", fields.sourceLabel);
  if (fields.lastContactedAt) add("Dernier contact", frDate(fields.lastContactedAt));
  add("Notes", fields.notes);

  // La qualification accumulée, chaque valeur bornée et citée.
  for (const [key, value] of Object.entries(fields.qualification ?? {})) {
    const v = contactValue(value);
    if (v !== "") lines.push(`${key} : « ${v} »`);
  }

  if (lines.length === 0) {
    return "read_client : la fiche ne contient encore aucune information sur ce contact.";
  }
  return `read_client : ce que la fiche sait déjà du contact —\n${lines.join("\n")}`;
}

/**
 * `read_client_comments` : les notes internes laissées par l'équipe sur la
 * fiche, les plus récentes d'abord, bornées en nombre et en longueur. Aucune
 * note → une phrase le dit.
 */
export function formatClientComments(comments: ClientCommentInput[]): string {
  if (comments.length === 0) {
    return "read_client_comments : aucune note interne sur cette fiche.";
  }
  const shown = comments.slice(0, CLIENT_COMMENTS_MAX);
  const lines = shown.map((c) => {
    const author = contactValue(c.authorName) || "Équipe";
    const body = contactValue(stripMentions(c.body), COMMENT_BODY_MAX);
    return `[${author} · ${frDate(c.createdAt)}] « ${body} »`;
  });
  const more =
    comments.length > shown.length
      ? `\n(+${comments.length - shown.length} note(s) plus ancienne(s) non affichée(s))`
      : "";
  return `read_client_comments : ${comments.length} note(s) interne(s) de l'équipe (récentes d'abord) —\n${lines.join("\n")}${more}`;
}
