/**
 * Le vocabulaire du graphique « Activité » — partagé serveur / client, comme
 * `period.ts`.
 *
 * Cinq familles, et pas une de plus. Ce n'est pas un plafond esthétique : au
 * delà, les bandes d'une pile ne se distinguent plus et la légende devient un
 * tableau qu'on ne lit pas. Un sixième geste à compter rejoint une famille
 * existante — c'est ce que font déjà `notes` (commentaires ET suivis) et
 * `records` (fiches créées ET modifiées).
 *
 * L'ORDRE de `ACTIVITY_KINDS` est l'ordre de la pile, et il est porteur : les
 * couleurs ne passent le validateur dataviz que sur cette suite-là (voir
 * `viz-theme.tsx`). Ne pas réordonner sans relancer le validateur.
 */

export const ACTIVITY_KINDS = ["calls", "bookings", "sms", "notes", "records"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** La couleur d'une famille — une variable du conteneur `.nx-viz`, jamais un hex. */
export const ACTIVITY_VAR: Record<ActivityKind, string> = {
  calls: "var(--viz-act-calls)",
  bookings: "var(--viz-act-bookings)",
  sms: "var(--viz-act-sms)",
  notes: "var(--viz-act-notes)",
  records: "var(--viz-act-records)",
};

export const ACTIVITY_GRAINS = ["hour", "day", "week"] as const;
export type ActivityGrain = (typeof ACTIVITY_GRAINS)[number];

/** Résout `?grain=` — défaut : le jour, la maille qu'on lit sans réfléchir. */
export function resolveGrain(value: string | undefined): ActivityGrain {
  return (ACTIVITY_GRAINS as readonly string[]).includes(value ?? "")
    ? (value as ActivityGrain)
    : "day";
}

/**
 * Au-delà de cette longueur de période, « Heure » cesse d'être une frise.
 *
 * Trente jours heure par heure font 720 barres pour 900 pixels : on ne lit
 * plus rien, et surtout on ne peut plus pointer une heure. Passé le seuil, la
 * même case montre le PROFIL DE LA JOURNÉE — les 24 heures cumulées sur toute
 * la période, « à quelle heure l'équipe travaille ». Les deux lectures sont
 * légitimes ; ce qui ne le serait pas, c'est de basculer sans le dire. L'écran
 * l'annonce en toutes lettres sous le titre.
 */
export const HOUR_TIMELINE_MAX_DAYS = 7;

/** La maille « heure » montre-t-elle une frise, ou le profil 0h–23h ? */
export function isHourProfile(grain: ActivityGrain, dayCount: number): boolean {
  return grain === "hour" && dayCount > HOUR_TIMELINE_MAX_DAYS;
}
