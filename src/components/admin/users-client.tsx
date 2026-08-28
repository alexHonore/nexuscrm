"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import {
  Check,
  CircleCheck,
  CircleDashed,
  KeyRound,
  Loader2,
  Phone,
  PhoneOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { LookGlyph, lookTint, roleLook } from "@/components/look";
import { PageHeader } from "@/components/shell/page-header";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { api, ApiError } from "./api";
import { LoginCredentials, OneTimeSecret } from "./copy-button";
import { errorMessage, type Tr } from "./errors";
import { OrderDidDialog, type OrderDidResult } from "./order-did-dialog";
import type { AdminUserDto, PhoneStatusDto, RoleOptionDto } from "./types";

const TZ = "America/Toronto";

// ── Rôles configurés ─────────────────────────────────────────────────────────

/**
 * Deux refus propres à la matrice des rôles. Ils ne sont pas dans `errors.ts`
 * (qui sert tous les écrans d'administration) : ils n'existent que là où l'on
 * change le rôle d'un compte.
 */
function userErrorMessage(t: Tr, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "unknown_role") return t("roles.errorNotFound");
    // TODO i18n : « last_admin » n'a pas encore son texte. Celui de la
    // rétrogradation de soi est le plus proche — il dit le bon danger (perdre
    // l'administrateur) sur la mauvaise personne (soi plutôt que le dernier).
    if (err.code === "last_admin") return t("users.errors.cannot_demote_self");
  }
  return errorMessage(t, err);
}

/** Le libellé d'un rôle dans la langue de l'INTERFACE. */
function useRoleName() {
  const locale = useLocale();
  return (role: { nameFr: string; nameEn: string }) =>
    locale === "en" ? role.nameEn : role.nameFr;
}

/**
 * Le rôle d'une ligne, retrouvé dans la liste configurée.
 *
 * Un compte dont le rôle vient d'être supprimé de la matrice garde les noms
 * sérialisés avec lui : mieux vaut une pastille périmée qu'une case vide en
 * face d'un compte qui, lui, a bel et bien des droits.
 */
function roleOfUser(u: AdminUserDto, roles: RoleOptionDto[]): RoleOptionDto | null {
  const known = roles.find((r) => r.id === u.roleId);
  if (known) return known;
  if (!u.roleId) return null;
  return {
    id: u.roleId,
    nameFr: u.roleNameFr ?? u.roleId,
    nameEn: u.roleNameEn ?? u.roleId,
    look: u.roleLook ?? "observer",
    superAdmin: u.role === "admin",
  };
}

/** Pictogramme + teinte du rôle : la couleur DOUBLE le nom, ne le remplace pas. */
function RoleBadge({ role, label }: { role: RoleOptionDto | null; label: string }) {
  const look = roleLook(role?.look ?? "observer");
  const tint = lookTint(look);
  return (
    <Badge
      variant="outline"
      className="gap-1 pl-1.5 font-medium"
      style={{ borderColor: tint.borderColor, backgroundColor: tint.backgroundColor }}
    >
      <LookGlyph look={look} className="size-3.5" />
      {label}
    </Badge>
  );
}

/**
 * Le choix du rôle — la seule chose qui se décide ici. Ce que chaque rôle a le
 * droit de faire se règle dans /admin/roles, et le lien y mène : sans lui, on
 * choisit « Observateur » sans savoir ce que ça retire.
 */
function RoleField({
  roles,
  value,
  onChange,
  disabled,
}: {
  roles: RoleOptionDto[];
  value: string;
  onChange: (roleId: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("admin");
  const roleName = useRoleName();
  const selected = roles.find((r) => r.id === value) ?? null;

  return (
    <div className="space-y-1.5">
      <Label>{t("users.role")}</Label>
      <Select
        items={roles.map((r) => ({ value: r.id, label: roleName(r) }))}
        value={value}
        onValueChange={(v) => onChange(String(v))}
        disabled={disabled}
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-8">
          <LookGlyph look={roleLook(selected?.look ?? "observer")} className="size-3.5" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roles.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              <LookGlyph look={roleLook(r.look)} className="size-3.5" />
              {roleName(r)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("users.roleHint")}</p>
      <Button
        variant="link"
        size="sm"
        className="h-auto min-h-11 px-0 md:min-h-0"
        render={<Link href="/admin/roles" />}
      >
        <ShieldCheck className="size-3.5" />
        {t("users.roleManage")}
      </Button>
    </div>
  );
}

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
      <span className="flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
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

// ── État du téléphone ────────────────────────────────────────────────────────

/**
 * L'incident d'origine : personne ne voyait qu'un téléphoniste avait des champs
 * SIP vides — donc aucun appel possible. La pastille répond d'un coup d'œil, et
 * l'info-bulle dit exactement ce qui manque.
 */
const PHONE_BADGE: Record<PhoneStatusDto["code"], { className: string; Icon: typeof Check }> = {
  ready: {
    className: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  no_did: {
    className: "bg-amber-500/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
    Icon: PhoneOff,
  },
  not_configured: { className: "bg-muted text-muted-foreground", Icon: CircleDashed },
  no_gateway: { className: "bg-destructive/10 text-destructive", Icon: TriangleAlert },
};

/**
 * Reflète immédiatement l'ajout ou le retrait d'un numéro sur la pastille,
 * sans attendre un rechargement. Le serveur reste la référence : toute réponse
 * d'API rapporte l'état recalculé.
 */
function phoneWithDid(phone: PhoneStatusDto, hasDid: boolean): PhoneStatusDto {
  if (phone.hasDid === hasDid) return phone;
  const blocked = phone.code === "no_gateway" || phone.code === "not_configured";
  return { ...phone, hasDid, code: blocked ? phone.code : hasDid ? "ready" : "no_did" };
}

/** Éléments manquants, du plus bloquant au moins bloquant. */
function missingPhoneParts(t: Tr, phone: PhoneStatusDto): string[] {
  return [
    !phone.hasGateway ? t("users.phone.missingGateway") : null,
    !phone.hasSipUsername ? t("users.phone.missingSipUsername") : null,
    !phone.hasSipPassword ? t("users.phone.missingSipPassword") : null,
    !phone.hasDid ? t("users.phone.missingDid") : null,
  ].filter((v): v is string => v !== null);
}

function PhoneBadge({ phone, className }: { phone: PhoneStatusDto; className?: string }) {
  const t = useTranslations("admin");
  const { className: tone, Icon } = PHONE_BADGE[phone.code];
  return (
    <Badge variant="secondary" className={cn("gap-1", tone, className)}>
      <Icon className="size-3" />
      {t(`users.phone.${phone.code}`)}
    </Badge>
  );
}

/** Pastille + info-bulle explicative (desktop ; au tactile, la carte suffit). */
function PhoneStatusCell({ phone }: { phone: PhoneStatusDto }) {
  const t = useTranslations("admin");
  const missing = missingPhoneParts(t, phone);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PhoneBadge phone={phone} />
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start gap-1 text-left">
          <span className="font-medium">{t(`users.phone.${phone.code}`)}</span>
          <span>{t(`users.phone.${phone.code}Hint`)}</span>
          {missing.length > 0 ? (
            <>
              <span className="pt-0.5 font-medium">{t("users.phone.missingTitle")}</span>
              <ul className="list-inside list-disc">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function UsersClient({
  initialUsers,
  roles,
  defaultRoleId,
  currentUserId,
}: {
  initialUsers: AdminUserDto[];
  roles: RoleOptionDto[];
  defaultRoleId: string;
  currentUserId: string;
}) {
  const t = useTranslations("admin");
  const roleName = useRoleName();
  const fmt = useDateFmt();
  const [users, setUsers] = useState(initialUsers);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = users.find((u) => u.id === editingId) ?? null;

  const upsert = (u: AdminUserDto) =>
    setUsers((prev) => {
      const i = prev.findIndex((p) => p.id === u.id);
      if (i === -1) return [...prev, u];
      const next = [...prev];
      // Les routes voip.ms ne lisent pas la matrice : leur réponse ne porte
      // aucun rôle (`roleId` nul). La ligne garde le sien plutôt que de perdre
      // sa pastille à chaque numéro attribué.
      next[i] = u.roleId
        ? u
        : {
            ...u,
            roleId: prev[i].roleId,
            roleNameFr: prev[i].roleNameFr,
            roleNameEn: prev[i].roleNameEn,
            roleLook: prev[i].roleLook,
          };
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
      toast.error(userErrorMessage(t, err));
    }
  };

  const roleBadge = (u: AdminUserDto) => {
    const role = roleOfUser(u, roles);
    return <RoleBadge role={role} label={role ? roleName(role) : t("users.roleCaller")} />;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<UsersRound />}
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        actions={
          <CreateUserDialog
            roles={roles}
            defaultRoleId={defaultRoleId}
            onCreated={upsert}
            onConfigure={setEditingId}
          />
        }
      />

      {/* ── Tableau (desktop) ── */}
      <div className="hidden overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10 md:block">
        <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("users.name")}</TableHead>
              <TableHead>{t("users.role")}</TableHead>
              <TableHead>{t("users.active")}</TableHead>
              <TableHead>{t("users.phone.column")}</TableHead>
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
                <TableCell>
                  <PhoneStatusCell phone={u.phone} />
                </TableCell>
                <TableCell className="text-sm tabular-nums">{u.didNumber ? formatPhone(u.didNumber) : "—"}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-xs">{u.sipUsername ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground tabular-nums">
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
            className="w-full rounded-xl bg-card p-4 text-left shadow-xs ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
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
            {/* L'état du téléphone doit rester visible sur mobile : c'est là que
                le courtier constate qu'une ligne n'a jamais été configurée. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <PhoneBadge phone={u.phone} />
              {u.phone.code !== "ready" ? (
                <span className="text-xs text-muted-foreground">
                  {missingPhoneParts(t, u.phone).join(" · ")}
                </span>
              ) : null}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 tabular-nums">
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
        roles={roles}
        defaultRoleId={defaultRoleId}
        currentUserId={currentUserId}
        onClose={() => setEditingId(null)}
        onUpdated={upsert}
        onDidReleased={(ids) =>
          setUsers((prev) =>
            prev.map((p) =>
              ids.includes(p.id)
                ? { ...p, didNumber: null, phone: phoneWithDid(p.phone, false) }
                : p,
            ),
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

// ── Provisionnement de la ligne SIP ──────────────────────────────────────────

/** voip.ms répond parfois après plus d'une minute : on laisse largement le temps. */
const PROVISION_TIMEOUT_MS = 90_000;

type ProvisionResponse = {
  account: string;
  password: string;
  created: boolean;
  derived: boolean;
  user: AdminUserDto;
};

type ProvisionState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; account: string; reused: boolean }
  | { state: "error"; message: string };

/**
 * Configure (ou reprend) la ligne SIP d'un utilisateur. Sans `username`, le
 * serveur dérive un nom sûr du nom/courriel. L'opération est idempotente :
 * rejouer après un échec ne crée jamais de doublon.
 */
async function provisionLine(userId: string, username?: string): Promise<ProvisionResponse> {
  return api<ProvisionResponse>("/api/admin/voipms/subaccounts", {
    method: "POST",
    body: JSON.stringify({ userId, ...(username ? { username } : {}) }),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
  });
}

/** Avancement « Configuration de la ligne… » → succès / échec + Réessayer. */
function ProvisionStatus({
  status,
  onRetry,
  onAssignDid,
}: {
  status: ProvisionState;
  onRetry: () => void;
  onAssignDid?: () => void;
}) {
  const t = useTranslations("admin");
  if (status.state === "idle") return null;

  return (
    <div className="space-y-2 rounded-lg bg-muted/50 p-3">
      <p className="text-sm font-medium">{t("users.provision.title")}</p>

      {status.state === "running" ? (
        <>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("users.provision.running")}
          </p>
          <p className="text-xs text-muted-foreground">{t("users.provision.slow")}</p>
        </>
      ) : null}

      {status.state === "done" ? (
        <>
          <p className="flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
            <span className="font-mono">
              {t(status.reused ? "users.provision.reused" : "users.provision.done", {
                account: status.account,
              })}
            </span>
          </p>
          {/* Un DID libre n'est JAMAIS attribué d'office — l'admin choisit. */}
          <p className="text-xs text-muted-foreground">{t("users.provision.noDid")}</p>
          {onAssignDid ? (
            <Button variant="secondary" size="sm" className="min-h-11 md:min-h-8" onClick={onAssignDid}>
              <Phone className="size-4" />
              {t("users.provision.assignDid")}
            </Button>
          ) : null}
        </>
      ) : null}

      {status.state === "error" ? (
        <>
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {t("users.provision.failed")}
          </p>
          <p className="text-xs text-muted-foreground">{status.message}</p>
          <Button variant="secondary" size="sm" className="min-h-11 md:min-h-8" onClick={onRetry}>
            <RefreshCw className="size-4" />
            {t("users.provision.retry")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

// ── Création ─────────────────────────────────────────────────────────────────

function CreateUserDialog({
  roles,
  defaultRoleId,
  onCreated,
  onConfigure,
}: {
  roles: RoleOptionDto[];
  defaultRoleId: string;
  onCreated: (u: AdminUserDto) => void;
  onConfigure: (userId: string) => void;
}) {
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // Le rôle proposé est celui que la matrice donne d'office : créer un compte
  // sans y toucher ne doit jamais accorder plus que le réglage par défaut.
  const [form, setForm] = useState({ name: "", email: "", roleId: defaultRoleId, locale: "fr" });
  /** Identifiants complets (courriel + mot de passe) montrés une seule fois. */
  const [created, setCreated] = useState<{ id: string; email: string; password: string } | null>(null);
  const [provision, setProvision] = useState<ProvisionState>({ state: "idle" });

  const reset = () => {
    setForm({ name: "", email: "", roleId: defaultRoleId, locale: "fr" });
    setCreated(null);
    setProvision({ state: "idle" });
  };

  /**
   * Configure la ligne APRÈS coup : le compte est déjà créé et son mot de passe
   * déjà affiché. Un échec voip.ms ne peut donc rien annuler ni masquer.
   */
  const runProvision = async (userId: string) => {
    setProvision({ state: "running" });
    try {
      const res = await provisionLine(userId);
      onCreated(res.user);
      setProvision({ state: "done", account: res.account, reused: !res.created });
    } catch (err) {
      setProvision({ state: "error", message: userErrorMessage(t, err) });
    }
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
      setCreated({ id: res.user.id, email: res.user.email, password: res.tempPassword });
      // La ligne se configure toute seule dans la foulée : l'incident venait de
      // ce deuxième pas manuel que personne ne faisait.
      void runProvision(res.user.id);
    } catch (err) {
      toast.error(userErrorMessage(t, err));
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
      <Button onClick={() => setOpen(true)} className="min-h-11 md:min-h-9">
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
            <ProvisionStatus
              status={provision}
              onRetry={() => void runProvision(created.id)}
              onAssignDid={() => {
                setOpen(false);
                onConfigure(created.id);
              }}
            />
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
              {/* Le rôle prend toute la largeur : sa liste s'allonge à chaque
                  rôle créé, et il porte son indice et son lien. */}
              <RoleField
                roles={roles}
                value={form.roleId}
                onChange={(roleId) => setForm({ ...form, roleId })}
              />
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
                  <SelectTrigger className="min-h-11 w-full md:min-h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fr">{t("users.localeFr")}</SelectItem>
                    <SelectItem value="en">{t("users.localeEn")}</SelectItem>
                  </SelectContent>
                </Select>
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

// ── Vérification de la ligne chez voip.ms ────────────────────────────────────

type VerifyCheck = {
  key: "gateway" | "subaccount" | "password" | "did" | "routing";
  status: "ok" | "fail" | "warn" | "unknown";
  reason: string;
  value?: string;
};

type VerifyResponse = {
  ok: boolean;
  canCall: boolean;
  checks: VerifyCheck[];
  canResync: boolean;
  user: AdminUserDto;
};

const CHECK_ICON = {
  ok: { Icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { Icon: X, className: "text-destructive" },
  warn: { Icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400" },
  unknown: { Icon: CircleDashed, className: "text-muted-foreground" },
} as const;

/**
 * Résultat de « Vérifier la ligne » : un ✓/✗ par point de contrôle, avec la
 * correction à faire en clair. C'est la réponse à « son téléphone marche-t-il
 * vraiment ? » — les champs remplis dans le CRM ne le garantissent pas.
 */
function VerifyChecklist({
  result,
  onResync,
  resyncing,
}: {
  result: VerifyResponse;
  onResync: () => void;
  resyncing: boolean;
}) {
  const t = useTranslations("admin");
  const headline = result.ok
    ? { text: t("users.verify.ok"), className: "text-emerald-700 dark:text-emerald-400" }
    : result.canCall
      ? { text: t("users.verify.partial"), className: "text-amber-700 dark:text-amber-400" }
      : { text: t("users.verify.failed"), className: "text-destructive" };

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <p className={cn("text-sm font-medium", headline.className)}>{headline.text}</p>
      <ul className="space-y-1.5">
        {result.checks.map((c) => {
          const { Icon, className } = CHECK_ICON[c.status];
          const value = c.key === "did" && c.value ? formatPhone(c.value) : (c.value ?? "—");
          return (
            <li key={c.key} className="flex items-start gap-2 text-xs">
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", className)} />
              <span className="min-w-0">
                <span className="font-medium">{t(`users.verify.labels.${c.key}`)}</span>
                <span className="block text-muted-foreground">
                  {t(`users.verify.reasons.${c.reason}`, { value })}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {result.canResync ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-11 md:min-h-8"
          onClick={onResync}
          disabled={resyncing}
        >
          {resyncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("users.verify.resync")}
        </Button>
      ) : null}
    </div>
  );
}

function UserEditSheet({
  user,
  roles,
  defaultRoleId,
  currentUserId,
  onClose,
  onUpdated,
  onDeleted,
  onDidReleased,
}: {
  user: AdminUserDto | null;
  roles: RoleOptionDto[];
  defaultRoleId: string;
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
    roleId: user?.roleId ?? defaultRoleId,
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
  const [provision, setProvision] = useState<ProvisionState>({ state: "idle" });
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);

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
      toast.error(userErrorMessage(t, err));
      return false;
    } finally {
      setPending(false);
    }
  };

  const saveAll = async () => {
    const ok = await patch({
      name: form.name,
      email: form.email.trim(),
      // Le rôle CONFIGURÉ, jamais le plancher « admin/caller » : c'est le
      // serveur qui en déduit la colonne (`setUserRole`).
      roleId: form.roleId,
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
      const res = await provisionLine(user.id, subUsername);
      setForm((f) => ({ ...f, sipUsername: res.account }));
      onUpdated(res.user);
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

  /**
   * Configuration automatique : nom de sous-compte dérivé côté serveur, mot de
   * passe généré et chiffré. Idempotent — rejouable sans risque de doublon.
   */
  const autoProvision = async () => {
    setVoipLoading("provision");
    setProvision({ state: "running" });
    try {
      const res = await provisionLine(user.id);
      setForm((f) => ({ ...f, sipUsername: res.account }));
      onUpdated(res.user);
      setSubaccounts(null);
      setSubsOpen(false);
      setProvision({ state: "done", account: res.account, reused: !res.created });
      setSecret({
        title: t("users.voip.sipPasswordCreated"),
        value: res.password,
        hint: t("users.voip.sipPasswordSavedHint"),
      });
    } catch (err) {
      setProvision({ state: "error", message: errorMessage(t, err) });
    } finally {
      setVoipLoading(null);
    }
  };

  /** Confronte les champs enregistrés à ce que voip.ms rapporte réellement. */
  const runVerify = async () => {
    setVoipLoading("verify");
    setVerifyResult(null);
    try {
      const res = await api<VerifyResponse>(`/api/admin/voipms/verify?userId=${user.id}`, {
        signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
      });
      setVerifyResult(res);
      onUpdated(res.user);
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  /** Adopte le mot de passe que voip.ms utilise vraiment, puis revérifie. */
  const resyncPassword = async () => {
    setVoipLoading("resync");
    try {
      const res = await api<{ account: string; user: AdminUserDto }>("/api/admin/voipms/verify", {
        method: "POST",
        body: JSON.stringify({ userId: user.id }),
        signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
      });
      onUpdated(res.user);
      toast.success(t("users.verify.resyncDone"));
      setVoipLoading(null);
      await runVerify();
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
      onUpdated({ ...user, didNumber: res.did, phone: phoneWithDid(user.phone, true) });
      announceReleased(res.released);
      toast.success(t("users.voip.routed"));
    } catch (err) {
      toast.error(errorMessage(t, err), { description: t("users.voip.ipHint") });
    } finally {
      setVoipLoading(null);
    }
  };

  /** Num\u00e9ro fra\u00eechement achet\u00e9 : champs, liste et caches se mettent \u00e0 jour d'un coup. */
  const handleOrdered = (res: OrderDidResult) => {
    setForm((f) => ({ ...f, didNumber: res.did, sipUsername: res.account }));
    onUpdated(res.user);
    announceReleased(res.released);
    setDids(null); // la vitrine vient de vendre un num\u00e9ro : affectations p\u00e9rim\u00e9es
    setDidsOpen(false);
    if (res.provision) {
      // La ligne SIP a \u00e9t\u00e9 cr\u00e9\u00e9e au passage : mot de passe montr\u00e9 UNE fois.
      setSecret({
        title: t("users.voip.sipPasswordCreated"),
        value: res.provision.password,
        hint: t("users.voip.sipPasswordSavedHint"),
      });
    }
  };

  /**
   * M\u00eame forme que la d\u00e9rivation serveur : pr\u00e9nom pli\u00e9 en ASCII, sans le
   * pr\u00e9fixe du compte principal (voip.ms l'ajoute lui-m\u00eame). \u00ab Alex-Honor\u00e9 \u00bb \u2192
   * \u00ab alexhonore \u00bb. L'admin reste libre de le remplacer.
   */
  const suggestedUsername = () => {
    const first = (user.name.split(/\s+/)[0] ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 12);
    return first.length >= 2 ? first : "agent";
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
            {/* Sur son PROPRE compte, le sélecteur est fermé : le serveur
                refuse de toute façon (`cannot_demote_self`) — se retirer les
                clés de la maison ne se rattrape pas depuis l'application. */}
            <RoleField
              roles={roles}
              value={form.roleId}
              onChange={(roleId) => setForm({ ...form, roleId })}
              disabled={isSelf}
            />
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
                <SelectTrigger className="min-h-11 w-full md:min-h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fr">{t("users.localeFr")}</SelectItem>
                  <SelectItem value="en">{t("users.localeEn")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <Separator />

          {/* ── VoIP ── */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{t("users.voip.title")}</h3>
              <PhoneBadge phone={user.phone} />
            </div>
            <p className="text-xs text-muted-foreground">{t("users.voip.desc")}</p>

            {/* Deux gestes suffisent : tout configurer, ou savoir ce qui cloche. */}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => void autoProvision()}
                disabled={voipLoading !== null}
              >
                {voipLoading === "provision" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                {t("users.provision.auto")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => void runVerify()}
                disabled={voipLoading !== null}
              >
                {voipLoading === "verify" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {t("users.verify.action")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("users.provision.autoHint")}</p>

            {provision.state !== "idle" ? (
              <ProvisionStatus status={provision} onRetry={() => void autoProvision()} />
            ) : null}
            {voipLoading === "verify" ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("users.verify.running")}
              </p>
            ) : null}
            {verifyResult ? (
              <VerifyChecklist
                result={verifyResult}
                onResync={() => void resyncPassword()}
                resyncing={voipLoading === "resync"}
              />
            ) : null}

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
              <div className="flex flex-wrap gap-2">
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
                {/* Achat d'un numéro NEUF, débité du solde voip.ms — sans portail. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-11 md:min-h-8"
                  onClick={() => setOrderOpen(true)}
                  disabled={voipLoading !== null}
                >
                  <ShoppingCart className="size-4" />
                  {t("users.voip.order.open")}
                </Button>
              </div>
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
                            toast.error(userErrorMessage(t, err));
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

        {/* ── Dialog : achat d'un nouveau numéro voip.ms ── */}
        <OrderDidDialog
          user={{ id: user.id, name: user.name }}
          open={orderOpen}
          onOpenChange={setOrderOpen}
          onOrdered={handleOrdered}
        />

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
    <div className="rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
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
