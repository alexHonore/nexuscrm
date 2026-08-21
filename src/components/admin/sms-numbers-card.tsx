"use client";

import { Loader2, Phone, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatPhone } from "@/lib/phone";
import type { AdminSmsNumbersView } from "@/lib/sms-server/numbers";
import { ApiError, api } from "./api";

const NONE = "__none__";

/**
 * Numéros SMS : l'écran qui manquait. Chaque ligne s'édite en place (libellé,
 * plafond, actif, assistant par défaut) ; un numéro s'ajoute à la main ou se
 * synchronise depuis le Messaging Service Twilio — et arrive alors INACTIF.
 */
export function SmsNumbersCard({
  initial,
  twilioConfigured,
}: {
  initial: AdminSmsNumbersView;
  twilioConfigured: boolean;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const reload = async () => {
    const fresh = await api<AdminSmsNumbersView>("/api/admin/sms-numbers");
    setView(fresh);
    router.refresh();
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    try {
      await api(`/api/admin/sms-numbers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(t("settings.numbers.saved"));
      await reload();
    } catch {
      toast.error(t("genericError"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/admin/sms-numbers/${id}`, { method: "DELETE" });
      toast.success(t("settings.numbers.deleted"));
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === "in_use" ? t("settings.numbers.inUse") : t("genericError"));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("new");
    try {
      await api("/api/admin/sms-numbers", {
        method: "POST",
        body: JSON.stringify({ e164: newNumber, label: newLabel.trim() || null }),
      });
      setNewNumber("");
      setNewLabel("");
      toast.success(t("settings.numbers.saved"));
      await reload();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      toast.error(
        code === "invalid_phone"
          ? t("settings.numbers.invalidPhone")
          : code === "already_exists"
            ? t("settings.numbers.exists")
            : t("genericError"),
      );
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    try {
      const res = await api<{ found: number; added: number }>("/api/admin/sms-numbers/sync", { method: "POST" });
      toast.success(t("settings.numbers.synced", { found: res.found, added: res.added }));
      await reload();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === "twilio_unconfigured"
          ? t("settings.numbers.syncUnconfigured")
          : t("genericError"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
            <Phone />
          </span>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.numbers.title")}</CardTitle>
            <CardDescription>{t("settings.numbers.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.numbers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.numbers.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {view.numbers.map((n) => (
              <NumberRow
                key={n.id}
                number={n}
                assistants={view.assistants}
                busy={busy === n.id}
                onPatch={(body) => void patch(n.id, body)}
                onDelete={() => void remove(n.id)}
              />
            ))}
          </ul>
        )}

        <div className="grid gap-2 rounded-lg border border-dashed p-3 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="new-sms-number">{t("settings.numbers.add")}</Label>
            <Input
              id="new-sms-number"
              className="min-h-11 md:min-h-9"
              inputMode="tel"
              placeholder={t("settings.numbers.addPlaceholder")}
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-sms-label">{t("settings.numbers.label")}</Label>
            <Input
              id="new-sms-label"
              className="min-h-11 md:min-h-9"
              maxLength={80}
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <Button
            className="min-h-11 self-end md:min-h-9"
            disabled={busy !== null || newNumber.trim() === ""}
            onClick={() => void create()}
          >
            {busy === "new" ? <Loader2 className="size-4 animate-spin" /> : <Plus />} {t("settings.numbers.create")}
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          className="min-h-11 md:min-h-8"
          disabled={busy !== null || !twilioConfigured}
          onClick={() => void sync()}
        >
          {busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("settings.numbers.sync")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function NumberRow({
  number,
  assistants,
  busy,
  onPatch,
  onDelete,
}: {
  number: AdminSmsNumbersView["numbers"][number];
  assistants: AdminSmsNumbersView["assistants"];
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("admin");
  const [label, setLabel] = useState(number.label ?? "");
  const [cap, setCap] = useState(String(number.dailyCap));
  const dirty = label !== (number.label ?? "") || Number(cap) !== number.dailyCap;

  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{formatPhone(number.e164)}</span>
        <Badge variant={number.active ? "default" : "secondary"}>
          {t("settings.numbers.active")}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {t("settings.numbers.threads", { count: number.conversationCount })}
        </span>
        <span className="flex-1" />
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
          <Switch
            checked={number.active}
            disabled={busy}
            aria-label={t("settings.numbers.active")}
            onCheckedChange={(next) => onPatch({ active: next })}
          />
        </label>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 text-destructive md:size-8"
          disabled={busy || number.conversationCount > 0}
          aria-label={t("settings.numbers.delete")}
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem_1fr_auto]">
        <div className="space-y-1.5">
          <Label htmlFor={`label-${number.id}`}>{t("settings.numbers.label")}</Label>
          <Input
            id={`label-${number.id}`}
            className="min-h-11 md:min-h-8"
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`cap-${number.id}`}>{t("settings.numbers.cap")}</Label>
          <Input
            id={`cap-${number.id}`}
            className="min-h-11 md:min-h-8"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("settings.numbers.defaultAssistant")}</Label>
          <Select
            items={[
              { value: NONE, label: t("settings.numbers.noAssistant") },
              ...assistants.map((a) => ({ value: a.id, label: a.name })),
            ]}
            value={number.defaultAssistantId ?? NONE}
            disabled={busy}
            onValueChange={(v) => onPatch({ defaultAssistantId: v === NONE ? null : String(v) })}
          >
            <SelectTrigger className="min-h-11 w-full md:min-h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("settings.numbers.noAssistant")}</SelectItem>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("settings.numbers.defaultAssistantHint")}</p>
        </div>
        <Button
          variant="outline"
          className="min-h-11 self-end md:min-h-8"
          disabled={busy || !dirty || Number(cap) < 1}
          onClick={() => onPatch({ label: label.trim() || null, dailyCap: Number(cap) })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("settings.numbers.save")}
        </Button>
      </div>
      {number.messagingServiceSid ? (
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {t("settings.numbers.service")} : {number.messagingServiceSid}
        </p>
      ) : null}
    </li>
  );
}
