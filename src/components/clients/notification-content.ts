import "server-only";
import enMessages from "../../../messages/en/notifications.json";
import frMessages from "../../../messages/fr/notifications.json";
import { formatPhone } from "@/lib/phone";

const CONTENT = { fr: frMessages.content, en: enMessages.content } as const;

type ContentKey = keyof typeof CONTENT.fr;

/**
 * Localized text for notifications persisted in DB (mentions, cron reminders).
 * Strings live in messages/{fr,en}/notifications.json under "content" — we
 * interpolate manually because these run outside a request locale (cron) or
 * must use the RECIPIENT's locale, not the author's.
 */
export function notificationContent(
  locale: "fr" | "en",
  key: ContentKey,
  vars: Record<string, string> = {},
): string {
  let text: string = CONTENT[locale][key] ?? CONTENT.fr[key];
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, value);
  }
  return text;
}

/**
 * Destination des notifications d'appel manqué sans fiche client. Fenêtre de
 * 30 jours : la notification peut dater d'hier (synchro CDR du matin) — le
 * filtre par défaut « aujourd'hui » cacherait l'appel.
 */
export const MISSED_CALLS_LINK = "/calls?direction=inbound&missed=1&period=30";

/**
 * Ligne de notification « appel manqué », identique quel que soit le chemin
 * qui l'a détecté (webphone, synchro CDR voip.ms, rappel TwiML Twilio).
 */
export function missedCallNotification(opts: {
  userId: string;
  locale: "fr" | "en";
  client: { id: string; fullName: string } | null;
  /** E.164, ou null si le numéro est masqué. */
  fromNumber: string | null;
}): { userId: string; type: string; title: string; body: string | null; link: string } {
  const number = opts.fromNumber ? formatPhone(opts.fromNumber) : null;
  const body =
    opts.client && number
      ? notificationContent(opts.locale, "missedCallKnownBody", {
          name: opts.client.fullName,
          number,
        })
      : (opts.client?.fullName ??
        (number ? notificationContent(opts.locale, "missedCallUnknownBody", { number }) : null));
  return {
    userId: opts.userId,
    type: "missed_call",
    title: notificationContent(opts.locale, "missedCallTitle"),
    body,
    link: opts.client ? `/clients/${opts.client.id}` : MISSED_CALLS_LINK,
  };
}

/**
 * QUI doit apprendre qu'un appel entrant n'a pas été pris.
 *
 * Deux personnes, et pour deux raisons différentes :
 *
 * - **Le propriétaire de la ligne** : son téléphone a sonné dans le vide. C'est
 *   lui qui rappelle, tout de suite, et c'est la notification qui existait déjà.
 * - **Le détenteur de la fiche** : « son » client vient d'appeler. Il ne le
 *   savait pas — l'appel a sonné ailleurs, sur la ligne principale ou chez un
 *   collègue — et c'est pourtant lui qui connaît le dossier, la dernière
 *   objection, le rendez-vous qu'on attendait. Sans cette ligne-ci, un rappel
 *   se perdait entre deux personnes qui croyaient chacune que l'autre s'en
 *   occupait.
 *
 * Trois règles, toutes dictées par des cas réels :
 *
 * 1. JAMAIS deux fois la même personne. Quand le détenteur EST le propriétaire
 *    de la ligne — le cas le plus courant, puisqu'on appelle le numéro qu'on a
 *    reçu — il ne reçoit qu'une notification. Deux lignes identiques dans la
 *    cloche feraient douter du compte, et deux vibrations feraient couper les
 *    notifications de l'application entière.
 * 2. La notification du détenteur NOMME le client ; celle du propriétaire de
 *    la ligne seulement si `visibleToLineOwner` — une notification est du
 *    contenu qui SURVIT, et elle nommerait pour toujours une fiche que l'écran
 *    refuse d'afficher.
 *
 *    Ne PAS lire ça comme « le détenteur voit forcément sa fiche » : c'est
 *    faux. La case `own` d'un rôle sur mesure est semée FERMÉE
 *    (`src/lib/permissions/schema.ts`), rien ne la garantit. Ce qui rend le
 *    geste sûr est ailleurs, et existait déjà : l'écran de la cloche masque
 *    toute ligne dont le lien mène à une fiche hors de portée, et `fanoutPush`
 *    refait la même vérification avant d'envoyer. Une notification écrite pour
 *    quelqu'un qui n'a pas le droit de voir la fiche ne fuit donc rien — elle
 *    ne s'affiche pas et ne part pas. Nommer le client ici est le choix utile
 *    dans le cas normal, et sans risque dans le cas tordu.
 * 3. Un compte désactivé n'est pas un destinataire. L'appelant résout
 *    `assignee` à `null` dans ce cas — la règle ne peut pas le savoir seule, et
 *    c'est délibéré : ce module reste PUR, sans base ni réseau, pour que les
 *    quatre chemins qui l'appellent (webphone, PATCH d'appel, TwiML Twilio,
 *    synchro CDR) partagent la MÊME règle au lieu de la réécrire chacun à leur
 *    façon — c'est exactement comme ça qu'ils avaient fini par diverger.
 */
export function missedCallRows(opts: {
  /** Celui dont la ligne a sonné. */
  lineOwner: { id: string; locale: string };
  /** Le détenteur de la fiche, s'il y en a un et qu'il est ACTIF. */
  assignee: { id: string; locale: string } | null;
  client: { id: string; fullName: string } | null;
  /** Le propriétaire de la ligne a-t-il le droit de voir cette fiche ? */
  visibleToLineOwner: boolean;
  /** E.164, ou null si le numéro est masqué. */
  fromNumber: string | null;
}): ReturnType<typeof missedCallNotification>[] {
  const asLocale = (value: string): "fr" | "en" => (value === "en" ? "en" : "fr");

  const rows = [
    missedCallNotification({
      userId: opts.lineOwner.id,
      locale: asLocale(opts.lineOwner.locale),
      client: opts.visibleToLineOwner ? opts.client : null,
      fromNumber: opts.fromNumber,
    }),
  ];

  // Sans fiche, il n'y a pas de détenteur à prévenir : un numéro inconnu
  // n'appartient à personne.
  if (opts.client && opts.assignee && opts.assignee.id !== opts.lineOwner.id) {
    rows.push(
      missedCallNotification({
        userId: opts.assignee.id,
        locale: asLocale(opts.assignee.locale),
        client: opts.client,
        fromNumber: opts.fromNumber,
      }),
    );
  }

  return rows;
}

/** Turn "@[Name](uuid)" tokens into plain "@Name" and clamp for excerpts. */
export function commentExcerpt(body: string, max = 140): string {
  const plain = body.replace(/@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g, "@$1").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** Extract mentioned user ids from "@[Name](uuid)" tokens (deduplicated). */
export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>();
  // UUID strict : un « id » de 36 caractères non conforme (ex. 36 tirets) ferait
  // échouer la requête Postgres sur une colonne uuid.
  for (const match of body.matchAll(
    /@\[[^\]]+\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g,
  )) {
    ids.add(match[1]);
  }
  return [...ids];
}
