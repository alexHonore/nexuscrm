"use client";

import type { LabBrand } from "@/lib/llm/labs";
import { cn } from "@/lib/utils";

/**
 * Marque d'un laboratoire — SVG géométrique, aux couleurs de la maison.
 *
 * Volontairement PAS une imitation du logo déposé : une approximation ratée
 * d'un logo connu se remarque plus qu'une forme neutre, et se périme au premier
 * changement de charte. La reconnaissance vient de la couleur et du nom, qui
 * suffisent à s'orienter dans une liste.
 */
export function LabMark({
  lab,
  size = 40,
  className,
}: {
  lab: LabBrand;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl transition-transform",
        className,
      )}
      style={{
        width: size,
        height: size,
        // Un fond teinté plutôt qu'aplat : lisible en clair comme en sombre.
        backgroundColor: `color-mix(in srgb, ${lab.color} 16%, transparent)`,
        color: lab.color,
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="none">
        <Glyph glyph={lab.glyph} />
      </svg>
    </span>
  );
}

function Glyph({ glyph }: { glyph: LabBrand["glyph"] }) {
  const stroke = { stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const };
  switch (glyph) {
    case "burst":
      return (
        <>
          <path d="M12 3v18" {...stroke} />
          <path d="M4.5 7.5l15 9" {...stroke} />
          <path d="M19.5 7.5l-15 9" {...stroke} />
        </>
      );
    case "orbit":
      return (
        <>
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          <ellipse cx="12" cy="12" rx="9" ry="4.2" {...stroke} />
          <ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(60 12 12)" {...stroke} />
        </>
      );
    case "quad":
      return (
        <>
          <rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor" opacity={0.9} />
          <rect x="13" y="3" width="8" height="8" rx="2" fill="currentColor" opacity={0.55} />
          <rect x="3" y="13" width="8" height="8" rx="2" fill="currentColor" opacity={0.4} />
          <rect x="13" y="13" width="8" height="8" rx="2" fill="currentColor" opacity={0.75} />
        </>
      );
    case "loop":
      return (
        <>
          <circle cx="8" cy="12" r="5" {...stroke} />
          <circle cx="16" cy="12" r="5" {...stroke} />
        </>
      );
    case "bars":
      return (
        <>
          <rect x="3" y="4" width="18" height="3.4" rx="1" fill="currentColor" opacity={0.95} />
          <rect x="3" y="10.3" width="18" height="3.4" rx="1" fill="currentColor" opacity={0.7} />
          <rect x="3" y="16.6" width="18" height="3.4" rx="1" fill="currentColor" opacity={0.45} />
        </>
      );
    case "wave":
      return (
        <>
          <path d="M3 14c3-4 6-4 9 0s6 4 9 0" {...stroke} />
          <path d="M3 8.5c3-4 6-4 9 0s6 4 9 0" {...stroke} opacity={0.45} />
        </>
      );
    case "cross":
      return (
        <>
          <path d="M5 5l14 14" {...stroke} />
          <path d="M19 5L5 19" {...stroke} />
        </>
      );
    case "spark":
      return (
        <path
          d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4-2.4 6.6-2.4-6.6L3 11.5l6.6-2.4z"
          fill="currentColor"
        />
      );
    case "hex":
      return <path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" {...stroke} />;
  }
}
