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

/**
 * Les SIX formes du graphique d'activité.
 *
 * Ce n'est pas une galerie de styles : chaque forme répond à une question
 * différente, et c'est la question qu'on choisit, pas la décoration.
 *
 * - `stacked` — combien, et de quoi ? La forme par défaut : la hauteur porte le
 *   volume, les bandes la composition.
 * - `area`    — la même lecture, mais le CONTOUR prime sur la case. Sur 168
 *   heures, cent-soixante-huit barres se lisent comme une clôture ; une aire
 *   se lit comme une courbe.
 * - `line`    — comparer les familles ENTRE ELLES. Cinq lignes non empilées :
 *   on voit laquelle monte, on perd le total.
 * - `share`   — la PART, pas le volume. « Les SMS passent de 20 % à 40 % » est
 *   invisible dans une pile qui grossit. L'axe est en pourcentage, exprès.
 * - `combo`   — les colonnes plus une ligne de TENDANCE (moyenne mobile du
 *   total). Une seule échelle, une seule unité : jamais deux axes Y, qui
 *   inventent une corrélation absente des données.
 * - `donut`   — la composition de TOUTE la période, sans axe de temps. La seule
 *   forme qui ne répond pas à « quand » — elle répond à « de quoi est fait ce
 *   qu'on a fait ».
 *
 * Aucune forme de cette liste ne trahit la donnée : ni double axe Y, ni
 * camembert de séries temporelles, ni dégradé de valeur sur des catégories
 * nominales. Les barres GROUPÉES sont absentes exprès — à trente jours, cent
 * cinquante barres côte à côte ne se lisent plus, et `line` répond mieux à la
 * même question.
 */
export const ACTIVITY_FORMS = ["stacked", "area", "line", "share", "combo", "donut"] as const;
export type ActivityForm = (typeof ACTIVITY_FORMS)[number];

/** Résout `?form=` — défaut : la pile, qui dit le volume ET la composition. */
export function resolveForm(value: string | undefined): ActivityForm {
  return (ACTIVITY_FORMS as readonly string[]).includes(value ?? "")
    ? (value as ActivityForm)
    : "stacked";
}

/**
 * Cette forme a-t-elle un axe de temps ?
 *
 * L'anneau n'en a pas : la maille Heure / Jour / Semaine ne change rien à ce
 * qu'il dessine. Les boutons de maille se désactivent alors plutôt que de
 * disparaître — un bouton qui s'évapore fait douter de ce qu'on vient de
 * cliquer.
 */
export function formHasTimeAxis(form: ActivityForm): boolean {
  return form !== "donut";
}

/**
 * La fenêtre de la moyenne mobile de `combo`, en nombre de cases.
 *
 * Elle suit la longueur de la série plutôt que la maille : une tendance qui
 * lisse sur sept cases dit quelque chose sur trente jours et rien sur treize
 * semaines. Toujours IMPAIRE pour être centrable, jamais moins de 3 (en
 * dessous, la « tendance » est la donnée elle-même) ni plus de 25.
 */
export function trendWindow(bucketCount: number): number {
  const raw = Math.round(bucketCount / 8);
  return Math.min(25, Math.max(3, raw % 2 === 0 ? raw + 1 : raw));
}

/**
 * Moyenne mobile CENTRÉE, calculée sur les cases réellement présentes.
 *
 * Aux deux bouts, la fenêtre est tronquée et l'on divise par ce qu'on a — pas
 * par la largeur nominale. Diviser par la largeur ferait plonger la tendance
 * vers zéro au début et à la fin de chaque période, et on lirait une accalmie
 * là où il n'y a qu'un bord.
 */
export function movingAverage(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += values[j];
    return sum / (to - from);
  });
}
