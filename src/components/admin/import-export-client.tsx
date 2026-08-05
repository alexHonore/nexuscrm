"use client";

import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api } from "./api";
import type { OptionDto } from "./types";

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="size-4" />
          {t("importExport.import.title")}
        </CardTitle>
        <CardDescription>{t("importExport.import.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="csv-file">{t("importExport.import.file")}</Label>
          <Input
            id="csv-file"
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="h-11 py-2.5 md:h-8 md:py-1"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
        </div>

        {rows.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t("importExport.import.parsed", { count: rows.length, file: fileName ?? "" })}
            </p>

            {/* ── Aperçu (5 premières lignes) ── */}
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {headers.map((h) => (
                      <TableHead key={h} className="text-xs">
                        {h}
                      </TableHead>
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

            {/* ── Correspondance des colonnes ── */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("importExport.import.mapping")}</h4>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {FIELDS.map(mappingSelect)}
              </div>
            </div>

            {/* ── Valeurs par défaut ── */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("importExport.import.defaults")}</h4>
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

            {/* ── Doublons ── */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">{t("importExport.import.dedupe")}</h4>
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

            {progress !== null ? (
              <div className="space-y-1.5">
                <Progress value={progress} />
                <p className="text-xs text-muted-foreground">{progress} %</p>
              </div>
            ) : null}

            <Button
              onClick={() => void runImport()}
              disabled={progress !== null || !mapping.phone}
              className="min-h-11 md:min-h-8"
            >
              {progress !== null ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {t("importExport.import.run", { count: rows.length })}
            </Button>
          </>
        ) : null}

        {/* ── Résumé ── */}
        {result ? (
          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-4">
            {(
              [
                ["created", result.created],
                ["updated", result.updated],
                ["skipped", result.skipped],
                ["invalid", result.invalid],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="text-center">
                <p className="text-2xl font-semibold tabular-nums">{v}</p>
                <p className="text-xs text-muted-foreground">{t(`importExport.import.result.${k}`)}</p>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="size-4" />
          {t("importExport.export.title")}
        </CardTitle>
        <CardDescription>{t("importExport.export.desc")}</CardDescription>
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
        <Button onClick={download} className="min-h-11 md:min-h-8">
          <Download className="size-4" />
          {t("importExport.export.run")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("importExport.export.note")}</p>
      </CardContent>
    </Card>
  );
}
