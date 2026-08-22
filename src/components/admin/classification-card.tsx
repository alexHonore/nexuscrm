"use client";

import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TOOL_LOOK, LookIcon } from "@/components/look";
import { ApiError, api } from "./api";

const LOOK = TOOL_LOOK.set_category;

export type ClassificationRule = {
  id: string;
  when: string;
  category: string;
  enabled: boolean;
};

export type CategoryChoice = { value: string; label: string; color: string };

/**
 * Le CLASSEMENT automatique : ce que l'assistant a le droit de conclure d'une
 * phrase, et où il range alors la fiche.
 *
 * « Je veux acheter, mais l'an prochain » et « je suis au Saguenay » sont des
 * décisions de pipeline qu'un téléphoniste prend sans y penser et qu'un
 * assistant apprenait sans rien pouvoir en faire : la fiche restait dans
 * « Non contacté » jusqu'à ce que quelqu'un relise le fil.
 *
 * Une règle est une PHRASE, pas un test : « l'an prochain » ne se compare à
 * rien, il faut le comprendre — c'est justement ce que le modèle sait faire.
 * La liste sert aussi de liste blanche : sans règle vers une catégorie,
 * l'assistant ne peut pas l'y mettre. Il n'y a donc pas un second réglage à
 * tenir d'accord avec le premier.
 */
export function ClassificationCard({
  initial,
  categories,
}: {
  initial: ClassificationRule[];
  categories: CategoryChoice[];
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [rules, setRules] = useState<ClassificationRule[]>(initial);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(rules) !== JSON.stringify(initial);
  const patch = (id: string, next: Partial<ClassificationRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...next } : r)));

  const add = () =>
    setRules((rs) => [
      ...rs,
      {
        // `crypto.randomUUID` est disponible partout où cette carte tourne ;
        // l'identifiant ne sert qu'à réordonner la liste à l'écran.
        id: crypto.randomUUID(),
        when: "",
        category: categories[0]?.value ?? "",
        enabled: true,
      },
    ]);

  const save = async () => {
    setBusy(true);
    try {
      await api("/api/admin/settings/classification", {
        method: "POST",
        body: JSON.stringify({ rules: rules.filter((r) => r.when.trim() !== "") }),
      });
      toast.success(t("saved"));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <LookIcon look={LOOK} size="sm" />
          {t("classification.title")}
        </CardTitle>
        <CardDescription>{t("classification.subtitle")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {categories.length === 0 ? (
          <Alert>
            <AlertDescription>{t("classification.noCategories")}</AlertDescription>
          </Alert>
        ) : null}

        {rules.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("classification.empty")}
          </p>
        ) : null}

        {rules.map((rule, index) => (
          <div key={rule.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_16rem_auto]">
            <div className="space-y-1.5">
              <Label htmlFor={`rule-when-${rule.id}`} className="text-xs">
                {t("classification.when")}
              </Label>
              <Input
                id={`rule-when-${rule.id}`}
                className="min-h-11 md:min-h-9"
                maxLength={300}
                placeholder={t("classification.whenPlaceholder")}
                value={rule.when}
                onChange={(e) => patch(rule.id, { when: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t("classification.then")}</Label>
              <Select
                items={categories.map((c) => ({ value: c.value, label: c.label }))}
                value={rule.category}
                onValueChange={(v) => patch(rule.id, { category: String(v) })}
              >
                <SelectTrigger className="min-h-11 w-full md:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: c.color }}
                        />
                        {c.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end gap-2">
              {/* Désactiver plutôt que supprimer : une règle qu'on veut
                  suspendre le temps d'une campagne se réécrirait sinon. */}
              <div className="flex min-h-11 items-center gap-2 md:min-h-9">
                <Switch
                  id={`rule-on-${rule.id}`}
                  checked={rule.enabled}
                  onCheckedChange={(next) => patch(rule.id, { enabled: next })}
                />
                <Label htmlFor={`rule-on-${rule.id}`} className="text-xs">
                  {t("classification.active")}
                </Label>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 text-destructive md:size-9"
                aria-label={t("classification.remove", { index: index + 1 })}
                onClick={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="min-h-11 md:min-h-9" onClick={add}>
            <Plus /> {t("classification.add")}
          </Button>
          <span className="flex-1" />
          <Button className="min-h-11 md:min-h-9" disabled={busy || !dirty} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            {t("save")}
          </Button>
        </div>

        {/* Le droit de classer se donne PAR ASSISTANT : ces règles ne font rien
            tant que l'outil n'est pas coché dans son onglet « Outils ». */}
        <p className="text-xs text-muted-foreground">{t("classification.toolHint")}</p>
      </CardContent>
    </Card>
  );
}
