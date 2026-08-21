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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "./api";

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
  const [bundle, setBundle] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setBundle(null);
    setPreview(null);
    setResolution({});
    if (fileRef.current) fileRef.current.value = "";
  };

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await api<Preview>("/api/assistants/import", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", bundle: parsed }),
      });
      setBundle(parsed);
      setPreview(result);
    } catch {
      toast.error(t("import.invalid"));
      reset();
    } finally {
      setBusy(false);
    }
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
    } catch {
      toast.error(t("import.invalid"));
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
            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("import.importing")}
              </p>
            ) : null}
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
                      <li key={`${w.code}-${i}`}>{w.messageFr}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
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
