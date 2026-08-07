"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createClientAction } from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { emitDataChange } from "@/lib/live";
import type { FilterOption } from "./clients-filters";

const NONE = "none";

/** Admin-only: manual client creation (server refuses callers too). */
export function AddClientDialog({
  categories,
  sources,
  users,
  compact = false,
}: {
  categories: FilterOption[];
  sources: FilterOption[];
  users: FilterOption[];
  /** Icon-only trigger — used in the tight /clients panel header. */
  compact?: boolean;
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [language, setLanguage] = useState<"fr" | "en">("fr");
  const [categoryId, setCategoryId] = useState(NONE);
  const [sourceId, setSourceId] = useState(NONE);
  const [assignedToId, setAssignedToId] = useState(NONE);
  const [notes, setNotes] = useState("");

  const withNone = (options: FilterOption[]): FilterOption[] => [
    { value: NONE, label: t("list.unassigned") },
    ...options,
  ];
  const categoryOptions: FilterOption[] = [
    { value: NONE, label: t("list.noCategory") },
    ...categories,
  ];
  const languageOptions: FilterOption[] = [
    { value: "fr", label: t("languages.fr") },
    { value: "en", label: t("languages.en") },
  ];

  const reset = () => {
    setFullName("");
    setPhone("");
    setEmail("");
    setCity("");
    setLanguage("fr");
    setCategoryId(NONE);
    setSourceId(NONE);
    setAssignedToId(NONE);
    setNotes("");
  };

  const submit = () => {
    startTransition(async () => {
      const res = await createClientAction({
        fullName,
        phone,
        email: email || null,
        language,
        city: city || null,
        categoryId: categoryId === NONE ? null : Number(categoryId),
        sourceId: sourceId === NONE ? null : Number(sourceId),
        assignedToId: assignedToId === NONE ? null : assignedToId,
        notes: notes || null,
      });
      if (res.ok) {
        toast.success(t("create.success"));
        setOpen(false);
        reset();
        // 1. le panneau de gauche recharge sa page 1 tout de suite,
        // 2. les données serveur (compteurs de catégories) sont réactualisées,
        // 3. on ouvre la fiche créée : la création est visible sans F5.
        emitDataChange("clients");
        router.refresh();
        if (res.id) router.push(`/clients/${res.id}`);
      } else if (res.error === "invalidPhone") {
        toast.error(t("create.invalidPhone"));
      } else if (res.error === "forbidden") {
        toast.error(t("errors.forbidden"));
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            className={compact ? "size-11 md:size-9" : "min-h-11 md:min-h-8"}
            aria-label={t("list.addClient")}
          />
        }
      >
        <PlusIcon />
        {compact ? null : t("list.addClient")}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="new-fullName">{t("fields.fullName")}</Label>
            <Input
              id="new-fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-phone">{t("fields.phone")}</Label>
            <Input
              id="new-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-email">{t("fields.email")}</Label>
            <Input id="new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-city">{t("fields.city")}</Label>
            <Input id="new-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("fields.language")}</Label>
            <Select
              items={languageOptions}
              value={language}
              onValueChange={(v) => setLanguage(v as "fr" | "en")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languageOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("fields.category")}</Label>
            <Select
              items={categoryOptions}
              value={categoryId}
              onValueChange={(v) => setCategoryId(v ?? NONE)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("fields.source")}</Label>
            <Select
              items={withNone(sources)}
              value={sourceId}
              onValueChange={(v) => setSourceId(v ?? NONE)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withNone(sources).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("fields.assignedTo")}</Label>
            <Select
              items={withNone(users)}
              value={assignedToId}
              onValueChange={(v) => setAssignedToId(v ?? NONE)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withNone(users).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="new-notes">{t("fields.notes")}</Label>
            <Textarea
              id="new-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("placeholders.notes")}
              maxLength={5000}
            />
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("create.cancel")}
            </Button>
            <Button type="submit" disabled={pending || !fullName.trim() || !phone.trim()}>
              {t("create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
