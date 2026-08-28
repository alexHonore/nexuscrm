import "server-only";
import { listDays } from "@/components/analytics/period";
import { db } from "@/db";
import { users } from "@/db/schema";
import { collapseCdrLegs, collapseCrossAccountLegs } from "./cdr-sync";
import { phoneMatchKey } from "./phone";
import {
  cdrCost,
  getBalanceDetail,
  getCdr,
  hasCdrCost,
  type VoipMsBalance,
  type VoipMsCdr,
} from "./voipms";

/**
 * Consommation téléphonique PAR TÉLÉPHONISTE et dépense voip.ms sur une période.
 *
 * Deux principes tiennent ce fichier :
 *
 * 1. **Le coût vient de voip.ms, jamais d'un calcul maison.** Les tarifs
 *    dépendent de la destination et du forfait du numéro : un montant estimé à
 *    partir de la durée ressemblerait à une facture sans en être une.
 * 2. **Un appel ne compte qu'une fois.** Le CDR renvoie plusieurs « pattes »
 *    pour un même appel (sauts internes, appel entrant vu par le compte
 *    principal PUIS par le sous-compte). On réutilise donc exactement les mêmes
 *    regroupements que la synchronisation des appels — sans eux, minutes ET
 *    dollars seraient comptés en double.
 *
 * Le rattachement suit lui aussi la synchronisation : sous-compte SIP d'abord
 * (`cdr.account` ↔ `users.sipUsername`), puis repli sur le numéro appelé
 * (`cdr.destination` ↔ `users.didNumber`) pour les entrants passés par le
 * compte principal. Ce qui ne se rattache à personne reste visible dans une
 * ligne « non rattaché » : le total affiché doit toujours égaler la dépense
 * réelle, même quand une part n'appartient à aucun téléphoniste.
 */

export type UsageRow = {
  /** null = trafic non rattaché à un téléphoniste (compte principal, ligne supprimée). */
  userId: string | null;
  name: string;
  email: string | null;
  sipUsername: string | null;
  didNumber: string | null;
  calls: number;
  answered: number;
  seconds: number;
  /** Coût total d'après le CDR voip.ms (dollars US). */
  cost: number;
};

/**
 * Un jour de téléphonie, borné à MINUIT HEURE DE TORONTO — le CDR de voip.ms
 * est déjà rendu dans le fuseau du compte, réglé sur Toronto.
 */
export type UsageDay = {
  date: string;
  calls: number;
  answered: number;
  seconds: number;
  cost: number;
};

export type UsageReport = {
  from: string;
  to: string;
  rows: UsageRow[];
  totals: { calls: number; answered: number; seconds: number; cost: number };
  /** Jour par jour, trous remplis à 0 — la courbe de la période. */
  daily: UsageDay[];
  balance: VoipMsBalance | null;
  /** Vrai si voip.ms n'a chiffré aucun appel — l'UI doit alors le dire plutôt qu'afficher 0 $. */
  costUnavailable: boolean;
};

export type UsagePerson = {
  id: string;
  name: string;
  email: string;
  sipUsername: string | null;
  didNumber: string | null;
  isActive: boolean;
};

/**
 * voip.ms marque les appels aboutis par « ANSWERED » exactement — surtout pas
 * une recherche de sous-chaîne : « NO ANSWER » contient « ANSWER » et un appel
 * manqué passerait pour répondu. Même règle que la synchronisation des appels.
 */
function isAnswered(row: VoipMsCdr): boolean {
  return (row.disposition ?? "").toUpperCase() === "ANSWERED";
}

function secondsOf(row: VoipMsCdr): number {
  const value = Number.parseInt(row.seconds, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const emptyRow = (): Omit<UsageRow, "userId" | "name" | "email" | "sipUsername" | "didNumber"> => ({
  calls: 0,
  answered: 0,
  seconds: 0,
  cost: 0,
});

/**
 * Agrège des lignes de CDR déjà chargées — testable sans réseau.
 * Les regroupements de pattes sont appliqués ICI, pour que tout appelant en
 * bénéficie sans avoir à y penser.
 */
export function aggregateUsage(
  cdrRows: VoipMsCdr[],
  people: UsagePerson[],
  /**
   * Bornes de la période, pour remplir les journées creuses à 0. Sans elles, le
   * jour par jour ne contient que les journées VUES dans le CDR — suffisant
   * pour un test, trompeur pour un axe du temps.
   */
  range?: { from: string; to: string },
): {
  rows: UsageRow[];
  totals: UsageReport["totals"];
  daily: UsageDay[];
  costUnavailable: boolean;
} {
  const byAccount = new Map<string, UsagePerson>();
  const byDid = new Map<string, UsagePerson>();
  for (const p of people) {
    if (p.sipUsername) byAccount.set(p.sipUsername, p);
    const key = phoneMatchKey(p.didNumber);
    if (key) byDid.set(key, p);
  }

  /** Même ordre que la synchronisation : sous-compte exact, puis repli par DID. */
  const attribute = (row: VoipMsCdr): UsagePerson | undefined => {
    const direct = byAccount.get(row.account);
    if (direct) return direct;
    const destKey = phoneMatchKey(row.destination);
    return destKey ? byDid.get(destKey) : undefined;
  };

  const rows = new Map<string, UsageRow>();
  const UNATTRIBUTED = "__unattributed__";

  const rowFor = (person: UsagePerson | undefined): UsageRow => {
    const key = person?.id ?? UNATTRIBUTED;
    let bucket = rows.get(key);
    if (!bucket) {
      bucket = person
        ? {
            userId: person.id,
            name: person.name,
            email: person.email,
            sipUsername: person.sipUsername,
            didNumber: person.didNumber,
            ...emptyRow(),
          }
        : {
            userId: null,
            name: "",
            email: null,
            sipUsername: null,
            didNumber: null,
            ...emptyRow(),
          };
      rows.set(key, bucket);
    }
    return bucket;
  };

  // Les téléphonistes ACTIFS apparaissent même sans appel : « zéro appel cette
  // semaine » est justement ce que le courtier cherche à voir. Les comptes
  // désactivés n'encombrent la liste que s'ils ont réellement consommé.
  for (const p of people) {
    if (p.isActive) rowFor(p);
  }

  // ── Appels et durée : sur les pattes REGROUPÉES ──
  // Un même appel produit plusieurs lignes CDR ; sans regroupement, minutes et
  // nombre d'appels seraient comptés deux fois.
  const collapsed = collapseCrossAccountLegs(
    collapseCdrLegs(cdrRows),
    new Set(byAccount.keys()),
  );
  // Jour par jour : les horodatages du CDR arrivent déjà en heure LOCALE de
  // Toronto (voir `getCdr`), donc les dix premiers caractères sont directement
  // la journée Toronto — aucune reconversion à faire.
  const days = new Map<string, UsageDay>();
  const dayFor = (row: VoipMsCdr): UsageDay | null => {
    const date = (row.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    let bucket = days.get(date);
    if (!bucket) {
      bucket = { date, calls: 0, answered: 0, seconds: 0, cost: 0 };
      days.set(date, bucket);
    }
    return bucket;
  };

  for (const row of collapsed) {
    const bucket = rowFor(attribute(row));
    bucket.calls += 1;
    if (isAnswered(row)) bucket.answered += 1;
    bucket.seconds += secondsOf(row);

    const day = dayFor(row);
    if (day) {
      day.calls += 1;
      if (isAnswered(row)) day.answered += 1;
      day.seconds += secondsOf(row);
    }
  }

  // ── Coût : sur les lignes BRUTES ──
  // Le regroupement ci-dessus garde la patte la plus longue / celle du
  // sous-compte — or c'est souvent l'AUTRE qui porte le montant (un appel
  // entrant est facturé sur la patte du compte principal, justement celle que
  // le regroupement écarte). Additionner les montants de toutes les lignes
  // donne donc la dépense réelle : voip.ms ne chiffre qu'une patte par appel,
  // les autres arrivent sans montant.
  let sawCost = false;
  for (const row of cdrRows) {
    if (hasCdrCost(row)) sawCost = true;
    const cost = cdrCost(row);
    rowFor(attribute(row)).cost += cost;
    // Même partage que les lignes : la DURÉE vient des pattes regroupées, le
    // MONTANT des pattes brutes. Une journée dont seule la patte facturée est
    // hors regroupement doit quand même porter sa dépense.
    const day = dayFor(row);
    if (day) day.cost += cost;
  }

  const list = [...rows.values()];
  // Non rattaché en dernier : c'est un reliquat, pas un téléphoniste.
  list.sort((a, b) => {
    if ((a.userId === null) !== (b.userId === null)) return a.userId === null ? 1 : -1;
    if (b.cost !== a.cost) return b.cost - a.cost;
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    return a.name.localeCompare(b.name);
  });

  // Une ligne « non rattaché » VIDE n'a rien à dire — mais une ligne qui porte
  // un montant en a, même sans appel à son nom : le coût vient des pattes
  // BRUTES et les appels des pattes regroupées, si bien qu'une patte facturée
  // écartée du regroupement laisse une ligne « 0 appel, X $ ». L'écarter ferait
  // mentir le total, qui doit toujours égaler la dépense réelle — et ferait
  // diverger le graphique jour par jour du grand chiffre.
  const cleaned = list.filter((r) => r.userId !== null || r.calls > 0 || r.cost !== 0);

  const totals = cleaned.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      answered: acc.answered + r.answered,
      seconds: acc.seconds + r.seconds,
      cost: acc.cost + r.cost,
    }),
    { calls: 0, answered: 0, seconds: 0, cost: 0 },
  );

  const daily = range
    ? listDays(range.from, range.to).map(
        (date) => days.get(date) ?? { date, calls: 0, answered: 0, seconds: 0, cost: 0 },
      )
    : [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { rows: cleaned, totals, daily, costUnavailable: totals.calls > 0 && !sawCost };
}

/**
 * Rapport complet d'une période (dates « YYYY-MM-DD », heure de Toronto).
 * Le solde est accessoire : son échec ne doit pas priver l'admin du reste.
 */
export async function getUsageReport(dateFrom: string, dateTo: string): Promise<UsageReport> {
  const people = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      sipUsername: users.sipUsername,
      didNumber: users.didNumber,
      isActive: users.isActive,
    })
    .from(users);

  const [cdrRows, balance] = await Promise.all([
    getCdr(dateFrom, dateTo),
    getBalanceDetail().catch(() => null),
  ]);

  const { rows, totals, daily, costUnavailable } = aggregateUsage(cdrRows, people, {
    from: dateFrom,
    to: dateTo,
  });
  return { from: dateFrom, to: dateTo, rows, totals, daily, balance, costUnavailable };
}
