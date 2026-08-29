/**
 * Ce qui a le droit de faire vibrer un téléphone, et ce qui peut attendre.
 *
 * Module PUR : aucune base, aucun `next-intl`, aucun cookie. Une notification
 * poussée est écrite pour son DESTINATAIRE, souvent depuis un cron ou un
 * webhook où il n'y a pas de requête et donc pas de langue d'interface (règle
 * 2). Tout ce qui est ici doit pouvoir se tester sans allumer quoi que ce soit.
 *
 * La liste est FERMÉE et exhaustive : un type de notification ajouté au produit
 * sans décision de poussée serait silencieusement muet sur les téléphones —
 * exactement la panne qu'on ne remarque jamais. `tests/unit-push-policy.test.ts`
 * refuse un type inconnu.
 */

import type { PushUrgency } from "./send";

/** Les treize types que la table `notifications` produit aujourd'hui. */
export const NOTIFICATION_TYPES = [
  "mention",
  "followup_due",
  "incoming_lead",
  "appointment",
  "system",
  "missed_call",
  "assignment",
  "sms_inbound",
  "sms_handoff",
  "sms_blocked",
  "sms_error",
  "sms_stopped",
  "sms_closed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * L'urgence au sens de la RFC 8030 — une indication consommée par le service
 * de push et le système, PAS une priorité « voix » : rien sur le web ne sonne
 * comme un appel. `high` demande seulement à ne pas être mis en file derrière
 * l'économie de batterie.
 *
 * Le type vient du TRANSPORT et n'est pas redéclaré ici : deux définitions
 * jumelles se seraient séparées au premier ajout, et la politique se serait
 * mise à produire une urgence que l'envoi refuse — un `cast` dans le
 * répartiteur l'aurait masqué jusqu'à la première notification perdue.
 */
export type { PushUrgency };

export type PushRule = {
  /** Pousse-t-on ce type par défaut ? */
  push: boolean;
  urgency: PushUrgency;
  /**
   * Durée de vie chez le service de push, en secondes. Une notification
   * d'appel manqué qui arrive deux heures plus tard n'informe plus : elle
   * ment. Zéro = « livre maintenant ou jette ».
   */
  ttl: number;
  /**
   * Traverse-t-il les heures de silence du téléphoniste ? Un appel manqué à
   * 21 h 30 est précisément ce pour quoi l'application a été installée ; un
   * rappel de suivi à 6 h 30 ne l'est pas.
   */
  urgent: boolean;
  /**
   * Comment les notifications se REMPLACENT sur l'écran. Cinq textos d'un même
   * client doivent laisser UNE ligne, pas cinq — sinon le premier réflexe du
   * téléphoniste est de couper les notifications de l'application entière.
   * `client` = une par fiche, `type` = une par catégorie, `none` = jamais
   * fusionnée.
   */
  collapse: "client" | "type" | "none";
};

const RULES: Record<NotificationType, PushRule> = {
  // Le cœur de la demande : « un client appelle le téléphone du téléphoniste ».
  // C'est la seule notification qui vaut d'être reçue au restaurant.
  missed_call: { push: true, urgency: "high", ttl: 1800, urgent: true, collapse: "none" },

  // Un texto sur un fil SANS assistant : personne d'autre ne va répondre.
  sms_inbound: { push: true, urgency: "high", ttl: 3600, urgent: true, collapse: "client" },
  // L'assistant rend la main : c'est LE moment où un humain est requis.
  sms_handoff: { push: true, urgency: "high", ttl: 3600, urgent: true, collapse: "client" },
  // Le fil attend un humain parce que quelque chose a échoué. Important, mais
  // ce n'est pas un client qui parle : cela peut attendre le matin.
  sms_blocked: { push: true, urgency: "normal", ttl: 7200, urgent: false, collapse: "client" },
  sms_error: { push: true, urgency: "normal", ttl: 7200, urgent: false, collapse: "client" },
  sms_stopped: { push: true, urgency: "normal", ttl: 7200, urgent: false, collapse: "client" },
  // L'assistant a fermé la conversation proprement : rien à faire, rien à
  // réveiller. La ligne reste dans la cloche pour qui la consulte.
  sms_closed: { push: false, urgency: "low", ttl: 0, urgent: false, collapse: "client" },

  // Un prospect qui vient d'entrer se rappelle dans les minutes qui suivent :
  // c'est la notification qui rapporte le plus d'argent de la liste.
  incoming_lead: { push: true, urgency: "high", ttl: 3600, urgent: true, collapse: "none" },
  mention: { push: true, urgency: "normal", ttl: 86400, urgent: false, collapse: "client" },
  assignment: { push: true, urgency: "normal", ttl: 86400, urgent: false, collapse: "client" },
  followup_due: { push: true, urgency: "normal", ttl: 21600, urgent: false, collapse: "type" },
  appointment: { push: true, urgency: "normal", ttl: 86400, urgent: false, collapse: "none" },

  // Avertissements d'exploitation (jeton Google expiré, etc.). Ils s'adressent
  // à quelqu'un devant un écran, pas à quelqu'un dans une voiture.
  system: { push: false, urgency: "low", ttl: 0, urgent: false, collapse: "type" },
};

/** Le repli d'un type inconnu : on prévient, sans urgence — jamais le silence. */
const UNKNOWN: PushRule = {
  push: true,
  urgency: "normal",
  ttl: 86400,
  urgent: false,
  collapse: "type",
};

export function pushRule(type: string): PushRule {
  return RULES[type as NotificationType] ?? UNKNOWN;
}

export function isKnownNotificationType(type: string): type is NotificationType {
  return type in RULES;
}

/**
 * L'étiquette qui décide des fusions à l'écran. Elle sert aussi de `Topic`
 * RFC 8030 côté service de push : deux notifications de même sujet, la seconde
 * remplace la première AVANT même d'arriver sur le téléphone éteint.
 */
export function collapseTag(type: string, link: string | null): string {
  const rule = pushRule(type);
  if (rule.collapse === "none") return `${type}:${link ?? ""}`;
  if (rule.collapse === "type") return type;
  const clientId = link?.match(
    /^\/clients\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
  )?.[1];
  return clientId ? `client:${clientId}` : `${type}:${link ?? ""}`;
}

/**
 * Le `Topic` de la RFC 8030 doit tenir dans 32 caractères de l'alphabet
 * base64url. Notre étiquette est plus bavarde (« client:<uuid> ») : on la
 * réduit par empreinte plutôt que de la tronquer, sinon deux fiches dont les
 * UUID commencent pareil s'écraseraient l'une l'autre.
 */
export function topicOf(tag: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < tag.length; i++) {
    h1 = Math.imul(h1 ^ tag.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + tag.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `t${h1.toString(36)}${h2.toString(36)}`.slice(0, 32);
}

// ── Les heures de silence du téléphoniste ────────────────────────────────────

/**
 * À ne pas confondre avec `src/lib/sms/quiet-hours.ts` : celles-là protègent le
 * CLIENT de nos envois (politesse, conformité) ; celles-ci protègent l'EMPLOYÉ
 * de son employeur. Les deux fenêtres n'ont aucune raison de coïncider, et les
 * confondre rendrait l'application inutile aux deux bouts de la journée — un
 * courtier immobilier travaille précisément quand ses clients sont chez eux.
 *
 * Une fenêtre qui enjambe minuit (22:00 → 07:00) est le cas NORMAL, pas le cas
 * limite : c'est la seule forme qu'une nuit puisse prendre.
 */
export function isWithinQuietHours(
  minutesOfDay: number,
  from: string | null,
  to: string | null,
): boolean {
  const start = parseHhMm(from);
  const end = parseHhMm(to);
  if (start === null || end === null) return false;
  if (start === end) return false;
  return start < end
    ? minutesOfDay >= start && minutesOfDay < end
    : minutesOfDay >= start || minutesOfDay < end;
}

export function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export type ReachPrefs = {
  pushPrefs: Record<string, boolean> | null;
  quietFrom: string | null;
  quietTo: string | null;
  quietBypassUrgent: boolean;
};

/**
 * La décision finale pour UN destinataire et UN type.
 *
 * L'absence de préférence vaut « oui » : un téléphoniste qui n'a jamais ouvert
 * l'écran des réglages doit recevoir ce qui compte. C'est le SILENCE qui se
 * demande, jamais le bruit — l'inverse produit une application installée qui
 * ne fait rien et qu'on croit cassée.
 */
export function shouldPush(
  type: string,
  prefs: ReachPrefs | null,
  minutesOfDay: number,
): { push: boolean; reason: "ok" | "type_off" | "user_off" | "quiet_hours" } {
  const rule = pushRule(type);
  if (!rule.push) return { push: false, reason: "type_off" };
  if (prefs?.pushPrefs && prefs.pushPrefs[type] === false) {
    return { push: false, reason: "user_off" };
  }
  if (prefs && isWithinQuietHours(minutesOfDay, prefs.quietFrom, prefs.quietTo)) {
    if (!(rule.urgent && prefs.quietBypassUrgent)) {
      return { push: false, reason: "quiet_hours" };
    }
  }
  return { push: true, reason: "ok" };
}
