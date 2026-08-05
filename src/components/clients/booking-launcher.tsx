"use client";

import { CalendarPlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BookingDialog } from "@/components/booking/booking-dialog";
import { Button } from "@/components/ui/button";

/**
 * "Prendre rendez-vous" button + BookingDialog (owned by the booking module).
 * Auto-opens when the URL has ?book=1 (post-call flow).
 */
export function BookingLauncher({
  client,
}: {
  client: { id: string; fullName: string; phone: string; email: string | null };
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const shouldAutoOpen = searchParams.get("book") === "1";
  const [open, setOpen] = useState(shouldAutoOpen);

  // Re-open when ?book=1 (re)appears after mount (post-call client-side nav).
  const [prevAuto, setPrevAuto] = useState(shouldAutoOpen);
  if (shouldAutoOpen !== prevAuto) {
    setPrevAuto(shouldAutoOpen);
    if (shouldAutoOpen) setOpen(true);
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && shouldAutoOpen) {
      // Drop ?book=1 so the dialog does not re-open on refresh.
      const params = new URLSearchParams(searchParams.toString());
      params.delete("book");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  };

  return (
    <>
      <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => setOpen(true)}>
        <CalendarPlusIcon />
        {t("detail.book")}
      </Button>
      <BookingDialog client={client} open={open} onOpenChange={onOpenChange} />
    </>
  );
}
