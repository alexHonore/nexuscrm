"use client";

import {
  BarChart3,
  Bell,
  BookOpenText,
  Bot,
  CalendarDays,
  ChevronsUpDown,
  Columns3,
  FileText,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessageCircle,
  Phone,
  PhoneCall,
  Radar,
  Rocket,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldUser,
  Upload,
  UserRound,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { logoutAction, setLocaleAction } from "@/app/actions";
import { LookGlyph, roleLook } from "@/components/look";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDataChange, useVisiblePolling } from "@/lib/live";
import type { PermissionKey } from "@/lib/permissions/catalog";
import { cn } from "@/lib/utils";

export type ShellUser = {
  id: string;
  name: string;
  role: "admin" | "caller";
  locale: "fr" | "en";
};

/**
 * Le rôle CONFIGURÉ du regard courant, réduit à ce que la coquille affiche.
 *
 * Les deux noms voyagent ensemble plutôt que le bon : la langue de l'écran est
 * celle du cookie (`useLocale()`), et elle peut changer sans nouvelle requête
 * serveur — trancher côté serveur aurait figé le libellé sur la mauvaise.
 */
export type ShellRole = { look: string; nameFr: string; nameEn: string };

/** Ce que le regard courant a le droit d'ouvrir — résolu côté serveur. */
export type ShellPerms = Partial<Record<PermissionKey, boolean>>;

type NavItem = {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Le ou les droits qui ouvrent cette entrée. Absent = il suffit d'être
   * connecté. Plusieurs = l'un SUFFIT : certains écrans font deux choses
   * gardées séparément, et la page tranche ensuite moitié par moitié.
   */
  perm?: PermissionKey | readonly PermissionKey[];
};

/**
 * Les écrans de fiches ne portent AUCUN droit d'entrée : ils se filtrent de
 * l'intérieur (la visibilité décide fiche par fiche). Un observateur qui ne
 * voit rien y arrive sur une liste vide — cacher le menu lui ferait croire que
 * l'écran n'existe pas, alors qu'une fiche peut lui être assignée demain.
 */
const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/clients", labelKey: "clients", icon: UsersRound },
  { href: "/pipeline", labelKey: "pipeline", icon: Columns3 },
  { href: "/calls", labelKey: "callsShort", icon: PhoneCall },
  { href: "/appointments", labelKey: "appointments", icon: CalendarDays },
  {
    href: "/conversations",
    labelKey: "conversations",
    icon: MessageCircle,
    perm: "conversations.view",
  },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
];

type NavGroup = { labelKey: string; items: NavItem[] };

/**
 * Navigation d'administration, par famille.
 *
 * Les trois écrans de l'IA — assistants, campagnes, garde-fous — forment un
 * système : un assistant sans garde-fou ne s'active pas, une campagne sans
 * assistant ne répond pas. Les lister à plat au milieu des utilisateurs et de
 * la facturation obligeait à reconstruire ce lien de tête à chaque fois.
 *
 * Chaque entrée porte le droit qui l'ouvre : ce n'est plus « es-tu
 * administrateur » mais « as-tu CE droit-là », et un superviseur voit
 * l'analytique sans voir les réglages.
 */
const ADMIN_GROUPS: NavGroup[] = [
  {
    labelKey: "groupAi",
    items: [
      { href: "/admin/assistants", labelKey: "assistants", icon: Bot, perm: "admin.assistants" },
      { href: "/admin/campaigns", labelKey: "campaigns", icon: Megaphone, perm: "admin.campaigns" },
      {
        href: "/admin/guardrails",
        labelKey: "guardrails",
        icon: ShieldAlert,
        perm: "admin.guardrails",
      },
      // La mise en service n'a pas de droit à elle : elle bascule les réglages
      // de l'installation, donc elle suit exactement celui des réglages.
      { href: "/admin/go-live", labelKey: "goLive", icon: Rocket, perm: "admin.settings" },
      { href: "/admin/docs", labelKey: "docs", icon: BookOpenText, perm: "admin.docs" },
    ],
  },
  {
    labelKey: "groupData",
    items: [
      { href: "/admin/users", labelKey: "users", icon: Users, perm: "admin.users" },
      { href: "/admin/roles", labelKey: "roles", icon: ShieldUser, perm: "admin.roles" },
      {
        href: "/admin/pipeline",
        labelKey: "pipelineSettings",
        icon: FileText,
        perm: "admin.pipeline",
      },
      // L'écran fait les deux sens et garde CHAQUE carte pour elle-même : il
      // ne se ferme (redirection vers le tableau de bord) que si les deux
      // droits manquent. Le menu dit donc la même chose — le gater sur le seul
      // import privait d'export un rôle qui n'avait que l'export, sans qu'il
      // puisse deviner que l'écran existe.
      {
        href: "/admin/import-export",
        labelKey: "importExport",
        icon: Upload,
        perm: ["clients.import", "clients.export"],
      },
      { href: "/admin/webhooks", labelKey: "webhooks", icon: KeyRound, perm: "admin.webhooks" },
    ],
  },
  {
    labelKey: "groupInsights",
    items: [
      { href: "/admin/analytics", labelKey: "analytics", icon: BarChart3, perm: "admin.analytics" },
      {
        href: "/admin/deliverability",
        labelKey: "deliverability",
        icon: Radar,
        perm: "admin.deliverability",
      },
      { href: "/admin/calls", labelKey: "calls", icon: PhoneCall, perm: "admin.calls" },
      { href: "/admin/billing", labelKey: "billing", icon: Wallet, perm: "admin.billing" },
      { href: "/admin/audit", labelKey: "audit", icon: ShieldCheck, perm: "admin.audit" },
    ],
  },
  {
    labelKey: "groupSystem",
    items: [
      { href: "/admin/settings", labelKey: "settings", icon: Settings, perm: "admin.settings" },
    ],
  },
];

/**
 * Cadence de rafraîchissement de la pastille « non lues ».
 * Il n'existe pas de route de comptage dédiée : on redemande les données
 * serveur (router.refresh()), et seulement quand l'onglet est au premier plan.
 */
const NOTIFICATIONS_POLL_MS = 30_000;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Une entrée sans droit est ouverte à tout compte connecté ; avec plusieurs,
 * un seul suffit (OU) — c'est la règle de la page de destination qu'on recopie
 * ici, pas une politique du menu. Un lien qui renvoie au tableau de bord et un
 * écran sans lien sont la même faute vue des deux côtés.
 */
function allowed(item: NavItem, perms: ShellPerms): boolean {
  if (!item.perm) return true;
  const keys = typeof item.perm === "string" ? [item.perm] : item.perm;
  return keys.some((key) => perms[key] === true);
}

export function AppShellClient({
  user,
  unreadCount,
  perms,
  role,
  children,
}: {
  user: ShellUser;
  unreadCount: number;
  perms: ShellPerms;
  role: ShellRole;
  children: React.ReactNode;
}) {
  const t = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

  // `unreadCount` est rendu côté serveur : sans ça, la pastille reste figée
  // jusqu'à un rechargement complet. On redemande les données serveur quand une
  // notification change dans cet onglet, puis à intervalle tant que l'onglet est
  // visible (les notifications des collègues arrivent ainsi toutes seules).
  useDataChange(["notifications"], () => {
    router.refresh();
  });
  useVisiblePolling(NOTIFICATIONS_POLL_MS, () => {
    router.refresh();
  });

  const mainNav = MAIN_NAV.filter((item) => allowed(item, perms));

  /**
   * Nav basse mobile : les notifications restent sur la cloche du haut. Le
   * pipeline en sort aussi : un tableau kanban est le moins utilisable des
   * écrans sur un téléphone, alors que les conversations sont précisément
   * l'écran qu'un téléphoniste ouvre depuis son cellulaire entre deux appels.
   *
   * Elle se calcule ICI et plus au chargement du module : la liste dépend
   * maintenant du regard, qui n'existe pas à l'import.
   */
  const mobileNav = mainNav.filter(
    (i) => i.labelKey !== "notifications" && i.labelKey !== "pipeline",
  );

  // Un groupe dont toutes les entrées tombent ne garde pas son titre — et si
  // aucun ne survit, la section d'administration disparaît, séparateur compris.
  const adminGroups = ADMIN_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed(item, perms)),
  })).filter((group) => group.items.length > 0);

  const isActive = (href: string) =>
    pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));

  const switchLocale = (locale: "fr" | "en") => {
    startTransition(async () => {
      await setLocaleAction(locale);
      window.location.reload();
    });
  };

  const navLink = (item: NavItem) => {
    const Icon = item.icon;
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        // Toutes les entrées du menu sont visibles d'emblée : avec le préchargement
        // par défaut, CHAQUE affichage de page déclenchait le rendu serveur des 14
        // routes du menu (toutes dynamiques, toutes interrogeant la base). Elles se
        // disputaient le pool de connexions et ralentissaient la navigation en
        // cours. Les squelettes (loading.tsx) rendent la transition immédiate de
        // toute façon.
        prefetch={false}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-white/5 before:absolute before:left-0 before:top-1/2 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-sidebar-primary"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className={cn("size-4 shrink-0", active && "text-sidebar-primary")} />
        <span className="truncate">{t(`nav.${item.labelKey}`)}</span>
        {item.labelKey === "notifications" && unreadCount > 0 ? (
          <Badge className="ml-auto h-5 min-w-5 rounded-full bg-sidebar-primary px-1.5 text-[11px] text-sidebar-primary-foreground">
            {unreadCount}
          </Badge>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="flex min-h-dvh">
      {/* ── Sidebar (desktop) ── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2.5 border-b border-sidebar-border/60 px-5 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sidebar-primary to-sidebar-ring text-sm font-bold text-sidebar-primary-foreground shadow-md ring-1 ring-white/10">
            N
          </div>
          <div className="min-w-0">
            <span className="block truncate text-base font-semibold tracking-tight">
              Groupe Nexus
            </span>
            <span className="block truncate text-[11px] text-sidebar-foreground/50">
              {t("tagline")}
            </span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4 pt-4">
          {mainNav.map(navLink)}
          {adminGroups.length > 0 ? (
            <div className="mt-4 space-y-4 border-t border-sidebar-border/60 pt-4">
              {adminGroups.map((group) => (
                <div key={group.labelKey} className="space-y-1">
                  <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                    {t(`nav.${group.labelKey}`)}
                  </p>
                  {group.items.map(navLink)}
                </div>
              ))}
            </div>
          ) : null}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <UserMenu
            user={user}
            role={role}
            adminGroups={adminGroups}
            onSwitchLocale={switchLocale}
            align="start"
          />
        </div>
      </aside>

      {/* ── Contenu ── */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        {/* Barre supérieure mobile */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b bg-background/95 px-4 py-2.5 shadow-[0_1px_8px_-4px_rgb(0_0_0/0.15)] backdrop-blur md:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-sidebar-primary to-sidebar-ring text-xs font-bold text-sidebar-primary-foreground shadow-sm ring-1 ring-white/10">
              N
            </div>
            <span className="text-sm font-semibold">Groupe Nexus</span>
          </Link>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="relative size-11"
              render={<Link href="/notifications" aria-label={t("nav.notifications")} />}
            >
              <Bell className="size-5" />
              {unreadCount > 0 ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </Button>
            <UserMenu
              user={user}
              role={role}
              adminGroups={adminGroups}
              onSwitchLocale={switchLocale}
              align="end"
              compact
            />
          </div>
        </header>

        {/* pb mobile : dégage la nav basse + le FAB webphone (size-14 au-dessus de la nav). */}
        <main className="min-w-0 flex-1 pb-[calc(8.5rem+env(safe-area-inset-bottom))] md:pb-8">
          {children}
        </main>

        {/* ── Nav basse (mobile) ── */}
        <nav
          className="pb-safe fixed inset-x-0 bottom-0 z-40 grid border-t bg-background/95 shadow-[0_-2px_10px_-6px_rgb(0_0_0/0.2)] backdrop-blur md:hidden"
          // Le nombre de colonnes suit le nombre d'onglets RESTANTS. Il était
          // écrit en dur à cinq : dès qu'un droit en retire un, la barre gardait
          // sa cinquième colonne et tout partait de travers. Tailwind ne sait
          // pas fabriquer une classe à partir d'un compte connu à l'exécution.
          style={{ gridTemplateColumns: `repeat(${mobileNav.length}, minmax(0, 1fr))` }}
        >
          {mobileNav.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                    active && "bg-primary/10 [&_svg]:stroke-[2.4]",
                  )}
                >
                  <span className="relative">
                    <Icon className="size-5" />
                    {item.labelKey === "notifications" && unreadCount > 0 ? (
                      <span className="absolute -right-1.5 -top-1 size-2 rounded-full bg-destructive" />
                    ) : null}
                  </span>
                </span>
                <span className="max-w-full truncate px-1">{t(`nav.${item.labelKey}`)}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function UserMenu({
  user,
  role,
  adminGroups,
  onSwitchLocale,
  align,
  compact,
}: {
  user: ShellUser;
  role: ShellRole;
  adminGroups: NavGroup[];
  onSwitchLocale: (locale: "fr" | "en") => void;
  align: "start" | "end";
  compact?: boolean;
}) {
  const t = useTranslations("common");
  // La langue EFFECTIVE de l'écran (cookie NEXT_LOCALE), pas la préférence en
  // base : quand la préférence diverge du cookie (compte créé en anglais,
  // navigateur neuf), le bouton proposait la langue déjà affichée et le
  // premier clic ne changeait rien. Le nom du rôle suit la même langue.
  const locale = useLocale();
  const pathname = usePathname();
  const roleName = locale === "en" ? role.nameEn : role.nameFr;
  const look = roleLook(role.look);
  return (
    <DropdownMenu>
      {compact ? (
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon" className="size-11" aria-label={t("nav.profile")} />
          }
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-primary text-xs text-primary-foreground">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <Avatar className="size-8">
            <AvatarFallback className="bg-sidebar-primary text-xs text-sidebar-primary-foreground">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <LookGlyph look={look} className="size-3" />
              <span className="truncate">{roleName}</span>
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-sidebar-foreground/50" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align={align} className="w-60">
        {/* Base UI : GroupLabel DOIT être dans un Group, sinon le menu jette
            « error #31 » à l'ouverture et démonte toute l'app (constaté en
            prod : le menu utilisateur ne s'ouvrait jamais). */}
        <DropdownMenuGroup>
          {/* Un SEUL GroupLabel par groupe — Base UI n'en attend qu'un, et le
              rôle se lit ici aussi : sur mobile la gouttière est cachée, et
              sans ça le téléphone ne dirait jamais à quel titre on est connecté. */}
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-sm font-medium text-foreground">{user.name}</span>
            <span className="mt-0.5 flex items-center gap-1.5">
              <LookGlyph look={look} className="size-3" />
              <span className="truncate">{roleName}</span>
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={cn(
            compact && "h-11",
            pathname === "/profile" && "bg-accent text-accent-foreground",
          )}
          render={<Link href="/profile" />}
        >
          <UserRound className="size-4" />
          {t("nav.profile")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {compact && adminGroups.length > 0 ? (
          <>
            {/* Liens admin — accessibles ici sur mobile, la sidebar étant cachée
                sous md. La liste est celle DÉJÀ filtrée par la coquille : les
                deux menus ne peuvent pas diverger. */}
            {adminGroups.map((group) => (
              <DropdownMenuGroup key={group.labelKey}>
                {/* DropdownMenuLabel DOIT rester dans un DropdownMenuGroup :
                    hors groupe, Base UI démonte l'application (erreur #31). */}
                <DropdownMenuLabel>{t(`nav.${group.labelKey}`)}</DropdownMenuLabel>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <DropdownMenuItem
                      key={item.href}
                      className={cn("h-11", active && "bg-accent text-accent-foreground")}
                      render={<Link href={item.href} />}
                    >
                      <Icon className="size-4" />
                      {t(`nav.${item.labelKey}`)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          className={cn(compact && "h-11")}
          onClick={() => onSwitchLocale(locale === "fr" ? "en" : "fr")}
        >
          <Globe className="size-4" />
          {locale === "fr" ? "English" : "Français"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          className={cn(compact && "h-11")}
          onClick={() => {
            void logoutAction();
          }}
        >
          <LogOut className="size-4" />
          {t("nav.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Icône inutilisée gardée pour la nav du module webphone.
export { Phone as PhoneIcon };
