"use client";

import { Loader2, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  EDITOR_TAB_LOOK,
  GUARDRAIL_KIND_LOOK,
  LookGlyph,
  LookIcon,
  ORIGIN_LOOK,
  SEVERITY_LOOK,
  lookTint,
} from "@/components/look";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { GUARDRAIL_SEVERITIES, type GuardrailKind, type GuardrailSeverity } from "@/lib/guardrails/types";
import { api } from "./api";
import {
  GuardrailRuleDialog,
  KindHelp,
  emptyRule,
  type EditableRule,
} from "./guardrail-rule-dialog";
import { GuardrailCoreDialog } from "./guardrail-core-dialog";
import {
  FixtureFieldHelp,
  GuardrailFixtureDialog,
  emptyFixture,
  type EditableFixture,
} from "./guardrail-fixture-dialog";

// ── DTO — sérialisés depuis src/app/(app)/admin/guardrails/page.tsx ──────────

export type GuardrailRuleDto = {
  id: string;
  key: string;
  label: string;
  /** Nécessaires au dialogue d'édition : sans eux il s'ouvrirait vide et une
   *  sauvegarde effacerait la configuration existante. */
  description: string | null;
  kind: GuardrailKind;
  config: unknown;
  promptText: string | null;
  severity: GuardrailSeverity;
  enabled: boolean;
  modifiedFromDefault: boolean;
  updatedAt: string;
};

export type GuardrailFixtureDto = {
  id: string;
  label: string;
  inbound: string;
  /** Nécessaires au dialogue : sans eux il s'ouvrirait vide et une
   *  sauvegarde effacerait le scénario existant. */
  setup: unknown;
  expectations: unknown;
  severity: GuardrailSeverity;
  enabled: boolean;
  modifiedFromDefault: boolean;
  updatedAt: string;
};

export type PromptCoreDto = {
  version: number;
  body: string;
  createdAt: string;
} | null;

/**
 * Puce du type de règle.
 *
 * Les huit types se ressemblent tous à la lecture — trois d'entre eux ouvrent
 * même sur le mot « interdit ». Le pictogramme précède le libellé (jamais à sa
 * place) et sa couleur dit ce que la règle regarde : les mots, ce qui se
 * compte, les outils, l'avis d'un modèle.
 */
function KindBadge({ kind }: { kind: GuardrailKind }) {
  const t = useTranslations("assistants");
  return (
    <Badge variant="outline" className="max-w-full gap-1 whitespace-nowrap">
      <LookGlyph look={GUARDRAIL_KIND_LOOK[kind]} className="size-3" />
      {/* `min-w-0` sans quoi la troncature n'a pas lieu : dans une puce en
          flex, un enfant ne descend pas sous sa largeur de contenu, et le
          libellé se ferait couper net par `overflow-hidden`, sans points de
          suspension, sur une carte de 360 px. */}
      <span className="min-w-0 truncate">{t(`guardrails.kind.${kind}`)}</span>
    </Badge>
  );
}

/** Pastille de sévérité en lecture seule (fixtures, préréglages). */
function SeverityBadge({ severity }: { severity: GuardrailSeverity }) {
  const t = useTranslations("assistants");
  const look = SEVERITY_LOOK[severity];
  return (
    <Badge variant="outline" className="gap-1" style={lookTint(look)}>
      <LookGlyph look={look} className="size-3" />
      {t(`guardrails.severity.${severity}`)}
    </Badge>
  );
}

/** « Modifié » = quelqu'un a repris à la main ce que la semence avait écrit. */
function ModifiedChip() {
  const t = useTranslations("assistants");
  return (
    <Badge variant="outline" className="gap-1" style={lookTint(ORIGIN_LOOK.handwritten)}>
      <LookGlyph look={ORIGIN_LOOK.handwritten} className="size-3" />
      {t("guardrails.modified")}
    </Badge>
  );
}

// ── Contrôles de règle ───────────────────────────────────────────────────────

function RuleSeveritySelect({ rule }: { rule: GuardrailRuleDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const change = async (severity: GuardrailSeverity) => {
    setPending(true);
    try {
      const res = await api<{ staleAssistants?: number }>(
        `/api/admin/guardrails/rules/${rule.id}`,
        { method: "PATCH", body: JSON.stringify({ severity }) },
      );
      // Changer une règle du noyau périme les assistants : le dire tout de
      // suite évite de croire que le changement s'applique déjà.
      const stale = res.staleAssistants ?? 0;
      toast.success(
        stale > 0
          ? `${t("guardrails.saved")} — ${t("guardrails.invalidated", { count: stale })}`
          : t("guardrails.saved"),
      );
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Select
      items={GUARDRAIL_SEVERITIES.map((s) => ({ value: s, label: t(`guardrails.severity.${s}`) }))}
      value={rule.severity}
      onValueChange={(v) => void change(v as GuardrailSeverity)}
      disabled={pending}
    >
      {/* Le feu de circulation jusque DANS le sélecteur : c'est ce champ qui
          décide si un message part, et « Bloque » / « Avertit » se lisent
          presque pareil quand on parcourt une colonne de dix règles. */}
      <SelectTrigger
        aria-label={t("guardrails.columns.severity")}
        className="min-h-11 w-full md:min-h-8 md:w-44"
      >
        <LookGlyph look={SEVERITY_LOOK[rule.severity]} className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GUARDRAIL_SEVERITIES.map((s) => (
          <SelectItem key={s} value={s}>
            <LookGlyph look={SEVERITY_LOOK[s]} className="size-3.5" />
            {t(`guardrails.severity.${s}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RuleEnabledSwitch({ rule }: { rule: GuardrailRuleDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const toggle = async (enabled: boolean) => {
    setPending(true);
    try {
      await api(`/api/admin/guardrails/rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      toast.success(t("guardrails.saved"));
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Switch
      checked={rule.enabled}
      disabled={pending}
      onCheckedChange={(checked) => void toggle(checked)}
      aria-label={t("guardrails.columns.enabled")}
    />
  );
}

/** Visible uniquement quand la règle diverge de sa semence (§16.6). */
function RuleResetButton({ rule }: { rule: GuardrailRuleDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!rule.modifiedFromDefault) return null;

  const confirm = async () => {
    setPending(true);
    try {
      await api(`/api/admin/guardrails/rules/${rule.id}/reset`, { method: "POST" });
      toast.success(t("guardrails.saved"));
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="min-h-11 md:min-h-8" />}>
        <RotateCcw className="size-3.5" />
        {t("guardrails.reset.action")}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("guardrails.reset.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("guardrails.reset.confirmBody", { label: rule.label })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="min-h-11 md:min-h-8">
            {t("guardrails.reset.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() => void confirm()}
            className="min-h-11 md:min-h-8"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("guardrails.reset.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Ouvre le dialogue d'édition prérempli avec la règle. */
function RuleEditButton({ rule, onEdit }: { rule: GuardrailRuleDto; onEdit: (r: EditableRule) => void }) {
  const t = useTranslations("assistants");
  return (
    <Button
      variant="ghost"
      size="sm"
      className="min-h-11 md:min-h-8"
      onClick={() =>
        onEdit({
          id: rule.id,
          key: rule.key,
          label: rule.label,
          description: rule.description,
          kind: rule.kind,
          config: rule.config,
          promptText: rule.promptText,
          severity: rule.severity,
          enabled: rule.enabled,
        })
      }
    >
      <Pencil className="size-3.5" />
      {t("guardrails.editRule")}
    </Button>
  );
}

function RuleDeleteButton({ rule }: { rule: GuardrailRuleDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      const res = await api<{ staleAssistants?: number }>(
        `/api/admin/guardrails/rules/${rule.id}`,
        { method: "DELETE" },
      );
      const stale = res.staleAssistants ?? 0;
      toast.success(
        stale > 0
          ? `${t("guardrails.deleted")} — ${t("guardrails.invalidated", { count: stale })}`
          : t("guardrails.deleted"),
      );
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {/* Bouton sans libellé : la corbeille est `aria-hidden` (lucide le pose
          seul), donc sans `aria-label` ce bouton n'a AUCUN nom — un lecteur
          d'écran annonce « bouton », juste avant une suppression. Le libellé
          existe déjà dans le registre. */}
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("guardrails.deleteRule")}
            className="min-h-11 text-destructive md:min-h-8"
          />
        }
      >
        <Trash2 className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("guardrails.deleteConfirm.title", { label: rule.label })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("guardrails.deleteConfirm.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="min-h-11 md:min-h-8">
            {t("guardrails.reset.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() => void confirm()}
            className="min-h-11 md:min-h-8"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("guardrails.deleteConfirm.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Section : règles globales ────────────────────────────────────────────────

function RulesCard({ rules }: { rules: GuardrailRuleDto[] }) {
  const t = useTranslations("assistants");
  const [editing, setEditing] = useState<EditableRule | null>(null);

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          {/* Le bouclier des garde-fous, le presse-papiers de la vérification,
              le parchemin du prompt : trois cartes qui portaient la même
              pastille bleue et se cherchaient à la lecture du titre. */}
          <LookIcon look={EDITOR_TAB_LOOK.guardrails} size="lg" />
          <div className="min-w-0 space-y-0.5">
            <CardTitle>{t("guardrails.sections.rules.title")}</CardTitle>
            <CardDescription>{t("guardrails.sections.rules.desc")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => setEditing(emptyRule())}
          >
            <Plus />
            {t("guardrails.addRule")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {rules.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("guardrails.emptyRules")}</p>
        ) : (
          <>
            {/* ── Tableau (desktop) ── */}
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t("guardrails.columns.label")}</TableHead>
                    <TableHead>{t("guardrails.columns.kind")}</TableHead>
                    <TableHead>{t("guardrails.columns.enabled")}</TableHead>
                    <TableHead>{t("guardrails.columns.severity")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{r.label}</span>
                          {r.modifiedFromDefault ? <ModifiedChip /> : null}
                        </div>
                        {/* La clé sous le nom, comme sur la carte mobile : en
                            colonne propre elle poussait les gestes hors du
                            cadre. */}
                        <span className="font-mono text-xs text-muted-foreground">{r.key}</span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-0.5">
                          <KindBadge kind={r.kind} />
                          <KindHelp kind={r.kind} />
                        </span>
                      </TableCell>
                      <TableCell>
                        <RuleEnabledSwitch rule={r} />
                      </TableCell>
                      <TableCell className="w-44">
                        <RuleSeveritySelect rule={r} />
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="flex items-center justify-end whitespace-nowrap">
                          <RuleEditButton rule={r} onEdit={setEditing} />
                          <RuleResetButton rule={r} />
                          <RuleDeleteButton rule={r} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* ── Cartes (mobile) ── */}
            <div className="space-y-3 p-4 md:hidden">
              {rules.map((r) => (
                <div key={r.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.label}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{r.key}</p>
                    </div>
                    <KindBadge kind={r.kind} />
                  </div>
                  {r.modifiedFromDefault ? (
                    <div className="mt-1.5">
                      <ModifiedChip />
                    </div>
                  ) : null}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
                      <RuleEnabledSwitch rule={r} />
                      {t("guardrails.columns.enabled")}
                    </label>
                    <RuleSeveritySelect rule={r} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
                    <KindHelp kind={r.kind} />
                    <RuleEditButton rule={r} onEdit={setEditing} />
                    <RuleResetButton rule={r} />
                    <RuleDeleteButton rule={r} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>

      {editing ? (
        <GuardrailRuleDialog
          rule={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

// ── Section : fixtures (lecture seule pour l'instant) ────────────────────────

function FixtureEnabledSwitch({ fixture }: { fixture: GuardrailFixtureDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const toggle = async (enabled: boolean) => {
    setPending(true);
    try {
      await api(`/api/admin/guardrails/fixtures/${fixture.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      toast.success(t("guardrails.saved"));
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Switch
      checked={fixture.enabled}
      disabled={pending}
      onCheckedChange={(checked) => void toggle(checked)}
      aria-label={t("guardrails.columns.enabled")}
    />
  );
}

/** DTO → brouillon éditable. */
function toEditableFixture(f: GuardrailFixtureDto): EditableFixture {
  const setup = (f.setup ?? {}) as { priorTurns?: [("out" | "in"), string][] };
  const e = (f.expectations ?? {}) as {
    mustCallTool?: string[]; mustNotCallTool?: string[];
    mustMatch?: string[]; mustNotMatch?: string[];
    judge?: string | null; maxChars?: number | null;
  };
  return {
    id: f.id,
    label: f.label,
    inbound: f.inbound,
    priorTurns: setup.priorTurns ?? [],
    severity: f.severity,
    enabled: f.enabled,
    mustCallTool: e.mustCallTool ?? [],
    mustNotCallTool: e.mustNotCallTool ?? [],
    mustMatch: e.mustMatch ?? [],
    mustNotMatch: e.mustNotMatch ?? [],
    judge: e.judge ?? null,
    maxChars: e.maxChars ?? null,
  };
}

function FixtureDeleteButton({ fixture }: { fixture: GuardrailFixtureDto }) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      await api(`/api/admin/guardrails/fixtures/${fixture.id}`, { method: "DELETE" });
      toast.success(t("guardrails.fixtures.deleted"));
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("guardrails.fixtures.delete")}
            className="min-h-11 text-destructive md:min-h-8"
          />
        }
      >
        <Trash2 className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("guardrails.fixtures.deleteConfirm.title", { label: fixture.label })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("guardrails.fixtures.deleteConfirm.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="min-h-11 md:min-h-8">
            {t("guardrails.reset.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => void confirm()} className="min-h-11 md:min-h-8">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("guardrails.fixtures.deleteConfirm.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FixturesCard({ fixtures }: { fixtures: GuardrailFixtureDto[] }) {
  const t = useTranslations("assistants");
  const [editing, setEditing] = useState<EditableFixture | null>(null);

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <LookIcon look={EDITOR_TAB_LOOK.test} size="lg" />
          <div className="min-w-0 space-y-0.5">
            <CardTitle>{t("guardrails.sections.fixtures.title")}</CardTitle>
            <CardDescription>{t("guardrails.sections.fixtures.desc")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => setEditing(emptyFixture())}
          >
            <Plus />
            {t("guardrails.fixtures.add")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {fixtures.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("guardrails.emptyFixtures")}</p>
        ) : (
          <ul className="divide-y">
            {fixtures.map((f) => (
              <li
                key={f.id}
                className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{f.label}</span>
                    <SeverityBadge severity={f.severity} />
                    <FixtureFieldHelp field="inbound" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{f.inbound}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <label className="flex min-h-11 items-center gap-2 text-sm font-medium md:min-h-0">
                    <FixtureEnabledSwitch fixture={f} />
                    {t("guardrails.columns.enabled")}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    onClick={() => setEditing(toEditableFixture(f))}
                  >
                    <Pencil className="size-3.5" />
                    {t("guardrails.editRule")}
                  </Button>
                  <FixtureDeleteButton fixture={f} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {editing ? (
        <GuardrailFixtureDialog
          fixture={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

// ── Section : noyau du prompt (L0) ───────────────────────────────────────────

function CoreCard({ core }: { core: PromptCoreDto }) {
  const t = useTranslations("assistants");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <LookIcon look={EDITOR_TAB_LOOK.prompt} size="lg" />
          <div className="min-w-0 space-y-0.5">
            <CardTitle>{t("guardrails.sections.core.title")}</CardTitle>
            <CardDescription>{t("guardrails.sections.core.desc")}</CardDescription>
          </div>
        </div>
        {core ? (
          <CardAction>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => setEditing(true)}
            >
              <Pencil />
              {t("guardrails.core.edit")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {core ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="outline" className="gap-1" style={lookTint(EDITOR_TAB_LOOK.prompt)}>
                <LookGlyph look={EDITOR_TAB_LOOK.prompt} className="size-3" />
                {t("guardrails.sections.core.version", { version: core.version })}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => setOpen((o) => !o)}
              >
                {open ? t("guardrails.sections.core.hideBody") : t("guardrails.sections.core.showBody")}
              </Button>
            </div>
            {open ? (
              <pre className="max-h-96 overflow-x-auto overflow-y-auto rounded-lg border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                {core.body}
              </pre>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("guardrails.emptyCore")}</p>
        )}
      </CardContent>

      {core && editing ? (
        <GuardrailCoreDialog
          version={core.version}
          body={core.body}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(false);
          }}
        />
      ) : null}
    </Card>
  );
}

// ── Tout réinitialiser ───────────────────────────────────────────────────────

function ResetAllButton() {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      const res = await api<{ restored: number; recreated: number; staleAssistants?: number }>(
        "/api/admin/guardrails/reset-all",
        { method: "POST" },
      );
      const stale = res.staleAssistants ?? 0;
      const done = t("guardrails.resetAll.done", { restored: res.restored, recreated: res.recreated });
      toast.success(stale > 0 ? `${done} — ${t("guardrails.invalidated", { count: stale })}` : done);
      setOpen(false);
      router.refresh();
    } catch {
      toast.error(t("guardrails.genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="destructive" className="min-h-11 md:min-h-8" />}>
        <RotateCcw className="size-4" />
        {t("guardrails.resetAll.action")}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("guardrails.resetAll.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("guardrails.resetAll.confirmBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} className="min-h-11 md:min-h-8">
            {t("guardrails.resetAll.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-11 bg-destructive text-white hover:bg-destructive/90 md:min-h-8"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("guardrails.resetAll.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Composant racine ─────────────────────────────────────────────────────────

export function GuardrailsClient({
  rules: initialRules,
  fixtures: initialFixtures,
  core,
}: {
  rules: GuardrailRuleDto[];
  fixtures: GuardrailFixtureDto[];
  core: PromptCoreDto;
}) {
  // Patron « ajuster l'état quand une prop change » (voir CategoriesCard dans
  // pipeline-client.tsx) : les mutations appellent router.refresh() sans mettre
  // à jour de copie locale — c'est cette resynchronisation, faite PENDANT le
  // rendu, qui fait réapparaître les nouvelles valeurs serveur.
  const [rules, setRules] = useState(initialRules);
  const [rulesFrom, setRulesFrom] = useState(initialRules);
  if (initialRules !== rulesFrom) {
    setRulesFrom(initialRules);
    setRules(initialRules);
  }

  const [fixtures, setFixtures] = useState(initialFixtures);
  const [fixturesFrom, setFixturesFrom] = useState(initialFixtures);
  if (initialFixtures !== fixturesFrom) {
    setFixturesFrom(initialFixtures);
    setFixtures(initialFixtures);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ResetAllButton />
      </div>
      <RulesCard rules={rules} />
      <FixturesCard fixtures={fixtures} />
      <CoreCard core={core} />
    </div>
  );
}
