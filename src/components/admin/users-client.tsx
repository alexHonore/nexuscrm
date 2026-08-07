"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import {
  Check,
  KeyRound,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { api, ApiError } from "./api";
import { LoginCredentials, OneTimeSecret } from "./copy-button";
import type { AdminUserDto } from "./types";

const TZ = "America/Toronto";

// ── Détection de fautes de frappe dans les courriels ──────────────────────────

/**
 * Domaines mal orthographiés vus en pratique. Un compte créé avec « gmsil.com »
 * ne peut jamais se connecter et le mot de passe généré semble « cassé » —
 * mieux vaut le signaler AVANT la création (indice, jamais bloquant).
 */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmsil.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmai.co": "gmail.com",
  "gnail.com": "gmail.com",
  "gmall.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmil.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmaul.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.vom": "gmail.com",
  "hotnail.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "hotmaill.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahho.com": "yahoo.com",
  "yahou.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
  "outlool.com": "outlook.com",
  "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
};

/** Extensions manifestement ratées (« .con » pour « .com »). */
const TLD_TYPOS: Record<string, string> = {
  con: "com",
  cmo: "com",
  comm: "com",
  cpm: "com",
  xom: "com",
  vom: "com",
  coom: "com",
  som: "com",
  "c0m": "com",
  cim: "com",
  cm: "com",
};

/**
 * Renvoie une adresse corrigée plausible, ou `null` si rien à signaler.
 * Purement indicatif : l'envoi n'est jamais bloqué.
 */
export function suggestEmailFix(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Les espaces internes sont toujours une faute (« gmail.co m »).
  const hasInnerSpace = /\s/.test(trimmed);
  const canonical = trimmed.replace(/\s+/g, "").toLowerCase();

  const at = canonical.lastIndexOf("@");
  if (at <= 0 || at === canonical.length - 1) return null;
  const local = canonical.slice(0, at);
  const domain = canonical.slice(at + 1);
  if (!domain.includes(".")) return null;

  let fixedDomain = DOMAIN_TYPOS[domain] ?? null;
  if (!fixedDomain) {
    const lastDot = domain.lastIndexOf(".");
    const tld = domain.slice(lastDot + 1);
    const fixedTld = TLD_TYPOS[tld];
    if (fixedTld) fixedDomain = `${domain.slice(0, lastDot)}.${fixedTld}`;
  }

  const suggestion = `${local}@${fixedDomain ?? domain}`;
  if (suggestion === canonical && !hasInnerSpace) return null;
  return suggestion;
}

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

// ── Champ courriel avec indice de faute de frappe ────────────────────────────

function EmailField({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const t = useTranslations("admin");
  const suggestion = suggestEmailFix(value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="email"
        inputMode="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {suggestion ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span>{t("users.emailTypoHint", { suggestion })}</span>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="min-h-11 px-3 md:min-h-8"
            onClick={() => onChange(suggestion)}
          >
            {t("users.emailTypoFix")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Rendu des ressources voip.ms (DID / sous-comptes) ────────────────────────

/** "account:551013_alex" → { target: "551013_alex", isMain: false }. */
function parseRouting(routing: string | null | undefined) {
  const raw = routing?.trim();
  if (!raw) return null;
  const m = raw.match(/^account:(.+)$/i);
  const target = m ? m[1] : raw;
  return { target, isMain: Boolean(m) && !target.includes("_") };
}

const last10 = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "").slice(-10);

/** Pastille verte « libre » / grise « pris par X ». */
function AssignmentStatus({
  available,
  assignedUserName,
  isCurrentUser,
}: {
  available: boolean;
  assignedUserName: string | null;
  isCurrentUser: boolean;
}) {
  const t = useTranslations("admin");
  if (available) {
    return (
      <span className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-3" />
        {t("users.voip.available")}
      </span>
    );
  }
  return (
    <span className="truncate text-muted-foreground">
      {t("users.voip.assignedTo", { name: assignedUserName ?? "—" })}
      {isCurrentUser ? ` ${t("users.voip.thisUser")}` : ""}
    </span>
  );
}

/** Légende « N disponibles · M assignés ». */
function AssignmentLegend({ available, assigned }: { available: number; assigned: number }) {
  const t = useTranslations("admin");
  return (
    <p className="px-1 text-xs text-muted-foreground">
      {t("users.voip.legend", { available, assigned })}
    </p>
  );
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
        onDidReleased={(ids) =>
          setUsers((prev) =>
            prev.map((p) => (ids.includes(p.id) ? { ...p, didNumber: null } : p)),
          )
        }
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
  /** Identifiants complets (courriel + mot de passe) montrés une seule fois. */
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const reset = () => {
    setForm({ name: "", email: "", role: "caller", locale: "fr" });
    setCreated(null);
  };

  const submit = async () => {
    setPending(true);
    try {
      const res = await api<{ user: AdminUserDto; tempPassword: string }>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ ...form, email: form.email.trim() }),
      });
      onCreated(res.user);
      // Le courriel affiché est celui RÉELLEMENT enregistré (normalisé serveur).
      setCreated({ email: res.user.email, password: res.tempPassword });
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
          <DialogTitle>{created ? t("users.credentialsTitle") : t("users.createTitle")}</DialogTitle>
          <DialogDescription>
            {created ? t("users.tempPasswordHint") : t("users.createDesc")}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <>
            <LoginCredentials email={created.email} password={created.password} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)} className="min-h-11 md:min-h-8">
                {t("close")}
              </Button>
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
              <EmailField
                id="new-user-email"
                label={t("users.email")}
                value={form.email}
                onChange={(email) => setForm({ ...form, email })}
              />
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
              <Button variant="outline" onClick={() => setOpen(false)} className="min-h-11 md:min-h-8">
                {t("cancel")}
              </Button>
              {/* Une faute de frappe probable n'empêche JAMAIS la création. */}
              <Button
                onClick={() => void submit()}
                disabled={pending || !form.name.trim() || !form.email.trim()}
                className="min-h-11 md:min-h-8"
              >
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

type VoipSubAccount = {
  id: string;
  account: string;
  username: string;
  description: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  available: boolean;
};

type VoipDid = {
  did: string;
  e164: string | null;
  description: string;
  routing: string;
  state: string;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedSipUsername: string | null;
  available: boolean;
};

/** Utilisateur dépossédé de son DID par une réassignation. */
type ReleasedUser = { id: string; name: string; email: string };

function UserEditSheet({
  user,
  currentUserId,
  onClose,
  onUpdated,
  onDeleted,
  onDidReleased,
}: {
  user: AdminUserDto | null;
  currentUserId: string;
  onClose: () => void;
  onUpdated: (u: AdminUserDto) => void;
  onDeleted: (id: string) => void;
  onDidReleased: (ids: string[]) => void;
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
  const [secret, setSecret] = useState<{
    title: string;
    value: string;
    hint?: string;
    email?: string;
  } | null>(null);

  // voip.ms pickers — la liste reste en cache une fois chargée pour pouvoir
  // afficher l'avertissement de conflit même après la fermeture du sélecteur.
  const [subaccounts, setSubaccounts] = useState<VoipSubAccount[] | null>(null);
  const [subsOpen, setSubsOpen] = useState(false);
  const [dids, setDids] = useState<VoipDid[] | null>(null);
  const [didsOpen, setDidsOpen] = useState(false);
  const [voipLoading, setVoipLoading] = useState<string | null>(null);
  const [subUsername, setSubUsername] = useState("");
  const [createSubOpen, setCreateSubOpen] = useState(false);

  if (!user) return null;
  const isSelf = user.id === currentUserId;

  /** Prévient l'admin des comptes qui viennent de perdre leur numéro. */
  const announceReleased = (released: ReleasedUser[] | undefined) => {
    if (!released || released.length === 0) return;
    onDidReleased(released.map((r) => r.id));
    for (const r of released) {
      toast.info(t("users.voip.didReleasedFrom", { name: r.name }));
    }
    // Le cache d'affectations n'est plus à jour : on force un rechargement.
    setDids(null);
    setDidsOpen(false);
  };

  const patch = async (payload: Record<string, unknown>, successMsg?: string) => {
    setPending(true);
    try {
      const res = await api<{ user: AdminUserDto; released?: ReleasedUser[] }>(
        `/api/admin/users/${user.id}`,
        { method: "PATCH", body: JSON.stringify(payload) },
      );
      onUpdated(res.user);
      announceReleased(res.released);
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
      email: form.email.trim(),
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
      // Le courriel accompagne le mot de passe : c'est avec CE compte qu'il faut
      // se connecter (une adresse mal saisie explique la plupart des « ça marche pas »).
      setSecret({
        title: t("users.credentialsTitle"),
        value: res.tempPassword,
        email: user.email,
      });
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally {
      setPending(false);
    }
  };

  const loadSubaccounts = async () => {
    if (subsOpen) {
      setSubsOpen(false);
      return;
    }
    setVoipLoading("subaccounts");
    try {
      const res = await api<{ accounts: VoipSubAccount[] }>("/api/admin/voipms/subaccounts");
      setSubaccounts(res.accounts);
      setSubsOpen(true);
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  const loadDids = async () => {
    if (didsOpen) {
      setDidsOpen(false);
      return;
    }
    setVoipLoading("dids");
    try {
      const res = await api<{ dids: VoipDid[] }>("/api/admin/voipms/dids");
      setDids(res.dids);
      setDidsOpen(true);
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
      setSubaccounts(null); // le cache d'affectations n'est plus à jour
      setSubsOpen(false);
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
      const res = await api<{ ok: boolean; did: string; released?: ReleasedUser[] }>(
        "/api/admin/voipms/route-did",
        {
          method: "POST",
          body: JSON.stringify({ did: form.didNumber, account: form.sipUsername, userId: user.id }),
        },
      );
      setForm((f) => ({ ...f, didNumber: res.did }));
      onUpdated({ ...user, didNumber: res.did });
      announceReleased(res.released);
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

  // ── Conflits d'affectation (dérivés des listes voip.ms chargées) ──
  // Le numéro saisi appartient-il DÉJÀ à quelqu'un d'autre ? On avertit avant
  // l'enregistrement : le serveur le retirera de son détenteur actuel.
  const didDigits = last10(form.didNumber);
  const didConflict =
    didDigits.length === 10
      ? (dids?.find(
          (d) =>
            last10(d.did) === didDigits && d.assignedUserId !== null && d.assignedUserId !== user.id,
        ) ?? null)
      : null;

  const sipKey = form.sipUsername.trim().toLowerCase();
  const subConflict = sipKey
    ? (subaccounts?.find(
        (a) =>
          a.account.trim().toLowerCase() === sipKey &&
          a.assignedUserId !== null &&
          a.assignedUserId !== user.id,
      ) ?? null)
    : null;

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
            {/* Une adresse mal saisie se corrige ici — inutile de supprimer et recréer. */}
            <EmailField
              id="edit-email"
              label={t("users.email")}
              value={form.email}
              onChange={(email) => setForm({ ...form, email })}
            />
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
                  className="min-h-11 shrink-0 md:min-h-8"
                  onClick={() => void loadSubaccounts()}
                  disabled={voipLoading !== null}
                >
                  {voipLoading === "subaccounts" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {subsOpen ? t("users.voip.hide") : t("users.voip.listSubaccounts")}
                </Button>
              </div>
              {subConflict ? (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span>{t("users.voip.subConflict", { name: subConflict.assignedUserName ?? "—" })}</span>
                </p>
              ) : null}
              {subsOpen && subaccounts !== null ? (
                <div className="space-y-1.5">
                  <AssignmentLegend
                    available={subaccounts.filter((a) => a.available).length}
                    assigned={subaccounts.filter((a) => !a.available).length}
                  />
                  <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                    {subaccounts.length === 0 ? (
                      <p className="p-2 text-xs text-muted-foreground">{t("users.voip.noSubaccounts")}</p>
                    ) : (
                      subaccounts.map((a) => {
                        const mine = a.assignedUserId === user.id;
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={cn(
                              "flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                              a.account === form.sipUsername && "bg-muted",
                            )}
                            onClick={() => {
                              setForm((f) => ({ ...f, sipUsername: a.account }));
                              setSubsOpen(false);
                            }}
                          >
                            <span className="flex w-full items-center gap-1.5">
                              <span className="truncate font-mono text-xs font-medium">{a.account}</span>
                              {a.description ? (
                                <span className="truncate text-xs text-muted-foreground">
                                  · {a.description}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex w-full items-center gap-1.5 text-xs">
                              <AssignmentStatus
                                available={a.available}
                                assignedUserName={a.assignedUserName}
                                isCurrentUser={mine}
                              />
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-11 md:min-h-8"
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
                  className="min-h-11 shrink-0 md:min-h-8"
                  onClick={() => void loadDids()}
                  disabled={voipLoading !== null}
                >
                  {voipLoading === "dids" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {didsOpen ? t("users.voip.hide") : t("users.voip.listDids")}
                </Button>
              </div>
              {didConflict ? (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span>{t("users.voip.didConflict", { name: didConflict.assignedUserName ?? "—" })}</span>
                </p>
              ) : null}
              {didsOpen && dids !== null ? (
                <div className="space-y-1.5">
                  <AssignmentLegend
                    available={dids.filter((d) => d.available).length}
                    assigned={dids.filter((d) => !d.available).length}
                  />
                  <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border p-1.5">
                    {dids.length === 0 ? (
                      <p className="p-2 text-xs text-muted-foreground">{t("users.voip.noDids")}</p>
                    ) : (
                      dids.map((d) => {
                        const e164 = d.e164 ?? `+1${last10(d.did)}`;
                        const mine = d.assignedUserId === user.id;
                        const routing = parseRouting(d.routing);
                        // Numéro attribué dans le CRM mais routé ailleurs chez
                        // voip.ms : les appels entrants n'arriveront pas au bon poste.
                        const routingMismatch =
                          !d.available &&
                          routing !== null &&
                          routing.target.toLowerCase() !== (d.assignedSipUsername ?? "").toLowerCase();
                        return (
                          <button
                            key={d.did}
                            type="button"
                            className={cn(
                              "flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                              last10(d.did) === didDigits && "bg-muted",
                            )}
                            onClick={() => {
                              setForm((f) => ({ ...f, didNumber: e164 }));
                              setDidsOpen(false);
                            }}
                          >
                            <span className="flex w-full items-center gap-1.5">
                              <span className="font-mono text-sm font-medium">{formatPhone(e164)}</span>
                              {d.description ? (
                                <span className="truncate text-xs text-muted-foreground">
                                  · {d.description}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                              <AssignmentStatus
                                available={d.available}
                                assignedUserName={d.assignedUserName}
                                isCurrentUser={mine}
                              />
                              {routing ? (
                                <span
                                  className={cn(
                                    "truncate font-mono text-[0.7rem]",
                                    routingMismatch
                                      ? "text-amber-700 dark:text-amber-400"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {routing.isMain
                                    ? t("users.voip.routedMain")
                                    : t("users.voip.routedTo", { target: routing.target })}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-11 md:min-h-8"
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
            {secret ? (
              secret.email ? (
                <LoginCredentials email={secret.email} password={secret.value} hint={secret.hint} />
              ) : (
                <OneTimeSecret value={secret.value} hint={secret.hint} />
              )
            ) : null}
            <DialogFooter>
              <Button onClick={() => setSecret(null)} className="min-h-11 md:min-h-8">
                {t("close")}
              </Button>
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
