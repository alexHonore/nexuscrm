"use client";

import { enUS, fr } from "date-fns/locale";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  lookTint,
  NOTIFICATION_LOOK,
  ORIGIN_LOOK,
  SEARCH_FIELD_LOOK,
  type Look,
} from "@/components/look";
import { RelativeTime } from "@/components/relative-time";
import type { ClientMatch, MatchField, MatchReason } from "@/lib/clients-search/types";
import { cn } from "@/lib/utils";
import { Highlighted } from "./highlighted";

/**
 * POURQUOI une fiche remonte dans une recherche — une ligne sous son nom.
 *
 * Le nom et la ville se surlignent sur place ; tout le reste (numéro, courriel,
 * adresse, notes, commentaires, suivis, appels, SMS) n'est pas à l'écran, et
 * une fiche trouvée « par magie » se relit trois fois avant qu'on ose
 * l'ouvrir. D'où des puces : le pictogramme du champ, sa teinte de famille
 * (`SEARCH_FIELD_LOOK`), et TOUJOURS son nom écrit — la couleur ne porte
 * jamais le sens seule.
 *
 * Quand le serveur a joint un extrait, la puce de SON champ passe en tête avec
 * l'auteur et le moment, puis le texte surligné. Le serveur n'envoie un extrait
 * que s'il apporte un terme qu'on ne voit pas déjà sur la ligne, et seulement
 * depuis une source que la fiche nous ouvre.
 */

type Snippet = NonNullable<ClientMatch["snippet"]>;

/** Champs déjà visibles, surlignés sur la ligne elle-même : pas de puce pour eux. */
const INLINE_FIELDS: ReadonlySet<MatchField> = new Set<MatchField>(["name", "city"]);

/** Les champs des raisons, dans l'ordre du serveur (points décroissants), sans doublon. */
export function reasonFields(reasons: readonly MatchReason[]): MatchField[] {
  const out: MatchField[] = [];
  for (const r of reasons) if (!out.includes(r.field)) out.push(r.field);
  return out;
}

/** Les puces à dessiner : ni nom ni ville (surlignés sur place), ni le champ de l'extrait (il a la sienne). */
export function chipFields(reasons: readonly MatchReason[], snippetField?: MatchField | null): MatchField[] {
  return reasonFields(reasons).filter((f) => !INLINE_FIELDS.has(f) && f !== snippetField);
}

function useFieldList(fields: readonly MatchField[]): string {
  const t = useTranslations("common.search");
  const locale = useLocale();
  return useMemo(() => {
    const labels = fields.map((f) => t(`field.${f}`));
    try {
      return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(labels);
    } catch {
      return labels.join(", ");
    }
  }, [fields, locale, t]);
}

/**
 * Une puce de champ, non interactive : pictogramme (décoratif) + libellé écrit.
 * `hidden` la retire du lecteur d'écran quand une phrase voisine la dit déjà.
 */
export function FieldChip({
  field,
  hidden = false,
  className,
}: {
  field: MatchField;
  hidden?: boolean;
  className?: string;
}) {
  const t = useTranslations("common.search");
  const look = SEARCH_FIELD_LOOK[field];
  return (
    <span
      aria-hidden={hidden || undefined}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[10px] font-medium leading-none",
        className,
      )}
      style={lookTint(look)}
    >
      <look.Icon aria-hidden className="size-3 shrink-0" />
      {t(`field.${field}`)}
    </span>
  );
}

/**
 * Les puces « trouvé dans », au plus `max` puis « +n ». Pour un lecteur
 * d'écran, UNE phrase complète (« Trouvé dans : Commentaire et Suivi ») : les
 * puces elles-mêmes sont masquées pour ne pas se faire lire deux fois.
 */
export function MatchChips({
  reasons,
  max = 2,
  snippetField = null,
  className,
}: {
  reasons: readonly MatchReason[];
  max?: number;
  snippetField?: MatchField | null;
  className?: string;
}) {
  const t = useTranslations("common.search");
  const all = useMemo(() => reasonFields(reasons), [reasons]);
  const fields = chipFields(reasons, snippetField);
  const spoken = useFieldList(all);
  if (all.length === 0) return null;
  const shown = fields.slice(0, Math.max(0, max));
  const rest = fields.length - shown.length;
  return (
    <>
      <span className="sr-only">{t("matchedIn", { fields: spoken })}</span>
      {shown.length > 0 ? (
        <span aria-hidden className={cn("flex min-w-0 items-center gap-1", className)}>
          {shown.map((field) => (
            <FieldChip key={field} field={field} />
          ))}
          {rest > 0 ? (
            <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
              {t("more", { count: rest })}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** Le badge d'origine d'un extrait : note écrite par l'IA, ou journal de rendez-vous. */
function OriginBadge({ origin }: { origin: Snippet["origin"] }) {
  const t = useTranslations("common.search");
  const badge: { look: Look; label: string } | null =
    origin === "ai"
      ? { look: ORIGIN_LOOK.generated, label: t("origin.ai") }
      : origin === "booking"
        ? { look: NOTIFICATION_LOOK.appointment, label: t("origin.booking") }
        : null;
  if (!badge) return null;
  const { look, label } = badge;
  return (
    <span
      className="mr-1 inline-flex h-4 items-center gap-0.5 whitespace-nowrap rounded px-1 align-[1px] text-[10px] font-medium leading-none"
      style={lookTint(look)}
    >
      <look.Icon aria-hidden className="size-2.5 shrink-0" />
      {label}
    </span>
  );
}

/**
 * L'extrait lui-même : badge d'origine, puis le texte avec ses tranches
 * surlignées, et des points de suspension là où le serveur l'a coupé.
 * `className` porte le `line-clamp-*` voulu par l'écran.
 */
export function MatchSnippet({ snippet, className }: { snippet: Snippet; className?: string }) {
  return (
    <span className={cn("block min-w-0 break-words text-xs leading-snug text-muted-foreground", className)}>
      <OriginBadge origin={snippet.origin} />
      {snippet.clippedStart ? <span aria-hidden>… </span> : null}
      <Highlighted text={snippet.text} ranges={snippet.ranges} className="text-foreground/80" />
      {snippet.clippedEnd ? <span aria-hidden> …</span> : null}
    </span>
  );
}

/** « Commentaire · Marie Tremblay · il y a 3 jours » — le champ, l'auteur, le moment. */
function SnippetMeta({ snippet }: { snippet: Snippet }) {
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  return (
    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      <FieldChip field={snippet.field} />
      {snippet.author ? (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{snippet.author}</span>
        </>
      ) : null}
      {snippet.at ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0 whitespace-nowrap">
            <RelativeTime date={snippet.at} locale={dfnsLocale} />
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * La ligne « pourquoi » complète, sous le nom d'une fiche.
 *
 * - `compact` (tableau, cartes du tableau sur téléphone) : UNE ligne tronquée —
 *   la première puce, puis l'extrait.
 * - sinon (palette, cartes du panneau) : puces + auteur + moment, puis
 *   l'extrait sur `snippetClassName` (le `line-clamp` de l'écran).
 *
 * Rien à dire (trouvée seulement par le nom ou la ville, déjà surlignés) :
 * rien n'est rendu, pas même une ligne vide.
 */
export function SearchReason({
  match,
  compact = false,
  maxChips = 3,
  snippetClassName = "line-clamp-2",
  className,
}: {
  match: ClientMatch | null | undefined;
  compact?: boolean;
  maxChips?: number;
  snippetClassName?: string;
  className?: string;
}) {
  if (!match) return null;
  const snippet = match.snippet;
  const others = chipFields(match.reasons, snippet?.field ?? null);
  if (!snippet && others.length === 0) {
    // Seulement nom / ville : le surlignage suffit, mais le lecteur d'écran
    // entend quand même où la fiche a été trouvée.
    return match.reasons.length > 0 ? <MatchChips reasons={match.reasons} max={0} /> : null;
  }

  if (compact) {
    const lead = snippet?.field ?? others[0];
    return (
      <span className={cn("mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
        <MatchChips reasons={match.reasons} max={0} />
        {lead ? <FieldChip field={lead} hidden /> : null}
        {snippet ? (
          <span className="min-w-0 truncate">
            {snippet.clippedStart ? <span aria-hidden>… </span> : null}
            <Highlighted text={snippet.text} ranges={snippet.ranges} />
          </span>
        ) : others.length > 1 ? (
          <span aria-hidden className="shrink-0 text-[10px] font-medium tabular-nums">
            <MoreCount count={others.length - 1} />
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className={cn("mt-1 block min-w-0 space-y-0.5", className)}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {snippet ? <SnippetMeta snippet={snippet} /> : null}
        {/* `maxChips` compte TOUTES les puces : celle de l'extrait en est une. */}
        <MatchChips
          reasons={match.reasons}
          max={snippet ? maxChips - 1 : maxChips}
          snippetField={snippet?.field ?? null}
        />
      </span>
      {snippet ? <MatchSnippet snippet={snippet} className={snippetClassName} /> : null}
    </span>
  );
}

function MoreCount({ count }: { count: number }) {
  const t = useTranslations("common.search");
  return <>{t("more", { count })}</>;
}
