import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { RedialButton } from "./redial-button";

/**
 * Journal personnel groupé par jour — Server Component pur : tous les libellés
 * (i18n, dates, durées) sont préparés côté serveur par la page. Seul le bouton
 * « Rappeler » est un composant client.
 */

export type CallRowData = {
  id: string;
  /** HH:mm (America/Toronto). */
  timeLabel: string;
  direction: "outbound" | "inbound";
  /** Entrant jamais décroché — icône « appel manqué » en rouge. */
  missed: boolean;
  directionLabel: string;
  clientId: string | null;
  clientName: string | null;
  /** Numéro formaté (ou « Numéro inconnu ») quand aucune fiche client. */
  numberDisplay: string;
  /** E.164 brut pour « Rappeler » — null si l'appel n'a pas de numéro distant. */
  dialNumber: string | null;
  /** mm:ss */
  durationLabel: string;
  dispositionLabel: string | null;
  dispositionColor: string | null;
  /** Aperçu déjà tronqué côté serveur. */
  note: string | null;
};

export type CallDayGroup = {
  /** yyyy-MM-dd (Toronto) — clé stable du groupe. */
  key: string;
  /** « Aujourd'hui » / « Hier » / date longue. */
  label: string;
  rows: CallRowData[];
};

function DirectionIcon({
  direction,
  missed,
  label,
  className,
}: {
  direction: "outbound" | "inbound";
  missed?: boolean;
  label: string;
  className?: string;
}) {
  const Icon = missed ? PhoneMissed : direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center",
        missed
          ? "text-red-600 dark:text-red-400"
          : direction === "outbound"
            ? "text-emerald-600 dark:text-emerald-500"
            : "text-blue-600 dark:text-blue-400",
        className,
      )}
    >
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function DispositionChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-2 text-xs font-medium ring-1 ring-foreground/10">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full ring-1 ring-foreground/10"
        style={{ background: color }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function ClientLink({ row }: { row: CallRowData }) {
  if (row.clientId && row.clientName) {
    return (
      <Link
        href={`/clients/${row.clientId}`}
        className="block truncate text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        {row.clientName}
      </Link>
    );
  }
  return <span className="block truncate text-sm font-medium tabular-nums">{row.numberDisplay}</span>;
}

export function CallsDayList({ groups }: { groups: CallDayGroup[] }) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h2>
          <ul className="divide-y divide-foreground/5 rounded-xl bg-card ring-1 ring-foreground/10">
            {group.rows.map((row) => (
              <li key={row.id}>
                {/* ── Rangée façon tableau (md+) ── */}
                <div className="hidden items-center gap-3 px-4 py-2 md:flex">
                  <span className="w-12 shrink-0 text-sm tabular-nums text-muted-foreground">
                    {row.timeLabel}
                  </span>
                  <DirectionIcon
                    direction={row.direction}
                    missed={row.missed}
                    label={row.directionLabel}
                  />
                  <div className="w-52 min-w-0 shrink-0">
                    <ClientLink row={row} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                    {row.durationLabel}
                  </span>
                  <div className="w-40 shrink-0">
                    {row.dispositionLabel && row.dispositionColor ? (
                      <DispositionChip color={row.dispositionColor} label={row.dispositionLabel} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                  <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {row.note ?? ""}
                  </p>
                  {row.dialNumber ? (
                    <RedialButton
                      number={row.dialNumber}
                      clientId={row.clientId ?? undefined}
                      clientName={row.clientName ?? undefined}
                      className="shrink-0"
                    />
                  ) : null}
                </div>

                {/* ── Carte compacte (mobile) ── */}
                <div className="flex items-center gap-3 p-3 md:hidden">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <ClientLink row={row} />
                      {row.dispositionLabel && row.dispositionColor ? (
                        <DispositionChip
                          color={row.dispositionColor}
                          label={row.dispositionLabel}
                        />
                      ) : null}
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <DirectionIcon
                        direction={row.direction}
                        missed={row.missed}
                        label={row.directionLabel}
                        className="[&_svg]:size-3.5"
                      />
                      <span className="tabular-nums">{row.timeLabel}</span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{row.durationLabel}</span>
                    </p>
                    {row.note ? (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{row.note}</p>
                    ) : null}
                  </div>
                  {row.dialNumber ? (
                    <RedialButton
                      number={row.dialNumber}
                      clientId={row.clientId ?? undefined}
                      clientName={row.clientName ?? undefined}
                      iconOnly
                      className="shrink-0"
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
