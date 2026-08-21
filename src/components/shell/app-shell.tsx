"use client";

import {
  BarChart3,
  Bot,
  Bell,
  CalendarDays,
  ChevronsUpDown,
  Columns3,
  FileText,
  Globe,
  KeyRound,
  Megaphone,
  LayoutDashboard,
  LogOut,
  Phone,
  PhoneCall,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserRound,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { logoutAction, setLocaleAction } from "@/app/actions";
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
import { cn } from "@/lib/utils";

export type ShellUser = {
  id: string;
  name: string;
  role: "admin" | "caller";
  locale: "fr" | "en";
};

type NavItem = {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
};

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/clients", labelKey: "clients", icon: UsersRound },
  { href: "/pipeline", labelKey: "pipeline", icon: Columns3 },
  { href: "/calls", labelKey: "callsShort", icon: PhoneCall },
  { href: "/appointments", labelKey: "appointments", icon: CalendarDays },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
];

/** Nav basse mobile : 5 onglets — les notifications restent sur la cloche du haut. */
const MOBILE_NAV = MAIN_NAV.filter((i) => i.labelKey !== "notifications");

const ADMIN_NAV: NavItem[] = [
  { href: "/admin/users", labelKey: "users", icon: Users },
  { href: "/admin/pipeline", labelKey: "pipelineSettings", icon: FileText },
  { href: "/admin/analytics", labelKey: "analytics", icon: BarChart3 },
  { href: "/admin/calls", labelKey: "calls", icon: PhoneCall },
  { href: "/admin/billing", labelKey: "billing", icon: Wallet },
  { href: "/admin/import-export", labelKey: "importExport", icon: Upload },
  { href: "/admin/webhooks", labelKey: "webhooks", icon: KeyRound },
  { href: "/admin/audit", labelKey: "audit", icon: ShieldCheck },
  { href: "/admin/assistants", labelKey: "assistants", icon: Bot },
  { href: "/admin/campaigns", labelKey: "campaigns", icon: Megaphone },
  { href: "/admin/guardrails", labelKey: "guardrails", icon: ShieldAlert },
  { href: "/admin/settings", labelKey: "settings", icon: Settings },
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

export function AppShell({
  user,
  unreadCount,
  children,
}: {
  user: ShellUser;
  unreadCount: number;
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
          {MAIN_NAV.map(navLink)}
          {user.role === "admin" ? (
            <div className="mt-4 space-y-1 border-t border-sidebar-border/60 pt-4">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {t("nav.admin")}
              </p>
              {ADMIN_NAV.map(navLink)}
            </div>
          ) : null}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <UserMenu user={user} onSwitchLocale={switchLocale} align="start" />
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
            <UserMenu user={user} onSwitchLocale={switchLocale} align="end" compact />
          </div>
        </header>

        {/* pb mobile : dégage la nav basse + le FAB webphone (size-14 au-dessus de la nav). */}
        <main className="min-w-0 flex-1 pb-[calc(8.5rem+env(safe-area-inset-bottom))] md:pb-8">
          {children}
        </main>

        {/* ── Nav basse (mobile) ── */}
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background/95 shadow-[0_-2px_10px_-6px_rgb(0_0_0/0.2)] backdrop-blur md:hidden">
          {MOBILE_NAV.map((item) => {
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
  onSwitchLocale,
  align,
  compact,
}: {
  user: ShellUser;
  onSwitchLocale: (locale: "fr" | "en") => void;
  align: "start" | "end";
  compact?: boolean;
}) {
  const t = useTranslations("common");
  const pathname = usePathname();
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
            <span className="block text-xs text-sidebar-foreground/60">
              {user.role === "admin" ? t("roleAdmin") : t("roleCaller")}
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
          <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
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
        {compact && user.role === "admin" ? (
          <>
            {/* Liens admin — accessibles ici sur mobile, la sidebar étant cachée sous md. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("nav.admin")}</DropdownMenuLabel>
              {ADMIN_NAV.map((item) => {
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
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          className={cn(compact && "h-11")}
          onClick={() => onSwitchLocale(user.locale === "fr" ? "en" : "fr")}
        >
          <Globe className="size-4" />
          {user.locale === "fr" ? "English" : "Français"}
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
