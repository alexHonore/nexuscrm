"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ASSISTANT_TOOLS,
  BOOKING_GOAL_TYPES,
  GOAL_TYPES,
  QUALIFICATION_FIELDS,
  TYPE_MANDATED_FIELDS,
  defaultAppointmentTypeFor,
  withMandatedFields,
  type AssistantTool,
  type GoalStep,
  type GoalType,
} from "@/lib/assistants/schema";
import { Label } from "@/components/ui/label";
import { signatureFor } from "@/lib/agent/compile";
import { FieldLabel, useParamDoc } from "./param-help";
import type { TabProps } from "./types";

const NONE = "__none__";
/** Valeur du sélecteur « saisir librement » — distincte d'« aucun ». */
const FREE_TEXT = "__free__";

/** Les objectifs qui RÉSERVENT réellement quelque chose dans l'agenda. */
const BOOKING_GOALS = BOOKING_GOAL_TYPES;

/** Curseur 1-5 rendu comme un choix : les valeurs ont un sens nommé, pas une amplitude. */
function ScaleField({
  path,
  value,
  onChange,
  labels,
}: {
  path: string;
  value: number;
  onChange: (v: number) => void;
  labels?: Record<number, string>;
}) {
  const doc = useParamDoc(path);
  const options = doc?.allowed?.length
    ? doc.allowed.map((a) => ({ value: Number(a.value), label: a.label }))
    : [1, 2, 3, 4, 5].map((n) => ({ value: n, label: labels?.[n] ?? String(n) }));

  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} />
      <Select
        items={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onValueChange={(v) => onChange(Number(v))}
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function EnumField({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const doc = useParamDoc(path);
  const options = (doc?.allowed ?? []).filter((a) => a.value !== null);
  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} />
      <Select
        items={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={value}
        onValueChange={(v) => onChange(String(v))}
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={String(o.value)} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberField({
  path,
  value,
  onChange,
  min,
  max,
}: {
  path: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const id = `f-${path}`;
  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} htmlFor={id} />
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-h-11 md:min-h-9"
      />
    </div>
  );
}

/** Aperçu de la signature réellement ajoutée aux messages. */
function signaturePreview(config: TabProps["config"]): string | null {
  return signatureFor(config.identity);
}

// ── Identité ─────────────────────────────────────────────────────────────────

export function IdentityTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel path="name" htmlFor="f-name" />
        <Input
          id="f-name"
          value={config.name}
          onChange={(e) => update((d) => void (d.name = e.target.value))}
          className="min-h-11 md:min-h-9"
        />
      </div>

      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel path="description" htmlFor="f-description" />
        <Textarea
          id="f-description"
          rows={2}
          value={config.description ?? ""}
          onChange={(e) => update((d) => void (d.description = e.target.value || null))}
        />
      </div>

      <EnumField
        path="identity.mode"
        value={config.identity.mode}
        onChange={(v) => update((d) => void (d.identity.mode = v as "team" | "named_person"))}
      />

      <div className="space-y-1.5">
        <FieldLabel path="identity.orgName" htmlFor="f-org" />
        <Input
          id="f-org"
          value={config.identity.orgName}
          onChange={(e) => update((d) => void (d.identity.orgName = e.target.value))}
          className="min-h-11 md:min-h-9"
        />
      </div>

      {/* Le courtier se choisit UNE fois : sélectionner la personne remplit le
          nom ET rattache le compte. Deux champs séparés — un nom libre d'un
          côté, un compte de l'autre — laissaient écrire « Alex » et rattacher
          quelqu'un d'autre sans que rien ne le signale. */}
      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel path="identity.brokerName" htmlFor="f-broker" />
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            items={[
              { value: FREE_TEXT, label: t("editor.identity.freeText") },
              ...data.users.map((u) => ({ value: u.id, label: u.name })),
            ]}
            value={config.identity.brokerUserId ?? FREE_TEXT}
            onValueChange={(v) =>
              update((d) => {
                if (v === FREE_TEXT) {
                  d.identity.brokerUserId = null;
                  return;
                }
                const picked = data.users.find((u) => u.id === String(v));
                d.identity.brokerUserId = String(v);
                if (picked) d.identity.brokerName = picked.name;
              })
            }
          >
            <SelectTrigger className="min-h-11 w-full md:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FREE_TEXT}>{t("editor.identity.freeText")}</SelectItem>
              {data.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            id="f-broker"
            value={config.identity.brokerName}
            disabled={config.identity.brokerUserId !== null}
            onChange={(e) => update((d) => void (d.identity.brokerName = e.target.value))}
            className="min-h-11 md:min-h-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {config.identity.brokerUserId === null
            ? t("editor.identity.freeTextHint")
            : t("editor.identity.linkedHint")}
        </p>
      </div>

      <EnumField
        path="identity.signature"
        value={config.identity.signature}
        onChange={(v) =>
          update((d) => void (d.identity.signature = v as typeof d.identity.signature))
        }
      />

      {config.identity.signature === "custom" ? (
        <div className="space-y-1.5">
          <FieldLabel path="identity.signatureText" htmlFor="f-signature-text" />
          <Input
            id="f-signature-text"
            maxLength={60}
            placeholder={t("editor.identity.signaturePlaceholder")}
            value={config.identity.signatureText ?? ""}
            onChange={(e) => update((d) => void (d.identity.signatureText = e.target.value || null))}
            className="min-h-11 md:min-h-9"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>{t("editor.identity.signaturePreview")}</Label>
          <p className="flex min-h-11 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground md:min-h-9">
            {signaturePreview(config) ?? t("editor.identity.noSignature")}
          </p>
        </div>
      )}
      <EnumField
        path="identity.aiDisclosure"
        value={config.identity.aiDisclosure}
        onChange={(v) =>
          update((d) => void (d.identity.aiDisclosure = v as "on_request" | "upfront"))
        }
      />

      {config.identity.mode === "named_person" && !config.identity.brokerUserId ? (
        <Alert className="md:col-span-2">
          <AlertTriangle />
          <AlertDescription>{t("editor.identity.namedPersonWarning")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

// ── Objectif ─────────────────────────────────────────────────────────────────

function GoalStepFields({
  step,
  prefix,
  onChange,
  data,
}: {
  step: GoalStep;
  prefix: string;
  onChange: (mutate: (s: GoalStep) => void) => void;
  data: TabProps["data"];
}) {
  const t = useTranslations("assistants");
  // Un objectif qui ne réserve rien n'a pas de rendez-vous à typer : afficher
  // « type » ET « type de rendez-vous » côte à côte sur « Obtenir le courriel »
  // était la source de confusion — deux champs presque homonymes dont l'un ne
  // servait à rien.
  const books = BOOKING_GOALS.includes(step.type);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel path={`${prefix}.type`}>{t("editor.goal.whatToObtain")}</FieldLabel>
        <Select
          items={GOAL_TYPES.map((g) => ({ value: g, label: t(`goalType.${g}`) }))}
          value={step.type}
          onValueChange={(v) =>
            onChange((s) => {
              const next = v as GoalType;
              s.type = next;
              // Le type de rendez-vous DÉCOULE du type d'objectif quand il
              // n'y a rien à choisir : une rencontre vidéo se réserve en
              // visioconférence, pas ailleurs. Un appel garde le choix fait,
              // sinon « meet » — jamais null : un cran de réservation sans
              // type de rendez-vous promet un appel que l'agenda refuse.
              s.appointmentType =
                next === "video_meeting" || next === "in_person_meeting"
                  ? defaultAppointmentTypeFor(next)
                  : BOOKING_GOALS.includes(next)
                    ? (s.appointmentType ?? defaultAppointmentTypeFor(next))
                    : null;
              if (!BOOKING_GOALS.includes(next)) s.durationMin = null;
              // Les champs que le nouveau type impose sont ajoutés d'office.
              s.requiredFields = withMandatedFields(next, s.requiredFields);
            })
          }
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GOAL_TYPES.map((g) => (
              <SelectItem key={g} value={g}>
                <span className="flex flex-col items-start">
                  <span>{t(`goalType.${g}`)}</span>
                  {/* La ligne d'explication vit DANS l'option : choisir entre
                      sept objectifs sur leur seul nom demande de deviner. */}
                  <span className="text-xs text-muted-foreground">{t(`goalTypeHint.${g}`)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`goalTypeHint.${step.type}`)}</p>
      </div>

      {books ? (
        <div className="space-y-1.5">
          <FieldLabel path={`${prefix}.durationMin`} htmlFor={`${prefix}-duration`} />
          <Input
            id={`${prefix}-duration`}
            type="number"
            inputMode="numeric"
            min={5}
            max={240}
            value={step.durationMin ?? ""}
            onChange={(e) =>
              onChange((s) => void (s.durationMin = e.target.value ? Number(e.target.value) : null))
            }
            className="min-h-11 md:min-h-9"
          />
        </div>
      ) : null}

      {books ? (
        <div className="space-y-1.5">
          <FieldLabel path={`${prefix}.appointmentType`}>
            {t("editor.goal.calendarSlot")}
          </FieldLabel>
          <Select
            items={[
              { value: "meet", label: t("editor.goal.calendarMeet") },
              { value: "inperson", label: t("editor.goal.calendarInperson") },
            ]}
            value={step.appointmentType ?? "meet"}
            onValueChange={(v) =>
              onChange((s) => void (s.appointmentType = String(v) as "meet" | "inperson"))
            }
          >
            <SelectTrigger className="min-h-11 w-full md:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="meet">{t("editor.goal.calendarMeet")}</SelectItem>
              <SelectItem value="inperson">{t("editor.goal.calendarInperson")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("editor.goal.calendarHint")}</p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <FieldLabel path={`${prefix}.withUserId`} />
        <Select
          items={[
            { value: NONE, label: "—" },
            ...data.users.map((u) => ({ value: u.id, label: u.name })),
          ]}
          value={step.withUserId ?? NONE}
          onValueChange={(v) =>
            onChange((s) => void (s.withUserId = v === NONE ? null : String(v)))
          }
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {data.users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2 md:col-span-2">
        <FieldLabel path={`${prefix}.requiredFields`} />
        <div className="grid gap-2 sm:grid-cols-2">
          {QUALIFICATION_FIELDS.map((field) => {
            // Un champ que le type impose (le courriel pour « obtenir le
            // courriel ») est coché et verrouillé : le schéma le rajouterait
            // de toute façon à l'enregistrement, autant le montrer.
            const mandated = TYPE_MANDATED_FIELDS[step.type].includes(field);
            const checked = mandated || step.requiredFields.includes(field);
            return (
              <label
                key={field}
                className="flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm md:min-h-9"
              >
                <Checkbox
                  checked={checked}
                  disabled={mandated}
                  onCheckedChange={(next) =>
                    onChange((s) => {
                      s.requiredFields = next
                        ? [...s.requiredFields, field]
                        : s.requiredFields.filter((f) => f !== field);
                    })
                  }
                />
                {t(`qualificationField.${field}`)}
                {mandated ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("editor.goal.mandatedField")}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>

      {books ? (
      <div className="space-y-1.5">
        <FieldLabel path={`${prefix}.slotOfferCount`} htmlFor={`${prefix}-slots`} />
        <Input
          id={`${prefix}-slots`}
          type="number"
          inputMode="numeric"
          min={1}
          max={3}
          value={step.slotOfferCount}
          onChange={(e) => onChange((s) => void (s.slotOfferCount = Number(e.target.value)))}
          className="min-h-11 md:min-h-9"
        />
      </div>
      ) : null}

      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel path={`${prefix}.confirmationTemplate`} htmlFor={`${prefix}-confirm`} />
        <Textarea
          id={`${prefix}-confirm`}
          rows={2}
          value={step.confirmationTemplate ?? ""}
          onChange={(e) =>
            onChange((s) => void (s.confirmationTemplate = e.target.value || null))
          }
        />
      </div>
    </div>
  );
}

export function GoalTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");

  const addFallback = () =>
    update((d) => {
      // Un appel se réserve : le type de rendez-vous est posé d'emblée (null
      // rendait le cran impossible à réserver tout en affichant « Visio »).
      d.goal.fallbacks.push({
        type: "phone_call",
        durationMin: 15,
        appointmentType: defaultAppointmentTypeFor("phone_call"),
        withUserId: null,
        requiredFields: withMandatedFields("phone_call", []),
        slotOfferCount: 2,
        confirmationTemplate: null,
      });
    });

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="font-medium">{t("editor.goal.primary")}</h3>
        <GoalStepFields
          step={config.goal.primary}
          prefix="goal.primary"
          data={data}
          onChange={(mutate) => update((d) => mutate(d.goal.primary))}
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{t("editor.goal.fallbacks")}</h3>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={addFallback}
            disabled={config.goal.fallbacks.length >= 3}
          >
            <Plus /> {t("editor.goal.addFallback")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("editor.goal.chainNote")}</p>

        {config.goal.fallbacks.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            {t("editor.goal.noFallbacks")}
          </p>
        ) : (
          config.goal.fallbacks.map((step, i) => (
            <div key={i} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <Badge variant="secondary">{t("editor.goal.fallbackAt", { n: i + 1 })}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-destructive md:min-h-9"
                  onClick={() => update((d) => void d.goal.fallbacks.splice(i, 1))}
                >
                  <Trash2 /> {t("editor.goal.removeFallback")}
                </Button>
              </div>
              <GoalStepFields
                step={step}
                prefix={`goal.fallbacks[${i}]`}
                data={data}
                onChange={(mutate) => update((d) => mutate(d.goal.fallbacks[i]))}
              />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

// ── Approche ─────────────────────────────────────────────────────────────────

export function ApproachTab({ config, update }: TabProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <EnumField
        path="approach.formality"
        value={config.approach.formality}
        onChange={(v) => update((d) => void (d.approach.formality = v as "vous" | "tu"))}
      />
      <ScaleField
        path="approach.persistence"
        value={config.approach.persistence}
        onChange={(v) => update((d) => void (d.approach.persistence = v))}
      />
      <NumberField
        path="approach.questionBudget"
        value={config.approach.questionBudget}
        min={1}
        max={6}
        onChange={(v) => update((d) => void (d.approach.questionBudget = v))}
      />
      <NumberField
        path="approach.maxChars"
        value={config.approach.maxChars}
        min={120}
        max={480}
        onChange={(v) => update((d) => void (d.approach.maxChars = v))}
      />
      <ScaleField
        path="approach.proactivity"
        value={config.approach.proactivity}
        onChange={(v) => update((d) => void (d.approach.proactivity = v))}
      />
      <ScaleField
        path="approach.warmth"
        value={config.approach.warmth}
        onChange={(v) => update((d) => void (d.approach.warmth = v))}
      />
      <EnumField
        path="approach.emoji"
        value={config.approach.emoji}
        onChange={(v) => update((d) => void (d.approach.emoji = v as "none" | "rare"))}
      />
      <EnumField
        path="approach.replySpeed"
        value={config.approach.replySpeed}
        onChange={(v) =>
          update((d) => void (d.approach.replySpeed = v as "instant" | "natural" | "deliberate"))
        }
      />
      <NumberField
        path="approach.maxTurns"
        value={config.approach.maxTurns}
        min={4}
        max={40}
        onChange={(v) => update((d) => void (d.approach.maxTurns = v))}
      />
    </div>
  );
}

// ── Connaissances et consignes ───────────────────────────────────────────────

/**
 * La liste porte DEUX sortes d'entrées — un fait que l'assistant peut
 * affirmer, ou une consigne de conduite (« si on demande X, réponds Y ») — et
 * l'ORDRE compte : c'est la première entrée qui gagne quand deux se
 * contredisent. Rien de tout ça ne se devinait devant un champ intitulé
 * « Faits autorisés » suivi de zones de texte sans numéro : on y écrivait des
 * consignes sans savoir si elles seraient suivies. D'où le numéro visible et
 * les flèches de réordonnancement, qui rendent la règle manipulable.
 */
export function KnowledgeTab({ config, update }: TabProps) {
  const t = useTranslations("assistants");
  const claims = config.knowledge.claims;

  /** Déplace une entrée d'un cran — l'ordre est une donnée, pas une présentation. */
  const move = (from: number, to: number) =>
    update((d) => {
      if (to < 0 || to >= d.knowledge.claims.length) return;
      const [entry] = d.knowledge.claims.splice(from, 1);
      d.knowledge.claims.splice(to, 0, entry);
    });

  return (
    <div className="space-y-4">
      <FieldLabel path="knowledge.claims" />
      <p className="text-sm text-muted-foreground">{t("editor.knowledge.intro")}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <ExampleLine kind="fact" text={t("editor.knowledge.exampleFact")} />
        <ExampleLine kind="rule" text={t("editor.knowledge.exampleRule")} />
      </div>

      {/* Ce n'est pas une note de ton : ces phrases sortent au nom d'un
          courtier titulaire d'un permis. */}
      <Alert>
        <AlertTriangle />
        <AlertDescription>{t("editor.knowledge.warning")}</AlertDescription>
      </Alert>

      {claims.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("editor.knowledge.empty")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("editor.knowledge.orderHint")}</p>
      )}

      <div className="space-y-2">
        {claims.map((claim, i) => (
          <div key={i} className="flex items-start gap-2">
            {/* Le numéro porte du SENS (c'est la première entrée qui gagne un
                conflit) : décoratif à l'œil, il est repris dans le nom
                accessible de la zone de texte, sinon trois entrées se lisent
                toutes « zone de texte » au lecteur d'écran. */}
            <span
              aria-hidden
              className="mt-2 w-6 shrink-0 text-right font-mono text-xs text-muted-foreground"
            >
              {i + 1}.
            </span>
            <Textarea
              rows={2}
              value={claim}
              maxLength={600}
              aria-label={t("editor.knowledge.entry", { index: i + 1 })}
              placeholder={t("editor.knowledge.placeholder")}
              onChange={(e) => update((d) => void (d.knowledge.claims[i] = e.target.value))}
            />
            <div className="flex shrink-0 flex-col">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 md:size-8"
                disabled={i === 0}
                aria-label={t("editor.knowledge.moveUp", { index: i + 1 })}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 md:size-8"
                disabled={i === claims.length - 1}
                aria-label={t("editor.knowledge.moveDown", { index: i + 1 })}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDown />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 text-destructive md:size-9"
              aria-label={t("editor.knowledge.remove", { index: i + 1 })}
              onClick={() => update((d) => void d.knowledge.claims.splice(i, 1))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        className="min-h-11 md:min-h-9"
        disabled={claims.length >= 50}
        onClick={() => update((d) => void d.knowledge.claims.push(""))}
      >
        <Plus /> {t("editor.knowledge.add")}
      </Button>
    </div>
  );
}

/** Un exemple des deux formes admises — c'est ce qui les rend évidentes. */
function ExampleLine({ kind, text }: { kind: "fact" | "rule"; text: string }) {
  const t = useTranslations("assistants");
  return (
    <p className="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
      <Badge variant="outline" className="mr-1.5 align-middle text-[10px]">
        {t(`editor.knowledge.kind.${kind}`)}
      </Badge>
      {text}
    </p>
  );
}

// ── Objections ───────────────────────────────────────────────────────────────

export function ObjectionsTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  if (data.packs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("editor.objections.none")}</p>;
  }
  return (
    <div className="space-y-3">
      <FieldLabel path="objectionPacks" />
      <div className="grid gap-2 sm:grid-cols-2">
        {data.packs.map((pack) => {
          const checked = config.objectionPacks.includes(pack.id);
          return (
            <label
              key={pack.id}
              className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  update((d) => {
                    d.objectionPacks = next
                      ? [...d.objectionPacks, pack.id]
                      : d.objectionPacks.filter((p) => p !== pack.id);
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{pack.label}</span>
                <span className="text-xs text-muted-foreground">
                  {t("editor.objections.items", { count: pack.itemCount })}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── Outils ───────────────────────────────────────────────────────────────────

/** « stop » et « handoff » ne se décochent pas — voir la note de l'onglet. */
const REQUIRED_TOOLS: AssistantTool[] = ["stop", "handoff"];

export function ToolsTab({ config, update }: TabProps) {
  const t = useTranslations("assistants");
  return (
    <div className="space-y-3">
      <FieldLabel path="tools" />
      <p className="text-sm text-muted-foreground">{t("editor.tools.requiredNote")}</p>
      <div className="space-y-2">
        {ASSISTANT_TOOLS.map((tool) => {
          const required = REQUIRED_TOOLS.includes(tool);
          const checked = config.tools.includes(tool);
          return (
            <div key={tool} className="flex items-start gap-3 rounded-md border p-3">
              <Switch
                checked={checked || required}
                disabled={required}
                aria-label={t(`tool.${tool}`)}
                onCheckedChange={(next) =>
                  update((d) => {
                    d.tools = next ? [...d.tools, tool] : d.tools.filter((x) => x !== tool);
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t(`tool.${tool}`)}</span>
                  {required ? (
                    <Badge variant="secondary">{t("editor.tools.required")}</Badge>
                  ) : null}
                  <ToolHelp tool={tool} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolHelp({ tool }: { tool: AssistantTool }) {
  const doc = useParamDoc(`tools.${tool}`);
  if (!doc) return null;
  return <span className="text-xs text-muted-foreground">{doc.what}</span>;
}
