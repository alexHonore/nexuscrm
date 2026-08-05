"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateClientAction } from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { FilterOption } from "./clients-filters";

const NONE = "none";
const PROJECT_TYPES = ["acheter", "vendre", "les_deux", "autre"] as const;

export type EditableClient = {
  id: string;
  fullName: string;
  phone: string;
  phoneAlt: string | null;
  email: string | null;
  language: "fr" | "en";
  city: string | null;
  address: string | null;
  projectType: string | null;
  timing: string | null;
  budget: string | null;
  sourceId: number | null;
  assignedToId: string | null;
  notes: string | null;
};

export function ClientInfoForm({
  client,
  sources,
  users,
  isAdmin,
}: {
  client: EditableClient;
  sources: FilterOption[];
  users: FilterOption[];
  isAdmin: boolean;
}) {
  const t = useTranslations("clients");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    fullName: client.fullName,
    phone: client.phone,
    phoneAlt: client.phoneAlt ?? "",
    email: client.email ?? "",
    language: client.language,
    city: client.city ?? "",
    address: client.address ?? "",
    projectType: client.projectType ?? NONE,
    timing: client.timing ?? "",
    budget: client.budget ?? "",
    sourceId: client.sourceId !== null ? String(client.sourceId) : NONE,
    assignedToId: client.assignedToId ?? NONE,
    notes: client.notes ?? "",
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const projectTypeOptions: FilterOption[] = [
    { value: NONE, label: "—" },
    ...PROJECT_TYPES.map((p) => ({ value: p, label: t(`projectTypes.${p}`) })),
    ...(form.projectType !== NONE && !PROJECT_TYPES.includes(form.projectType as never)
      ? [{ value: form.projectType, label: form.projectType }]
      : []),
  ];
  const languageOptions: FilterOption[] = [
    { value: "fr", label: t("languages.fr") },
    { value: "en", label: t("languages.en") },
  ];
  const sourceOptions: FilterOption[] = [{ value: NONE, label: "—" }, ...sources];
  const userOptions: FilterOption[] = [{ value: NONE, label: t("assign.unassigned") }, ...users];

  const fieldClass = "min-h-11 md:min-h-8";
  const selectClass = "min-h-11 w-full md:min-h-8";

  const submit = () => {
    startTransition(async () => {
      const res = await updateClientAction(client.id, {
        fullName: form.fullName,
        phone: form.phone,
        phoneAlt: form.phoneAlt || null,
        email: form.email || null,
        language: form.language,
        city: form.city || null,
        address: form.address || null,
        projectType: form.projectType === NONE ? null : form.projectType,
        timing: form.timing || null,
        budget: form.budget || null,
        sourceId: form.sourceId === NONE ? null : Number(form.sourceId),
        assignedToId: form.assignedToId === NONE ? null : form.assignedToId,
        notes: form.notes || null,
      });
      if (res.ok) {
        toast.success(t("detail.saved"));
        router.refresh();
      } else if (res.error === "invalidPhone") {
        toast.error(t("detail.invalidPhone"));
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  const selectField = (
    label: string,
    options: FilterOption[],
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select items={options} value={value} onValueChange={(v) => onChange(v ?? NONE)}>
        <SelectTrigger className={selectClass} aria-label={label}>
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
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("detail.infoTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ci-fullName">{t("fields.fullName")}</Label>
            <Input
              id="ci-fullName"
              className={fieldClass}
              value={form.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-phone">{t("fields.phone")}</Label>
            <Input
              id="ci-phone"
              type="tel"
              className={fieldClass}
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-phoneAlt">{t("fields.phoneAlt")}</Label>
            <Input
              id="ci-phoneAlt"
              type="tel"
              className={fieldClass}
              value={form.phoneAlt}
              onChange={(e) => set("phoneAlt", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-email">{t("fields.email")}</Label>
            <Input
              id="ci-email"
              type="email"
              className={fieldClass}
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          {selectField(t("fields.language"), languageOptions, form.language, (v) =>
            set("language", v as "fr" | "en"),
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ci-city">{t("fields.city")}</Label>
            <Input
              id="ci-city"
              className={fieldClass}
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-address">{t("fields.address")}</Label>
            <Input
              id="ci-address"
              className={fieldClass}
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          {selectField(t("fields.projectType"), projectTypeOptions, form.projectType, (v) =>
            set("projectType", v),
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ci-timing">{t("fields.timing")}</Label>
            <Input
              id="ci-timing"
              className={fieldClass}
              value={form.timing}
              onChange={(e) => set("timing", e.target.value)}
              placeholder={t("placeholders.timing")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-budget">{t("fields.budget")}</Label>
            <Input
              id="ci-budget"
              className={fieldClass}
              value={form.budget}
              onChange={(e) => set("budget", e.target.value)}
              placeholder={t("placeholders.budget")}
            />
          </div>
          {selectField(t("fields.source"), sourceOptions, form.sourceId, (v) => set("sourceId", v))}
          {isAdmin
            ? selectField(t("fields.assignedTo"), userOptions, form.assignedToId, (v) =>
                set("assignedToId", v),
              )
            : null}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ci-notes">{t("fields.notes")}</Label>
            <Textarea
              id="ci-notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder={t("placeholders.notes")}
              maxLength={5000}
              rows={4}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" className="min-h-11 w-full sm:w-auto md:min-h-8" disabled={pending}>
              {t("detail.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
