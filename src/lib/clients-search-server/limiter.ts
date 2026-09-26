import "server-only";

/**
 * Le robinet des recherches PROFONDES (commentaires, suivis, notes d'appel,
 * SMS) : au plus 4 à la fois par processus.
 *
 * Pourquoi un plafond : une recherche profonde tient une connexion du pool
 * pendant toute sa transaction (jusqu'à 3 s de `statement_timeout`). Or le
 * pool est la seule chose qui empêche postgres.js de PIPELINER des requêtes
 * sur une connexion occupée — ce qui, derrière Supavisor, croise les
 * paramètres entre requêtes (voir `src/db/index.ts`). Une rafale de frappes
 * sur ⌘K ne doit jamais pouvoir l'épuiser.
 *
 * Qui n'obtient pas de place en 750 ms n'attend pas plus : la recherche se
 * rabat sur la fiche seule (`degraded: "busy"`), rapide et sans historique.
 */

export const DEEP_MAX_CONCURRENT = 4;
export const DEEP_WAIT_MS = 750;

export type Release = () => void;
export type Acquire = (waitMs: number) => Promise<Release | null>;

type Waiter = { grant: () => void; timer: ReturnType<typeof setTimeout> };

/** Un sémaphore à attente bornée, FIFO. Exporté pour les tests. */
export function createLimiter(max: number): { acquire: Acquire; active: () => number; waiting: () => number } {
  let active = 0;
  const queue: Waiter[] = [];

  const release = (): Release => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      if (next) {
        // La place passe directement au suivant : `active` ne bouge pas.
        clearTimeout(next.timer);
        next.grant();
      } else {
        active--;
      }
    };
  };

  const acquire: Acquire = (waitMs) => {
    if (active < max) {
      active++;
      return Promise.resolve(release());
    }
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: () => resolve(release()),
        timer: setTimeout(() => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
        }, waitMs),
      };
      queue.push(waiter);
    });
  };

  return { acquire, active: () => active, waiting: () => queue.length };
}

// Un seul robinet par processus, même quand plusieurs bundles chargent ce
// module (rechargement à chaud, routes compilées séparément) — même motif que
// le client `db`.
const globalForLimiter = globalThis as unknown as {
  nexusDeepSearchLimiter?: ReturnType<typeof createLimiter>;
};
const limiter = (globalForLimiter.nexusDeepSearchLimiter ??= createLimiter(DEEP_MAX_CONCURRENT));

/**
 * Une place de recherche profonde, ou `null` après `waitMs`. Toujours rendre
 * la place (`finally`) ; la rendre deux fois est sans effet.
 */
export function acquireDeep(waitMs: number = DEEP_WAIT_MS): Promise<Release | null> {
  return limiter.acquire(waitMs);
}
