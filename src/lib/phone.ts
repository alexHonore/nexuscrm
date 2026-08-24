/**
 * Phone helpers — NANP-first (Québec), tolerant of international numbers.
 * Usable on both server and client.
 */

/**
 * Extensions à écarter avant normalisation : « x22 », « ext. 22 », « poste 22 »,
 * « #22 »… Sinon les chiffres de l'extension se recollent au numéro et le
 * client n'est plus reconnu lors d'un appel entrant.
 */
const EXTENSION_RE = /(?:\s|^)(?:x|ext|ext\.|extension|p|poste|#)\s*\.?\s*\d{1,6}\s*$/i;

/** Normalize to E.164. "418-476-1542" → "+14184761542". Returns null if unusable. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(EXTENSION_RE, "").trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Fallback: keep digits as-is with +, better than dropping the lead.
  return `+${digits}`;
}

/** Display format: "+14184761542" → "(418) 476-1542"; non-NANP left as-is. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

/**
 * Clé de rapprochement souple (appel entrant, SMS, CDR, lead) : les 10 DERNIERS
 * chiffres, ou `null` s'il y en a moins. Jamais de clé plus courte : un numéro
 * local à 7 chiffres (« 476-1542 ») donnerait une clé qui, en suffixe
 * (`LIKE '%4761542'`), rattacherait n'importe quelle fiche se terminant ainsi
 * (+1418…, +1514…) — un lead fondu dans la fiche d'un inconnu. Sous 10
 * chiffres, l'appelant se rabat sur l'égalité E.164 exacte ou ne rattache pas.
 */
export function phoneMatchKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}
