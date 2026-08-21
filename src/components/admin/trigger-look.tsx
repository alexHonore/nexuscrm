import {
  CalendarClockIcon,
  HandIcon,
  MoveRightIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";
import type { TriggerKind } from "@/lib/campaigns/schema";
import { cn } from "@/lib/utils";

/**
 * Identité visuelle d'un déclencheur de campagne.
 *
 * Les quatre déclencheurs se ressemblent à la lecture — « nouveau lead » et
 * « changement de catégorie » sont deux lignes de texte presque identiques.
 * Une couleur et un pictogramme les rendent distinguables d'un coup d'œil.
 * Le couple est défini ICI et nulle part ailleurs : ce qu'on choisit à la
 * création doit se reconnaître ensuite dans la liste des campagnes.
 */
export const TRIGGER_LOOK: Record<TriggerKind, { color: string; Icon: LucideIcon }> = {
  lead_created: { color: "#3B82F6", Icon: UserPlusIcon },
  category_changed: { color: "#8B5CF6", Icon: MoveRightIcon },
  scheduled: { color: "#F59E0B", Icon: CalendarClockIcon },
  manual: { color: "#64748B", Icon: HandIcon },
};

/** Pastille colorée d'un déclencheur. */
export function TriggerIcon({
  kind,
  className,
  size = "md",
}: {
  kind: TriggerKind;
  className?: string;
  size?: "sm" | "md";
}) {
  const { color, Icon } = TRIGGER_LOOK[kind];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        size === "sm" ? "size-5 rounded-md" : "size-8",
        className,
      )}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon className={size === "sm" ? "size-3" : "size-4"} />
    </span>
  );
}
