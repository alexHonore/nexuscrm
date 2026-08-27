"use client";

import { AlertTriangle, Loader2, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
  CAMPAIGN_RUNG_LOOK,
  CAMPAIGN_STAT_LOOK,
  CAMPAIGN_TAB_LOOK,
  ENROLLMENT_STATUS_LOOK,
  LookGlyph,
  LookIcon,
  lookTint,
  type Look,
} from "@/components/look";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { TRIGGER_KINDS } from "@/lib/campaigns/schema";
import { planLadder } from "@/lib/campaigns/ladder";
import { enrollmentInFlight, enrollmentPaused } from "@/lib/campaigns/enrollment-status";
import { AddClientsDialog } from "./add-clients-dialog";
import { analyzeSms } from "@/lib/sms/segments";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { TRIGGER_LOOK, TriggerIcon } from "../trigger-look";
import type { CampaignTabProps } from "./types";

const NONE = "__none__";

/**
 * Pastille teintée aux couleurs d'un concept.
 *
 * Le motif — pictogramme, libellé, teinte du vocabulaire — revient à chaque
 * état et à chaque mesure de cet éditeur ; groupé ici, il ne peut pas dériver
 * d'un écran à l'autre, et la règle tient au même endroit : le libellé RESTE,
 * la couleur ne le remplace jamais.
 *
 * La teinte prend le FOND et la BORDURE, jamais le texte : un « En pause »
 * ambre de douze pixels sur fond clair ne se lit pas. Le pictogramme porte la
 * couleur, le libellé garde son contraste — même règle que la liste des
 * assistants, où la teinte a déjà quitté le texte pour cette raison.
 */
function LookBadge({
  look,
  filled = false,
  className,
  children,
}: {
  look: Look;
  filled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const tint = lookTint(look);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 pl-1.5 font-normal", className)}
      style={{
        borderColor: tint.borderColor,
        backgroundColor: filled ? tint.backgroundColor : undefined,
      }}
    >
      <LookGlyph look={look} />
      {children}
    </Badge>
  );
}

/**
 * Motifs de fin d'inscription qui ont une étiquette. Tout autre motif (une
 * valeur écrite par un module futur) s'affiche tel quel plutôt que de faire
 * fuir une clé i18n à l'écran.
 */
const END_REASONS = new Set([
  "replied",
  "booked",
  "opted_out",
  "ladder_exhausted",
  "suppressed",
  "do_not_call",
  "live_conversation",
  "client_deleted",
  "campaign_archived",
  // Retrait manuel par l'administrateur (removeEnrollment) : la fiche est close
  // avec ce motif. « paused_by_admin » n'y figure PAS — une pause a
  // `ended_at` null et n'atteint jamais la colonne « Terminé ».
  "removed_by_admin",
  // Retrait AUTOMATIQUE : la fiche a changé de catégorie et la campagne ne la
  // vise plus (releaseCategoryMismatches).
  "left_audience",
  // Verdicts de l'assistant (`agent/runtime.ts`). Ils n'avaient jamais
  // d'étiquette : ils s'affichaient en anglais brut dans cette colonne, et
  // DISPARAISSAIENT sur la fiche client, dont le garde `tc.has` masque toute
  // clé absente — l'inscription se terminait alors sans dire pourquoi.
  "hard_refusal",
  "goal_reached",
  "disqualified",
  "not_interested",
]);

/** Cases à cocher d'une liste d'identifiants — le motif se répète 4 fois. */
function MultiSelect<T extends string | number>({
  label,
  icon,
  hint,
  options,
  selected,
  onChange,
  emptyLabel,
}: {
  label: string;
  /** Pictogramme du concept que la liste filtre — il DOUBLE l'étiquette. */
  icon?: ReactNode;
  hint?: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-2">
      <Label>
        {icon}
        {label}
      </Label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label
                key={String(option.value)}
                className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm md:min-h-9"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next
                        ? [...selected, option.value]
                        : selected.filter((v) => v !== option.value),
                    )
                  }
                />
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
      )}
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : null}
    </div>
  );
}

// ── Général ──────────────────────────────────────────────────────────────────

export function BasicsTab({ config, update, data }: CampaignTabProps) {
  const t = useTranslations("campaigns");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1.5 md:col-span-2">
        <Label htmlFor="c-name">{t("editor.basics.name")}</Label>
        <Input
          id="c-name"
          value={config.name}
          onChange={(e) => update((d) => void (d.name = e.target.value))}
          className="min-h-11 md:min-h-9"
        />
      </div>

      <div className="space-y-1.5 md:col-span-2">
        <Label htmlFor="c-desc">{t("editor.basics.description")}</Label>
        <Textarea
          id="c-desc"
          rows={2}
          value={config.description ?? ""}
          onChange={(e) => update((d) => void (d.description = e.target.value || null))}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t("editor.basics.assistant")}</Label>
        <p className="text-xs text-muted-foreground">{t("editor.basics.assistantHint")}</p>
        <Select
          items={[
            { value: NONE, label: t("editor.basics.noAssistant") },
            ...data.assistants.map((a) => ({ value: a.id, label: a.name })),
          ]}
          value={config.assistantId ?? NONE}
          onValueChange={(v) => update((d) => void (d.assistantId = v === NONE ? null : String(v)))}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("editor.basics.noAssistant")}</SelectItem>
            {data.assistants.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>{t("editor.basics.number")}</Label>
        <Select
          items={[
            { value: NONE, label: t("editor.basics.defaultNumber") },
            ...data.numbers.map((n) => ({ value: n.id, label: n.label ?? n.e164 })),
          ]}
          value={config.smsNumberId ?? NONE}
          onValueChange={(v) => update((d) => void (d.smsNumberId = v === NONE ? null : String(v)))}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("editor.basics.defaultNumber")}</SelectItem>
            {data.numbers.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.label ? `${n.label} — ${n.e164}` : n.e164}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="c-daily">{t("editor.basics.dailyCap")}</Label>
        <p className="text-xs text-muted-foreground">{t("editor.basics.dailyCapHint")}</p>
        <Input
          id="c-daily"
          type="number"
          inputMode="numeric"
          min={1}
          max={5000}
          value={config.dailyEnrollmentCap}
          onChange={(e) => update((d) => void (d.dailyEnrollmentCap = Number(e.target.value)))}
          className="min-h-11 md:min-h-9"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="c-total">{t("editor.basics.totalCap")}</Label>
        <Input
          id="c-total"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder={t("editor.basics.noTotalCap")}
          value={config.totalEnrollmentCap ?? ""}
          onChange={(e) =>
            update((d) => void (d.totalEnrollmentCap = e.target.value ? Number(e.target.value) : null))
          }
          className="min-h-11 md:min-h-9"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="c-starts">{t("editor.basics.startsAt")}</Label>
        <Input
          id="c-starts"
          type="date"
          value={config.startsAt ? config.startsAt.toISOString().slice(0, 10) : ""}
          onChange={(e) =>
            update((d) => void (d.startsAt = e.target.value ? new Date(e.target.value) : null))
          }
          className="min-h-11 md:min-h-9"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="c-ends">{t("editor.basics.endsAt")}</Label>
        <Input
          id="c-ends"
          type="date"
          value={config.endsAt ? config.endsAt.toISOString().slice(0, 10) : ""}
          onChange={(e) =>
            update((d) => void (d.endsAt = e.target.value ? new Date(e.target.value) : null))
          }
          className="min-h-11 md:min-h-9"
        />
      </div>
    </div>
  );
}

// ── Déclencheur ──────────────────────────────────────────────────────────────

export function TriggerTab({ config, update, data }: CampaignTabProps) {
  const t = useTranslations("campaigns");
  const kind = config.trigger.kind;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>
          <LookGlyph look={CAMPAIGN_TAB_LOOK.trigger} className="size-3.5" />
          {t("editor.trigger.kind")}
        </Label>
        {/* Quatre tuiles plutôt qu'une liste déroulante : elle cachait trois
            options sur quatre et n'expliquait le choix qu'une fois fait. Même
            pastille et même couleur qu'à la création. */}
        <div className="grid gap-2 sm:grid-cols-2">
          {TRIGGER_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() =>
                update((d) => {
                  d.trigger =
                    k === "lead_created"
                      ? { kind: "lead_created", sourceIds: [] }
                      : k === "category_changed"
                        ? { kind: "category_changed", toCategoryIds: [] }
                        : k === "scheduled"
                          ? { kind: "scheduled", everyHours: 24 }
                          : { kind: "manual" };
                })
              }
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm",
                "transition-all duration-150 hover:border-[color:var(--tone)] hover:bg-[color:var(--tone)]/5",
                kind === k && "border-[color:var(--tone)] bg-[color:var(--tone)]/5",
              )}
              style={{ ["--tone" as string]: TRIGGER_LOOK[k].color }}
            >
              <TriggerIcon kind={k} />
              <span className="min-w-0">
                <span className="font-medium">{t(`list.trigger.${k}`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(
                    k === "manual"
                      ? "editor.trigger.manualHint"
                      : k === "lead_created"
                        ? "editor.trigger.leadHint"
                        : k === "category_changed"
                          ? "editor.trigger.categoryHint"
                          : "editor.trigger.scheduledHint",
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {config.trigger.kind === "lead_created" ? (
        <MultiSelect
          label={t("editor.trigger.sources")}
          // Le réglage appartient au déclencheur choisi : la même pastille le
          // rattache à sa tuile, sinon la liste flotte sans propriétaire.
          icon={<TriggerIcon kind="lead_created" size="sm" />}
          options={data.sources.map((s) => ({ value: s.id, label: s.name }))}
          selected={config.trigger.sourceIds}
          emptyLabel={t("editor.trigger.allSources")}
          onChange={(next) =>
            update((d) => {
              if (d.trigger.kind === "lead_created") d.trigger.sourceIds = next;
            })
          }
        />
      ) : null}

      {config.trigger.kind === "category_changed" ? (
        <MultiSelect
          label={t("editor.trigger.categories")}
          icon={<TriggerIcon kind="category_changed" size="sm" />}
          options={data.categories.map((c) => ({ value: c.id, label: c.name }))}
          selected={config.trigger.toCategoryIds}
          emptyLabel={t("editor.trigger.allCategories")}
          onChange={(next) =>
            update((d) => {
              if (d.trigger.kind === "category_changed") d.trigger.toCategoryIds = next;
            })
          }
        />
      ) : null}

      {config.trigger.kind === "scheduled" ? (
        <div className="space-y-1.5">
          <Label htmlFor="c-every">
            <TriggerIcon kind="scheduled" size="sm" />
            {t("editor.trigger.everyHours")}
          </Label>
          <Input
            id="c-every"
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            value={config.trigger.everyHours}
            onChange={(e) =>
              update((d) => {
                if (d.trigger.kind === "scheduled") d.trigger.everyHours = Number(e.target.value);
              })
            }
            className="min-h-11 md:min-h-9 md:w-40"
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Audience ─────────────────────────────────────────────────────────────────

export function AudienceTab({ config, update, data }: CampaignTabProps) {
  const t = useTranslations("campaigns");
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // L'aperçu compte la configuration À L'ÉCRAN, enregistrée ou non : après
  // avoir resserré un filtre, l'administrateur veut savoir ce que CE filtre
  // vise — pas ce que la version en base visait. Un échec se dit : un compteur
  // qui disparaît sans un mot ressemble à « personne ».
  const preview = async () => {
    setLoading(true);
    try {
      const res = await api<{ count: number }>(`/api/campaigns/${data.id}/preview`, {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setCount(res.count);
    } catch {
      setCount(null);
      toast.error(t("editor.errors.preview"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <LookIcon look={CAMPAIGN_TAB_LOOK.audience} size="sm" />
          {loading
            ? t("editor.audience.previewing")
            : count === null
              ? t("editor.audience.title")
              : t("editor.audience.preview", { count })}
        </p>
        {/* L'aperçu se demande, il ne se devine pas — et il compte la
            configuration affichée, enregistrée ou non. */}
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-9"
          onClick={() => void preview()}
          disabled={loading}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}{" "}
          {t("editor.audience.refresh")}
        </Button>
      </div>

      <MultiSelect
        label={t("editor.audience.categories")}
        options={data.categories.map((c) => ({ value: c.id, label: c.name }))}
        selected={config.audience.categoryIds}
        emptyLabel={t("editor.audience.any")}
        onChange={(next) => update((d) => void (d.audience.categoryIds = next))}
      />

      <MultiSelect
        label={t("editor.audience.sources")}
        options={data.sources.map((s) => ({ value: s.id, label: s.name }))}
        selected={config.audience.sourceIds}
        emptyLabel={t("editor.audience.any")}
        onChange={(next) => update((d) => void (d.audience.sourceIds = next))}
      />

      <MultiSelect
        label={t("editor.audience.assignedTo")}
        options={data.users.map((u) => ({ value: u.id, label: u.name }))}
        selected={config.audience.assignedToIds}
        emptyLabel={t("editor.audience.any")}
        onChange={(next) => update((d) => void (d.audience.assignedToIds = next))}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="a-within">{t("editor.audience.createdWithinDays")}</Label>
          <Input
            id="a-within"
            type="number"
            inputMode="numeric"
            min={1}
            value={config.audience.createdWithinDays ?? ""}
            onChange={(e) =>
              update(
                (d) =>
                  void (d.audience.createdWithinDays = e.target.value
                    ? Number(e.target.value)
                    : null),
              )
            }
            className="min-h-11 md:min-h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-before">{t("editor.audience.createdBeforeDays")}</Label>
          <Input
            id="a-before"
            type="number"
            inputMode="numeric"
            min={1}
            value={config.audience.createdBeforeDays ?? ""}
            onChange={(e) =>
              update(
                (d) =>
                  void (d.audience.createdBeforeDays = e.target.value
                    ? Number(e.target.value)
                    : null),
              )
            }
            className="min-h-11 md:min-h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a-cold">{t("editor.audience.notContactedForDays")}</Label>
          <Input
            id="a-cold"
            type="number"
            inputMode="numeric"
            min={1}
            value={config.audience.notContactedForDays ?? ""}
            onChange={(e) =>
              update(
                (d) =>
                  void (d.audience.notContactedForDays = e.target.value
                    ? Number(e.target.value)
                    : null),
              )
            }
            className="min-h-11 md:min-h-9"
          />
          <p className="text-xs text-muted-foreground">{t("editor.audience.notContactedHint")}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="a-excl-active">{t("editor.audience.excludeActive")}</Label>
            <Switch
              id="a-excl-active"
              checked={config.audience.excludeActiveInOtherCampaign}
              onCheckedChange={(next) =>
                update((d) => void (d.audience.excludeActiveInOtherCampaign = next))
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("editor.audience.excludeActiveHint")}</p>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <Label htmlFor="a-excl-dnc">{t("editor.audience.excludeDoNotCall")}</Label>
          <Switch
            id="a-excl-dnc"
            checked={config.audience.excludeDoNotCall}
            onCheckedChange={(next) => update((d) => void (d.audience.excludeDoNotCall = next))}
          />
        </div>
      </div>
    </div>
  );
}

// ── Échelle ──────────────────────────────────────────────────────────────────

export function LadderTab({ config, update }: CampaignTabProps) {
  const t = useTranslations("campaigns");
  const now = new Date();
  const plan = planLadder(config.ladder, now);
  // Le délai affiché en tête de barreau est CUMULÉ depuis l'inscription : le
  // champ, lui, se saisit relativement au barreau précédent. C'est le cumul
  // qu'on cherche en parcourant l'échelle — « ce message part le jour 5 ».
  // Même arrondi qu'au résumé de création, pour que les deux écrans concordent.
  const dayOf = plan.map((touch) =>
    Math.round((touch.dueAt.getTime() - now.getTime()) / 86_400_000),
  );
  const when = CAMPAIGN_RUNG_LOOK.when;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("editor.ladder.hint")}</p>

      {config.ladder.length === 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription>{t("editor.ladder.empty")}</AlertDescription>
        </Alert>
      ) : null}

      {/* Une SÉQUENCE, pas une pile de cartes identiques. Le rang tient dans
          la pastille, un fil relie les barreaux entre eux, et le départ cumulé
          se lit en tête : c'est ce couple rang/délai qu'on parcourt du regard
          avant de lire un seul mot de message. */}
      {/* Aucun espacement entre les <li> : le fil du rail traverse d'un
          barreau à l'autre, une gouttière le couperait. */}
      <ol className="space-y-0">
        {config.ladder.map((step, i) => {
          const analysis = analyzeSms(step.body ?? "");
          const last = i === config.ladder.length - 1;
          return (
            <li key={i} className="flex gap-3">
              {/* Le rail double le badge « Barreau n » : muet pour un lecteur
                  d'écran, qui entendrait sinon un « 1 » sans contexte.
                  Exactement le rail du résumé de création — même pastille,
                  même fil, même teinte de thème : c'est la même échelle vue
                  deux fois, et le bleu clair du vocabulaire ne se lirait pas à
                  cette taille. */}
              <div aria-hidden className="flex w-8 shrink-0 flex-col items-center">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {i + 1}
                </span>
                {last ? null : <span className="my-1 w-px flex-1 rounded-full bg-primary/25" />}
              </div>

              <div className="mb-4 min-w-0 flex-1 space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={i === 0 ? "default" : "secondary"}>
                    {i === 0 ? t("editor.ladder.opener") : t("editor.ladder.step", { n: i + 1 })}
                  </Badge>
                  {/* Le départ cumulé, dans les mots déjà employés au résumé de
                      création : l'échelle se lit pareil des deux côtés. */}
                  <LookBadge look={when}>
                    {dayOf[i] === 0
                      ? t("create.summary.now")
                      : t("create.summary.dayN", { days: dayOf[i] })}
                  </LookBadge>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 text-destructive md:min-h-9"
                    onClick={() => update((d) => void d.ladder.splice(i, 1))}
                  >
                    <Trash2 /> {t("editor.ladder.remove")}
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`l-delay-${i}`}>
                      <LookGlyph look={when} className="size-3.5" />
                      {t("editor.ladder.delayHours")}
                    </Label>
                    <Input
                      id={`l-delay-${i}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={step.delayHours}
                      onChange={(e) =>
                        update((d) => void (d.ladder[i].delayHours = Number(e.target.value)))
                      }
                      className="min-h-11 md:min-h-9"
                    />
                    <p className="text-xs text-muted-foreground">
                      {i === 0
                        ? t("editor.ladder.delayFromEnroll")
                        : t("editor.ladder.delayFromPrevious")}
                      {" · "}
                      {t("editor.ladder.schedule", {
                        when: plan[i]?.dueAt.toLocaleString("fr-CA", { timeZone: "America/Toronto" }) ?? "",
                      })}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={`l-label-${i}`}>{t("editor.ladder.label")}</Label>
                    <Input
                      id={`l-label-${i}`}
                      value={step.label}
                      onChange={(e) => update((d) => void (d.ladder[i].label = e.target.value))}
                      className="min-h-11 md:min-h-9"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  {/* Un barreau au message vide n'est pas muet : c'est l'assistant
                      qui rédigera. Deux pictogrammes différents, parce que ce
                      n'est pas la même chose et que ça ne se voyait nulle part. */}
                  <Label htmlFor={`l-body-${i}`}>
                    <LookGlyph
                      look={step.body ? CAMPAIGN_RUNG_LOOK.written : CAMPAIGN_RUNG_LOOK.byAssistant}
                      className="size-3.5"
                    />
                    {t("editor.ladder.body")}
                  </Label>
                  <Textarea
                    id={`l-body-${i}`}
                    rows={3}
                    placeholder={t("editor.ladder.bodyPlaceholder")}
                    value={step.body ?? ""}
                    // Des espaces seuls ne sont pas un message : c'est « l'assistant
                    // rédige », comme le schéma serveur le normalise.
                    onChange={(e) =>
                      update(
                        (d) =>
                          void (d.ladder[i].body = e.target.value.trim() === "" ? null : e.target.value),
                      )
                    }
                  />
                  {step.body ? (
                    // Le nombre de segments décide du coût : un accent hors table
                    // GSM fait tomber la capacité de 160 à 70 caractères.
                    <p className="text-xs text-muted-foreground">
                      {t("editor.ladder.segments", {
                        chars: analysis.units,
                        segments: analysis.segments,
                      })}
                    </p>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LookGlyph look={CAMPAIGN_RUNG_LOOK.byAssistant} className="size-3.5" />
                      {t("editor.ladder.bodyAgent")}
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <Button
        variant="outline"
        className="min-h-11 md:min-h-9"
        disabled={config.ladder.length >= 8}
        onClick={() =>
          update((d) =>
            void d.ladder.push({ delayHours: d.ladder.length === 0 ? 0 : 48, body: null, label: "" }),
          )
        }
      >
        <Plus /> {t("editor.ladder.add")}
      </Button>
    </div>
  );
}

// ── A/B ──────────────────────────────────────────────────────────────────────

export function VariantsTab({ config, update, data }: CampaignTabProps) {
  const t = useTranslations("campaigns");
  const totalWeight = config.variants.reduce((sum, v) => sum + v.weight, 0);
  const split = CAMPAIGN_TAB_LOOK.variants;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("editor.variants.hint")}</p>

      {config.variants.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("editor.variants.none")}
        </p>
      ) : null}

      {config.variants.map((variant, i) => (
        <div key={i} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`v-key-${i}`}>{t("editor.variants.key")}</Label>
              <Input
                id={`v-key-${i}`}
                value={variant.key}
                onChange={(e) => update((d) => void (d.variants[i].key = e.target.value))}
                className="min-h-11 md:min-h-9 md:w-40"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`v-weight-${i}`}>{t("editor.variants.weight")}</Label>
              <Input
                id={`v-weight-${i}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={variant.weight}
                onChange={(e) => update((d) => void (d.variants[i].weight = Number(e.target.value)))}
                className="min-h-11 md:min-h-9 md:w-28"
              />
            </div>
            {/* La part est le résultat du poids, pas un réglage : en pastille
                teintée, elle se distingue du champ qu'on vient de saisir. */}
            {totalWeight > 0 ? (
              <LookBadge look={split} className="mb-2">
                {t("editor.variants.share", {
                  percent: Math.round((variant.weight / totalWeight) * 100),
                })}
              </LookBadge>
            ) : null}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 text-destructive md:min-h-9"
              onClick={() => update((d) => void d.variants.splice(i, 1))}
            >
              <Trash2 /> {t("editor.variants.remove")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`v-body-${i}`}>{t("editor.variants.body")}</Label>
            <Textarea
              id={`v-body-${i}`}
              rows={3}
              value={variant.body}
              onChange={(e) => update((d) => void (d.variants[i].body = e.target.value))}
            />
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        className="min-h-11 md:min-h-9"
        disabled={config.variants.length >= 4}
        onClick={() =>
          update((d) =>
            void d.variants.push({ key: `v${d.variants.length + 1}`, weight: 50, body: "" }),
          )
        }
      >
        <Plus /> {t("editor.variants.add")}
      </Button>

      {data.variantStats.length > 0 ? (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 font-medium">
            <LookGlyph look={split} />
            {t("editor.variants.results")}
          </h3>
          {/* Les MÊMES pictogrammes que les compteurs de la liste : trois
              colonnes de chiffres se distinguent par leur en-tête, pas par
              leur position. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("editor.variants.key")}</TableHead>
                {(["enrolled", "replied", "stopped"] as const).map((key) => (
                  <TableHead key={key}>
                    <span className="flex items-center gap-1.5">
                      <LookGlyph look={CAMPAIGN_STAT_LOOK[key]} className="size-3.5" />
                      {t(`list.stats.${key}`, { count: "" }).trim()}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.variantStats.map((row) => (
                <TableRow key={row.variant || "—"}>
                  <TableCell>{row.variant || "—"}</TableCell>
                  <TableCell>{row.enrolled}</TableCell>
                  <TableCell>{row.replied}</TableCell>
                  <TableCell className={row.stopped > 0 ? "text-destructive" : undefined}>
                    {row.stopped}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}

// ── Inscriptions ─────────────────────────────────────────────────────────────

export function EnrollmentsTab({
  data,
  onEnroll,
  enrolling,
  onAction,
  actingId,
  onBulk,
  bulkBusy,
  onAdded,
}: CampaignTabProps & {
  onEnroll: () => void;
  enrolling: boolean;
  /** Pause / reprise / retrait d'UNE inscription. */
  onAction: (enrollmentId: string, action: "pause" | "resume" | "remove", clientName: string) => void;
  /** L'inscription dont une action est en cours — ses boutons tournent. */
  actingId: string | null;
  /** Action sur un LOT d'inscriptions sélectionnées. */
  onBulk: (enrollmentIds: string[], action: "pause" | "resume" | "remove") => void;
  /** Une action en lot est en cours. */
  bulkBusy: boolean;
  /** Des fiches viennent d'être ajoutées — recharger la liste. */
  onAdded: () => void;
}) {
  const t = useTranslations("campaigns");
  // Sélection pour les actions en lot — uniquement des inscriptions EN VOL
  // (les inscriptions closes ne s'actionnent pas).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inFlightIds = data.enrollments.filter((e) => enrollmentInFlight(e.status)).map((e) => e.id);
  const allSelected = inFlightIds.length > 0 && inFlightIds.every((id) => selected.has(id));
  const toggleOne = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(inFlightIds) : new Set());
  const runBulk = (action: "pause" | "resume" | "remove") => {
    const ids = [...selected];
    if (ids.length === 0) return;
    onBulk(ids, action);
    setSelected(new Set());
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Ajouter des fiches précises — une par une ou en lot — indépendamment
            des filtres d'audience. Recherche par nom, catégorie, source, etc. */}
        <AddClientsDialog
          campaignId={data.id}
          categories={data.categories}
          sources={data.sources}
          users={data.users}
          onAdded={onAdded}
        />
        <Button onClick={onEnroll} disabled={enrolling} className="min-h-11 md:min-h-9">
          {enrolling ? <Loader2 className="animate-spin" /> : <Plus />}
          {enrolling ? t("editor.enrollments.enrolling") : t("editor.enrollments.enrollNow")}
        </Button>
      </div>

      {/* Barre d'actions en lot — visible dès qu'une inscription est cochée. */}
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-sm font-medium">
            {t("editor.enrollments.selected", { count: selected.size })}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={bulkBusy}
              onClick={() => runBulk("pause")}
            >
              {bulkBusy ? <Loader2 className="animate-spin" /> : <Pause />}
              {t("editor.enrollments.pause")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={bulkBusy}
              onClick={() => runBulk("resume")}
            >
              <Play /> {t("editor.enrollments.resume")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 text-destructive md:min-h-8"
              disabled={bulkBusy}
              onClick={() => runBulk("remove")}
            >
              <Trash2 /> {t("editor.enrollments.remove")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
            >
              {t("editor.enrollments.clearSelection")}
            </Button>
          </div>
        </div>
      ) : null}

      {data.enrollments.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("editor.enrollments.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  {/* Tout cocher — seulement les inscriptions EN VOL. */}
                  <Checkbox
                    aria-label={t("editor.enrollments.selected", { count: inFlightIds.length })}
                    checked={allSelected}
                    disabled={inFlightIds.length === 0}
                    onCheckedChange={(on) => toggleAll(Boolean(on))}
                  />
                </TableHead>
                <TableHead>{t("editor.enrollments.columns.client")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.variant")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.status")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.step")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.next")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.ended")}</TableHead>
                <TableHead className="text-right">
                  {t("editor.enrollments.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.enrollments.map((row) => {
                // Une pause manuelle se lit sur trois champs (voir
                // `enrollment-status.ts`) : on la montre comme un état à part,
                // pas comme « en cours ».
                const paused = enrollmentPaused(row);
                const displayStatus = paused ? "paused" : row.status;
                const inFlight = enrollmentInFlight(row.status);
                const acting = actingId === row.id;
                const anyActing = actingId !== null;
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      {/* Cochable seulement si l'inscription peut être actionnée. */}
                      {inFlight ? (
                        <Checkbox
                          aria-label={row.clientName}
                          checked={selected.has(row.id)}
                          onCheckedChange={(on) => toggleOne(row.id, Boolean(on))}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-40 truncate">
                      {/* Le nom mène à la fiche : « voir le client » d'un clic. */}
                      <Link
                        href={`/clients/${row.clientId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.clientName}
                      </Link>
                    </TableCell>
                    <TableCell>{row.variant || "—"}</TableCell>
                    <TableCell>
                      {/* « En cours » et « Arrêtée » sont opposés — l'un reçoit
                          encore des SMS, l'autre n'en recevra plus jamais — et se
                          ressemblaient en badges gris identiques. */}
                      <LookBadge
                        filled
                        className="font-medium"
                        // Un état inconnu (valeur écrite par un module futur)
                        // reste lisible plutôt que de perdre sa pastille.
                        look={ENROLLMENT_STATUS_LOOK[displayStatus] ?? ENROLLMENT_STATUS_LOOK.pending}
                      >
                        {t(`editor.enrollments.status.${displayStatus}` as never)}
                      </LookBadge>
                    </TableCell>
                    <TableCell>{row.step}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.nextTouchAt
                        ? new Date(row.nextTouchAt).toLocaleString("fr-CA", {
                            timeZone: "America/Toronto",
                          })
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {/* Le motif ne s'affiche que sur une inscription CLOSE
                          (`endedAt` posé). Un fil en pause porte `end_reason`
                          sans être terminé : il ne doit rien montrer ici. */}
                      {row.endedAt ? (
                        <>
                          {row.endReason
                            ? END_REASONS.has(row.endReason)
                              ? t(`editor.enrollments.endReason.${row.endReason}` as never)
                              : row.endReason
                            : "—"}
                          {" · "}
                          {new Date(row.endedAt).toLocaleDateString("fr-CA", {
                            timeZone: "America/Toronto",
                          })}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {inFlight ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 md:min-h-8"
                            disabled={anyActing}
                            onClick={() =>
                              onAction(row.id, paused ? "resume" : "pause", row.clientName)
                            }
                          >
                            {acting ? (
                              <Loader2 className="animate-spin" />
                            ) : paused ? (
                              <Play />
                            ) : (
                              <Pause />
                            )}
                            {paused ? t("editor.enrollments.resume") : t("editor.enrollments.pause")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 text-destructive md:min-h-8"
                            disabled={anyActing}
                            onClick={() => onAction(row.id, "remove", row.clientName)}
                          >
                            <Trash2 /> {t("editor.enrollments.remove")}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
