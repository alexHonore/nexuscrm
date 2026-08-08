"use client";

import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
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
import { api } from "./api";
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

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

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

  const runImport = async () => {
    if (!mapping.phone) {
      toast.error(t("importExport.import.phoneRequired"));
      return;
    }
    setProgress(0);
    setResult(null);
    const totals: Counts = { created: 0, updated: 0, skipped: 0, invalid: 0 };
    const BATCH = 200;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const batchRows = rows.slice(i, i + BATCH).map((raw) => {
          const mapped: Record<string, string> = {};
          for (const field of FIELDS) {
            const header = mapping[field];
            if (header && raw[header] != null && String(raw[header]).trim() !== "") {
              mapped[field] = String(raw[header]).trim();
            }
          }
          return mapped;
        });
        const counts = await api<Counts>("/api/admin/import", {
          method: "POST",
          body: JSON.stringify({
            rows: batchRows,
            mode,
            batch: Math.floor(i / BATCH),
            defaults: {
              categoryId: defaults.categoryId ? Number(defaults.categoryId) : null,
              sourceId: defaults.sourceId ? Number(defaults.sourceId) : null,
              assignedToId: defaults.assignedToId || null,
            },
          }),
        });
        totals.created += counts.created;
        totals.updated += counts.updated;
        totals.skipped += counts.skipped;
        totals.invalid += counts.invalid;
        setProgress(Math.round(((i + batchRows.length) / rows.length) * 100));
      }
      setResult(totals);
      toast.success(t("importExport.import.done"));
    } catch {
      toast.error(t("genericError"));
    } finally {
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
