"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OptionDto } from "./types";

export function AuditFilters({ actions, users }: { actions: string[]; users: OptionDto[] }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page"); // retour à la première page quand un filtre change
    router.replace(`${pathname}?${params.toString()}`);
  };

  const selectFilter = (
    key: string,
    label: string,
    options: OptionDto[],
    allLabel: string,
  ) => {
    const current = searchParams.get(key);
    return (
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <Select
          items={[{ value: null as unknown as string, label: allLabel }, ...options]}
          value={current}
          onValueChange={(v) => setParam(key, v === null ? null : String(v))}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-0" size="sm">
            <SelectValue placeholder={allLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={null}>{allLabel}</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {selectFilter(
        "action",
        t("audit.filterAction"),
        actions.map((a) => ({ value: a, label: a })),
        t("audit.allActions"),
      )}
      {selectFilter("userId", t("audit.filterUser"), users, t("audit.allUsers"))}
      <div className="space-y-1">
        <Label htmlFor="audit-from" className="text-xs">
          {t("audit.from")}
        </Label>
        <Input
          id="audit-from"
          type="date"
          className="h-8"
          defaultValue={searchParams.get("from") ?? ""}
          onChange={(e) => setParam("from", e.target.value || null)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="audit-to" className="text-xs">
          {t("audit.to")}
        </Label>
        <Input
          id="audit-to"
          type="date"
          className="h-8"
          defaultValue={searchParams.get("to") ?? ""}
          onChange={(e) => setParam("to", e.target.value || null)}
        />
      </div>
    </div>
  );
}
