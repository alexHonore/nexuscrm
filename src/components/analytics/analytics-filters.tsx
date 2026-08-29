"use client";

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
import type { PeriodPreset } from "@/components/analytics/period";

const ALL_USERS = "all";

export function AnalyticsFilters({
  preset,
  fromStr,
  toStr,
  userId,
  users,
}: {
  preset: PeriodPreset;
  fromStr: string;
  toStr: string;
  userId?: string;
  users: { id: string; name: string }[];
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [showCustom, setShowCustom] = useState(preset === "custom");
  const [customFrom, setCustomFrom] = useState(fromStr);
  const [customTo, setCustomTo] = useState(toStr);

  const apply = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  };

  const selectPreset = (p: Exclude<PeriodPreset, "custom">) => {
    setShowCustom(false);
    apply({ period: p, from: null, to: null });
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    apply({ period: "custom", from: customFrom, to: customTo });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("period.label")}
          className="inline-flex rounded-lg border border-border p-0.5"
        >
          {(["7", "30", "90"] as const).map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={preset === p && !showCustom ? "secondary" : "ghost"}
              className="h-11 min-w-14 md:h-7"
              aria-pressed={preset === p && !showCustom}
              onClick={() => selectPreset(p)}
            >
              {t(`period.days${p}`)}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant={preset === "custom" || showCustom ? "secondary" : "ghost"}
            className="h-11 md:h-7"
            aria-pressed={preset === "custom" || showCustom}
            onClick={() => setShowCustom((v) => !v)}
          >
            {t("period.custom")}
          </Button>
        </div>

        <Select
          value={userId ?? ALL_USERS}
          onValueChange={(value) =>
            apply({ user: value === ALL_USERS || value === null ? null : String(value) })
          }
        >
          <SelectTrigger
            aria-label={t("period.user")}
            className="min-h-11 min-w-44 md:min-h-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_USERS}>{t("period.allUsers")}</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showCustom ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="analytics-from" className="text-xs text-muted-foreground">
              {t("period.from")}
            </Label>
            <Input
              id="analytics-from"
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-11 w-40 md:h-8"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="analytics-to" className="text-xs text-muted-foreground">
              {t("period.to")}
            </Label>
            <Input
              id="analytics-to"
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-11 w-40 md:h-8"
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-11 md:h-8"
            onClick={applyCustom}
            disabled={!customFrom || !customTo}
          >
            {t("period.apply")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
