/**
 * Phone helpers — NANP-first (Québec), tolerant of international numbers.
 * Usable on both server and client.
 */

/** Normalize to E.164. "418-476-1542" → "+14184761542". Returns null if unusable. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
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

/** Loose match key for incoming-call lookup: last 10 digits. */
export function phoneMatchKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}
