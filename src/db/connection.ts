/**
 * Réglages de connexion Postgres tirés de l'environnement — PURS, testables.
 *
 * L'application tourne à deux endroits qui n'ont pas la même base :
 *
 * - **Vercel + Supabase cloud** (la version d'origine, gardée en repli) :
 *   Supavisor exige TLS, et une instance Fluid multiplexe plusieurs requêtes
 *   dans un même pool — d'où `max: 30` ;
 * - **Tayoo Ops** (instance Supabase auto-hébergée sur le VPS) : l'application
 *   parle à `db:5432` sur le réseau Docker PRIVÉ de son instance. Ce Postgres
 *   n'offre pas TLS, et rien ne sort du serveur.
 *
 * Sans variable, le comportement est EXACTEMENT celui d'avant (repli intact) :
 * TLS exigé sauf si l'URL contient `localhost` / `127.0.0.1`, pool de 30.
 */

export type DbSslMode = "require" | "disable";

/** Valeurs admises pour `DATABASE_SSL` (vide ou `auto` = déduit de l'URL). */
const SSL_VALUES = new Set(["", "auto", "require", "disable"]);

/**
 * TLS ou pas. `DATABASE_SSL=disable` est le réglage EXPLICITE de Tayoo Ops ;
 * il remplace l'ancienne astuce qui glissait « localhost » dans
 * `application_name` pour déclencher la détection par sous-chaîne.
 *
 * Une valeur inconnue lève : une faute de frappe ne doit jamais retirer TLS
 * en silence (ni le réclamer à un Postgres qui ne l'offre pas).
 */
export function resolveDbSsl(url: string, raw: string | undefined): DbSslMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (!SSL_VALUES.has(value)) {
    throw new Error(`DATABASE_SSL invalide (« ${raw} ») : attendu require, disable ou auto.`);
  }
  if (value === "require" || value === "disable") return value;
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  return isLocal ? "disable" : "require";
}

export const DEFAULT_POOL_MAX = 30;

/**
 * Taille du pool. 30 reste le défaut (voir la longue note dans `index.ts` :
 * épuiser le pool corrompt les paramètres derrière Supavisor). Sur le VPS,
 * un seul processus Node longue durée parle directement à Postgres ; le
 * réglage permet de l'ajuster sans toucher au code.
 */
export function resolvePoolMax(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_POOL_MAX;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error(`DATABASE_POOL_MAX invalide (« ${raw} ») : entier de 1 à 200 attendu.`);
  }
  return n;
}
