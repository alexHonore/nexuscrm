"use client";

import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CopyIcon,
  HelpCircleIcon,
  Loader2Icon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type Look,
  LookGlyph,
  LookIcon,
  PERMISSION_GROUP_LOOK,
  ROLE_LOOK,
  lookTint,
  roleLook,
} from "@/components/look";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { can } from "@/lib/permissions/access";
import {
  GRANT_CEILING,
  GRANT_KEYS,
  type GrantKey,
  type Grants,
  LOCKED_TO_ADMIN,
  PERMISSION_GROUPS,
  type PermissionGroup,
  type PermissionKey,
  allGrants,
  noGrants,
  permissionsOfGroup,
  roleBucket,
} from "@/lib/permissions/catalog";
import { CALLER_ROLE_ID } from "@/lib/permissions/defaults";
import { ROLE_ID_RE } from "@/lib/permissions/schema";
import type { AssignmentRules, PermissionsConfig, Role } from "@/lib/permissions/types";
import { ApiError, api } from "./api";

/**
 * L'écran où le courtier fabrique ses rôles.
 *
 * Tout se modifie DANS UN BROUILLON local, et une seule requête écrit la
 * configuration entière. C'est délibéré : les trois réglages qui composent un
 * rôle se contredisent volontiers (un droit retiré ferme dix cases de
 * relation), et enregistrer case par case donnerait des états intermédiaires
 * où l'équipe perdrait des fiches le temps d'un aller-retour. Le serveur
 * répare et tranche (`repairConfig`) ; l'écran ne fait qu'écrire une intention.
 */

// ── Ce que la page serveur envoie ────────────────────────────────────────────

/** Une fiche du registre des droits, déjà résolue dans la langue de l'écran. */
export type RoleDocText = {
  label: string;
  what?: string;
  why?: string;
  pitfalls?: string;
};

export type RolesDocs = {
  permissions: Record<string, RoleDocText | undefined>;
  grants: Record<string, RoleDocText | undefined>;
  groups: Record<string, RoleDocText | undefined>;
};

type RolesClientProps = {
  config: PermissionsConfig;
  /** roleId → nombre de comptes qui le portent. */
  counts: Record<string, number>;
  /** roleId → noms des comptes, pour vérifier que c'est le bon monde dedans. */
  members: Record<string, string[]>;
  docs: RolesDocs;
  locale: "fr" | "en";
};

// ── Petits utilitaires ───────────────────────────────────────────────────────

function roleName(role: Role, locale: "fr" | "en"): string {
  return locale === "en" ? role.nameEn : role.nameFr;
}

/**
 * Les cases ENREGISTRÉES d'un compartiment — celles-là et pas d'autres.
 *
 * Aucune valeur par défaut n'est inventée ici, et c'est le point : `grantsFor`
 * (access.ts) lit `relations[bucket]` sans repli, et `repairConfig` matérialise
 * le compartiment de chaque rôle chez chaque rôle. L'entrée existe donc
 * toujours dans une configuration chargée, et ce que l'écran peint est
 * exactement ce que le moteur applique. Rajouter une retombée « au cas où »
 * rouvrirait le pire défaut possible pour une matrice réglée à la main : un
 * écran qui montre une case fermée pendant que le moteur l'ouvre.
 *
 * Le plafond des droits, lui, ne s'applique QU'À L'USAGE : une case cochée dont
 * le droit vient d'être retiré reste cochée ici (grisée, avec son motif), sinon
 * rendre le droit ne rouvrirait rien.
 */
function storedGrants(role: Role, bucket: string): Grants {
  const raw = role.relations[bucket] ?? {};
  const out = noGrants();
  for (const key of GRANT_KEYS) if (raw[key] === true) out[key] = true;
  return out;
}

/**
 * Où retombent les comptes d'un rôle qu'on supprime — la règle de
 * `repairConfig`, redite ici pour l'ANNONCER avant le geste : le rôle par
 * défaut, sauf si c'est justement lui qu'on supprime, auquel cas le serveur
 * reprend le téléphoniste livré (ou le premier rôle non administrateur).
 */
function fallbackRoleFor(roles: Role[], defaultRoleId: string, removedId: string): Role | null {
  const remaining = roles.filter((role) => role.id !== removedId);
  return (
    remaining.find((role) => role.id === defaultRoleId && !role.superAdmin) ??
    remaining.find((role) => role.id === CALLER_ROLE_ID) ??
    remaining.find((role) => !role.superAdmin) ??
    null
  );
}

function readOnlyGrants(): Grants {
  const g = noGrants();
  g.visible = true;
  g.contact = true;
  g.history = true;
  return g;
}

const PRESETS = {
  invisible: noGrants,
  readOnly: readOnlyGrants,
  full: allGrants,
} as const;

type PresetKey = keyof typeof PRESETS;

/** La clé i18n de chaque préréglage — un ternaire imbriqué dans un libellé se relit mal. */
const PRESET_LABEL = {
  invisible: "roles.presetInvisible",
  readOnly: "roles.presetReadOnly",
  full: "roles.presetFull",
  custom: "roles.presetCustom",
} as const;

/** Le préréglage qui correspond exactement aux cases, sinon « sur mesure ». */
function presetOf(grants: Grants): PresetKey | "custom" {
  for (const key of Object.keys(PRESETS) as PresetKey[]) {
    const model = PRESETS[key]();
    if (GRANT_KEYS.every((g) => model[g] === grants[g])) return key;
  }
  return "custom";
}

const EMPTY_ASSIGNMENT: AssignmentRules = {
  claimPool: false,
  release: false,
  assignToOthers: false,
  takeFromOthers: false,
  maxOwned: 0,
};

/** Un identifiant de rôle tenable dans une clé JSON et dans une URL. */
function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ROLE_ID_RE.test(slug) ? slug : "";
}

/**
 * L'identifiant ne change JAMAIS après coup (les affectations de comptes et
 * les compartiments des autres rôles le citent) : on le fabrique une fois, on
 * le rend unique tout de suite.
 */
function freshRoleId(nameEn: string, nameFr: string, taken: Set<string>): string {
  const base = slugify(nameEn) || slugify(nameFr) || "role";
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 40);
    if (!taken.has(candidate)) return candidate;
  }
  return `role-${Date.now().toString(36)}`;
}

function cloneRelations(source: Record<string, Partial<Grants>>): Record<string, Partial<Grants>> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { ...value }]));
}

// ── Aide en ligne ────────────────────────────────────────────────────────────

/**
 * Ce que la case fait, pourquoi elle existe, et ce qui surprend.
 *
 * Sans ça, une matrice de 34 droits se coche « au cas où » et ne protège plus
 * rien. Le registre est la source ; quand une fiche manque, l'aide disparaît
 * plutôt que d'afficher une bulle vide.
 */
function DocHelp({ look, text }: { look: Look; text: RoleDocText | undefined }) {
  if (!text || (!text.what && !text.why && !text.pitfalls)) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-muted-foreground md:size-8"
            aria-label={text.label}
          />
        }
      >
        <HelpCircleIcon className="size-3.5" />
      </PopoverTrigger>
      {/* Plafonné à la largeur du téléphone : une bulle de 320 px déborde d'un
          écran de 360 px une fois les marges de la carte comptées. */}
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm">
        <div className="flex items-start gap-2">
          <LookIcon look={look} size="sm" />
          <p className="min-w-0 font-medium break-words">{text.label}</p>
        </div>
        {text.what ? <p className="text-xs text-muted-foreground">{text.what}</p> : null}
        {text.why ? <p className="text-xs text-muted-foreground">{text.why}</p> : null}
        {text.pitfalls ? (
          <div className="rounded-md bg-amber-500/10 p-2 text-xs text-muted-foreground">
            <AlertTriangleIcon className="mr-1 inline size-3.5 text-amber-700 dark:text-amber-400" />
            {text.pitfalls}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ── Une case à cocher, avec son mot ──────────────────────────────────────────

/**
 * Un interrupteur porte TOUJOURS son libellé visible : douze colonnes de
 * pictogrammes ne se relisent pas, et sur un téléphone elles ne tiennent pas.
 */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
  help,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  help?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2.5 py-1 md:min-h-9">
        <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        <span className="min-w-0">
          <span className="block text-sm font-medium break-words">{label}</span>
          {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
        </span>
      </label>
      {help}
    </div>
  );
}

// ── Onglet : les droits ──────────────────────────────────────────────────────

function PermissionsTab({
  role,
  docs,
  onChange,
}: {
  role: Role;
  docs: RolesDocs;
  onChange: (next: Role) => void;
}) {
  const t = useTranslations("admin");

  const toggle = (key: PermissionKey, value: boolean) => {
    const perms = { ...role.perms };
    if (value) perms[key] = true;
    else delete perms[key];
    onChange({ ...role, perms });
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium">{t("roles.permissionsTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("roles.permissionsDesc")}</p>
      </div>

      {PERMISSION_GROUPS.map((group: PermissionGroup) => {
        const look = PERMISSION_GROUP_LOOK[group];
        return (
          <section key={group} className="rounded-xl border">
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <LookIcon look={look} size="sm" />
              <h4 className="text-sm font-medium">{docs.groups[group]?.label ?? group}</h4>
            </header>
            <div className="grid gap-x-6 px-3 py-2 md:grid-cols-2">
              {permissionsOfGroup(group).map((key) => {
                const text = docs.permissions[key];
                const help = <DocHelp look={look} text={text} />;
                // Les deux clés de la maison n'ont PAS d'interrupteur, même
                // éteint : un interrupteur grisé se lit « pas encore », alors
                // que c'est « jamais » (le serveur les retire de toute façon).
                // La ligne reste, avec son motif — sinon on cherche le droit
                // disparu de la liste.
                if (LOCKED_TO_ADMIN.includes(key)) {
                  return (
                    <div key={key} className="flex items-start justify-between gap-2">
                      <div className="flex min-h-11 flex-1 items-center py-1 md:min-h-9">
                        <span className="min-w-0">
                          <span className="block text-sm font-medium break-words text-muted-foreground">
                            {text?.label ?? key}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t("roles.permissionsLocked")}
                          </span>
                        </span>
                      </div>
                      {help}
                    </div>
                  );
                }
                return (
                  <SwitchRow
                    key={key}
                    label={text?.label ?? key}
                    checked={role.perms[key] === true}
                    onCheckedChange={(value) => toggle(key, value)}
                    help={help}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Onglet : les fiches des autres ───────────────────────────────────────────

type BucketInfo = { key: string; label: string; hint: string; look: Look | null };

function BucketBlock({
  role,
  bucket,
  docs,
  onChange,
}: {
  role: Role;
  bucket: BucketInfo;
  docs: RolesDocs;
  onChange: (next: Role) => void;
}) {
  const t = useTranslations("admin");
  const grants = storedGrants(role, bucket.key);
  const preset = presetOf(grants);

  const write = (next: Grants) => {
    // On n'enregistre que les cases ouvertes : une relation absente vaut
    // « tout fermé », et le fichier reste lisible à l'œil nu.
    const open: Partial<Grants> = {};
    for (const key of GRANT_KEYS) if (next[key]) open[key] = true;
    onChange({ ...role, relations: { ...role.relations, [bucket.key]: open } });
  };

  return (
    <section className="rounded-xl border">
      <header className="space-y-2 border-b p-3">
        <div className="flex items-start gap-2">
          {bucket.look ? <LookIcon look={bucket.look} size="sm" /> : null}
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-medium break-words">{bucket.label}</h4>
            <p className="text-xs text-muted-foreground">{bucket.hint}</p>
          </div>
          <Badge variant="outline" className="shrink-0 whitespace-nowrap">
            {t(PRESET_LABEL[preset])}
          </Badge>
        </div>
        {/* Trois gestes plutôt que douze : « invisible » et « lecture seule »
            sont les deux réglages que l'on pose vraiment, case par case on se
            trompe d'une ligne. */}
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant={preset === "invisible" ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => write(PRESETS.invisible())}
          >
            {t("roles.presetInvisible")}
          </Button>
          <Button
            variant={preset === "readOnly" ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => write(PRESETS.readOnly())}
          >
            {t("roles.presetReadOnly")}
          </Button>
          <Button
            variant={preset === "full" ? "default" : "outline"}
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => write(PRESETS.full())}
          >
            {t("roles.presetFull")}
          </Button>
        </div>
      </header>

      <div className="grid gap-x-6 p-3 md:grid-cols-2 lg:grid-cols-3">
        {GRANT_KEYS.map((key: GrantKey) => {
          const ceiling = GRANT_CEILING[key];
          // Le droit est le plafond : ouvrir la case ici ne rendrait rien.
          const allowed = ceiling === null || can(role, ceiling);
          const text = docs.grants[key];
          return (
            <SwitchRow
              key={key}
              label={text?.label ?? key}
              hint={allowed ? undefined : t("roles.ceilingOff")}
              checked={grants[key]}
              disabled={!allowed}
              onCheckedChange={(value) => write({ ...grants, [key]: value })}
              help={
                <DocHelp look={bucket.look ?? PERMISSION_GROUP_LOOK.clients} text={text} />
              }
            />
          );
        })}
      </div>

      {!grants.visible ? (
        <div className="px-3 pb-3">
          <Alert>
            <AlertTriangleIcon />
            <AlertDescription>{t("roles.invisibleWarning")}</AlertDescription>
          </Alert>
        </div>
      ) : null}
    </section>
  );
}

function RelationsTab({
  role,
  buckets,
  docs,
  onChange,
}: {
  role: Role;
  buckets: BucketInfo[];
  docs: RolesDocs;
  onChange: (next: Role) => void;
}) {
  const t = useTranslations("admin");
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("roles.relationsTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("roles.relationsDesc")}</p>
      </div>
      {buckets.map((bucket) => (
        <BucketBlock
          key={bucket.key}
          role={role}
          bucket={bucket}
          docs={docs}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

// ── Onglet : l'assignation ───────────────────────────────────────────────────

const ASSIGNMENT_SWITCHES = ["claimPool", "release", "assignToOthers", "takeFromOthers"] as const;

function AssignmentTab({ role, onChange }: { role: Role; onChange: (next: Role) => void }) {
  const t = useTranslations("admin");
  const rules = role.assignment;

  const set = (patch: Partial<AssignmentRules>) =>
    onChange({ ...role, assignment: { ...rules, ...patch } });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("roles.assignmentTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("roles.assignmentDesc")}</p>
      </div>

      <div className="grid gap-x-6 rounded-xl border p-3 md:grid-cols-2">
        {ASSIGNMENT_SWITCHES.map((key) => (
          <SwitchRow
            key={key}
            label={t(`roles.${key}`)}
            checked={rules[key]}
            onCheckedChange={(value) => set({ [key]: value })}
          />
        ))}
      </div>

      <div className="space-y-1.5 rounded-xl border p-3">
        <Label htmlFor={`maxOwned-${role.id}`}>{t("roles.maxOwned")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`maxOwned-${role.id}`}
            type="number"
            min={0}
            max={100000}
            inputMode="numeric"
            className="h-11 w-32 md:h-8"
            value={rules.maxOwned}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              set({ maxOwned: Number.isFinite(parsed) ? Math.max(0, Math.min(100000, parsed)) : 0 });
            }}
          />
          {/* Zéro ne se lit pas « aucune fiche » mais « aucun plafond » : le
              dire à côté du champ évite d'écrire 9999 pour être tranquille. */}
          {rules.maxOwned === 0 ? (
            <span className="text-sm text-muted-foreground">{t("roles.unlimited")}</span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t("roles.maxOwnedHint")}</p>
      </div>
    </div>
  );
}

// ── L'éditeur d'un rôle ──────────────────────────────────────────────────────

function RoleEditor({
  role,
  roles,
  defaultRoleId,
  memberCount,
  buckets,
  docs,
  locale,
  busy,
  onChange,
  onDuplicate,
  onDelete,
}: {
  role: Role;
  /** Tous les rôles — pour nommer les pastilles, et dire où retombent les comptes. */
  roles: Role[];
  defaultRoleId: string;
  /** Combien de comptes portent CE rôle : ce qui bouge si on le supprime. */
  memberCount: number;
  buckets: BucketInfo[];
  docs: RolesDocs;
  locale: "fr" | "en";
  busy: boolean;
  onChange: (next: Role) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const [confirming, setConfirming] = useState(false);
  const fallback = fallbackRoleFor(roles, defaultRoleId, role.id);
  const fallbackLook = roleLook(fallback?.look ?? "observer");

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <LookIcon look={roleLook(role.look)} size="lg" />
          <div className="min-w-0 space-y-0.5">
            <CardTitle className="break-words">{roleName(role, locale)}</CardTitle>
            <CardDescription>{t("roles.lookHint")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              disabled={busy}
              onClick={onDuplicate}
            >
              <CopyIcon className="size-3.5" />
              {t("roles.duplicate")}
            </Button>
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    // Un rôle livré ne se supprime pas : le bouton reste
                    // visible mais inerte, et le motif s'affiche dessous —
                    // sinon on cherche le geste manquant.
                    disabled={role.builtin || busy}
                    aria-label={tc("actions.delete")}
                    className="min-h-11 min-w-11 text-destructive md:min-h-8 md:min-w-0"
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("roles.deleteTitle", { name: roleName(role, locale) })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t("roles.deleteDesc")}</AlertDialogDescription>
                </AlertDialogHeader>
                {/* « Ils retombent sur le rôle par défaut » ne dit ni COMBIEN
                    ils sont ni LEQUEL c'est — et c'est exactement ce qu'on
                    veut savoir avant de cliquer. Hors de la description : elle
                    se rend en <p>, un rang de pastilles n'y a pas sa place. */}
                {memberCount > 0 && fallback ? (
                  <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-start">
                    <Badge variant="outline">{t("roles.members", { count: memberCount })}</Badge>
                    <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    <Badge variant="outline" className="gap-1" style={lookTint(fallbackLook)}>
                      <LookGlyph look={fallbackLook} className="size-3" />
                      {roleName(fallback, locale)}
                    </Badge>
                    {fallback.id === defaultRoleId ? (
                      <Badge variant="outline">{t("roles.defaultBadge")}</Badge>
                    ) : null}
                  </div>
                ) : null}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy} className="min-h-11 md:min-h-8">
                    {tc("actions.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    className="min-h-11 md:min-h-8"
                    onClick={() => {
                      setConfirming(false);
                      onDelete();
                    }}
                  >
                    {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
                    {tc("actions.delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {role.builtin ? (
          <p className="text-xs text-muted-foreground">{t("roles.deleteBlocked")}</p>
        ) : null}

        {role.superAdmin ? (
          <Alert>
            <AlertDescription>{t("roles.adminLocked")}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`nameFr-${role.id}`}>{t("roles.nameFr")}</Label>
                <Input
                  id={`nameFr-${role.id}`}
                  className="h-11 md:h-8"
                  value={role.nameFr}
                  maxLength={60}
                  onChange={(event) => onChange({ ...role, nameFr: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`nameEn-${role.id}`}>{t("roles.nameEn")}</Label>
                <Input
                  id={`nameEn-${role.id}`}
                  className="h-11 md:h-8"
                  value={role.nameEn}
                  maxLength={60}
                  onChange={(event) => onChange({ ...role, nameEn: event.target.value })}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor={`look-${role.id}`}>{t("roles.look")}</Label>
                <LookPicker
                  id={`look-${role.id}`}
                  value={role.look}
                  roles={roles}
                  locale={locale}
                  onChange={(look) => onChange({ ...role, look })}
                />
              </div>
            </div>

            <Tabs defaultValue="permissions">
              <div className="-mx-2 overflow-x-auto px-2 md:mx-0 md:px-0">
                <TabsList className="w-max">
                  <TabsTrigger value="permissions" className="min-h-11 md:min-h-8">
                    {t("roles.tabPermissions")}
                  </TabsTrigger>
                  <TabsTrigger value="relations" className="min-h-11 md:min-h-8">
                    {t("roles.tabRelations")}
                  </TabsTrigger>
                  <TabsTrigger value="assignment" className="min-h-11 md:min-h-8">
                    {t("roles.tabAssignment")}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="permissions" className="pt-4">
                <PermissionsTab role={role} docs={docs} onChange={onChange} />
              </TabsContent>
              <TabsContent value="relations" className="pt-4">
                <RelationsTab role={role} buckets={buckets} docs={docs} onChange={onChange} />
              </TabsContent>
              <TabsContent value="assignment" className="pt-4">
                <AssignmentTab role={role} onChange={onChange} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Le choix de la pastille ──────────────────────────────────────────────────

/**
 * Quatre pastilles, pas une par rôle : elles disent le NIVEAU d'autorité, et
 * quinze pictogrammes dans une colonne ne se distinguent plus. Chaque option
 * porte le nom du rôle livré qui l'emploie — c'est ce niveau-là qu'elle dit.
 */
function LookPicker({
  id,
  value,
  roles,
  locale,
  onChange,
}: {
  id: string;
  value: string;
  /** Sert à NOMMER les pastilles : chacune porte le nom du rôle livré qui l'emploie. */
  roles: Role[];
  locale: "fr" | "en";
  onChange: (look: string) => void;
}) {
  const keys = Object.keys(ROLE_LOOK);
  const label = (key: string) => {
    const owner = roles.find((role) => role.builtin && role.look === key);
    return owner ? roleName(owner, locale) : key;
  };
  return (
    <Select
      items={keys.map((key) => ({ value: key, label: label(key) }))}
      value={value}
      onValueChange={(next) => onChange(String(next))}
    >
      <SelectTrigger id={id} className="min-h-11 w-full md:min-h-0">
        <LookGlyph look={roleLook(value)} className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {keys.map((key) => (
          <SelectItem key={key} value={key}>
            <LookGlyph look={roleLook(key)} className="size-3.5" />
            {label(key)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Le dialogue de création ──────────────────────────────────────────────────

export type CreateSeed = { nameFr: string; nameEn: string; look: string; basedOn: string };

function CreateRoleDialog({
  seed,
  roles,
  choices,
  locale,
  busy,
  onCancel,
  onCreate,
}: {
  seed: CreateSeed;
  /** Tous les rôles — pour nommer les pastilles. */
  roles: Role[];
  /** Ceux dont on peut RECOPIER les droits (l'administrateur n'en a pas d'écrits). */
  choices: Role[];
  locale: "fr" | "en";
  busy: boolean;
  onCancel: () => void;
  onCreate: (draft: CreateSeed) => void;
}) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const [draft, setDraft] = useState<CreateSeed>(seed);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("roles.createTitle")}</DialogTitle>
          <DialogDescription>{t("roles.createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="create-role-fr">{t("roles.nameFr")}</Label>
            <Input
              id="create-role-fr"
              className="h-11 md:h-9"
              value={draft.nameFr}
              maxLength={60}
              onChange={(event) => setDraft({ ...draft, nameFr: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-role-en">{t("roles.nameEn")}</Label>
            <Input
              id="create-role-en"
              className="h-11 md:h-9"
              value={draft.nameEn}
              maxLength={60}
              onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-role-look">{t("roles.look")}</Label>
            <LookPicker
              id="create-role-look"
              value={draft.look}
              roles={roles}
              locale={locale}
              onChange={(look) => setDraft({ ...draft, look })}
            />
            <p className="text-xs text-muted-foreground">{t("roles.lookHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-role-based">{t("roles.basedOn")}</Label>
            {/* L'administrateur ne figure pas dans la liste : ses droits ne
                sont écrits nulle part (il a tout par construction), le copier
                donnerait un rôle vide. */}
            <Select
              items={choices.map((role) => ({ value: role.id, label: roleName(role, locale) }))}
              value={draft.basedOn}
              onValueChange={(next) => setDraft({ ...draft, basedOn: String(next) })}
            >
              <SelectTrigger id="create-role-based" className="min-h-11 w-full md:min-h-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    <LookGlyph look={roleLook(role.look)} className="size-3.5" />
                    {roleName(role, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            disabled={busy}
            onClick={onCancel}
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            className="min-h-11 md:min-h-9"
            disabled={busy}
            onClick={() => onCreate(draft)}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
            {t("roles.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── La liste des rôles ───────────────────────────────────────────────────────

function RoleRow({
  role,
  locale,
  selected,
  isDefault,
  count,
  members,
  summary,
  busy,
  onSelect,
  onSetDefault,
}: {
  role: Role;
  locale: "fr" | "en";
  selected: boolean;
  isDefault: boolean;
  count: number;
  members: string[];
  summary: string;
  busy: boolean;
  onSelect: () => void;
  onSetDefault: () => void;
}) {
  const t = useTranslations("admin");
  const look = roleLook(role.look);

  return (
    <li className={selected ? "bg-muted/50" : undefined}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <LookIcon look={look} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium break-words">{roleName(role, locale)}</span>
            {role.superAdmin ? (
              <Badge variant="outline" className="gap-1" style={lookTint(look)}>
                <LookGlyph look={look} className="size-3" />
                {t("roles.adminBadge")}
              </Badge>
            ) : null}
            {role.builtin ? <Badge variant="outline">{t("roles.builtinBadge")}</Badge> : null}
            {isDefault ? <Badge variant="outline">{t("roles.defaultBadge")}</Badge> : null}
          </span>
          <span className="block text-xs text-muted-foreground">
            {count > 0 ? t("roles.members", { count }) : t("roles.membersNone")}
            {members.length > 0 ? ` — ${members.slice(0, 3).join(", ")}${members.length > 3 ? " …" : ""}` : ""}
          </span>
          {/* Ce que le rôle VOIT, en une ligne : c'est la question qu'on se
              pose devant la liste, pas le détail des 34 droits. */}
          <span className="line-clamp-2 block text-xs text-muted-foreground">{summary}</span>
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 md:min-h-8"
          // L'administrateur ne peut pas être le rôle par défaut : tout compte
          // sans affectation deviendrait administrateur au chargement suivant.
          disabled={busy || isDefault || role.superAdmin}
          onClick={onSetDefault}
        >
          {t("roles.setDefault")}
        </Button>
        {isDefault ? (
          <span className="text-xs text-muted-foreground">{t("roles.defaultHint")}</span>
        ) : null}
      </div>
    </li>
  );
}

// ── Les règles communes ──────────────────────────────────────────────────────

const GLOBAL_SWITCHES = ["claimOnCall", "notifyAssignee", "notifyPreviousOwner"] as const;

function GlobalRulesCard({
  config,
  onChange,
}: {
  config: PermissionsConfig;
  onChange: (next: PermissionsConfig) => void;
}) {
  const t = useTranslations("admin");
  const rules = config.assignment;

  const set = (patch: Partial<PermissionsConfig["assignment"]>) =>
    onChange({ ...config, assignment: { ...rules, ...patch } });

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle>{t("roles.globalTitle")}</CardTitle>
        <CardDescription>{t("roles.globalDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="staleDays">{t("roles.staleDays")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="staleDays"
              type="number"
              min={0}
              max={3650}
              inputMode="numeric"
              className="h-11 w-32 md:h-8"
              value={rules.staleDays}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                set({
                  staleDays: Number.isFinite(parsed) ? Math.max(0, Math.min(3650, parsed)) : 0,
                });
              }}
            />
            {rules.staleDays === 0 ? (
              <span className="text-sm text-muted-foreground">{t("roles.staleNever")}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("roles.staleDaysHint")}</p>
        </div>

        <div className="grid gap-x-6 md:grid-cols-2">
          {GLOBAL_SWITCHES.map((key) => (
            <SwitchRow
              key={key}
              label={t(`roles.${key}`)}
              hint={key === "claimOnCall" ? t("roles.claimOnCallHint") : undefined}
              checked={rules[key]}
              onCheckedChange={(value) => set({ [key]: value })}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── L'écran ──────────────────────────────────────────────────────────────────

export function RolesClient({ config, counts, members, docs, locale }: RolesClientProps) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();

  const snapshot = useMemo(() => JSON.stringify(config), [config]);
  /** Ce que le serveur a envoyé en dernier — sert à repartir de zéro. */
  const [fromServer, setFromServer] = useState(snapshot);
  /** Ce qui est ENREGISTRÉ : le brouillon est « sale » dès qu'il en diffère. */
  const [baseline, setBaseline] = useState(snapshot);
  const [draft, setDraft] = useState<PermissionsConfig>(config);
  const [selectedId, setSelectedId] = useState<string>(
    () => config.roles.find((role) => !role.superAdmin)?.id ?? config.roles[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<CreateSeed | null>(null);

  // Une configuration neuve arrive (rafraîchissement, enregistrement fait
  // ailleurs) : le brouillon repart d'elle plutôt que de vivre sa vie.
  if (snapshot !== fromServer) {
    setFromServer(snapshot);
    setBaseline(snapshot);
    setDraft(config);
  }

  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);
  const selected = draft.roles.find((role) => role.id === selectedId) ?? draft.roles[0];

  const buckets: BucketInfo[] = useMemo(
    () => [
      { key: "own", label: t("roles.bucketOwn"), hint: t("roles.bucketOwnHint"), look: null },
      {
        key: "unassigned",
        label: t("roles.bucketUnassigned"),
        hint: t("roles.bucketUnassignedHint"),
        look: null,
      },
      ...draft.roles.map((role) => ({
        key: roleBucket(role.id),
        label: t("roles.bucketRole", { role: roleName(role, locale) }),
        hint: t("roles.bucketRoleHint"),
        look: roleLook(role.look),
      })),
    ],
    [draft.roles, locale, t],
  );

  /** Une phrase par rôle : les situations où la fiche EXISTE pour lui. */
  const summaryOf = (role: Role): string => {
    const seen = buckets
      .filter((bucket) => role.superAdmin || storedGrants(role, bucket.key).visible)
      .map((bucket) => bucket.label);
    return seen.length === 0
      ? t("roles.summaryNothing")
      : t("roles.summarySees", { list: seen.join(", ") });
  };

  /**
   * L'écriture, toujours entière : le serveur répare ce qu'on lui envoie
   * (`repairConfig`) et rend la configuration telle qu'elle est RÉELLEMENT
   * enregistrée — c'est elle qu'on adopte, pas l'intention. Sans ça, l'écran
   * continuerait d'afficher une case que le serveur vient de refuser.
   */
  const persist = async (next: PermissionsConfig, message: string) => {
    setBusy(true);
    try {
      const res = await api<{ config?: PermissionsConfig } & Partial<PermissionsConfig>>(
        "/api/admin/roles",
        { method: "PUT", body: JSON.stringify(next) },
      );
      // La réponse porte la configuration réparée, à la racine ou sous `config`.
      const stored = res.config ?? (res.roles ? (res as PermissionsConfig) : next);
      setDraft(stored);
      setBaseline(JSON.stringify(stored));
      toast.success(message);
      router.refresh();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      toast.error(
        code === "notFound"
          ? t("roles.errorNotFound")
          : code === "forbidden"
            ? t("roles.errorForbidden")
            : // Le rôle d'un compte a bougé ailleurs (/admin/users) pendant
              // qu'on éditait : la matrice n'est pas cassée, elle est vieille.
              // « Enregistrement impossible. Réessayez. » ferait réessayer
              // pour rien, indéfiniment.
              code === "user_roles_readonly"
              ? t("roles.errorStale")
              : t("roles.errorGeneric"),
      );
    } finally {
      setBusy(false);
    }
  };

  const updateRole = (next: Role) =>
    setDraft((current) => ({
      ...current,
      roles: current.roles.map((role) => (role.id === next.id ? next : role)),
    }));

  const createRole = (seed: CreateSeed) => {
    const nameFr = seed.nameFr.trim();
    const nameEn = seed.nameEn.trim();
    if (!nameFr || !nameEn) {
      toast.error(t("roles.errorNameRequired"));
      return;
    }
    const source = draft.roles.find((role) => role.id === seed.basedOn && !role.superAdmin);
    const role: Role = {
      id: freshRoleId(nameEn, nameFr, new Set(draft.roles.map((r) => r.id))),
      nameFr,
      nameEn,
      builtin: false,
      superAdmin: false,
      look: seed.look,
      perms: source ? { ...source.perms } : {},
      relations: source ? cloneRelations(source.relations) : {},
      assignment: source ? { ...source.assignment } : { ...EMPTY_ASSIGNMENT },
      sortOrder: Math.min(999, Math.max(0, ...draft.roles.map((r) => r.sortOrder)) + 1),
    };
    setSelectedId(role.id);
    setCreating(null);
    void persist({ ...draft, roles: [...draft.roles, role] }, t("roles.created"));
  };

  const deleteRole = (role: Role) => {
    if (role.builtin || role.superAdmin) return;
    // On efface aussi le compartiment que les autres rôles lui consacraient :
    // sans ça, un identifiant réutilisé ressusciterait de vieux réglages.
    const roles = draft.roles
      .filter((r) => r.id !== role.id)
      .map((r) => {
        if (!(roleBucket(role.id) in r.relations)) return r;
        const relations = { ...r.relations };
        delete relations[roleBucket(role.id)];
        return { ...r, relations };
      });
    // `userRoles` part TEL QUEL, membres du rôle supprimé compris : cet écran
    // n'a pas le droit de changer le rôle d'un compte (ça se fait dans
    // /admin/users, qui écrit `users.role` et la configuration ensemble), et
    // le serveur refuse un envoi qui s'y essaie. C'est `repairConfig` qui
    // oublie les affectations devenues orphelines — les comptes retombent
    // alors sur le rôle par défaut, ce que la confirmation vient d'annoncer.
    setSelectedId(roles.find((r) => !r.superAdmin)?.id ?? roles[0]?.id ?? "");
    void persist({ ...draft, roles }, t("roles.deleted"));
  };

  const copyChoices = draft.roles.filter((role) => !role.superAdmin);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          className="min-h-11 md:min-h-9"
          disabled={!dirty || busy}
          onClick={() => setDraft(config)}
        >
          {tc("actions.cancel")}
        </Button>
        <Button
          className="min-h-11 md:min-h-9"
          disabled={!dirty || busy}
          onClick={() => void persist(draft, t("roles.saved"))}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
          {tc("actions.save")}
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
        <Card className="shadow-xs">
          <CardHeader className="border-b">
            <CardTitle>{t("roles.title")}</CardTitle>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={busy}
                onClick={() =>
                  setCreating({
                    nameFr: "",
                    nameEn: "",
                    look: "caller",
                    basedOn: copyChoices[0]?.id ?? "",
                  })
                }
              >
                <PlusIcon />
                {t("roles.create")}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {draft.roles.map((role) => (
                <RoleRow
                  key={role.id}
                  role={role}
                  locale={locale}
                  selected={selected?.id === role.id}
                  isDefault={draft.defaultRoleId === role.id}
                  count={counts[role.id] ?? 0}
                  members={members[role.id] ?? []}
                  summary={summaryOf(role)}
                  busy={busy}
                  onSelect={() => setSelectedId(role.id)}
                  onSetDefault={() =>
                    void persist({ ...draft, defaultRoleId: role.id }, t("roles.saved"))
                  }
                />
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {selected ? (
            <RoleEditor
              role={selected}
              roles={draft.roles}
              defaultRoleId={draft.defaultRoleId}
              memberCount={counts[selected.id] ?? 0}
              buckets={buckets}
              docs={docs}
              locale={locale}
              busy={busy}
              onChange={updateRole}
              onDuplicate={() =>
                setCreating({
                  nameFr: selected.nameFr,
                  nameEn: selected.nameEn,
                  look: selected.look,
                  basedOn: selected.superAdmin ? (copyChoices[0]?.id ?? "") : selected.id,
                })
              }
              onDelete={() => deleteRole(selected)}
            />
          ) : null}

          <GlobalRulesCard config={draft} onChange={setDraft} />

          <Card className="shadow-xs">
            <CardHeader className="border-b">
              <CardTitle>{t("roles.assignRoleTitle")}</CardTitle>
              <CardDescription>{t("roles.assignRoleDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                className="min-h-11 md:min-h-9"
                render={<Link href="/admin/users" />}
              >
                {t("roles.openUsers")}
                <ArrowRightIcon />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {creating ? (
        <CreateRoleDialog
          seed={creating}
          roles={draft.roles}
          choices={copyChoices}
          locale={locale}
          busy={busy}
          onCancel={() => setCreating(null)}
          onCreate={createRole}
        />
      ) : null}
    </div>
  );
}
