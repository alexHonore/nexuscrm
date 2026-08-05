"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import { KeyRound, Loader2, Phone, Plus, RefreshCw, Trash2, UserRound } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPhone } from "@/lib/phone";
import { api, ApiError } from "./api";
import { OneTimeSecret } from "./copy-button";
import type { AdminUserDto } from "./types";

const TZ = "America/Toronto";

function useDateFmt() {
  const locale = useLocale();
  return (iso: string | null, pattern = "d MMM yyyy, HH:mm") =>
    iso ? formatInTimeZone(new Date(iso), TZ, pattern, { locale: locale === "fr" ? fr : enCA }) : null;
}

type Tr = ReturnType<typeof useTranslations>;

function errorMessage(t: Tr, err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code;
    const known = [
      "email_taken",
      "cannot_deactivate_self",
      "cannot_demote_self",
      "cannot_delete_self",
      "invalid_did",
      "has_activity",
    ];
    if (known.includes(code)) return t(`users.errors.${code}`);
    if (code === "voipms") {
      const msg = typeof err.data.message === "string" ? err.data.message : String(err.data.status ?? "");
      return `${t("users.voip.apiError")} : ${msg}`;
    }
    if (typeof err.data.message === "string") return err.data.message;
  }
  return t("genericError");
}

// ─────────────────────────────────────────────────────────────────────────────

export function UsersClient({
  initialUsers,
  currentUserId,
}: {
  initialUsers: AdminUserDto[];
  currentUserId: string;
}) {
  const t = useTranslations("admin");
  const fmt = useDateFmt();
  const [users, setUsers] = useState(initialUsers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = users.find((u) => u.id === editingId) ?? null;

  const upsert = (u: AdminUserDto) =>
    setUsers((prev) => {
      const i = prev.findIndex((p) => p.id === u.id);
      if (i === -1) return [...prev, u];
      const next = [...prev];
      next[i] = u;
      return next;
    });

  const toggleActive = async (u: AdminUserDto, isActive: boolean) => {
    try {
      const res = await api<{ user: AdminUserDto }>(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
      upsert(res.user);
      toast.success(isActive ? t("users.activated") : t("users.deactivated"));
    } catch (err) {
      toast.error(errorMessage(t, err));
    }
  };

  const roleBadge = (u: AdminUserDto) =>
    u.role === "admin" ? (
      <Badge>{t("users.roleAdmin")}</Badge>
    ) : (
      <Badge variant="secondary">{t("users.roleCaller")}</Badge>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("users.subtitle")}</p>
        <CreateUserDialog onCreated={upsert} />
      </div>

      {/* ── Tableau (desktop) ── */}
      <div className="hidden overflow-hidden rounded-xl ring-1 ring-foreground/10 md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("users.name")}</TableHead>
              <TableHead>{t("users.role")}</TableHead>
              <TableHead>{t("users.active")}</TableHead>
              <TableHead>{t("users.did")}</TableHead>
              <TableHead>{t("users.sipUser")}</TableHead>
              <TableHead>{t("users.lastLogin")}</TableHead>
              <TableHead>{t("users.locale")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {u.name}
                      {u.id === currentUserId ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">({t("users.you")})</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                </TableCell>
                <TableCell>{roleBadge(u)}</TableCell>
                <TableCell>
                  <Switch
                    checked={u.isActive}
                    disabled={u.id === currentUserId}
                    onCheckedChange={(checked) => void toggleActive(u, checked)}
                    aria-label={t("users.active")}
                  />
                </TableCell>
                <TableCell className="text-sm">{u.didNumber ? formatPhone(u.didNumber) : "—"}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-xs">{u.sipUsername ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {fmt(u.lastLoginAt) ?? t("users.neverLogged")}
                </TableCell>
                <TableCell className="text-sm uppercase">{u.locale}</TableCell>
                <TableCell className="text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditingId(u.id)}>
                    {t("edit")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        {users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => setEditingId(u.id)}
            className="w-full rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors active:bg-muted"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {u.name}
                  {u.id === currentUserId ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">({t("users.you")})</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">{u.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {roleBadge(u)}
                {!u.isActive ? <Badge variant="destructive">{t("users.inactive")}</Badge> : null}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Phone className="size-3" />
                {u.didNumber ? formatPhone(u.didNumber) : "—"}
              </span>
              <span className="truncate font-mono">{u.sipUsername ?? "—"}</span>
              <span className="col-span-2">
                {t("users.lastLogin")} : {fmt(u.lastLoginAt) ?? t("users.neverLogged")}
              </span>
            </div>
          </button>
        ))}
      </div>

      <UserEditSheet
        key={editingId ?? "none"}
        user={editing}
        currentUserId={currentUserId}
        onClose={() => setEditingId(null)}
        onUpdated={upsert}
        onDeleted={(id) => {
          setUsers((prev) => prev.filter((p) => p.id !== id));
          setEditingId(null);
        }}
      />
    </div>
  );
}

// ── Création ─────────────────────────────────────────────────────────────────

function CreateUserDialog({ onCreated }: { onCreated: (u: AdminUserDto) => void }) {
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "caller", locale: "fr" });
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const reset = () => {
    setForm({ name: "", email: "", role: "caller", locale: "fr" });
    setTempPassword(null);
  };

  const submit = async () => {
    setPending(true);
    try {
      const res = await api<{ user: AdminUserDto; tempPassword: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(form),
      });
      onCreated(res.user);
      setTempPassword(res.tempPassword);
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("users.create")}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tempPassword ? t("users.tempPasswordTitle") : t("users.createTitle")}</DialogTitle>
          <DialogDescription>
            {tempPassword ? t("users.tempPasswordHint") : t("users.createDesc")}
          </DialogDescription>
        </DialogHeader>

        {tempPassword ? (
          <>
            <OneTimeSecret value={tempPassword} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>{t("close")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-user-name">{t("users.name")}</Label>
                <Input
                  id="new-user-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-user-email">{t("users.email")}</Label>
                <Input
                  id="new-user-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("users.role")}</Label>
                  <Select
                    items={[
                      { value: "caller", label: t("users.roleCaller") },
                      { value: "admin", label: t("users.roleAdmin") },
                    ]}
                    value={form.role}
                    onValueChange={(v) => setForm({ ...form, role: String(v) })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="caller">{t("users.roleCaller")}</SelectItem>
                      <SelectItem value="admin">{t("users.roleAdmin")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("users.locale")}</Label>
                  <Select
                    items={[
                      { value: "fr", label: t("users.localeFr") },
                      { value: "en", label: t("users.localeEn") },
                    ]}
                    value={form.locale}
                    onValueChange={(v) => setForm({ ...form, locale: String(v) })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fr">{t("users.localeFr")}</SelectItem>
                      <SelectItem value="en">{t("users.localeEn")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button onClick={() => void submit()} disabled={pending || !form.name || !form.email}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <UserRound className="size-4" />}
                {t("users.create")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Édition ──────────────────────────────────────────────────────────────────

type VoipSubAccount = { id: string; account: string; username: string; description: string };
type VoipDid = { did: string; description: string; routing: string; state: string };

function UserEditSheet({
  user,
  currentUserId,
  onClose,
  onUpdated,
  onDeleted,
}: {
  user: AdminUserDto | null;
  currentUserId: string;
  onClose: () => void;
  onUpdated: (u: AdminUserDto) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("admin");
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState(() => ({
    name: user?.name ?? "",
    email: user?.email ?? "",
    role: user?.role ?? "caller",
    locale: user?.locale ?? "fr",
    sipUsername: user?.sipUsername ?? "",
    sipPassword: "",
    didNumber: user?.didNumber ?? "",
  }));
  const [secret, setSecret] = useState<{ title: string; value: string; hint?: string } | null>(null);

  // voip.ms pickers
  const [subaccounts, setSubaccounts] = useState<VoipSubAccount[] | null>(null);
  const [dids, setDids] = useState<VoipDid[] | null>(null);
  const [voipLoading, setVoipLoading] = useState<string | null>(null);
  const [subUsername, setSubUsername] = useState("");
  const [createSubOpen, setCreateSubOpen] = useState(false);

  if (!user) return null;
  const isSelf = user.id === currentUserId;

  const patch = async (payload: Record<string, unknown>, successMsg?: string) => {
    setPending(true);
    try {
      const res = await api<{ user: AdminUserDto }>(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      onUpdated(res.user);
      toast.success(successMsg ?? t("saved"));
      return true;
    } catch (err) {
      toast.error(errorMessage(t, err));
      return false;
    } finally {
      setPending(false);
    }
  };

  const saveAll = async () => {
    const ok = await patch({
      name: form.name,
      email: form.email,
      role: form.role,
      locale: form.locale,
      sipUsername: form.sipUsername || null,
      ...(form.sipPassword ? { sipPassword: form.sipPassword } : {}),
      didNumber: form.didNumber || null,
    });
    if (ok) setForm((f) => ({ ...f, sipPassword: "" }));
  };

  const resetPassword = async () => {
    setPending(true);
    try {
      const res = await api<{ tempPassword: string }>(`/api/admin/users/${user.id}/reset-password`, {
        method: "POST",
      });
      setSecret({ title: t("users.newTempPassword"), value: res.tempPassword });
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  };

  const loadSubaccounts = async () => {
    setVoipLoading("subaccounts");
    try {
      const res = await api<{ accounts: VoipSubAccount[] }>("/api/admin/voipms/subaccounts");
      setSubaccounts(res.accounts);
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  const loadDids = async () => {
    setVoipLoading("dids");
    try {
      const res = await api<{ dids: VoipDid[] }>("/api/admin/voipms/dids");
      setDids(res.dids);
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  const createSubaccount = async () => {
    setVoipLoading("create");
    try {
      const res = await api<{ account: string; password: string }>("/api/admin/voipms/subaccounts", {
        method: "POST",
        body: JSON.stringify({ userId: user.id, username: subUsername }),
      });
      setForm((f) => ({ ...f, sipUsername: res.account }));
      onUpdated({ ...user, sipUsername: res.account, hasSipPassword: true });
      setCreateSubOpen(false);
      setSecret({
        title: t("users.voip.sipPasswordCreated"),
        value: res.password,
        hint: t("users.voip.sipPasswordSavedHint"),
      });
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  const routeDid = async () => {
    setVoipLoading("route");
    try {
      const res = await api<{ ok: boolean; did: string }>("/api/admin/voipms/route-did", {
        method: "POST",
        body: JSON.stringify({ did: form.didNumber, account: form.sipUsername, userId: user.id }),
      });
      setForm((f) => ({ ...f, didNumber: res.did }));
      onUpdated({ ...user, didNumber: res.did });
      toast.success(t("users.voip.routed"));
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  const suggestedUsername = () => {
    const first = (user.name.split(/\s+/)[0] ?? "agent")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
    return `551013_${first || "agent"}`;
  };

  return (
    <Sheet open={Boolean(user)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("users.editTitle", { name: user.name })}</SheetTitle>
          <SheetDescription>{user.email}</SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8">
          {/* ── Identité ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t("users.identity")}</h3>
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">{t("users.name")}</Label>
              <Input
                id="edit-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">{t("users.email")}</Label>
              <Input
                id="edit-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("users.role")}</Label>
                <Select
                  items={[
                    { value: "caller", label: t("users.roleCaller") },
                    { value: "admin", label: t("users.roleAdmin") },
                  ]}
                  value={form.role}
                  onValueChange={(v) => setForm({ ...form, role: v as "admin" | "caller" })}
                  disabled={isSelf}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="caller">{t("users.roleCaller")}</SelectItem>
                    <SelectItem value="admin">{t("users.roleAdmin")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("users.locale")}</Label>
                <Select
                  items={[
                    { value: "fr", label: t("users.localeFr") },
                    { value: "en", label: t("users.localeEn") },
                  ]}
                  value={form.locale}
                  onValueChange={(v) => setForm({ ...form, locale: v as "fr" | "en" })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fr">{t("users.localeFr")}</SelectItem>
                    <SelectItem value="en">{t("users.localeEn")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── VoIP ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t("users.voip.title")}</h3>
            <p className="text-xs text-muted-foreground">{t("users.voip.desc")}</p>

            <div className="space-y-1.5">
              <Label htmlFor="edit-sip-user">{t("users.voip.sipUsername")}</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-sip-user"
                  className="font-mono"
                  value={form.sipUsername}
                  onChange={(e) => setForm({ ...form, sipUsername: e.target.value })}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-8 shrink-0"
                  onClick={() => void loadSubaccounts()}
                  disabled={voipLoading !== null}
                >
                  {voipLoading === "subaccounts" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("users.voip.listSubaccounts")}
                </Button>
              </div>
              {subaccounts !== null ? (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                  {subaccounts.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">{t("users.voip.noSubaccounts")}</p>
                  ) : (
                    subaccounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setForm((f) => ({ ...f, sipUsername: a.account }));
                          setSubaccounts(null);
                        }}
                      >
                        <span className="font-mono text-xs">{a.account}</span>
                        <span className="truncate text-xs text-muted-foreground">{a.description}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-8"
                onClick={() => {
                  setSubUsername(suggestedUsername());
                  setCreateSubOpen(true);
                }}
              >
                <Plus className="size-4" />
                {t("users.voip.createSubaccount")}
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-sip-pass">{t("users.voip.sipPassword")}</Label>
              <Input
                id="edit-sip-pass"
                type="password"
                value={form.sipPassword}
                onChange={(e) => setForm({ ...form, sipPassword: e.target.value })}
                placeholder={user.hasSipPassword ? t("users.voip.sipPasswordSet") : ""}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">{t("users.voip.sipPasswordHint")}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="edit-did">{t("users.voip.didNumber")}</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-did"
                  value={form.didNumber}
                  onChange={(e) => setForm({ ...form, didNumber: e.target.value })}
                  placeholder="+14184761542"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-8 shrink-0"
                  onClick={() => void loadDids()}
                  disabled={voipLoading !== null}
                >
                  {voipLoading === "dids" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("users.voip.listDids")}
                </Button>
              </div>
              {dids !== null ? (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                  {dids.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">{t("users.voip.noDids")}</p>
                  ) : (
                    dids.map((d) => (
                      <button
                        key={d.did}
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setForm((f) => ({ ...f, didNumber: `+1${d.did.replace(/\D/g, "").slice(-10)}` }));
                          setDids(null);
                        }}
                      >
                        <span className="font-mono text-xs">{formatPhone(`+1${d.did.replace(/\D/g, "").slice(-10)}`)}</span>
                        <span className="truncate text-xs text-muted-foreground">{d.routing}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-8"
                onClick={() => void routeDid()}
                disabled={!form.didNumber || !form.sipUsername || voipLoading !== null}
              >
                {voipLoading === "route" ? <Loader2 className="size-4 animate-spin" /> : <Phone className="size-4" />}
                {t("users.voip.routeDid")}
              </Button>
            </div>
          </section>

          <Separator />

          {/* ── Sécurité / danger ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t("users.security")}</h3>
            <div className="flex flex-wrap gap-2">
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="outline" size="sm" className="min-h-11 md:min-h-8" />}>
                  <KeyRound className="size-4" />
                  {t("users.resetPassword")}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("users.resetPasswordConfirmTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("users.resetPasswordConfirmDesc", { name: user.name })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void resetPassword()}>
                      {t("users.resetPassword")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {!isSelf ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-8"
                  disabled={pending}
                  onClick={() => void patch({ isActive: !user.isActive })}
                >
                  {user.isActive ? t("users.deactivate") : t("users.activate")}
                </Button>
              ) : null}

              {!isSelf ? (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="destructive" size="sm" className="min-h-11 md:min-h-8" />}>
                    <Trash2 className="size-4" />
                    {t("delete")}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("users.deleteTitle", { name: user.name })}</AlertDialogTitle>
                      <AlertDialogDescription>{t("users.deleteDesc")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={async () => {
                          try {
                            await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
                            toast.success(t("users.deleted"));
                            onDeleted(user.id);
                          } catch (err) {
                            toast.error(errorMessage(t, err));
                          }
                        }}
                      >
                        {t("users.deleteConfirm")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </section>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} className="min-h-11 md:min-h-8">
              {t("cancel")}
            </Button>
            <Button onClick={() => void saveAll()} disabled={pending} className="min-h-11 md:min-h-8">
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </div>
        </div>

        {/* ── Dialog : création de sous-compte voip.ms ── */}
        <Dialog open={createSubOpen} onOpenChange={setCreateSubOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("users.voip.createSubaccountTitle")}</DialogTitle>
              <DialogDescription>{t("users.voip.createSubaccountDesc")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="sub-username">{t("users.voip.usernameLabel")}</Label>
              <Input
                id="sub-username"
                className="font-mono"
                value={subUsername}
                onChange={(e) => setSubUsername(e.target.value)}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateSubOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                onClick={() => void createSubaccount()}
                disabled={voipLoading !== null || !/^[A-Za-z0-9_]{2,32}$/.test(subUsername)}
              >
                {voipLoading === "create" ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("users.voip.createSubaccount")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Dialog : secret affiché une seule fois ── */}
        <Dialog open={secret !== null} onOpenChange={(o) => (!o ? setSecret(null) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{secret?.title}</DialogTitle>
            </DialogHeader>
            {secret ? <OneTimeSecret value={secret.value} hint={secret.hint} /> : null}
            <DialogFooter>
              <Button onClick={() => setSecret(null)}>{t("close")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

// ── Mot de passe de l'admin connecté ────────────────────────────────────────

export function OwnPasswordCard() {
  const t = useTranslations("admin");
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (form.next.length < 8) {
      toast.error(t("ownPassword.tooShort"));
      return;
    }
    if (form.next !== form.confirm) {
      toast.error(t("ownPassword.mismatch"));
      return;
    }
    setPending(true);
    try {
      await api("/api/admin/password", {
        method: "POST",
        body: JSON.stringify({ current: form.current, next: form.next }),
      });
      toast.success(t("ownPassword.success"));
      setForm({ current: "", next: "", confirm: "" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "wrong_password") {
        toast.error(t("ownPassword.wrong"));
      } else {
        toast.error(errorMessage(t, err));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 className="font-heading text-base font-medium">{t("ownPassword.title")}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{t("ownPassword.desc")}</p>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="own-current">{t("ownPassword.current")}</Label>
          <Input
            id="own-current"
            type="password"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
            autoComplete="current-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="own-next">{t("ownPassword.new")}</Label>
          <Input
            id="own-next"
            type="password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="own-confirm">{t("ownPassword.confirm")}</Label>
          <Input
            id="own-confirm"
            type="password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            autoComplete="new-password"
          />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={pending || !form.current || !form.next} className="min-h-11 md:min-h-8">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("ownPassword.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
