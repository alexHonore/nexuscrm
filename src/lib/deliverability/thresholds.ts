/**
 * Les seuils — un seul endroit, avec leur provenance.
 *
 * Module PUR. Trois règles qui tiennent tout l'écran :
 *
 *  · **Un seuil est la DERNIÈRE valeur encore acceptable.** Les comparaisons
 *    sont strictes : `warn` franchi veut dire « au-delà de warn », pas
 *    « à warn ». Écrit une fois ici, jamais réinterprété ailleurs.
 *  · **Sous `minSample`, le verdict est « inconnu », pas « bon ».** Deux échecs
 *    sur trois messages ne sont pas un taux d'échec de 67 % : c'est du bruit,
 *    et le peindre en rouge est la façon la plus sûre de faire ignorer un
 *    tableau de bord.
 *  · **La provenance voyage avec le seuil.** Presque aucun opérateur
 *    téléphonique ne publie ses barres. Faire passer un repère de fournisseur
 *    pour une règle d'opérateur fabrique une fausse certitude que plus
 *    personne ne saura défaire.
 */
import type { MetricId, MetricUnit, Provenance, Verdict } from "./types";
import { METRIC_IDS } from "./types";

/**
 * Sens de lecture d'un indicateur.
 *
 * `high` : monter est mauvais (taux d'échec, désabonnements).
 * `low`  : descendre est mauvais (taux de remise, taux de réponse).
 */
export type ThresholdDirection = "high" | "low";

export interface Threshold {
  metric: MetricId;
  direction: ThresholdDirection;
  /** Dernière valeur ENCORE bonne. */
  warn: number;
  /** Dernière valeur encore simplement inquiétante. */
  danger: number;
  /** En deçà de ce dénominateur, le verdict reste « inconnu ». */
  minSample: number;
  unit: MetricUnit;
  provenance: Provenance;
  /**
   * Indicateur de CONTEXTE : il se lit, il n'alarme jamais.
   *
   * Le taux de répétition en est l'exemple : une campagne conforme envoie le
   * même gabarit à tout le monde, et c'est exactement ce qu'elle a déclaré.
   * Alarmer là-dessus pousserait à varier les textes — or varier pour échapper
   * à la détection est justement ce que la politique de Twilio interdit. C'est
   * `template_spread` (le même texte sur PLUSIEURS numéros) qui alarme.
   */
  informational?: boolean;
}

const t = (
  metric: MetricId,
  direction: ThresholdDirection,
  warn: number,
  danger: number,
  minSample: number,
  unit: MetricUnit,
  provenance: Provenance,
  informational?: boolean,
): Threshold => ({ metric, direction, warn, danger, minSample, unit, provenance, informational });

/**
 * Fenêtre par défaut : 7 jours glissants pour tout ce qui bouge vite (remise,
 * filtrage, rafales), 30 jours pour ce qui a besoin de volume (désabonnement,
 * réponse). La fenêtre réelle est choisie par l'écran ; ces seuils ne
 * dépendent pas d'elle, sauf mention contraire dans le registre de constats.
 */
export const THRESHOLDS: Record<MetricId, Threshold> = {
  // ── Est-ce arrivé ? ───────────────────────────────────────────────────────
  /** Remis / (remis + non remis + échoué). Le dénominateur ignore ce qui vole encore. */
  delivered_rate: t("delivered_rate", "low", 0.95, 0.9, 50, "rate", "vendor"),
  /**
   * `sent` sans accusé de remise après 24 h. L'incident du 25 août 2026 est
   * né exactement là : les envois partaient, les rappels de statut n'arrivaient
   * plus, et le fil restait « En file » sans que rien n'ait l'air cassé.
   */
  no_dlr_rate: t("no_dlr_rate", "high", 0.02, 0.1, 50, "rate", "operational"),
  /** `queued`/`sending`/`accepted` immobiles depuis plus d'une heure. */
  stale_in_flight: t("stale_in_flight", "high", 0, 9, 0, "count", "operational"),
  /**
   * 30007 — filtré par l'opérateur téléphonique. LE signal de pourriel.
   * Pondéré en SEGMENTS : c'est le segment que le réseau compte, pas le message.
   */
  filtered_rate: t("filtered_rate", "high", 0, 0.01, 100, "rate", "carrier"),
  /** 30004 / 21610 — le destinataire ou l'opérateur bloque la ligne. */
  blocked_rate: t("blocked_rate", "high", 0, 0.005, 50, "rate", "carrier"),
  /**
   * 30005 / 30006 — numéro inconnu ou ligne fixe. Un taux qui monte dit une
   * chose sur la LISTE, pas sur les messages : des numéros achetés, périmés ou
   * mal saisis. Les opérateurs lisent ça comme du ratissage.
   */
  hard_invalid_rate: t("hard_invalid_rate", "high", 0.01, 0.03, 50, "rate", "vendor"),
  /**
   * 30003 en DÉRIVE, pas en niveau. « Téléphone éteint » a un niveau de fond
   * normal ; c'est sa hausse d'une période à l'autre qui trahit un filtrage
   * déguisé.
   */
  // Provenance « exploitation », pas « opérateur » : le MÉCANISME (30003) est
  // documenté par Twilio, mais les +2 et +5 points sont nos barres. Les
  // étiqueter « règle d'opérateur » fabriquait une autorité que le constat
  // lui-même dément deux lignes plus loin.
  unreachable_delta: t("unreachable_delta", "high", 0.02, 0.05, 50, "rate", "operational"),
  total_error_rate: t("total_error_rate", "high", 0.06, 0.1, 50, "rate", "vendor"),
  /** 30034 / 30032 / 30033 / 30037 / 30035 / 30024 — un envoi refusé faute d'inscription. */
  registration_blocks: t("registration_blocks", "high", 0, 0, 0, "count", "carrier"),
  /** 30001 / 21611 / 30022 / 30023 / 30450 / 30453 / 30454 — file ou débit saturé. */
  throughput_blocks: t("throughput_blocks", "high", 0, 4, 0, "count", "carrier"),

  // ── Qui a dit stop ? ─────────────────────────────────────────────────────
  /**
   * Le désabonnement est l'indicateur le plus regardé de tous : il ne se
   * discute pas, il ne se conteste pas, et il précède le filtrage.
   */
  optout_rate: t("optout_rate", "high", 0.01, 0.02, 100, "rate", "vendor"),
  /** Un seul message parti vers un numéro supprimé est déjà un de trop. */
  suppression_leak: t("suppression_leak", "high", 0, 0, 0, "count", "carrier"),
  carrier_suppressions: t("carrier_suppressions", "high", 0, 4, 0, "count", "operational"),
  /**
   * PROXY de plainte, jamais la plainte. Les signalements au 7726 arrivent à
   * l'agrégateur, pas sur la rangée du message : ils sont structurellement
   * hors de portée. Un mot hostile en réponse est ce qu'on peut voir — le dire
   * autrement serait présenter une approximation comme une mesure.
   */
  hostile_reply_rate: t("hostile_reply_rate", "high", 0.01, 0.03, 100, "rate", "operational"),

  // ── Quelle forme a le trafic ? ───────────────────────────────────────────
  /**
   * L'engagement est le contrepoids du volume : un trafic que personne ne lit
   * finit filtré même sans un mot de travers.
   */
  reply_rate: t("reply_rate", "low", 0.15, 0.05, 50, "rate", "vendor"),
  out_per_in: t("out_per_in", "high", 5, 10, 50, "ratio", "operational"),
  unanswered_tail: t("unanswered_tail", "high", 0.2, 0.4, 50, "rate", "operational"),
  /**
   * Un seul « ê » fait basculer TOUT le message en UCS-2 : 70 caractères par
   * segment au lieu de 160. Trois fois le prix, trois fois le volume réseau,
   * pour une apostrophe courbe.
   */
  ucs2_rate: t("ucs2_rate", "high", 0.05, 0.2, 50, "rate", "operational"),
  segments_per_message: t("segments_per_message", "high", 1.2, 2, 50, "ratio", "operational"),
  /**
   * LE constat d'essaimage : le même texte porté par plusieurs numéros. Nommé
   * mot pour mot dans les bonnes pratiques CTIA §5.5.2 et dans la politique de
   * messagerie de Twilio, qui juge sur « l'intention OU l'effet ».
   */
  template_spread: t("template_spread", "high", 1, 1, 0, "count", "carrier"),
  /** Contexte pur — voir `informational` ci-dessus. */
  duplication_rate: t("duplication_rate", "high", 1, 1, 100, "rate", "context", true),
  /** Destinataires distincts / messages du groupe. Bas = on écrit aux mêmes en boucle. */
  reach_concentration: t("reach_concentration", "low", 0.9, 0.5, 50, "rate", "operational"),
  sender_consistency: t("sender_consistency", "high", 0, 0, 0, "count", "carrier"),
  daily_cap_headroom: t("daily_cap_headroom", "high", 0.7, 0.95, 0, "rate", "operational"),
  burst_factor: t("burst_factor", "high", 5, 15, 200, "ratio", "operational"),
  quiet_hours_violations: t("quiet_hours_violations", "high", 0, 2, 0, "count", "carrier"),
  /**
   * L'inscription A2P 10DLC se déclenche sur la DESTINATION, pas sur
   * l'expéditeur : un courtier qui n'écrit qu'au Québec n'a rien à inscrire.
   * Dès qu'un mobile américain entre dans la liste, la question change.
   */
  us_bound_share: t("us_bound_share", "high", 0, 0.05, 50, "rate", "carrier"),

  // ── La machine tourne-t-elle ? ───────────────────────────────────────────
  /** Minutes depuis le dernier passage du répartiteur — même barre que le préflight. */
  dispatcher_age: t("dispatcher_age", "high", 15, 60, 0, "minutes", "operational"),
  queue_backlog: t("queue_backlog", "high", 20, 100, 0, "count", "operational"),
};

/**
 * Le verdict d'une valeur. `null` (rien à mesurer) et un dénominateur trop
 * mince donnent tous deux « inconnu » — délibérément le même mot, parce que
 * c'est la même situation vue de l'écran : on ne sait pas.
 */
export function verdictFor(metric: MetricId, value: number | null, denominator: number): Verdict {
  const threshold = THRESHOLDS[metric];
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (denominator < threshold.minSample) return "unknown";
  if (threshold.informational) return "ok";
  if (threshold.direction === "high") {
    if (value > threshold.danger) return "danger";
    if (value > threshold.warn) return "warn";
    return "ok";
  }
  if (value < threshold.danger) return "danger";
  if (value < threshold.warn) return "warn";
  return "ok";
}

/** Le seuil réellement franchi — celui qu'on affiche à côté du chiffre. */
export function thresholdFor(metric: MetricId, verdict: Verdict): number | null {
  const threshold = THRESHOLDS[metric];
  if (verdict === "danger") return threshold.danger;
  if (verdict === "warn") return threshold.warn;
  return null;
}

/** Le pire de deux verdicts. Un calcul peut escalader, jamais adoucir. */
export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { ok: 0, unknown: 1, warn: 2, danger: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/** Garde-fou de développement : aucun indicateur ne part sans seuil. */
export const METRICS_WITHOUT_THRESHOLD = METRIC_IDS.filter((id) => !THRESHOLDS[id]);
