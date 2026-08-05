"use client";

import { Trash2Icon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteClientAction } from "@/app/(app)/clients/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogAction,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** Admin-only delete with confirmation (server refuses callers too). */
export function DeleteClientButton({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    startTransition(async () => {
      const res = await deleteClientAction(clientId);
      if (res.ok) {
        toast.success(t("delete.success"));
        setOpen(false);
        if (pathname !== "/clients") router.push("/clients");
        else router.refresh();
      } else {
        toast.error(res.error === "forbidden" ? t("errors.forbidden") : t("errors.generic"));
      }
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={<Button variant="destructive" className="size-11 md:size-8" aria-label={t("delete.label")} />}
      >
        <Trash2Icon />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.description", { name: clientName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={pending}
            onClick={confirm}
          >
            {t("delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
