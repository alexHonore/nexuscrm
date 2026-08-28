"use client";

import { EyeOffIcon, LockIcon, UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateClientAction } from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
  canEdit,
  canAssign,
  contactMasked,
}: {
  client: EditableClient;
  sources: FilterOption[];
  users: FilterOption[];
  canEdit: boolean;
  /** Donner la fiche à quelqu'un d'autre (prendre/rendre vit dans l'entête). */
  canAssign: boolean;
  /** Téléphone et courriel non ouverts : le serveur n'a envoyé que le masque. */
  contactMasked: boolean;
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

  /**
   * Enregistrer suppose de VOIR les coordonnées.
   *
   * Le formulaire renvoie tous ses champs d'un bloc : avec un numéro masqué,
   * « Enregistrer » écrirait le masque à la place du vrai numéro. Le serveur
   * refuserait, mais l'écran ne doit pas proposer un geste qui détruit —
   * d'où une fiche en lecture seule tant que le contact est fermé. (Le
   * serveur revérifie de toute façon : ce booléen ne protège rien.)
   */
  const editable = canEdit && !contactMasked;

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
    if (!editable) return;
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
        // Le nom/téléphone/ville changent la ligne du panneau de gauche.
        emitDataChange("clients");
        router.refresh();
      } else if (res.error === "invalidPhone") {
        toast.error(t("detail.invalidPhone"));
      } else if (res.error === "invalidPhoneAlt") {
        toast.error(t("detail.invalidPhoneAlt"));
      } else if (res.error === "forbidden") {
        toast.error(t("access.noRight"));
      } else if (res.error === "notFound") {
        // La fiche a cessé d'exister POUR CE REGARD (rendue, réassignée) : le
        // serveur ne distingue pas, et l'écran non plus.
        toast.error(t("errors.notFound"));
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
      <Select
        items={options}
        value={value}
        onValueChange={(v) => onChange(v ?? NONE)}
        disabled={!editable}
      >
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
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <UserRoundIcon className="size-4 text-muted-foreground" />
          {t("detail.infoTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Ce qu'on peut faire de cette fiche, dit AVANT les champs : découvrir
            au moment d'enregistrer qu'on ne pouvait pas est le pire ordre. */}
        {!canEdit ? (
          <p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <LockIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="font-medium text-foreground">{t("access.readOnly")}</span>
            <span>{t("access.readOnlyHint")}</span>
          </p>
        ) : null}
        <form
          id="client-info-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <p className="pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:pt-0 sm:col-span-2">
            {t("detail.sectionContact")}
          </p>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="ci-fullName">{t("fields.fullName")}</Label>
            <Input
              id="ci-fullName"
              className={fieldClass}
              value={form.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              disabled={!editable}
              required
              maxLength={200}
            />
          </div>
          {/* Coordonnées masquées : on ne montre pas des champs vides (qui se
              lisent « il n'y a rien ») ni le masque dans une zone de saisie
              (qui s'enregistrerait). On dit ce qui manque, et pourquoi. */}
          {contactMasked ? (
            <p className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground sm:col-span-2">
              <EyeOffIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">{t("access.masked")}</span>
              <span>{t("access.maskedHint")}</span>
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="ci-phone">{t("fields.phone")}</Label>
                <Input
                  id="ci-phone"
                  type="tel"
                  className={fieldClass}
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  disabled={!editable}
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
                  disabled={!editable}
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
                  disabled={!editable}
                />
              </div>
            </>
          )}
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
              disabled={!editable}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ci-address">{t("fields.address")}</Label>
            <Input
              id="ci-address"
              className={fieldClass}
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              disabled={!editable}
            />
          </div>
          <p className="pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:pt-0 sm:col-span-2">
            {t("detail.sectionProject")}
          </p>
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
              disabled={!editable}
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
              disabled={!editable}
            />
          </div>
          {selectField(t("fields.source"), sourceOptions, form.sourceId, (v) => set("sourceId", v))}
          {/* Donner la fiche à quelqu'un d'autre. Prendre et rendre se font
              dans l'entête : ce sont des gestes, pas des champs de formulaire. */}
          {canAssign
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
              disabled={!editable}
            />
          </div>
        </form>
      </CardContent>
      {editable ? (
        <CardFooter>
          <Button
            type="submit"
            form="client-info-form"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={pending}
          >
            {t("detail.save")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
