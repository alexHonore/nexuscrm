import "server-only";
import enMessages from "../../../messages/en/notifications.json";
import frMessages from "../../../messages/fr/notifications.json";

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
