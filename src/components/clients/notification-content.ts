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
