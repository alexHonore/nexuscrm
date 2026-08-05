"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type FilterOption = { value: string; label: string };

const ALL = "all";

export function ClientsFilters({
  categories,
  sources,
  users,
}: {
  categories: FilterOption[];
  sources: FilterOption[];
  users: FilterOption[];
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== ALL) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const onSearchChange = (value: string) => {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setParam("q", value.trim() || null), 350);
  };

  const withAll = (options: FilterOption[]): FilterOption[] => [
    { value: ALL, label: t("list.filters.all") },
    ...options,
  ];

  const statusOptions: FilterOption[] = [
    { value: ALL, label: t("list.filters.all") },
    { value: "late", label: t("list.filters.late") },
    { value: "today", label: t("list.filters.today") },
  ];

  const hasFilters =
    Boolean(searchParams.get("q")) ||
    ["category", "source", "assigned", "status"].some((k) => searchParams.get(k));

  const selectClass = "min-h-11 w-full md:min-h-8 md:w-auto md:min-w-36";

  return (
    <div className="space-y-3">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("list.searchPlaceholder")}
          aria-label={t("list.searchPlaceholder")}
          className="min-h-11 pl-9 md:min-h-9"
          inputMode="search"
          enterKeyHint="search"
        />
      </div>
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <Select
          items={withAll(categories)}
          value={searchParams.get("category") ?? ALL}
          onValueChange={(v) => setParam("category", v)}
        >
          <SelectTrigger className={selectClass} aria-label={t("list.filters.category")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {withAll(categories).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          items={withAll(sources)}
          value={searchParams.get("source") ?? ALL}
          onValueChange={(v) => setParam("source", v)}
        >
          <SelectTrigger className={selectClass} aria-label={t("list.filters.source")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {withAll(sources).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          items={withAll(users)}
          value={searchParams.get("assigned") ?? ALL}
          onValueChange={(v) => setParam("assigned", v)}
        >
          <SelectTrigger className={selectClass} aria-label={t("list.filters.assignedTo")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {withAll(users).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          items={statusOptions}
          value={searchParams.get("status") ?? ALL}
          onValueChange={(v) => setParam("status", v)}
        >
          <SelectTrigger className={selectClass} aria-label={t("list.filters.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters ? (
          <Button
            variant="ghost"
            className="col-span-2 min-h-11 md:min-h-8"
            onClick={() => {
              setQ("");
              router.replace(pathname, { scroll: false });
            }}
          >
            <XIcon />
            {t("list.filters.clear")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
