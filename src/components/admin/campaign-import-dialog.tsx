"use client";

import { AlertTriangle, CheckIcon, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  describeJsonSyntaxError,
  locateIssues,
  type ImportIssue,
  type JsonSyntaxProblem,
} from "@/lib/import-diagnostics";
import { ApiError, api } from "./api";
import { ImportIssues } from "./import-issues";

type Binding = { path: string; kind: string; sourceValue: string | null; label: string; hint: string };
type Warning = {
  code: string;
  messageFr: string;
  path?: string;
  params?: Record<string, string>;
};
type Catalog = {
  assistants: { id: string; name: string }[];
  smsNumbers: { id: string; e164: string; label: string }[];
  categories: { id: number; name: string }[];
  sources: { id: number; name: string }[];
  users: { id: string; name: string; email: string }[];
};
type Preview = {
  bindings: Binding[];
  resolved: Record<string, string | null>;
  catalog: Catalog;
  warnings: Warning[];
};

const UNBOUND = "__unbound__";

/**
 * Import d'une campagne, en deux temps : le fichier est relu SANS rien écrire,
 * les liaisons résolues automatiquement (par nom, courriel, E.164) sont
 * montrées telles quelles, et ce qui ne s'est pas résolu se choisit ici.
 */
export function CampaignImportDialog({ trigger }: { trigger: React.ReactNode }) {
  const t = useTranslations("campaigns");
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  // Deux façons d'apporter le même JSON : un fichier, ou un collage direct.
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [pasted, setPasted] = useState("");
  const [bundle, setBundle] = useState<unknown>(null);
  // Le TEXTE du fichier, gardé pour situer chaque objection à sa ligne :
  // le serveur voit la forme, lui seul voit la mise en page.
  const [source, setSource] = useState("");
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [syntax, setSyntax] = useState<JsonSyntaxProblem | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setBundle(null);
    setPreview(null);
    setResolution({});
    setSource("");
    setPasted("");
    setMode("file");
    setIssues([]);
    setSyntax(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  /**
   * Le cœur commun aux deux entrées : le texte JSON est relu SANS rien écrire,
   * les liaisons résolues automatiquement montrées telles quelles. Fichier
   * téléversé ou JSON collé, la suite est identique.
   */
  const ingest = async (text: string) => {
    setBusy(true);
    setIssues([]);
    setSyntax(null);
    setSource(text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // Pas même du JSON : ce n'est pas un problème de contenu, et le dire
      // évite de chercher un champ fautif qui n'existe pas.
      setSyntax(describeJsonSyntaxError(text, err));
      setBusy(false);
      return;
    }

    try {
      const result = await api<Preview>("/api/campaigns/import", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", bundle: parsed }),
      });
      setBundle(parsed);
      setPreview(result);
      // Les choix partent de la résolution automatique ; l'utilisateur ne
      // corrige que ce qui ne s'est pas trouvé tout seul.
      setResolution(
        Object.fromEntries(
          Object.entries(result.resolved).map(([k, v]) => [k, v ?? UNBOUND]),
        ),
      );
    } catch (err) {
      // Le serveur renvoie CHAQUE objection avec son chemin ; c'est ici qu'on
      // y ajoute la ligne, parce que le texte du fichier ne quitte pas le
      // navigateur.
      const raised = err instanceof ApiError ? (err.data.issues as ImportIssue[] | undefined) : undefined;
      if (raised?.length) setIssues(locateIssues(raised, text));
      else toast.error(t("import.invalid"));
      setBundle(null);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File) => {
    const text = await file.text();
    // Le champ est vidé TOUT DE SUITE : on lit le diagnostic, on corrige le
    // fichier, on le reprend — et un navigateur ne renvoie pas d'évènement
    // quand on rechoisit le même nom de fichier. Sans ça, la deuxième
    // tentative ne se passait tout simplement rien.
    if (fileRef.current) fileRef.current.value = "";
    await ingest(text);
  };

  const commit = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const result = await api<{ campaignId: string }>("/api/campaigns/import", {
        method: "POST",
        body: JSON.stringify({
          mode: "commit",
          bundle,
          resolution: Object.fromEntries(
            Object.entries(resolution).map(([k, v]) => [k, v === UNBOUND ? null : v]),
          ),
        }),
      });
      toast.success(t("import.done"));
      setOpen(false);
      reset();
      router.push(`/admin/campaigns/${result.campaignId}`);
    } catch (err) {
      const raised = err instanceof ApiError ? (err.data.issues as ImportIssue[] | undefined) : undefined;
      if (raised?.length) setIssues(locateIssues(raised, source));
      else toast.error(t("import.invalid"));
    } finally {
      setBusy(false);
    }
  };

  /** Choix locaux pour un genre de liaison. */
  const choicesFor = (kind: string): { value: string; label: string }[] => {
    const c = preview?.catalog;
    if (!c) return [];
    switch (kind) {
      case "assistant":
        return c.assistants.map((a) => ({ value: a.id, label: a.name }));
      case "sms_number":
        return c.smsNumbers.map((n) => ({ value: n.id, label: `${n.e164}${n.label ? ` — ${n.label}` : ""}` }));
      case "category":
        return c.categories.map((x) => ({ value: String(x.id), label: x.name }));
      case "source":
        return c.sources.map((x) => ({ value: String(x.id), label: x.name }));
      case "user":
        return c.users.map((u) => ({ value: u.id, label: `${u.name} — ${u.email}` }));
      default:
        return [];
    }
  };

  // Une ligne par valeur d'origine : la même catégorie peut apparaître dans
  // l'audience ET le déclencheur.
  const uniqueBindings = (preview?.bindings ?? []).filter(
    (b, i, all) => b.sourceValue && all.findIndex((o) => o.sourceValue === b.sourceValue) === i,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.bindingsNote")}</DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="space-y-3">
            {/* Deux entrées pour le même JSON : téléverser un fichier ou le
                coller. La bascule ne fait que changer le champ montré. */}
            <div className="grid grid-cols-2 gap-2" role="tablist">
              <Button
                type="button"
                variant={mode === "file" ? "default" : "outline"}
                size="sm"
                disabled={busy}
                aria-pressed={mode === "file"}
                onClick={() => setMode("file")}
              >
                {t("import.fromFile")}
              </Button>
              <Button
                type="button"
                variant={mode === "paste" ? "default" : "outline"}
                size="sm"
                disabled={busy}
                aria-pressed={mode === "paste"}
                onClick={() => setMode("paste")}
              >
                {t("import.fromPaste")}
              </Button>
            </div>

            {mode === "file" ? (
              <>
                <Label htmlFor="campaign-import-file">{t("import.pick")}</Label>
                <input
                  ref={fileRef}
                  id="campaign-import-file"
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void pick(file);
                  }}
                  className="block w-full min-h-11 rounded-md border border-input bg-transparent px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
                />
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="campaign-import-paste">{t("import.pasteLabel")}</Label>
                <Textarea
                  id="campaign-import-paste"
                  value={pasted}
                  disabled={busy}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={t("import.pastePlaceholder")}
                  className="min-h-40 font-mono text-xs"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || pasted.trim() === ""}
                  onClick={() => void ingest(pasted)}
                >
                  {busy ? <Loader2 className="animate-spin" /> : null} {t("import.analyze")}
                </Button>
              </div>
            )}

            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("import.importing")}
              </p>
            ) : null}

            {/* Un fichier rédigé à la main se corrige beaucoup plus vite à côté
                d'un vrai : c'est le même que celui de la documentation. */}
            <p className="text-xs text-muted-foreground">
              {t("import.needExample")}{" "}
              <a
                href="/api/docs/examples/campaign"
                className="font-medium underline underline-offset-2"
                download
              >
                {t("import.downloadExample")}
              </a>
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {uniqueBindings.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t("import.bindings")}</h3>
                {uniqueBindings.map((binding) => {
                  const key = binding.sourceValue!;
                  const auto = preview.resolved[key];
                  const items = [
                    { value: UNBOUND, label: t("import.unbound") },
                    ...choicesFor(binding.kind),
                  ];
                  return (
                    <div key={key} className="space-y-1.5">
                      <Label className="flex flex-wrap items-center gap-1">
                        <span>{binding.label || binding.path}</span>
                        <span className="font-normal text-muted-foreground">
                          · {t(`import.kind.${binding.kind}` as never)}
                          {binding.hint ? ` · ${binding.hint}` : ""}
                        </span>
                        {auto && resolution[key] === auto ? (
                          <span className="ml-auto flex items-center gap-1 text-xs font-normal text-emerald-600">
                            <CheckIcon className="size-3" /> {t("import.autoResolved")}
                          </span>
                        ) : null}
                      </Label>
                      <Select
                        items={items}
                        value={resolution[key] ?? UNBOUND}
                        onValueChange={(v) => setResolution((r) => ({ ...r, [key]: String(v) }))}
                      >
                        <SelectTrigger className="min-h-11 w-full md:min-h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {items.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {preview.warnings.length > 0 ? (
              <Alert>
                <AlertTriangle />
                <AlertDescription>
                  <p className="mb-1 font-medium">{t("import.warnings")}</p>
                  <ul className="list-disc space-y-1 pl-4">
                    {preview.warnings.map((w, i) => (
                      // Le code est traduit quand la clé existe ; sinon le
                      // texte du serveur sert de repli plutôt qu'un vide. Les
                      // paramètres portent QUELLE liaison a échoué : sans eux,
                      // quatre liaisons perdues donnent quatre lignes
                      // identiques et l'avertissement n'apprend plus rien.
                      <li key={`${w.code}-${i}`}>
                        {t.has(`import.warning.${w.code}`)
                          ? t(`import.warning.${w.code}` as never, (w.params ?? {}) as never)
                          : w.messageFr}
                        {w.path ? <span className="ml-1 font-mono text-xs">{w.path}</span> : null}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            <p className="text-xs text-muted-foreground">{t("import.draftNote")}</p>
          </div>
        )}

        {/* Hors des deux états : la prévisualisation ET l'écriture peuvent
            échouer, et le diagnostic se lit au même endroit dans les deux cas. */}
        <ImportIssues issues={issues} syntax={syntax} />

        <DialogFooter>
          {/* `setOpen(false)` NE passe pas par `onOpenChange` : sans le reset
              explicite, rouvrir le dialogue montrait l'erreur du fichier
              précédent au-dessus d'un sélecteur vide. */}
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            disabled={busy}
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => void commit()} disabled={busy || !preview}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />} {t("import.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
