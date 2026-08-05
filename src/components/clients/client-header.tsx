"use client";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  MailIcon,
  MapPinIcon,
  PhoneIcon,
  PhoneOffIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { setClientCategoryAction } from "@/app/(app)/clients/actions";
import { useTelephony } from "@/components/telephony/telephony-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { BookingLauncher } from "./booking-launcher";

export type HeaderCategory = { id: number; nameFr: string; nameEn: string; color: string };

export function ClientHeader({
  client,
  categories,
}: {
  client: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    city: string | null;
    doNotCall: boolean;
    categoryId: number | null;
  };
  categories: HeaderCategory[];
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const router = useRouter();
  const { dial, ready } = useTelephony();
  const [, startTransition] = useTransition();

  const categoryName = (c: HeaderCategory) => (locale === "en" ? c.nameEn : c.nameFr);
  const current = categories.find((c) => c.id === client.categoryId) ?? null;

  const changeCategory = (categoryId: number | null) => {
    startTransition(async () => {
      const res = await setClientCategoryAction(client.id, categoryId);
      if (res.ok) {
        toast.success(t("detail.categoryUpdated"));
        router.refresh();
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  const callDisabled = !ready || client.doNotCall;
  const callButton = (
    <Button
      className="min-h-12 flex-1 bg-emerald-600 px-6 text-base text-white hover:bg-emerald-700 sm:flex-none"
      disabled={callDisabled}
      onClick={() =>
        dial({ number: client.phone, clientId: client.id, clientName: client.fullName })
      }
    >
      <PhoneIcon className="size-5" />
      {t("detail.call")}
    </Button>
  );

  return (
    <div className="space-y-3">
      <Link
        href="/clients"
        className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0"
      >
        <ChevronLeftIcon className="size-4" />
        {t("detail.backToList")}
      </Link>

      {client.doNotCall ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
        >
          <PhoneOffIcon className="size-4 shrink-0" />
          {t("detail.doNotCallBanner")}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-2xl font-semibold tracking-tight break-words">
              {client.fullName}
            </h1>
            {/* Big category badge with quick-change dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("detail.changeCategory")}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
                  !current && "border-border text-muted-foreground hover:bg-muted",
                )}
                style={
                  current
                    ? {
                        color: current.color,
                        backgroundColor: `${current.color}1a`,
                        borderColor: `${current.color}40`,
                      }
                    : undefined
                }
              >
                {current ? (
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: current.color }}
                  />
                ) : null}
                {current ? categoryName(current) : t("detail.noCategory")}
                <ChevronDownIcon className="size-3.5 opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                {categories.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className="min-h-10"
                    onClick={() => changeCategory(c.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                    {categoryName(c)}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem className="min-h-10" onClick={() => changeCategory(null)}>
                  <span aria-hidden className="size-2.5 rounded-full bg-muted-foreground/40" />
                  {t("detail.noCategory")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              <PhoneIcon className="size-3.5" />
              {formatPhone(client.phone)}
            </span>
            {client.email ? (
              <a
                href={`mailto:${client.email}`}
                className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
              >
                <MailIcon className="size-3.5" />
                {client.email}
              </a>
            ) : null}
            {client.city ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPinIcon className="size-3.5" />
                {client.city}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {callDisabled ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger render={<span className="flex-1 sm:flex-none" />}>
                  {callButton}
                </TooltipTrigger>
                <TooltipContent>
                  {client.doNotCall ? t("detail.doNotCallTooltip") : t("detail.phoneNotReady")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            callButton
          )}
          <BookingLauncher
            client={{
              id: client.id,
              fullName: client.fullName,
              phone: client.phone,
              email: client.email,
            }}
          />
        </div>
      </div>
    </div>
  );
}
