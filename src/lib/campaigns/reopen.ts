import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { nextTouchAt } from "./ladder";
import type { LadderStep } from "./schema";
import { nextSendTime, type QuietHours } from "@/lib/sms/quiet-hours";

/**
 * Calendrier d'une RELANCE — module PUR, horloge et hasard injectés.
 *
 * Relancer, c'est réveiller d'un coup des inscriptions endormies depuis des
 * semaines. La date « naturelle » — celle de `resumeEnrollment`, à savoir
 * `dernier envoi + délai du barreau` — tombe alors toujours dans le PASSÉ :
 * toutes deviennent dues au même instant, et le planificateur les sert dans
 * l'ordre du `next_touch_at` le plus ancien. Trois conséquences, toutes
 * mauvaises :
 *
 *  · le numéro expéditeur crache tout ce que le cycle peut porter, jusqu'à son
 *    plafond du jour — c'est ainsi qu'un DID se fait classer indésirable ;
 *  · au-delà du plafond, l'envoi est REPORTÉ au lendemain matin alors que le
 *    barreau, lui, a déjà été tracé « envoyé » et a programmé le suivant
 *    depuis aujourd'hui : l'échelle raconte une histoire fausse ;
 *  · datées dans le passé, ces inscriptions passent DEVANT les campagnes
 *    vivantes à chaque cycle et les affament.
 *
 * D'où ce module : la relance ne pose jamais une date passée, et elle étale
 * les départs de façon à ne pas atteindre le plafond du numéro. L'étalement
 * n'est pas un chiffre inventé — il se DÉDUIT du plafond : une journée d'envoi
 * divisée par ce que le numéro s'autorise.
 */

/**
 * Durée d'une journée d'envoi, sur laquelle l'étalement se répartit — la
 * fenêtre de politesse par défaut, 9 h → 20 h.
 */
const SEND_WINDOW_MS = 11 * 60 * 60 * 1000;

/** En deçà, l'étalement ne protège plus de rien : deux SMS dans la même minute. */
const MIN_SPACING_MS = 60 * 1000;

/**
 * Délai de grâce avant le premier départ.
 *
 * Un webhook entrant ou une action de conversation déclenche un cycle de
 * dispatch immédiat (`kickDispatch`) : sans cette minute d'avance, le premier
 * barreau relancé pourrait partir dans la seconde qui suit le clic, et
 * l'administrateur n'aurait aucune fenêtre pour se raviser. Avec elle, la mise
 * en pause en lot — qui existe déjà — fait office d'annulation.
 */
export const REOPEN_GRACE_MS = 15 * 60 * 1000;

/**
 * Plafond d'un seul geste. Même ordre de grandeur que l'ajout en lot
 * (`MAX_BATCH`) et que les libérations de `match.ts` : au-delà, une requête
 * HTTP n'est plus le bon outil, et le reste se relance au clic suivant.
 */
export const MAX_REOPEN = 500;

export interface ReopenRow {
  id: string;
  /** Prochain barreau à envoyer — jamais rembobiné par une relance. */
  step: number;
  enrolledAt: Date;
  lastTouchAt: Date | null;
  /**
   * Heures de travail de l'assistant qui prendra CE fil, quand elles diffèrent
   * de celles de la campagne. L'envoi les rejoue au moment de partir : planifier
   * avec une fenêtre et faire appliquer l'autre replierait tout le lot sur la
   * même ouverture, et l'étalement disparaîtrait.
   */
  quietHours?: QuietHours;
}

export interface ReopenSlot {
  enrollmentId: string;
  dueAt: Date;
}

/**
 * Espacement entre deux départs relancés, déduit du plafond du numéro : 200
 * messages par jour ⇒ un toutes les 3 min 18 s remplissent exactement la
 * journée d'envoi. Le but est que l'envoi n'ait JAMAIS à reporter pour cause
 * de plafond — c'est ce qui garde la trace du barreau honnête.
 */
export function reopenSpacingMs(dailyCap: number): number {
  return Math.max(MIN_SPACING_MS, Math.ceil(SEND_WINDOW_MS / Math.max(1, dailyCap)));
}

/**
 * Minuit du jour local SUIVANT. Ancré à midi puis +1 jour, comme
 * `nextSendTime` : ajouter 24 h à un minuit traverse mal un changement d'heure,
 * les transitions ayant lieu la nuit.
 */
function startOfNextLocalDay(date: Date, tz: string): Date {
  const anchor = addDays(fromZonedTime(`${formatInTimeZone(date, tz, "yyyy-MM-dd")}T12:00:00`, tz), 1);
  return fromZonedTime(`${formatInTimeZone(anchor, tz, "yyyy-MM-dd")}T00:00:00`, tz);
}

export interface ReopenPlanOptions {
  ladder: LadderStep[];
  /** Fenêtre de référence — celle de la campagne, et le repli quand un fil n'en a pas. */
  quietHours: QuietHours;
  /** Plafond quotidien du numéro expéditeur. */
  dailyCap: number;
  /** Ce que le numéro a DÉJÀ envoyé aujourd'hui — une autre campagne compte aussi. */
  sentToday: number;
  now: Date;
  random?: () => number;
}

/**
 * Quand chaque inscription relancée reprend l'échelle.
 *
 * Le curseur AVANCE de proche en proche ; il n'est jamais calculé en
 * `base + i × espacement`. `nextSendTime` replie tout instant hors fenêtre sur
 * la même ouverture : trois cents créneaux pré-calculés après 20 h
 * atterriraient tous sur le lendemain 9 h et reconstitueraient exactement la
 * rafale qu'on cherche à éviter.
 *
 * Le calendrier de l'échelle reste souverain quand il est DEVANT nous : un
 * barreau prévu à 48 h du précédent ne part pas ce soir sous prétexte qu'on a
 * cliqué. C'est rare — le dernier envoi est presque toujours ancien — mais
 * c'est la seule lecture honnête du délai que l'administrateur a saisi.
 */
export function planReopen(rows: ReopenRow[], opts: ReopenPlanOptions): ReopenSlot[] {
  const random = opts.random ?? Math.random;
  const spacing = reopenSpacingMs(opts.dailyCap);
  // Ce qui reste du plafond AUJOURD'HUI. Sans ce report, l'étalement serait
  // calculé pour un système vide et le plafond ramènerait le report qu'on
  // cherche justement à ne pas subir.
  let budget = Math.max(0, opts.dailyCap - opts.sentToday);
  let cursor = nextSendTime(new Date(opts.now.getTime() + REOPEN_GRACE_MS), opts.quietHours, random);

  return rows.map((row) => {
    if (budget <= 0) {
      cursor = nextSendTime(startOfNextLocalDay(cursor, opts.quietHours.tz), opts.quietHours, random);
      budget = opts.dailyCap;
    }
    // Le compteur ne se remet à plein QUE sur épuisement, jamais parce que le
    // curseur a franchi minuit tout seul : une journée peut donc recevoir moins
    // que le plafond, jamais plus. L'erreur va du bon côté.
    const ladderDue = nextTouchAt(opts.ladder, row.step, row.enrolledAt, row.lastTouchAt);
    const wanted = ladderDue !== null && ladderDue > cursor ? ladderDue : cursor;
    // La fenêtre du FIL décide du placement — c'est elle que l'envoi rejouera.
    // Le curseur, lui, reste sur la fenêtre de référence : une seule horloge
    // pour l'arithmétique du jour et du plafond. `nextSendTime` ne recule
    // jamais, donc l'ordre et l'espacement tiennent quand même.
    const dueAt = nextSendTime(wanted, row.quietHours ?? opts.quietHours, random);
    cursor = new Date(dueAt.getTime() + spacing);
    budget -= 1;
    return { enrollmentId: row.id, dueAt };
  });
}
