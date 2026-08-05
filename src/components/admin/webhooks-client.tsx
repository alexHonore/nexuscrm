"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import { Eye, EyeOff, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { api } from "./api";
import { CopyButton, OneTimeSecret } from "./copy-button";
import type { OptionDto, WebhookDefaults, WebhookKeyDto } from "./types";

const TZ = "America/Toronto";

export function WebhookKeysCard({
  initialKeys,
  categories,
  sources,
  users,
}: {
  initialKeys: WebhookKeyDto[];
  categories: OptionDto[];
  sources: OptionDto[];
  users: OptionDto[];
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [keys, setKeys] = useState(initialKeys);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookKeyDto | null>(null);

  const fmt = (iso: string | null) =>
    iso
      ? formatInTimeZone(new Date(iso), TZ, "d MMM yyyy, HH:mm", { locale: locale === "fr" ? fr : enCA })
      : t("webhooks.neverUsed");

  const patchKey = async (id: number, payload: Record<string, unknown>) => {
    try {
      const res = await api<{ key: WebhookKeyDto }>(`/api/admin/webhook-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, ...res.key } : k)));
      toast.success(t("saved"));
    } catch {
      toast.error(t("genericError"));
    }
  };

  const reveal = async (id: number) => {
    if (revealed[id]) {
      setRevealed((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const res = await api<{ key: string }>(`/api/admin/webhook-keys/${id}/reveal`, { method: "POST" });
      setRevealed((r) => ({ ...r, [id]: res.key }));
    } catch {
      toast.error(t("genericError"));
    }
  };

  const defaultsSelect = (
    key: WebhookKeyDto,
    field: keyof WebhookDefaults,
    options: OptionDto[],
    label: string,
  ) => {
    const current = key.defaults?.[field];
    const value = current == null ? null : String(current);
    return (
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <Select
          items={[{ value: null as unknown as string, label: "—" }, ...options]}
          value={value}
          onValueChange={(v) => {
            const parsed =
              v === null ? null : field === "assignedToId" ? String(v) : Number(v);
            void patchKey(key.id, { defaults: { ...key.defaults, [field]: parsed } });
          }}
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
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" />
          {t("webhooks.keys.title")}
        </CardTitle>
        <CardDescription>{t("webhooks.keys.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("webhooks.keys.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {keys.map((k) => (
              <li key={k.id} className="space-y-3 rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-medium">{k.name}</p>
                    {!k.isActive ? <Badge variant="destructive">{t("webhooks.keys.inactive")}</Badge> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={k.isActive}
                      onCheckedChange={(checked) => void patchKey(k.id, { isActive: checked })}
                      aria-label={t("webhooks.keys.active")}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 text-destructive md:size-7"
                      onClick={() => setDeleting(k)}
                      aria-label={t("delete")}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
                    {revealed[k.id] ?? `••••••••${k.keyLast4}`}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 md:size-7"
                    onClick={() => void reveal(k.id)}
                    aria-label={revealed[k.id] ? t("webhooks.keys.hide") : t("webhooks.keys.reveal")}
                  >
                    {revealed[k.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                  {revealed[k.id] ? <CopyButton value={revealed[k.id]} label={t("copy")} size="xs" /> : null}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {defaultsSelect(k, "categoryId", categories, t("webhooks.keys.defaultCategory"))}
                  {defaultsSelect(k, "sourceId", sources, t("webhooks.keys.defaultSource"))}
                  {defaultsSelect(k, "assignedToId", users, t("webhooks.keys.defaultAssignee"))}
                </div>

                <p className="text-xs text-muted-foreground">
                  {t("webhooks.keys.lastUsed")} : {fmt(k.lastUsedAt)}
                </p>
              </li>
            ))}
          </ul>
        )}

        <Button onClick={() => setCreateOpen(true)} className="min-h-11 md:min-h-8">
          <Plus className="size-4" />
          {t("webhooks.keys.create")}
        </Button>
      </CardContent>

      {/* ── Création ── */}
      <CreateKeyDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setNewKey(null);
        }}
        newKey={newKey}
        onCreated={(dto, plainKey) => {
          setKeys((prev) => [...prev, dto]);
          setNewKey(plainKey);
        }}
      />

      {/* ── Suppression ── */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("webhooks.keys.deleteTitle", { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("webhooks.keys.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (!deleting) return;
                try {
                  await api(`/api/admin/webhook-keys/${deleting.id}`, { method: "DELETE" });
                  setKeys((prev) => prev.filter((k) => k.id !== deleting.id));
                  toast.success(t("webhooks.keys.deleted"));
                } catch {
                  toast.error(t("genericError"));
                } finally {
                  setDeleting(null);
                }
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
  newKey,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (dto: WebhookKeyDto, plainKey: string) => void;
  newKey: string | null;
}) {
  const t = useTranslations("admin");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    try {
      const res = await api<{ id: number; name: string; keyLast4: string; key: string }>(
        "/api/admin/webhook-keys",
        { method: "POST", body: JSON.stringify({ name, defaults: {} }) },
      );
      onCreated(
        {
          id: res.id,
          name: res.name,
          keyLast4: res.keyLast4,
          defaults: {},
          isActive: true,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
        },
        res.key,
      );
      setName("");
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{newKey ? t("webhooks.keys.createdTitle") : t("webhooks.keys.createTitle")}</DialogTitle>
          <DialogDescription>
            {newKey ? t("webhooks.keys.createdDesc") : t("webhooks.keys.createDesc")}
          </DialogDescription>
        </DialogHeader>
        {newKey ? (
          <>
            <OneTimeSecret value={newKey} />
            <DialogFooter>
              <Button onClick={onClose}>{t("close")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="key-name">{t("webhooks.keys.name")}</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="n8n — Facebook Leads"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t("cancel")}
              </Button>
              <Button onClick={() => void submit()} disabled={pending || !name.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("webhooks.keys.create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
