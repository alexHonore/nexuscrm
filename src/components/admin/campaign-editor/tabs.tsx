"use client";

import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { analyzeSms } from "@/lib/sms/segments";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { TRIGGER_LOOK, TriggerIcon } from "../trigger-look";
import type { CampaignTabProps } from "./types";

const NONE = "__none__";

/** Cases à cocher d'une liste d'identifiants — le motif se répète 4 fois. */
function MultiSelect<T extends string | number>({
  label,
  hint,
  options,
  selected,
  onChange,
  emptyLabel,
}: {
  label: string;
  hint?: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
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

      <div className="space-y-2 rounded-md border p-3 md:col-span-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="c-consent">{t("editor.basics.requireConsent")}</Label>
          <Switch
            id="c-consent"
            checked={config.requireConsent}
            onCheckedChange={(next) => update((d) => void (d.requireConsent = next))}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("editor.basics.requireConsentHint")}</p>
        {!config.requireConsent ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{t("editor.basics.requireConsentHint")}</AlertDescription>
          </Alert>
        ) : null}
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
        <Label>{t("editor.trigger.kind")}</Label>
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
          <Label htmlFor="c-every">{t("editor.trigger.everyHours")}</Label>
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

  const preview = async () => {
    setLoading(true);
    try {
      const res = await api<{ count: number }>(`/api/campaigns/${data.id}/preview`);
      setCount(res.count);
    } catch {
      setCount(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
        <p className="text-sm">
          {loading
            ? t("editor.audience.previewing")
            : count === null
              ? t("editor.audience.title")
              : t("editor.audience.preview", { count })}
        </p>
        {/* L'aperçu se demande, il ne se devine pas : il compte sur la config
            ENREGISTRÉE, pas sur celle à l'écran. */}
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
  const plan = planLadder(config.ladder, new Date());

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("editor.ladder.hint")}</p>

      {config.ladder.length === 0 ? (
        <Alert>
          <AlertTriangle />
          <AlertDescription>{t("editor.ladder.empty")}</AlertDescription>
        </Alert>
      ) : null}

      {config.ladder.map((step, i) => {
        const analysis = analyzeSms(step.body ?? "");
        return (
          <div key={i} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant={i === 0 ? "default" : "secondary"}>
                {i === 0 ? t("editor.ladder.opener") : t("editor.ladder.step", { n: i + 1 })}
              </Badge>
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
                <Label htmlFor={`l-delay-${i}`}>{t("editor.ladder.delayHours")}</Label>
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
              <Label htmlFor={`l-body-${i}`}>{t("editor.ladder.body")}</Label>
              <Textarea
                id={`l-body-${i}`}
                rows={3}
                placeholder={t("editor.ladder.bodyPlaceholder")}
                value={step.body ?? ""}
                onChange={(e) => update((d) => void (d.ladder[i].body = e.target.value || null))}
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
                <p className="text-xs text-muted-foreground">{t("editor.ladder.bodyAgent")}</p>
              )}
            </div>
          </div>
        );
      })}

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
            <p className="pb-2 text-sm text-muted-foreground">
              {totalWeight > 0
                ? t("editor.variants.share", {
                    percent: Math.round((variant.weight / totalWeight) * 100),
                  })
                : null}
            </p>
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
          <h3 className="font-medium">{t("editor.variants.results")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("editor.variants.key")}</TableHead>
                <TableHead>{t("list.stats.enrolled", { count: "" }).trim()}</TableHead>
                <TableHead>{t("list.stats.replied", { count: "" }).trim()}</TableHead>
                <TableHead>{t("list.stats.stopped", { count: "" }).trim()}</TableHead>
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
}: CampaignTabProps & { onEnroll: () => void; enrolling: boolean }) {
  const t = useTranslations("campaigns");

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={onEnroll} disabled={enrolling} className="min-h-11 md:min-h-9">
          {enrolling ? <Loader2 className="animate-spin" /> : <Plus />}
          {enrolling ? t("editor.enrollments.enrolling") : t("editor.enrollments.enrollNow")}
        </Button>
      </div>

      {data.enrollments.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("editor.enrollments.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("editor.enrollments.columns.client")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.variant")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.status")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.step")}</TableHead>
                <TableHead>{t("editor.enrollments.columns.next")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.enrollments.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-40 truncate">{row.clientName}</TableCell>
                  <TableCell>{row.variant || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === "stopped" ? "destructive" : "secondary"}>
                      {t(`editor.enrollments.status.${row.status}` as never)}
                    </Badge>
                  </TableCell>
                  <TableCell>{row.step}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.nextTouchAt
                      ? new Date(row.nextTouchAt).toLocaleString("fr-CA", {
                          timeZone: "America/Toronto",
                        })
                      : (row.endReason ?? "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
