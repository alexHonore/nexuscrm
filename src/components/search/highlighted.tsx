import { cn } from "@/lib/utils";

/**
 * Un texte dont certaines tranches sont surlignées — les tranches viennent du
 * SERVEUR (`nameRanges`, `cityRanges`, `snippet.ranges`), en offsets UTF-16.
 *
 * Le navigateur ne recalcule rien : les motifs de recherche portent des
 * lookbehind que Safari < 16.4 refuse de compiler, et un second calcul côté
 * client finirait tôt ou tard par diverger du premier. Il se contente de
 * découper la chaîne — jamais de `dangerouslySetInnerHTML`, le texte reste du
 * texte.
 *
 * Défensif par construction : une tranche hors bornes, vide ou à l'envers est
 * ignorée ou rognée, deux tranches qui se chevauchent ou se touchent n'en font
 * qu'une, et une borne qui tomberait au milieu d'une paire de substitution (un
 * emoji) est repoussée à côté. Une réponse abîmée affiche le texte intact,
 * jamais un caractère coupé en deux.
 *
 * Sans hook ni état : utilisable tel quel dans un composant serveur comme
 * client.
 */
export function Highlighted({
  text,
  ranges,
  className,
  markClassName,
}: {
  text: string;
  ranges?: readonly (readonly [number, number])[] | null;
  className?: string;
  markClassName?: string;
}) {
  const parts = segments(text, ranges ?? []);
  if (parts.length === 1 && !parts[0].hit) {
    return <span className={className}>{text}</span>;
  }
  return (
    <span className={className}>
      {parts.map((part) =>
        part.hit ? (
          // `<mark>` est jaune par défaut dans tous les navigateurs, et ni le
          // préflight de Tailwind ni `globals.css` ne le remettent à zéro : le
          // fond et la couleur s'écrivent donc toujours explicitement.
          <mark
            key={part.start}
            className={cn("rounded-[3px] bg-primary/15 px-px text-inherit", markClassName)}
          >
            {part.text}
          </mark>
        ) : (
          <span key={part.start}>{part.text}</span>
        ),
      )}
    </span>
  );
}

type Segment = { start: number; text: string; hit: boolean };

/** Vrai quand `i` tombe ENTRE les deux moitiés d'une paire de substitution. */
function splitsPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const high = text.charCodeAt(i - 1);
  const low = text.charCodeAt(i);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Découpe `text` en morceaux alternés. Exportée pour les tests : c'est la seule
 * logique du composant.
 */
export function segments(text: string, ranges: readonly (readonly [number, number])[]): Segment[] {
  const clean = ranges
    .filter(
      (r): r is readonly [number, number] =>
        Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]),
    )
    .map(([s, e]) => {
      let start = Math.max(0, Math.min(s, text.length));
      let end = Math.max(0, Math.min(e, text.length));
      if (splitsPair(text, start)) start -= 1;
      if (splitsPair(text, end)) end += 1;
      return [start, end] as const;
    })
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Tranches qui se chevauchent ou se touchent : UNE seule marque.
  const merged: [number, number][] = [];
  for (const [s, e] of clean) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const out: Segment[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ start: cursor, text: text.slice(cursor, s), hit: false });
    out.push({ start: s, text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length || out.length === 0) {
    out.push({ start: cursor, text: text.slice(cursor), hit: false });
  }
  return out;
}
