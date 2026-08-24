"use client";

import { AlertTriangle, Loader2, Upload } from "lucide-react";
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
type Warning = { code: string; messageFr: string; path?: string };
type Preview = {
  bindings: Binding[];
  userChoices: { id: string; name: string; email: string; role: string }[];
  warnings: Warning[];
};

const UNBOUND = "__unbound__";

/**
 * Import d'un assistant, en deux temps.
 *
 * Le fichier est d'abord relu SANS rien écrire, pour montrer ce qu'il contient
 * et laisser choisir l'équivalent local de chaque référence. Un import direct
 * rattacherait les rendez-vous à des identifiants qui, ici, désignent quelqu'un
 * d'autre — ou personne.
 */
export function AssistantImportDialog({ trigger }: { trigger: React.ReactNode }) {
  const t = useTranslations("assistants");
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
   * puis prévisualisé. Fichier téléversé ou JSON collé, la suite est identique
   * — un seul chemin de diagnostic, un seul chemin d'erreur.
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
      const result = await api<Preview>("/api/assistants/import", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", bundle: parsed }),
      });
      setBundle(parsed);
      setPreview(result);
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
      const result = await api<{ assistantId: string }>("/api/assistants/import", {
        method: "POST",
        body: JSON.stringify({
          mode: "commit",
          bundle,
          resolution: Object.fromEntries(
            Object.entries(resolution).map(([k, v]) => [k, v === UNBOUND ? null : v]),
          ),
          // La suite appelle le modèle : on la laisse à l'écran d'édition pour
          // que l'import ne semble pas figé pendant plusieurs minutes.
          runSuite: false,
        }),
      });
      toast.success(t("import.done"));
      setOpen(false);
      reset();
      router.push(`/admin/assistants/${result.assistantId}`);
    } catch (err) {
      const raised = err instanceof ApiError ? (err.data.issues as ImportIssue[] | undefined) : undefined;
      if (raised?.length) setIssues(locateIssues(raised, source));
      else toast.error(t("import.invalid"));
    } finally {
      setBusy(false);
    }
  };

  /** Une liaison par valeur d'origine — le même courtier peut apparaître 3 fois. */
  const uniqueUserBindings = (preview?.bindings ?? [])
    .filter((b) => b.kind === "user" && b.sourceValue)
    .filter((b, i, all) => all.findIndex((o) => o.sourceValue === b.sourceValue) === i);

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
                <Label htmlFor="assistant-import-file">{t("import.pick")}</Label>
                <input
                  ref={fileRef}
                  id="assistant-import-file"
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
                <Label htmlFor="assistant-import-paste">{t("import.pasteLabel")}</Label>
                <Textarea
                  id="assistant-import-paste"
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
                href="/api/docs/examples/assistant"
                className="font-medium underline underline-offset-2"
                download
              >
                {t("import.downloadExample")}
              </a>
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {uniqueUserBindings.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t("import.bindings")}</h3>
                {uniqueUserBindings.map((binding) => (
                  <div key={binding.sourceValue} className="space-y-1.5">
                    <Label>
                      {binding.label || binding.path}
                      {binding.hint ? (
                        <span className="ml-1 font-normal text-muted-foreground">
                          · {binding.hint}
                        </span>
                      ) : null}
                    </Label>
                    <Select
                      items={[
                        { value: UNBOUND, label: t("import.unbound") },
                        ...preview.userChoices.map((u) => ({ value: u.id, label: u.name })),
                      ]}
                      value={resolution[binding.sourceValue!] ?? UNBOUND}
                      onValueChange={(v) =>
                        setResolution((r) => ({ ...r, [binding.sourceValue!]: String(v) }))
                      }
                    >
                      <SelectTrigger className="min-h-11 w-full md:min-h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNBOUND}>{t("import.unbound")}</SelectItem>
                        {preview.userChoices.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name} — {u.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
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
                      // texte du serveur sert de repli plutôt qu'un vide.
                      <li key={`${w.code}-${i}`}>
                        {t.has(`import.warning.${w.code}`)
                          ? t(`import.warning.${w.code}` as never)
                          : w.messageFr}
                        {w.path ? <span className="ml-1 font-mono text-xs">{w.path}</span> : null}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
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
