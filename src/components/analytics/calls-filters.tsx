"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "all";

export function CallsFilters({
  q,
  userId,
  direction,
  disposition,
  status,
  fromStr,
  toStr,
  users,
  dispositions,
}: {
  q: string;
  userId?: string;
  direction?: "outbound" | "inbound";
  disposition?: string;
  status?: "missed" | "answered";
  fromStr?: string;
  toStr?: string;
  users: { id: string; name: string }[];
  /** « Sans réponse » + statuts du pipeline — libellés préparés côté serveur. */
  dispositions: { value: string; label: string }[];
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState(q);
  const [from, setFrom] = useState(fromStr ?? "");
  const [to, setTo] = useState(toStr ?? "");

  const apply = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  };

  const hasFilters =
    q !== "" || userId || direction || disposition || status || fromStr || toStr;

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: search.trim() || null });
        }}
      >
        <div className="relative flex-1 md:max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("callsPage.searchPlaceholder")}
            aria-label={t("callsPage.search")}
            className="h-11 pl-8 md:h-8"
          />
        </div>
        <Button type="submit" variant="outline" className="h-11 md:h-8">
          {t("callsPage.search")}
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-2">
        <Select
          value={userId ?? ALL}
          onValueChange={(value) => apply({ user: value === ALL ? null : String(value) })}
        >
          <SelectTrigger aria-label={t("period.user")} className="h-11 min-w-40 md:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("period.allUsers")}</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={direction ?? ALL}
          // « Sortants » et « Manqués » (entrants par définition) s'excluent.
          onValueChange={(value) =>
            apply({
              direction: value === ALL ? null : String(value),
              ...(value === "outbound" && status === "missed" ? { status: null } : {}),
            })
          }
        >
          <SelectTrigger aria-label={t("callsPage.direction")} className="h-11 min-w-32 md:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("callsPage.allDirections")}</SelectItem>
            <SelectItem value="outbound">{t("callsPage.outbound")}</SelectItem>
            <SelectItem value="inbound">{t("callsPage.inbound")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={status ?? ALL}
          onValueChange={(value) =>
            apply({
              status: value === ALL ? null : String(value),
              ...(value === "missed" && direction === "outbound" ? { direction: null } : {}),
            })
          }
        >
          <SelectTrigger aria-label={t("callsPage.status")} className="h-11 min-w-32 md:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("callsPage.allStatuses")}</SelectItem>
            <SelectItem value="answered">{t("callsPage.answered")}</SelectItem>
            <SelectItem value="missed">{t("callsPage.missed")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={disposition ?? ALL}
          onValueChange={(value) => apply({ dispo: value === ALL ? null : String(value) })}
        >
          <SelectTrigger aria-label={t("callsPage.disposition")} className="h-11 min-w-40 md:h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("callsPage.allDispositions")}</SelectItem>
            {dispositions.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-col gap-1">
          <Label htmlFor="calls-from" className="text-xs text-muted-foreground">
            {t("period.from")}
          </Label>
          <Input
            id="calls-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              apply({ from: e.target.value || null });
            }}
            className="h-11 w-38 md:h-8"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="calls-to" className="text-xs text-muted-foreground">
            {t("period.to")}
          </Label>
          <Input
            id="calls-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              apply({ to: e.target.value || null });
            }}
            className="h-11 w-38 md:h-8"
          />
        </div>

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 md:h-8"
            onClick={() => {
              setSearch("");
              setFrom("");
              setTo("");
              apply({
                q: null,
                user: null,
                direction: null,
                dispo: null,
                status: null,
                from: null,
                to: null,
              });
            }}
          >
            <XIcon className="size-4" />
            {t("callsPage.reset")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
