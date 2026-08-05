"use client";

import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Global quick search — jumps to /clients?q= (name or phone). */
export function QuickSearch() {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const [q, setQ] = useState("");

  return (
    <form
      className="flex w-full max-w-xl items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        router.push(query ? `/clients?q=${encodeURIComponent(query)}` : "/clients");
      }}
    >
      <div className="relative flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          className="h-11 pl-9"
          inputMode="search"
          enterKeyHint="search"
        />
      </div>
      <Button type="submit" className="h-11 px-4">
        {t("search.submit")}
      </Button>
    </form>
  );
}
