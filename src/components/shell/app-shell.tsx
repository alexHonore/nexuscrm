"use client";

import {
  BarChart3,
  Bell,
  CalendarDays,
  Columns3,
  FileText,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Phone,
  PhoneCall,
  Settings,
  ShieldCheck,
  Upload,
  Users,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  { href: "/admin/import-export", labelKey: "importExport", icon: Upload },
  { href: "/admin/webhooks", labelKey: "webhooks", icon: KeyRound },
  { href: "/admin/audit", labelKey: "audit", icon: ShieldCheck },
  { href: "/admin/settings", labelKey: "settings", icon: Settings },
];

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
  const [, startTransition] = useTransition();

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
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{t(`nav.${item.labelKey}`)}</span>
        {item.labelKey === "notifications" && unreadCount > 0 ? (
          <Badge className="ml-auto h-5 min-w-5 rounded-full px-1.5 text-[11px]">{unreadCount}</Badge>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="flex min-h-dvh">
      {/* ── Sidebar (desktop) ── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
            N
          </div>
          <span className="text-base font-semibold tracking-tight">Groupe Nexus</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {MAIN_NAV.map(navLink)}
          {user.role === "admin" ? (
            <>
              <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {t("nav.admin")}
              </p>
              {ADMIN_NAV.map(navLink)}
            </>
          ) : null}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <UserMenu user={user} onSwitchLocale={switchLocale} align="start" />
        </div>
      </aside>

      {/* ── Contenu ── */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        {/* Barre supérieure mobile */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur md:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              N
            </div>
            <span className="text-sm font-semibold">Groupe Nexus</span>
          </Link>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="relative"
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
        <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background/95 backdrop-blur md:hidden">
          {MOBILE_NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <Icon className="size-5" />
                  {item.labelKey === "notifications" && unreadCount > 0 ? (
                    <span className="absolute -right-1.5 -top-1 size-2 rounded-full bg-destructive" />
                  ) : null}
                </span>
                {t(`nav.${item.labelKey}`)}
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
          render={<Button variant="ghost" size="icon" aria-label={t("nav.profile")} />}
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-primary text-xs text-primary-foreground">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/60">
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
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel className="truncate">{user.name}</DropdownMenuLabel>
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
        <DropdownMenuItem onClick={() => onSwitchLocale(user.locale === "fr" ? "en" : "fr")}>
          <Globe className="size-4" />
          {user.locale === "fr" ? "English" : "Français"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
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
