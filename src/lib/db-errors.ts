/**
 * Détection des erreurs Postgres au travers de l'enveloppe Drizzle.
 *
 * Drizzle encapsule l'erreur du pilote (DrizzleQueryError) : le message de
 * surface ne contient plus le nom de la contrainte, seulement `cause`. Sans
 * ça, une violation d'unicité remonte en 500 au lieu d'un 409 explicite.
 */

const UNIQUE_VIOLATION = "23505";

type PgLikeError = { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown };

function* chain(err: unknown): Generator<PgLikeError> {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    yield current as PgLikeError;
    current = (current as { cause?: unknown }).cause;
  }
}

/** Vrai si l'erreur est une violation de contrainte d'unicité (optionnellement précise). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (const link of chain(err)) {
    const code = typeof link.code === "string" ? link.code : null;
    const name =
      (typeof link.constraint_name === "string" && link.constraint_name) ||
      (typeof link.constraint === "string" && link.constraint) ||
      null;
    const message = typeof link.message === "string" ? link.message : "";

    const isUnique =
      code === UNIQUE_VIOLATION ||
      message.includes("duplicate key value violates unique constraint");
    if (!isUnique) continue;
    if (!constraint) return true;
    if (name === constraint || message.includes(constraint)) return true;
  }
  return false;
}
