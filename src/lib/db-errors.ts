/**
 * Détection des erreurs Postgres au travers de l'enveloppe Drizzle.
 *
 * Drizzle encapsule l'erreur du pilote (DrizzleQueryError) : le message de
 * surface ne contient plus le nom de la contrainte, seulement `cause`. Sans
 * ça, une violation d'unicité remonte en 500 au lieu d'un 409 explicite.
 */

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

type PgLikeError = { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown };

function* chain(err: unknown): Generator<PgLikeError> {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    yield current as PgLikeError;
    current = (current as { cause?: unknown }).cause;
  }
}

function constraintName(link: PgLikeError): string | null {
  return (
    (typeof link.constraint_name === "string" && link.constraint_name) ||
    (typeof link.constraint === "string" && link.constraint) ||
    null
  );
}

function matches(
  err: unknown,
  code: string,
  messageMarker: string,
  constraint: string | undefined,
): boolean {
  for (const link of chain(err)) {
    const linkCode = typeof link.code === "string" ? link.code : null;
    const name = constraintName(link);
    const message = typeof link.message === "string" ? link.message : "";

    const hit = linkCode === code || message.includes(messageMarker);
    if (!hit) continue;
    if (!constraint) return true;
    if (name === constraint || message.includes(constraint)) return true;
  }
  return false;
}

/** Vrai si l'erreur est une violation de contrainte d'unicité (optionnellement précise). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return matches(err, UNIQUE_VIOLATION, "duplicate key value violates unique constraint", constraint);
}

/**
 * Vrai si l'erreur est une violation de clé étrangère (optionnellement précise) :
 * référence vers une ligne inexistante, ou suppression d'une ligne encore référencée.
 */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  return matches(err, FOREIGN_KEY_VIOLATION, "violates foreign key constraint", constraint);
}
