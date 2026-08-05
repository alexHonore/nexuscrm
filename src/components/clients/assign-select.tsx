"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { assignClientAction } from "@/app/(app)/clients/actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FilterOption } from "./clients-filters";

const NONE = "none";

/** Admin-only quick assignment (server refuses callers too). */
export function AssignSelect({
  clientId,
  users,
  value,
}: {
  clientId: string;
  users: FilterOption[];
  value: string | null;
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const [current, setCurrent] = useState(value ?? NONE);
  const [, startTransition] = useTransition();

  const options: FilterOption[] = [{ value: NONE, label: t("assign.unassigned") }, ...users];

  const onChange = (nextValue: string | null) => {
    const next = nextValue ?? NONE;
    const previous = current;
    setCurrent(next);
    startTransition(async () => {
      const res = await assignClientAction(clientId, next === NONE ? null : next);
      if (res.ok) {
        toast.success(t("assign.success"));
        router.refresh();
      } else {
        setCurrent(previous);
        toast.error(res.error === "forbidden" ? t("errors.forbidden") : t("errors.generic"));
      }
    });
  };

  return (
    <Select items={options} value={current} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className="min-h-11 w-full max-w-44 md:min-h-7"
        aria-label={t("assign.label")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
