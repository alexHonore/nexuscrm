"use client";

/**
 * Illustrations des modes de création.
 *
 * Vecteurs en ligne : aucun fichier distant, aucune dépendance nouvelle, et
 * elles suivent la couleur du thème (`currentColor`) donc elles restent
 * lisibles en clair comme en sombre. Chacune montre CE QUE LE MODE DEMANDE —
 * une conversation, quelques champs, un tableau de bord complet — pour qu'on
 * choisisse sans lire.
 */

export function ChatIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 64" className={className} fill="none" aria-hidden>
      <rect x="6" y="8" width="46" height="16" rx="8" fill="currentColor" opacity={0.16} />
      <rect x="14" y="14" width="26" height="3" rx="1.5" fill="currentColor" opacity={0.5} />
      <rect x="44" y="30" width="46" height="16" rx="8" fill="currentColor" opacity={0.9} />
      <rect x="52" y="36" width="28" height="3" rx="1.5" fill="currentColor" opacity={0.35} />
      <rect x="6" y="48" width="34" height="12" rx="6" fill="currentColor" opacity={0.16} />
      <circle cx="15" cy="54" r="1.6" fill="currentColor" opacity={0.55}>
        <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.4s" repeatCount="indefinite" />
      </circle>
      <circle cx="22" cy="54" r="1.6" fill="currentColor" opacity={0.55}>
        <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.4s" begin="0.2s" repeatCount="indefinite" />
      </circle>
      <circle cx="29" cy="54" r="1.6" fill="currentColor" opacity={0.55}>
        <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.4s" begin="0.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

export function FormIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 64" className={className} fill="none" aria-hidden>
      <rect x="10" y="6" width="76" height="52" rx="8" fill="currentColor" opacity={0.1} />
      {[16, 30, 44].map((y, i) => (
        <g key={y}>
          <rect x="20" y={y} width="20" height="3" rx="1.5" fill="currentColor" opacity={0.45} />
          <rect
            x="20"
            y={y + 6}
            width={i === 2 ? 32 : 56}
            height="6"
            rx="3"
            fill="currentColor"
            opacity={0.22}
          />
        </g>
      ))}
      <circle cx="70" cy="50" r="7" fill="currentColor" opacity={0.9} />
      <path d="M67 50l2 2 4-4" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function DashboardIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 64" className={className} fill="none" aria-hidden>
      <rect x="6" y="6" width="84" height="52" rx="8" fill="currentColor" opacity={0.1} />
      <rect x="6" y="6" width="84" height="10" rx="8" fill="currentColor" opacity={0.18} />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={12 + i * 15}
          y={9}
          width="11"
          height="4"
          rx="2"
          fill="currentColor"
          opacity={i === 1 ? 0.85 : 0.35}
        />
      ))}
      <rect x="12" y="22" width="34" height="30" rx="4" fill="currentColor" opacity={0.16} />
      <rect x="50" y="22" width="34" height="13" rx="4" fill="currentColor" opacity={0.16} />
      <rect x="50" y="39" width="34" height="13" rx="4" fill="currentColor" opacity={0.16} />
      {[26, 32, 38, 44].map((y) => (
        <rect key={y} x="18" y={y} width={y === 44 ? 14 : 22} height="2.5" rx="1.2" fill="currentColor" opacity={0.4} />
      ))}
    </svg>
  );
}

/** Ruban animé pour l'entête du choix de mode. */
export function SparkleTrail({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 24" className={className} fill="none" aria-hidden preserveAspectRatio="none">
      <path
        d="M0 18 C 40 4, 70 22, 100 12 S 160 4, 200 14"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity={0.35}
        strokeDasharray="4 6"
      >
        <animate attributeName="stroke-dashoffset" values="20;0" dur="2.4s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}
