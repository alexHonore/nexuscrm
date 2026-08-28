"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
  EDITOR_TAB_LOOK,
  GOAL_LOOK,
  KNOWLEDGE_LOOK,
  LookGlyph,
  LookIcon,
  TOOL_LOOK,
  lookTint,
} from "@/components/look";
import {
  ASSISTANT_LANGUAGES,
  ASSISTANT_TOOLS,
  BOOKING_GOAL_TYPES,
  GOAL_TYPES,
  QUALIFICATION_FIELDS,
  TYPE_MANDATED_FIELDS,
  defaultAppointmentTypeFor,
  withMandatedFields,
  type AssistantConfig,
  type AssistantLanguage,
  type AssistantTool,
  type GoalStep,
  type GoalType,
} from "@/lib/assistants/schema";
import { Label } from "@/components/ui/label";
import { signatureFor } from "@/lib/agent/compile";
import type { OverflowPolicy, TextEconomy } from "@/lib/sms/budget";
import { capacityFor, segmentsForChars } from "@/lib/sms/segments";
import { cn } from "@/lib/utils";
import {
  EmptyRow,
  FieldNote,
  Fields,
  Panel,
  TabHead,
  WideField,
  useTabHead,
} from "./layout";
import { FieldLabel, useParamDoc } from "./param-help";
import { useCanEdit } from "./read-only";
import { ObjectionPacksEditor } from "./objection-packs";
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
  const canEdit = useCanEdit();
  const options = doc?.allowed?.length
    ? doc.allowed.map((a) => ({ value: Number(a.value), label: a.label }))
    : [1, 2, 3, 4, 5].map((n) => ({ value: n, label: labels?.[n] ?? String(n) }));

  return (
    <div className="space-y-1.5">
      {/* Trois curseurs 1-5 voisins (persistance, proactivité, chaleur) ne se
          comparaient qu'en lisant trois libellés nommés. Remplis jusqu'à la
          valeur, ils se situent d'un coup d'œil — le libellé du choix reste
          seul porteur du sens, la jauge ne fait que le doubler.

          La jauge suit le libellé de PRÈS : poussée au bord droit d'une
          colonne large, elle flottait dans le vide, à trente centimètres du
          mot qu'elle qualifie. */}
      <FieldLabel path={path} after={<ScaleMeter value={value} max={options.length} />} />
      <Select
        items={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onValueChange={(v) => onChange(Number(v))}
        disabled={!canEdit}
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

/** Les crans de l'échelle, remplis jusqu'à la valeur — décor pur, donc muet. */
function ScaleMeter({ value, max }: { value: number; max: number }) {
  const { color } = EDITOR_TAB_LOOK.approach;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-muted-foreground/25"
          style={i < value ? { backgroundColor: color } : undefined}
        />
      ))}
    </span>
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
  const canEdit = useCanEdit();
  const options = (doc?.allowed ?? []).filter((a) => a.value !== null);
  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} />
      <Select
        items={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={value}
        onValueChange={(v) => onChange(String(v))}
        disabled={!canEdit}
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

/**
 * Un choix dont « rien » est une valeur.
 *
 * `EnumField` écarte les valeurs nulles du registre, et c'est juste pour la
 * plupart des paramètres : `null` y veut dire « non renseigné ». Le plafond de
 * segments est l'exception — son absence EST un réglage, celui qui laisse la
 * longueur seule décider. L'encodage passe par `String(value)`, exactement la
 * clé sous laquelle le registre range ses libellés (« null », « 1 », « 2 »…) :
 * une seconde convention ici ferait un menu aux libellés vides.
 */
function NullableNumberField({
  path,
  value,
  onChange,
}: {
  path: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const doc = useParamDoc(path);
  const canEdit = useCanEdit();
  const options = doc?.allowed ?? [];
  return (
    <div className="space-y-1.5">
      <FieldLabel path={path} />
      <Select
        items={options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(value)}
        onValueChange={(v) => onChange(String(v) === "null" ? null : Number(v))}
        disabled={!canEdit}
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
  const canEdit = useCanEdit();
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
        disabled={!canEdit}
      />
    </div>
  );
}

/** Aperçu de la signature réellement ajoutée aux messages. */
function signaturePreview(config: TabProps["config"]): string | null {
  return signatureFor(config.identity);
}

/**
 * Ce que les deux limites donnent VRAIMENT, en caractères et en segments.
 *
 * Sans ce calcul, le réglage se pilote à l'aveugle : « 2 segments » ne dit
 * rien tant qu'on n'a pas écrit que ça fait 134 caractères en français
 * accentué et 306 sans accents. Et surtout, il révèle le cas où le plafond ne
 * sert à rien — une longueur maximale déjà plus stricte que lui, auquel cas
 * c'est elle qui décide et le plafond est décoratif.
 *
 * Les nombres viennent de `capacityFor`/`segmentsForChars` : la même table
 * GSM 03.38 que l'expéditeur, jamais une division maison.
 */
function SegmentBudgetNote({ config }: { config: TabProps["config"] }) {
  const t = useTranslations("assistants");
  const { maxChars, segmentBudget } = config.approach;
  const encoding = segmentBudget.economy === "ascii" ? "GSM-7" : "UCS-2";

  if (segmentBudget.maxSegments === null) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        {t("editor.approach.costNoCap", {
          chars: maxChars,
          accented: segmentsForChars(maxChars, "UCS-2"),
          plain: segmentsForChars(maxChars, "GSM-7"),
        })}
      </p>
    );
  }

  const capacity = capacityFor(encoding, segmentBudget.maxSegments);
  return (
    <div className="mt-3 space-y-1">
      <p className="text-xs text-muted-foreground">
        {t("editor.approach.costBudget", {
          chars: Math.min(maxChars, capacity),
          segments: segmentBudget.maxSegments,
        })}
      </p>
      {maxChars < capacity ? (
        <p className="text-xs text-destructive">
          {t("editor.approach.costCharsWin", { chars: maxChars, capacity })}
        </p>
      ) : null}
    </div>
  );
}

// ── Identité ─────────────────────────────────────────────────────────────────

export function IdentityTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("identity");
  const look = EDITOR_TAB_LOOK.identity;
  // Sans le droit d'écrire, tout se lit et rien ne se change : la prop
  // `disabled` du contrôle, la même que pour l'état occupé de l'en-tête.
  const canEdit = useCanEdit();

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel
        look={look}
        title={t("editor.identity.sectionNaming")}
        description={t("editor.identity.sectionNamingHint")}
      >
        <Fields>
          <WideField>
            <FieldLabel path="name" htmlFor="f-name" />
            <Input
              id="f-name"
              value={config.name}
              onChange={(e) => update((d) => void (d.name = e.target.value))}
              className="min-h-11 md:min-h-9"
              disabled={!canEdit}
            />
          </WideField>
          <WideField>
            <FieldLabel path="description" htmlFor="f-description" />
            <Textarea
              id="f-description"
              rows={2}
              value={config.description ?? ""}
              onChange={(e) => update((d) => void (d.description = e.target.value || null))}
              disabled={!canEdit}
            />
          </WideField>
        </Fields>
      </Panel>

      {/* La langue vit ICI, avec le nom et l'organisation : c'est une donnée
          d'identité de l'assistant, pas un réglage technique. Elle était
          enregistrée sans jamais être modifiable ni compilée. */}
      <Panel
        look={look}
        title={t("editor.identity.sectionLanguage")}
        description={t("editor.identity.sectionLanguageHint")}
      >
        <Fields>
          <EnumField
            path="language"
            value={config.language}
            onChange={(v) => update((d) => void (d.language = v as AssistantLanguage))}
          />
          <div className="space-y-1.5">
            <FieldLabel path="secondaryLanguage" />
            <Select
              items={[
                { value: NONE, label: t("editor.identity.noSecondLanguage") },
                ...ASSISTANT_LANGUAGES.filter((l) => l !== config.language).map((l) => ({
                  value: l,
                  label: t(`language.${l}`),
                })),
              ]}
              value={config.secondaryLanguage ?? NONE}
              onValueChange={(v) =>
                update((d) => {
                  d.secondaryLanguage = v === NONE ? null : (String(v) as AssistantLanguage);
                })
              }
              disabled={!canEdit}
            >
              <SelectTrigger className="min-h-11 w-full md:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("editor.identity.noSecondLanguage")}</SelectItem>
                {ASSISTANT_LANGUAGES.filter((l) => l !== config.language).map((l) => (
                  <SelectItem key={l} value={l}>
                    {t(`language.${l}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldNote>{t("editor.identity.secondLanguageHint")}</FieldNote>
          </div>
        </Fields>
      </Panel>

      <Panel
        look={look}
        title={t("editor.identity.sectionWho")}
        description={t("editor.identity.sectionWhoHint")}
      >
        <Fields>
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
              disabled={!canEdit}
            />
          </div>

          {/* Le courtier se choisit UNE fois : sélectionner la personne remplit
              le nom ET rattache le compte. Deux champs séparés — un nom libre
              d'un côté, un compte de l'autre — laissaient écrire « Alex » et
              rattacher quelqu'un d'autre sans que rien ne le signale. */}
          <WideField>
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
                disabled={!canEdit}
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
                disabled={!canEdit || config.identity.brokerUserId !== null}
                onChange={(e) => update((d) => void (d.identity.brokerName = e.target.value))}
                className="min-h-11 md:min-h-9"
              />
            </div>
            <FieldNote>
              {config.identity.brokerUserId === null
                ? t("editor.identity.freeTextHint")
                : t("editor.identity.linkedHint")}
            </FieldNote>
          </WideField>

          {config.identity.mode === "named_person" && !config.identity.brokerUserId ? (
            <Alert className="md:col-span-2">
              <AlertTriangle />
              <AlertDescription>{t("editor.identity.namedPersonWarning")}</AlertDescription>
            </Alert>
          ) : null}
        </Fields>
      </Panel>

      <Panel look={look} title={t("editor.identity.sectionSignature")}>
        <Fields>
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
                onChange={(e) =>
                  update((d) => void (d.identity.signatureText = e.target.value || null))
                }
                className="min-h-11 md:min-h-9"
                disabled={!canEdit}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>{t("editor.identity.signaturePreview")}</Label>
              <p className="flex min-h-11 items-center rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground md:min-h-9">
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
        </Fields>
      </Panel>
    </div>
  );
}

// ── Objectif ─────────────────────────────────────────────────────────────────

/** Les huit clés du catalogue — tout le reste est une exigence libre. */
const KNOWN_FIELDS = new Set<string>(QUALIFICATION_FIELDS);

/**
 * Les exigences que le catalogue n'a pas prévues.
 *
 * Elles vivent dans LA MÊME liste que les huit clés connues (`requiredFields`),
 * pas dans un champ à part : pour l'outil de réservation, « type de projet » et
 * « nombre de chambres » sont deux exigences de même nature, et les séparer
 * aurait produit deux portes à franchir au lieu d'une.
 */
function CustomRequirements({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations("assistants");
  const canEdit = useCanEdit();
  const [draft, setDraft] = useState("");

  const add = () => {
    const text = draft.trim();
    // Pas de doublon, et jamais une clé du catalogue saisie à la main : elle
    // apparaîtrait deux fois, une fois cochée et une fois en texte libre.
    if (text === "" || values.includes(text) || KNOWN_FIELDS.has(text)) return;
    onChange([...values, text]);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {values.map((value) => (
            <li
              key={value}
              className="flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm"
            >
              <span className="break-words">{value}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-destructive"
                aria-label={t("editor.goal.removeRequirement", { name: value })}
                disabled={!canEdit}
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Input
          className="min-h-11 md:min-h-9"
          maxLength={80}
          placeholder={t("editor.goal.customRequirementPlaceholder")}
          value={draft}
          disabled={!canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          variant="outline"
          className="min-h-11 shrink-0 md:min-h-9"
          disabled={!canEdit || draft.trim() === ""}
          onClick={add}
        >
          <Plus /> {t("editor.goal.addRequirement")}
        </Button>
      </div>
    </div>
  );
}

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
  const canEdit = useCanEdit();
  // Un objectif qui ne réserve rien n'a pas de rendez-vous à typer : afficher
  // « type » ET « type de rendez-vous » côte à côte sur « Obtenir le courriel »
  // était la source de confusion — deux champs presque homonymes dont l'un ne
  // servait à rien.
  const books = BOOKING_GOALS.includes(step.type);
  // Le cran emprunte la couleur de SON objectif. Les trois objectifs qui
  // réservent vraiment une plage d'agenda la partagent : la retrouver autour
  // du bloc de réservation ci-dessous fait dire quelque chose à ce bleu
  // commun — « ceci pose un rendez-vous » — au lieu de le laisser décoratif.
  const accent = GOAL_LOOK[step.type];

  return (
    <Fields>
      <WideField>
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
          disabled={!canEdit}
        >
          <SelectTrigger className="min-h-11 w-full md:min-h-9">
            <SelectValue>
              {(v: unknown) => {
                // Base UI passe la valeur brute : hors des sept objectifs
                // connus on n'affiche rien plutôt qu'une clé i18n crue.
                const picked = GOAL_TYPES.find((g) => g === v);
                if (!picked) return null;
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    <LookGlyph look={GOAL_LOOK[picked]} />
                    <span className="truncate">{t(`goalType.${picked}`)}</span>
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {GOAL_TYPES.map((g) => (
              <SelectItem key={g} value={g}>
                {/* `whitespace-normal` : la ligne d'une option Base UI est en
                    « nowrap » et le menu fait la largeur du champ, à bord
                    coupé. Sans ça la phrase d'explication part hors de l'écran
                    au lieu de passer à la ligne — et le pictogramme, qui prend
                    sa place à gauche, en coupait encore un mot de plus. */}
                <span className="flex items-start gap-2 whitespace-normal">
                  <LookIcon look={GOAL_LOOK[g]} size="sm" className="mt-0.5" />
                  <span className="flex min-w-0 flex-col items-start">
                    <span>{t(`goalType.${g}`)}</span>
                    {/* La ligne d'explication vit DANS l'option : choisir entre
                        sept objectifs sur leur seul nom demande de deviner. */}
                    <span className="text-xs text-muted-foreground">{t(`goalTypeHint.${g}`)}</span>
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <LookGlyph look={GOAL_LOOK[step.type]} className="mt-px size-3.5" />
          <span className="min-w-0">{t(`goalTypeHint.${step.type}`)}</span>
        </p>
      </WideField>

      {/* Durée, lieu et nombre de plages ne sont QUE les réglages de la
          réservation : rassemblés dans un bloc à la couleur de l'objectif, ils
          se lisent comme la conséquence du type choisi et disparaissent
          ensemble dès qu'il ne réserve plus rien. Séparés, le nombre de plages
          se retrouvait sous les champs de qualification, loin de la durée. */}
      {books ? (
        <div
          className="grid gap-4 rounded-lg border border-l-[3px] p-3 md:col-span-2 md:grid-cols-3"
          style={{
            borderLeftColor: accent.color,
            backgroundColor: lookTint(accent).backgroundColor,
          }}
        >
          <div className="space-y-1.5">
            <FieldLabel short path={`${prefix}.durationMin`} htmlFor={`${prefix}-duration`} />
            <Input
              id={`${prefix}-duration`}
              type="number"
              inputMode="numeric"
              min={5}
              max={240}
              value={step.durationMin ?? ""}
              onChange={(e) =>
                onChange(
                  (s) => void (s.durationMin = e.target.value ? Number(e.target.value) : null),
                )
              }
              className="min-h-11 bg-background md:min-h-9"
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel short path={`${prefix}.slotOfferCount`} htmlFor={`${prefix}-slots`} />
            <Input
              id={`${prefix}-slots`}
              type="number"
              inputMode="numeric"
              min={1}
              max={3}
              value={step.slotOfferCount}
              onChange={(e) => onChange((s) => void (s.slotOfferCount = Number(e.target.value)))}
              className="min-h-11 bg-background md:min-h-9"
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-1.5">
            <FieldLabel short path={`${prefix}.withUserId`} />
            <Select
              items={[
                { value: NONE, label: "—" },
                ...data.users.map((u) => ({ value: u.id, label: u.name })),
              ]}
              value={step.withUserId ?? NONE}
              onValueChange={(v) =>
                onChange((s) => void (s.withUserId = v === NONE ? null : String(v)))
              }
              disabled={!canEdit}
            >
              <SelectTrigger className="min-h-11 w-full bg-background md:min-h-9">
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
        </div>
      ) : (
        <div className="space-y-1.5">
          <FieldLabel short path={`${prefix}.withUserId`} />
          <Select
            items={[
              { value: NONE, label: "—" },
              ...data.users.map((u) => ({ value: u.id, label: u.name })),
            ]}
            value={step.withUserId ?? NONE}
            onValueChange={(v) =>
              onChange((s) => void (s.withUserId = v === NONE ? null : String(v)))
            }
            disabled={!canEdit}
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
      )}

      <WideField className="space-y-2">
        <FieldLabel short path={`${prefix}.requiredFields`} />
        {/* Des PUCES, pas huit rangées pleine largeur. Une case à cocher suivie
            de deux mots dans une boîte de six cents pixels ressemble à un
            bouton, et huit boutons empilés cachent que la liste est un choix
            multiple court. Enroulées, les huit tiennent sur trois lignes et se
            comparent d'un regard. */}
        <div className="flex flex-wrap gap-2">
          {QUALIFICATION_FIELDS.map((field) => {
            // Un champ que le type impose (le courriel pour « obtenir le
            // courriel ») est coché et verrouillé : le schéma le rajouterait
            // de toute façon à l'enregistrement, autant le montrer.
            const mandated = TYPE_MANDATED_FIELDS[step.type].includes(field);
            const checked = mandated || step.requiredFields.includes(field);
            return (
              <label
                key={field}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm transition-colors md:min-h-9",
                  checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50",
                  mandated && "cursor-default opacity-90",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={mandated || !canEdit}
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
                  <span className="text-xs text-muted-foreground">
                    {t("editor.goal.mandatedField")}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>

        {/* Les huit clés connues ne couvrent pas tout : « nombre de chambres »,
            « budget de rénovation », « adresse à évaluer » sont des exigences
            légitimes qu'on ne pouvait pas exprimer. Une exigence libre part
            telle quelle dans le prompt — c'est celui qui l'écrit qui sait ce
            qu'elle veut dire. */}
        <CustomRequirements
          values={step.requiredFields.filter((f) => !KNOWN_FIELDS.has(f))}
          onChange={(next) =>
            onChange((s) => {
              s.requiredFields = [...s.requiredFields.filter((f) => KNOWN_FIELDS.has(f)), ...next];
            })
          }
        />
      </WideField>

      {/* L'objectif dit CE QU'ON CHERCHE ; il ne dit pas comment le demander.
          « Propose l'appel comme un dépannage de quinze minutes » n'entrait
          dans aucun réglage — il fallait réécrire une couche du prompt. */}
      <div className="space-y-1.5">
        <FieldLabel short path={`${prefix}.instruction`} htmlFor={`${prefix}-instruction`} />
        <Textarea
          id={`${prefix}-instruction`}
          rows={2}
          maxLength={400}
          placeholder={t("editor.goal.instructionPlaceholder")}
          value={step.instruction ?? ""}
          onChange={(e) => onChange((s) => void (s.instruction = e.target.value || null))}
          disabled={!canEdit}
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel short path={`${prefix}.confirmationTemplate`} htmlFor={`${prefix}-confirm`} />
        <Textarea
          id={`${prefix}-confirm`}
          rows={2}
          value={step.confirmationTemplate ?? ""}
          onChange={(e) => onChange((s) => void (s.confirmationTemplate = e.target.value || null))}
          disabled={!canEdit}
        />
      </div>
    </Fields>
  );
}

/**
 * Le nom d'un objectif, avec son pictogramme.
 *
 * La chaîne se lit de haut en bas : « Repli 1 », « Repli 2 »… sans qu'on sache
 * ce que chaque cran vise avant d'ouvrir son sélecteur. La forme se reconnaît
 * sans être lue, et le bleu commun aux trois objectifs qui réservent une plage
 * d'agenda dit lesquels posent un rendez-vous. Le NOM reste écrit à côté : la
 * couleur ne porte jamais le sens toute seule.
 */
function GoalTypeTag({ type, className }: { type: GoalType; className?: string }) {
  const t = useTranslations("assistants");
  const look = GOAL_LOOK[type];
  // On reprend le fond et la bordure de `lookTint`, mais PAS sa couleur de
  // texte : l'ambre de « passer la main » sur fond clair ne se lit pas. Le
  // pictogramme porte la couleur, le libellé garde son contraste.
  const tint = lookTint(look);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-normal text-muted-foreground",
        className,
      )}
      style={{ borderColor: tint.borderColor, backgroundColor: tint.backgroundColor }}
    >
      <LookGlyph look={look} className="size-3.5" />
      <span className="truncate">{t(`goalType.${type}`)}</span>
    </span>
  );
}

export function GoalTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("goal");
  const look = EDITOR_TAB_LOOK.goal;
  const canEdit = useCanEdit();

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
        instruction: null,
      });
    });

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      {/* Le titre de la carte porte « Objectif principal » UNE fois : les huit
          libellés qu'elle contient le répétaient chacun en préfixe, huit lignes
          commençant par les mêmes trois mots. */}
      <Panel
        look={look}
        title={t("editor.goal.primary")}
        description={t("editor.goal.primaryHint")}
        actions={<GoalTypeTag type={config.goal.primary.type} />}
      >
        <GoalStepFields
          step={config.goal.primary}
          prefix="goal.primary"
          data={data}
          onChange={(mutate) => update((d) => mutate(d.goal.primary))}
        />
      </Panel>

      <Panel
        look={look}
        title={t("editor.goal.fallbacks")}
        description={t("editor.goal.chainNote")}
        actions={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-9"
            onClick={addFallback}
            disabled={!canEdit || config.goal.fallbacks.length >= 3}
          >
            <Plus /> {t("editor.goal.addFallback")}
          </Button>
        }
        contentClassName="space-y-3"
      >
        {config.goal.fallbacks.length === 0 ? (
          <EmptyRow>{t("editor.goal.noFallbacks")}</EmptyRow>
        ) : (
          config.goal.fallbacks.map((step, i) => (
            <div key={i} className="space-y-3 rounded-lg border bg-muted/20 p-3 md:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="shrink-0">
                  {t("editor.goal.fallbackAt", { n: i + 1 })}
                </Badge>
                {/* Ce que ce cran vise, visible sans le déplier. */}
                <GoalTypeTag type={step.type} />
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto min-h-11 shrink-0 text-destructive md:min-h-9"
                  disabled={!canEdit}
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
      </Panel>
    </div>
  );
}

// ── Approche ─────────────────────────────────────────────────────────────────

export function ApproachTab({ config, update }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("approach");
  const look = EDITOR_TAB_LOOK.approach;

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      {/* Neuf réglages en une seule grille se lisaient un par un. Ils règlent
          pourtant deux choses distinctes : COMMENT il parle, et COMBIEN il
          parle. Deux cartes séparent les deux questions. */}
      <Panel
        look={look}
        title={t("editor.approach.sectionTone")}
        description={t("editor.approach.sectionToneHint")}
      >
        <Fields>
          <EnumField
            path="approach.formality"
            value={config.approach.formality}
            onChange={(v) => update((d) => void (d.approach.formality = v as "vous" | "tu"))}
          />
          <ScaleField
            path="approach.warmth"
            value={config.approach.warmth}
            onChange={(v) => update((d) => void (d.approach.warmth = v))}
          />
          <EnumField
            path="approach.emoji"
            value={config.approach.emoji}
            onChange={(v) =>
              update((d) => void (d.approach.emoji = v as AssistantConfig["approach"]["emoji"]))
            }
          />
          <EnumField
            path="approach.replySpeed"
            value={config.approach.replySpeed}
            onChange={(v) =>
              update(
                (d) => void (d.approach.replySpeed = v as "instant" | "natural" | "deliberate"),
              )
            }
          />
        </Fields>
      </Panel>

      <Panel
        look={look}
        title={t("editor.approach.sectionRhythm")}
        description={t("editor.approach.sectionRhythmHint")}
      >
        <Fields>
          <ScaleField
            path="approach.persistence"
            value={config.approach.persistence}
            onChange={(v) => update((d) => void (d.approach.persistence = v))}
          />
          <ScaleField
            path="approach.proactivity"
            value={config.approach.proactivity}
            onChange={(v) => update((d) => void (d.approach.proactivity = v))}
          />
          {/* Le mode AVANT le nombre : c'est lui qui dit si « 3 » est un mur
              ou une cible. Dans l'autre ordre, on règle un nombre dont on ne
              sait pas encore ce qu'il veut dire. */}
          <EnumField
            path="approach.qualificationMode"
            value={config.approach.qualificationMode}
            onChange={(v) =>
              update(
                (d) =>
                  void (d.approach.qualificationMode = v as "strict" | "flexible"),
              )
            }
          />
          <NumberField
            path="approach.questionBudget"
            value={config.approach.questionBudget}
            min={1}
            max={10}
            onChange={(v) => update((d) => void (d.approach.questionBudget = v))}
          />
          {/* Le plafond n'a de sens qu'en mode souple : en mode stricte, le
              budget EST le mur, et afficher un second nombre inerte ferait
              croire à un réglage qui ne fait rien. */}
          {config.approach.qualificationMode === "flexible" ? (
            <NumberField
              path="approach.questionCeiling"
              value={config.approach.questionCeiling}
              min={1}
              max={12}
              onChange={(v) => update((d) => void (d.approach.questionCeiling = v))}
            />
          ) : null}
          <NumberField
            path="approach.maxChars"
            value={config.approach.maxChars}
            min={120}
            max={480}
            onChange={(v) => update((d) => void (d.approach.maxChars = v))}
          />
          <NumberField
            path="approach.maxTurns"
            value={config.approach.maxTurns}
            min={4}
            max={40}
            onChange={(v) => update((d) => void (d.approach.maxTurns = v))}
          />
        </Fields>
        {/* Un plafond sous la cible, c'est une consigne qui se contredit. Le
            compilateur relève le plafond plutôt que d'écrire les deux nombres,
            mais l'administrateur doit savoir que son réglage est ignoré. */}
        {config.approach.qualificationMode === "flexible" &&
        config.approach.questionCeiling < config.approach.questionBudget ? (
          <p className="mt-3 text-xs text-destructive">
            {t("editor.approach.ceilingBelowTarget")}
          </p>
        ) : null}
      </Panel>

      {/* Le coût, à part du rythme et de la longueur.
          Un plafond de SEGMENTS ne se lit pas comme une longueur : c'est la
          facture du transporteur, pas le confort de lecture. Les mêler dans la
          même carte laissait croire que « longueur maximale » tenait déjà le
          budget — elle ne le tient pas, un accent suffit à la tripler. */}
      <Panel
        look={look}
        title={t("editor.approach.sectionCost")}
        description={t("editor.approach.sectionCostHint")}
      >
        <Fields>
          <NullableNumberField
            path="approach.segmentBudget.maxSegments"
            value={config.approach.segmentBudget.maxSegments}
            onChange={(v) => update((d) => void (d.approach.segmentBudget.maxSegments = v))}
          />
          <EnumField
            path="approach.segmentBudget.economy"
            value={config.approach.segmentBudget.economy}
            onChange={(v) =>
              update(
                (d) =>
                  void (d.approach.segmentBudget.economy = v as TextEconomy),
              )
            }
          />
          {/* La conduite en cas de dépassement n'existe QUE s'il y a un
              plafond à dépasser. Un menu inerte ferait croire à un réglage
              qui ne fait rien — le même piège que le plafond de questions en
              mode stricte. */}
          {config.approach.segmentBudget.maxSegments !== null ? (
            <EnumField
              path="approach.segmentBudget.onOverflow"
              value={config.approach.segmentBudget.onOverflow}
              onChange={(v) =>
                update(
                  (d) =>
                    void (d.approach.segmentBudget.onOverflow = v as OverflowPolicy),
                )
              }
            />
          ) : null}
        </Fields>
        <SegmentBudgetNote config={config} />
      </Panel>

      {/* Heures de travail — propre à CET assistant. Le garde-fou contre un
          texto à 3 h : hors fenêtre, l'envoi est reporté (voir send-sms). */}
      <Panel
        look={look}
        title={t("editor.approach.sectionHours")}
        description={t("editor.approach.sectionHoursHint")}
      >
        <div className="space-y-3">
          <HoursRow
            label={t("editor.approach.hoursWeekday")}
            value={config.approach.quietHours.weekday}
            onChange={(w) => update((d) => void (d.approach.quietHours.weekday = w))}
            fromLabel={t("editor.approach.hoursFrom")}
            toLabel={t("editor.approach.hoursTo")}
          />
          <HoursRow
            label={t("editor.approach.hoursSaturday")}
            value={config.approach.quietHours.saturday}
            onChange={(w) => update((d) => void (d.approach.quietHours.saturday = w))}
            fromLabel={t("editor.approach.hoursFrom")}
            toLabel={t("editor.approach.hoursTo")}
          />
          <HoursRow
            label={t("editor.approach.hoursSunday")}
            value={config.approach.quietHours.sunday}
            onChange={(w) => update((d) => void (d.approach.quietHours.sunday = w))}
            fromLabel={t("editor.approach.hoursFrom")}
            toLabel={t("editor.approach.hoursTo")}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("editor.approach.hoursNote")}</p>
        {(["weekday", "saturday", "sunday"] as const).some(
          (day) => config.approach.quietHours[day][0] >= config.approach.quietHours[day][1],
        ) ? (
          <p className="mt-1 text-xs text-destructive">{t("editor.approach.hoursInvalid")}</p>
        ) : null}
      </Panel>
    </div>
  );
}

/** Une ligne « de X h à Y h » pour un type de jour de la fenêtre d'envoi. */
function HoursRow({
  label,
  value,
  onChange,
  fromLabel,
  toLabel,
}: {
  label: string;
  value: [number, number];
  onChange: (window: [number, number]) => void;
  fromLabel: string;
  toLabel: string;
}) {
  const invalid = value[0] >= value[1];
  const canEdit = useCanEdit();
  const setHour = (idx: 0 | 1, raw: string) => {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    const next: [number, number] = idx === 0 ? [n, value[1]] : [value[0], n];
    onChange(next);
  };
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-end gap-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{fromLabel}</Label>
        <Input
          type="number"
          min={0}
          max={23}
          className="h-9 w-20"
          value={value[0]}
          aria-invalid={invalid || undefined}
          disabled={!canEdit}
          onChange={(e) => setHour(0, e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{toLabel}</Label>
        <Input
          type="number"
          min={1}
          max={24}
          className="h-9 w-20"
          value={value[1]}
          aria-invalid={invalid || undefined}
          disabled={!canEdit}
          onChange={(e) => setHour(1, e.target.value)}
        />
      </div>
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
  const head = useTabHead("knowledge");
  const look = EDITOR_TAB_LOOK.knowledge;
  const canEdit = useCanEdit();
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
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel look={look} contentClassName="space-y-4">
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
          <EmptyRow>{t("editor.knowledge.empty")}</EmptyRow>
        ) : (
          <FieldNote>{t("editor.knowledge.orderHint")}</FieldNote>
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
                className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-md font-mono text-xs"
                style={{ backgroundColor: lookTint(look).backgroundColor }}
              >
                {i + 1}
              </span>
              <Textarea
                rows={2}
                // Une zone de texte ne descend pas sous sa largeur intrinsèque
                // dans une rangée flex : à 360 px la rangée (numéro, flèches,
                // corbeille) poussait la page en débordement horizontal.
                className="min-w-0"
                value={claim}
                maxLength={600}
                aria-label={t("editor.knowledge.entry", { index: i + 1 })}
                placeholder={t("editor.knowledge.placeholder")}
                disabled={!canEdit}
                onChange={(e) => update((d) => void (d.knowledge.claims[i] = e.target.value))}
              />
              <div className="flex shrink-0 flex-col">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-8"
                  disabled={!canEdit || i === 0}
                  aria-label={t("editor.knowledge.moveUp", { index: i + 1 })}
                  onClick={() => move(i, i - 1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-8"
                  disabled={!canEdit || i === claims.length - 1}
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
                disabled={!canEdit}
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
          disabled={!canEdit || claims.length >= 50}
          onClick={() => update((d) => void d.knowledge.claims.push(""))}
        >
          <Plus /> {t("editor.knowledge.add")}
        </Button>
      </Panel>
    </div>
  );
}

/** Un exemple des deux formes admises — c'est ce qui les rend évidentes. */
function ExampleLine({ kind, text }: { kind: "fact" | "rule"; text: string }) {
  const t = useTranslations("assistants");
  // Les deux exemples s'écrivent dans la même liste et se ressemblent en
  // texte ; le pictogramme sépare « ce que l'assistant peut affirmer » de
  // « comment il doit se conduire » avant qu'on ait lu la phrase.
  const look = KNOWLEDGE_LOOK[kind];
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
      <LookIcon look={look} size="sm" className="mt-px" />
      <span className="min-w-0">
        <Badge variant="outline" className="mr-1.5 align-middle text-[10px]">
          {t(`editor.knowledge.kind.${kind}`)}
        </Badge>
        {text}
      </span>
    </p>
  );
}

// ── Objections ───────────────────────────────────────────────────────────────

export function ObjectionsTab({ config, update, data }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("objections");
  const look = EDITOR_TAB_LOOK.objections;

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel look={look} contentClassName="space-y-3">
        <p className="text-sm text-muted-foreground">{t("editor.objections.intro")}</p>
        {/* Cocher règle CET assistant ; ouvrir et corriger règle le paquet pour
            tous ceux qui s'en servent. Les deux gestes vivent au même endroit
            parce qu'on les enchaîne — mais ils s'enregistrent séparément. */}
        <ObjectionPacksEditor
          packs={data.packs}
          selected={config.objectionPacks}
          onToggle={(id, next) =>
            update((d) => {
              d.objectionPacks = next
                ? [...d.objectionPacks, id]
                : d.objectionPacks.filter((p) => p !== id);
            })
          }
        />
      </Panel>
    </div>
  );
}

// ── Outils ───────────────────────────────────────────────────────────────────

/** « stop » et « handoff » ne se décochent pas — voir la note de l'onglet. */
const REQUIRED_TOOLS: AssistantTool[] = ["stop", "handoff"];

export function ToolsTab({ config, update }: TabProps) {
  const t = useTranslations("assistants");
  const head = useTabHead("tools");
  const look = EDITOR_TAB_LOOK.tools;
  const canEdit = useCanEdit();

  return (
    <div className="space-y-4">
      <TabHead look={look} title={head.title} hint={head.hint} />

      <Panel look={look} contentClassName="space-y-3">
        {/* La note nomme « stop » et « handoff » : leurs deux pictogrammes la
            précèdent, ce sont eux qu'on retrouvera plus bas dans la liste. */}
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <span className="flex shrink-0 items-center gap-1 pt-0.5">
            <LookGlyph look={TOOL_LOOK.stop} className="size-3.5" />
            <LookGlyph look={TOOL_LOOK.handoff} className="size-3.5" />
          </span>
          <span className="min-w-0">{t("editor.tools.requiredNote")}</span>
        </p>
        <div className="space-y-2">
          {ASSISTANT_TOOLS.map((tool) => {
            const required = REQUIRED_TOOLS.includes(tool);
            const checked = config.tools.includes(tool);
            // Huit interrupteurs de texte nu se valaient tous à l'œil. Le
            // pictogramme identifie l'outil ; le liseré ne teinte QUE les deux
            // qu'on ne peut pas éteindre, dans leur propre couleur — le rouge de
            // l'arrêt et l'ambre du passage à un humain sont déjà graves.
            const toolLook = TOOL_LOOK[tool];
            return (
              <div
                key={tool}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                  !required && !checked && "opacity-70",
                )}
                style={
                  required
                    ? {
                        borderLeftWidth: 3,
                        borderLeftColor: toolLook.color,
                        backgroundColor: lookTint(toolLook).backgroundColor,
                      }
                    : undefined
                }
              >
                <Switch
                  checked={checked || required}
                  disabled={required || !canEdit}
                  aria-label={t(`tool.${tool}`)}
                  onCheckedChange={(next) =>
                    update((d) => {
                      d.tools = next ? [...d.tools, tool] : d.tools.filter((x) => x !== tool);
                    })
                  }
                />
                <LookIcon look={toolLook} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-words">{t(`tool.${tool}`)}</span>
                    {required ? (
                      <Badge variant="secondary">{t("editor.tools.required")}</Badge>
                    ) : null}
                  </div>
                  {/* L'explication passe sous le nom : à 360 px elle se glissait
                      entre le nom et la pastille « Requis ». */}
                  <ToolHelp tool={tool} />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function ToolHelp({ tool }: { tool: AssistantTool }) {
  const doc = useParamDoc(`tools.${tool}`);
  if (!doc) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{doc.what}</p>;
}
