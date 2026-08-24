"use client";

import {
  Copy as CopyIcon,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ApiError, api } from "./api";
import type { OptionDto } from "./types";

/** Pastille d'icône commune aux en-têtes des cartes Import / Export. */
function CardIcon({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4"
    >
      {children}
    </div>
  );
}

/** Numéro d'étape (1, 2, 3…) affiché à côté du titre de chaque section d'import. */
function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums"
    >
      {n}
    </span>
  );
}

const FIELDS = [
  "fullName",
  "phone",
  "phoneAlt",
  "email",
  "city",
  "address",
  "projectType",
  "timing",
  "budget",
  "notes",
] as const;
type Field = (typeof FIELDS)[number];

/** En-têtes reconnus (français / anglais / exports Notion), sans accents ni casse. */
const HEADER_GUESSES: Record<Field, string[]> = {
  fullName: ["name", "nom", "full name", "full_name", "nom complet", "nom_complet", "client", "prospect"],
  phone: ["phone", "telephone", "tel", "numero", "numero de telephone", "phone number", "mobile", "cellulaire"],
  phoneAlt: ["phone 2", "phone2", "telephone 2", "autre telephone", "phone alt", "secondary phone"],
  email: ["email", "courriel", "e-mail", "mail", "adresse courriel"],
  city: ["city", "ville", "municipalite"],
  address: ["address", "adresse"],
  projectType: ["type", "besoin", "projet", "project", "project type", "type de projet", "quel est votre besoin"],
  timing: ["timing", "delai", "quand", "echeance", "votre projet est prevu pour quand"],
  budget: ["budget", "prix", "price"],
  notes: ["notes", "note", "commentaire", "commentaires", "comments", "message", "remarques"],
};

function slug(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_?!.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessMapping(headers: string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const used = new Set<string>();
  for (const field of FIELDS) {
    for (const header of headers) {
      if (used.has(header)) continue;
      if (HEADER_GUESSES[field].includes(slug(header))) {
        out[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return out;
}

type Counts = { created: number; updated: number; skipped: number; invalid: number };

/** Motifs de rejet renvoyés par l'API (voir src/app/api/admin/import/route.ts). */
type IssueReason = "phone_missing" | "phone_invalid" | "duplicate_in_file" | "duplicate_in_db";
type ImportIssue = {
  index: number;
  reason: IssueReason;
  phone?: string;
  name?: string;
  existingId?: string;
};
type ImportResponse = Counts & { issues: ImportIssue[] };

/** Ligne écartée, ramenée au numéro de ligne réel du fichier CSV. */
type RejectedRow = ImportIssue & { csvLine: number; rowIndex: number };

/** Ordre d'affichage : d'abord ce qui demande une action, puis l'informatif. */
const REASON_ORDER: IssueReason[] = [
  "duplicate_in_db",
  "phone_invalid",
  "phone_missing",
  "duplicate_in_file",
];

export function ImportCard({
  categories,
  sources,
  users,
}: {
  categories: OptionDto[];
  sources: OptionDto[];
  users: OptionDto[];
}) {
  const t = useTranslations("admin");
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<Field, string>>>({});
  const [defaults, setDefaults] = useState<{ categoryId: string | null; sourceId: string | null; assignedToId: string | null }>({
    categoryId: null,
    sourceId: null,
    assignedToId: null,
  });
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Counts | null>(null);
  const [rejected, setRejected] = useState<RejectedRow[]>([]);
  const [fixing, setFixing] = useState<IssueReason | null>(null);
  /** Corrections saisies sur place : index de ligne → nouveau téléphone. */
  const [fixes, setFixes] = useState<Record<number, string>>({});

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  /** Lignes écartées regroupées par motif, dans l'ordre d'affichage. */
  const rejectedGroups = useMemo(
    () =>
      REASON_ORDER.map((reason) => ({
        reason,
        items: rejected.filter((r) => r.reason === reason),
      })).filter((g) => g.items.length > 0),
    [rejected],
  );

  const onFile = (file: File) => {
    setResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const fields = res.meta.fields ?? [];
        setFileName(file.name);
        setHeaders(fields);
        setRows(res.data);
        setMapping(guessMapping(fields));
        if (res.data.length === 0) toast.error(t("importExport.import.emptyFile"));
      },
      error: () => toast.error(t("importExport.import.parseError")),
    });
  };

  /** Applique le mappage colonnes → champs à une ligne brute du CSV. */
  const mapRow = (raw: Record<string, string>) => {
    const mapped: Record<string, string> = {};
    for (const field of FIELDS) {
      const header = mapping[field];
      if (header && raw[header] != null && String(raw[header]).trim() !== "") {
        mapped[field] = String(raw[header]).trim();
      }
    }
    return mapped;
  };

  /**
   * Envoie par lots les lignes désignées (index dans `rows`) et agrège les
   * compteurs ET les lignes écartées, ramenées à leur position dans le fichier.
   * Sert autant à l'import initial qu'au rejeu d'un groupe d'erreurs.
   */
  const sendRows = async (
    sourceRows: Record<string, string>[],
    rowIndexes: number[],
    sendMode: "skip" | "update",
  ) => {
    const totals: Counts = { created: 0, updated: 0, skipped: 0, invalid: 0 };
    const collected: RejectedRow[] = [];
    const BATCH = 200;
    for (let i = 0; i < rowIndexes.length; i += BATCH) {
      const slice = rowIndexes.slice(i, i + BATCH);
      const res = await api<ImportResponse>("/api/admin/import", {
        method: "POST",
        body: JSON.stringify({
          rows: slice.map((idx) => mapRow(sourceRows[idx])),
          mode: sendMode,
          batch: Math.floor(i / BATCH),
          defaults: {
            categoryId: defaults.categoryId ? Number(defaults.categoryId) : null,
            sourceId: defaults.sourceId ? Number(defaults.sourceId) : null,
            assignedToId: defaults.assignedToId || null,
          },
        }),
      });
      totals.created += res.created;
      totals.updated += res.updated;
      totals.skipped += res.skipped;
      totals.invalid += res.invalid;
      for (const issue of res.issues ?? []) {
        const rowIndex = slice[issue.index];
        // +2 : la ligne d'en-tête, puis la numérotation à partir de 1.
        collected.push({ ...issue, rowIndex, csvLine: rowIndex + 2 });
      }
      setProgress(Math.round(((i + slice.length) / rowIndexes.length) * 100));
    }
    return { totals, collected };
  };

  const runImport = async () => {
    if (!mapping.phone) {
      toast.error(t("importExport.import.phoneRequired"));
      return;
    }
    setProgress(0);
    setResult(null);
    setRejected([]);
    setFixes({});
    try {
      const { totals, collected } = await sendRows(
        rows,
        rows.map((_, i) => i),
        mode,
      );
      setResult(totals);
      setRejected(collected);
      toast.success(t("importExport.import.done"));
    } catch (err) {
      // 422 invalid_default : une valeur par défaut (catégorie/source/assigné)
      // a été supprimée depuis le chargement — la liste déroulante est périmée.
      if (err instanceof ApiError && err.code === "invalid_default") {
        toast.error(t("importExport.import.invalidDefault"));
      } else {
        toast.error(t("genericError"));
      }
    } finally {
      setProgress(null);
    }
  };

  /** Compteurs après le rejeu d'un groupe : ce qui repasse quitte les écartés. */
  const mergeRetry = (
    group: { reason: IssueReason; items: RejectedRow[] },
    retried: number[],
    totals: Counts,
    collected: RejectedRow[],
  ) => {
    const stillRejected = new Set(collected.map((r) => r.rowIndex));
    setRejected((prev) => [
      ...prev.filter((r) => !retried.includes(r.rowIndex) || stillRejected.has(r.rowIndex)),
      ...collected.filter((r) => !prev.some((p) => p.rowIndex === r.rowIndex && p.reason === r.reason)),
    ]);
    const resolved = retried.length - collected.length;
    setResult((prev) =>
      prev
        ? {
            created: prev.created + totals.created,
            updated: prev.updated + totals.updated,
            // Les lignes réglées sortent du compteur d'où elles venaient.
            skipped:
              prev.skipped - (group.reason.startsWith("duplicate") ? resolved : 0) + totals.skipped,
            invalid:
              prev.invalid - (group.reason.startsWith("phone") ? resolved : 0) + totals.invalid,
          }
        : totals,
    );
  };

  /** « Mettre à jour ces fiches » — rejoue le groupe en mode update. */
  const updateGroup = async (group: { reason: IssueReason; items: RejectedRow[] }) => {
    setFixing(group.reason);
    setProgress(0);
    const retried = group.items.map((r) => r.rowIndex);
    try {
      const { totals, collected } = await sendRows(rows, retried, "update");
      mergeRetry(group, retried, totals, collected);
      toast.success(t("importExport.import.issues.updated", { count: totals.updated }));
    } catch {
      toast.error(t("genericError"));
    } finally {
      setFixing(null);
      setProgress(null);
    }
  };

  /**
   * « Corriger et réimporter » — applique les numéros saisis sur place dans les
   * lignes du fichier chargé, puis rejoue uniquement ces lignes. La correction
   * reste visible dans l'aperçu : plus besoin de retoucher le CSV à l'extérieur.
   */
  const retryFixed = async (group: { reason: IssueReason; items: RejectedRow[] }) => {
    const phoneHeader = mapping.phone;
    if (!phoneHeader) return;
    const edited = group.items.filter(
      (r) => (fixes[r.rowIndex] ?? "").trim() !== "" && fixes[r.rowIndex] !== r.phone,
    );
    if (edited.length === 0) return;

    const nextRows = rows.map((raw, i) =>
      edited.some((e) => e.rowIndex === i) ? { ...raw, [phoneHeader]: fixes[i].trim() } : raw,
    );
    setRows(nextRows);

    setFixing(group.reason);
    setProgress(0);
    const retried = edited.map((r) => r.rowIndex);
    try {
      const { totals, collected } = await sendRows(nextRows, retried, mode);
      mergeRetry(group, retried, totals, collected);
      setFixes((prev) => {
        const next = { ...prev };
        for (const i of retried) if (!collected.some((c) => c.rowIndex === i)) delete next[i];
        return next;
      });
      toast.success(t("importExport.import.issues.fixed", { count: totals.created }));
    } catch {
      toast.error(t("genericError"));
    } finally {
      setFixing(null);
      setProgress(null);
    }
  };

  const mappingSelect = (field: Field) => (
    <div key={field} className="space-y-1">
      <Label className="text-xs">
        {t(`importExport.fields.${field}`)}
        {field === "phone" ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Select
        items={[
          { value: null as unknown as string, label: "—" },
          ...headers.map((h) => ({ value: h, label: h })),
        ]}
        value={mapping[field] ?? null}
        onValueChange={(v) => setMapping((m) => ({ ...m, [field]: v === null ? undefined : String(v) }))}
      >
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>—</SelectItem>
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const defaultSelect = (
    label: string,
    options: OptionDto[],
    value: string | null,
    onChange: (v: string | null) => void,
  ) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select
        items={[{ value: null as unknown as string, label: "—" }, ...options]}
        value={value}
        onValueChange={(v) => onChange(v === null ? null : String(v))}
      >
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>—</SelectItem>
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
        <div className="flex items-center gap-3">
          <CardIcon>
            <Upload />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("importExport.import.title")}</CardTitle>
            <CardDescription>{t("importExport.import.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Étape 1 : fichier ── */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <StepBadge n={1} />
            <Label htmlFor="csv-file" className="text-sm font-semibold">
              {t("importExport.import.file")}
            </Label>
          </div>
          <div className="relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-muted/30 px-4 py-10 text-center transition-colors hover:bg-muted/50 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring">
            <div
              aria-hidden
              className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"
            >
              <FileSpreadsheet className="size-4" />
            </div>
            <p className="text-sm font-medium">{fileName ?? t("importExport.import.dropHint")}</p>
            <Input
              id="csv-file"
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
          </div>
          {rows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("importExport.import.parsed", { count: rows.length, file: fileName ?? "" })}
            </p>
          ) : null}
        </div>

        {rows.length > 0 ? (
          <>
            {/* ── Aperçu (5 premières lignes) ── */}
            <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
              <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    {headers.map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((row, i) => (
                    <TableRow key={i}>
                      {headers.map((h) => (
                        <TableCell key={h} className="max-w-40 truncate text-xs">
                          {row[h]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* ── Étape 2 : correspondance des colonnes ── */}
            <div className="border-t pt-4">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <StepBadge n={2} />
                {t("importExport.import.mapping")}
              </h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {FIELDS.map(mappingSelect)}
              </div>
            </div>

            {/* ── Étape 3 : valeurs par défaut ── */}
            <div className="border-t pt-4">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <StepBadge n={3} />
                {t("importExport.import.defaults")}
              </h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {defaultSelect(t("importExport.category"), categories, defaults.categoryId, (v) =>
                  setDefaults((d) => ({ ...d, categoryId: v })),
                )}
                {defaultSelect(t("importExport.source"), sources, defaults.sourceId, (v) =>
                  setDefaults((d) => ({ ...d, sourceId: v })),
                )}
                {defaultSelect(t("importExport.assignedTo"), users, defaults.assignedToId, (v) =>
                  setDefaults((d) => ({ ...d, assignedToId: v })),
                )}
              </div>
            </div>

            {/* ── Étape 4 : doublons ── */}
            <div className="border-t pt-4">
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <StepBadge n={4} />
                {t("importExport.import.dedupe")}
              </h4>
              <RadioGroup
                value={mode}
                onValueChange={(v) => setMode(v as "skip" | "update")}
                className="gap-2"
              >
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                  <RadioGroupItem value="skip" />
                  {t("importExport.import.modeSkip")}
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                  <RadioGroupItem value="update" />
                  {t("importExport.import.modeUpdate")}
                </label>
              </RadioGroup>
            </div>

          </>
        ) : null}

        {/* ── Résumé ── */}
        {result ? (
          <div className="grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
            {(
              [
                ["created", result.created, "bg-emerald-500/10", "text-emerald-700 dark:text-emerald-400"],
                ["updated", result.updated, "bg-primary/10", "text-primary"],
                ["skipped", result.skipped, "bg-muted/40", ""],
                ["invalid", result.invalid, "bg-destructive/10", "text-destructive"],
              ] as const
            ).map(([k, v, box, num]) => (
              <div key={k} className={cn("rounded-lg p-3 text-center", box)}>
                <p className={cn("text-2xl font-semibold tabular-nums", num)}>{v}</p>
                <p className="text-xs text-muted-foreground">{t(`importExport.import.result.${k}`)}</p>
              </div>
            ))}
          </div>
        ) : null}

        {/* ── Détail des lignes écartées ──
            Aucun rejet muet : chaque groupe dit pourquoi et propose une suite. */}
        {rejectedGroups.length > 0 ? (
          <div className="space-y-3 border-t pt-4">
            <div>
              <p className="text-sm font-medium">
                {t("importExport.import.issues.title", { count: rejected.length })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("importExport.import.issues.subtitle")}
              </p>
            </div>
            {rejectedGroups.map((group) => (
              <div key={group.reason} className="space-y-2 rounded-xl border p-3 shadow-xs">
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                      group.reason === "duplicate_in_db"
                        ? "bg-primary/10 text-primary"
                        : group.reason === "duplicate_in_file"
                          ? "bg-muted text-muted-foreground"
                          : "bg-destructive/10 text-destructive",
                    )}
                  >
                    {group.reason === "duplicate_in_db" || group.reason === "duplicate_in_file" ? (
                      <CopyIcon className="size-4" />
                    ) : (
                      <TriangleAlert className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {t(`importExport.import.issues.${group.reason}.title`)}
                      <span className="ml-1.5 tabular-nums text-muted-foreground">
                        ({group.items.length})
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(`importExport.import.issues.${group.reason}.why`)}
                    </p>
                    <p className="mt-1 text-xs">
                      <span className="font-medium">
                        {t("importExport.import.issues.suggestion")}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {t(`importExport.import.issues.${group.reason}.what`)}
                      </span>
                    </p>
                  </div>
                </div>

                {/* Correction sur place : le numéro se répare ici, pas dans
                    Excel. Chaque ligne garde son n° pour être retrouvée. */}
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {group.items.map((r) => (
                    <li
                      key={`${r.rowIndex}-${r.reason}`}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {t("importExport.import.issues.line", { line: r.csvLine })}
                        </span>
                        {r.name ? ` · ${r.name}` : ""}
                      </span>
                      <Input
                        value={fixes[r.rowIndex] ?? r.phone ?? ""}
                        onChange={(e) =>
                          setFixes((prev) => ({ ...prev, [r.rowIndex]: e.target.value }))
                        }
                        placeholder={t("importExport.import.issues.phonePlaceholder")}
                        aria-label={t("importExport.import.issues.phoneLabel", {
                          line: r.csvLine,
                        })}
                        inputMode="tel"
                        className="min-h-11 w-44 text-xs md:min-h-8"
                      />
                      {r.existingId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-11 md:min-h-8"
                          render={<Link href={`/clients/${r.existingId}`} target="_blank" />}
                        >
                          {t("importExport.import.issues.openClient")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap gap-2">
                  {group.reason === "duplicate_in_db" ? (
                    <Button
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      disabled={progress !== null}
                      onClick={() => void updateGroup(group)}
                    >
                      {fixing === group.reason ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      {t("importExport.import.issues.updateExisting")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={group.reason === "duplicate_in_db" ? "outline" : "default"}
                    className="min-h-11 md:min-h-8"
                    disabled={
                      progress !== null ||
                      !group.items.some(
                        (r) =>
                          (fixes[r.rowIndex] ?? "").trim() !== "" && fixes[r.rowIndex] !== r.phone,
                      )
                    }
                    onClick={() => void retryFixed(group)}
                  >
                    {fixing === group.reason ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    {t("importExport.import.issues.retryFixed")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
      {rows.length > 0 ? (
        <CardFooter className="flex-wrap gap-3">
          <Button
            onClick={() => void runImport()}
            disabled={progress !== null || !mapping.phone}
            className="min-h-11 md:min-h-8"
          >
            {progress !== null ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t("importExport.import.run", { count: rows.length })}
          </Button>
          {progress !== null ? (
            <div className="min-w-40 flex-1 space-y-1">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground tabular-nums">{progress} %</p>
            </div>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────

export function ExportCard({
  categories,
  sources,
  users,
}: {
  categories: OptionDto[];
  sources: OptionDto[];
  users: OptionDto[];
}) {
  const t = useTranslations("admin");
  const [filters, setFilters] = useState({
    categoryId: null as string | null,
    sourceId: null as string | null,
    assignedToId: null as string | null,
    from: "",
    to: "",
  });

  const filterSelect = (
    label: string,
    options: OptionDto[],
    value: string | null,
    onChange: (v: string | null) => void,
  ) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select
        items={[{ value: null as unknown as string, label: t("importExport.all") }, ...options]}
        value={value}
        onValueChange={(v) => onChange(v === null ? null : String(v))}
      >
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder={t("importExport.all")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={null}>{t("importExport.all")}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const download = () => {
    const qs = new URLSearchParams();
    if (filters.categoryId) qs.set("categoryId", filters.categoryId);
    if (filters.sourceId) qs.set("sourceId", filters.sourceId);
    if (filters.assignedToId) qs.set("assignedToId", filters.assignedToId);
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    // Téléchargement direct du CSV (route API, pas une page Next).
    const a = document.createElement("a");
    a.href = `/api/admin/export?${qs.toString()}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <FileSpreadsheet />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("importExport.export.title")}</CardTitle>
            <CardDescription>{t("importExport.export.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {filterSelect(t("importExport.category"), categories, filters.categoryId, (v) =>
            setFilters((f) => ({ ...f, categoryId: v })),
          )}
          {filterSelect(t("importExport.source"), sources, filters.sourceId, (v) =>
            setFilters((f) => ({ ...f, sourceId: v })),
          )}
          {filterSelect(t("importExport.assignedTo"), users, filters.assignedToId, (v) =>
            setFilters((f) => ({ ...f, assignedToId: v })),
          )}
          <div className="space-y-1">
            <Label htmlFor="export-from" className="text-xs">
              {t("importExport.export.from")}
            </Label>
            <Input
              id="export-from"
              type="date"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="export-to" className="text-xs">
              {t("importExport.export.to")}
            </Label>
            <Input
              id="export-to"
              type="date"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex-wrap gap-x-4 gap-y-2">
        <Button onClick={download} className="min-h-11 md:min-h-8">
          <Download className="size-4" />
          {t("importExport.export.run")}
        </Button>
        <p className="min-w-56 flex-1 text-xs text-muted-foreground">{t("importExport.export.note")}</p>
      </CardFooter>
    </Card>
  );
}
