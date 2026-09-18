"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { DASHBOARD_LOOK, LookIcon } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FollowupItem, type FollowupItemData } from "./followup-item";
import { UpcomingFollowups, type FollowupDayGroup } from "./upcoming-followups";

const INITIAL_FOCUS_COUNT = 8;

/** Une seule file de travail : les échéances dépassées restent en tête. */
export function FollowupWorkspace({
  overdue,
  today,
  upcoming,
  overdueCount,
  todayCount,
  upcomingCount,
  truncated,
  months,
}: {
  overdue: FollowupItemData[];
  today: FollowupItemData[];
  upcoming: FollowupDayGroup[];
  overdueCount: number;
  todayCount: number;
  upcomingCount: number;
  truncated: number;
  months: number;
}) {
  const t = useTranslations("dashboard");
  const [expanded, setExpanded] = useState(false);
  const focusCount = overdueCount + todayCount;
  const [view, setView] = useState<string>(focusCount > 0 || upcomingCount === 0 ? "today" : "upcoming");
  const loadedFocusCount = overdue.length + today.length;
  const visibleOverdue = expanded ? overdue : overdue.slice(0, INITIAL_FOCUS_COUNT);
  const visibleToday = expanded ? today : today.slice(0, Math.max(0, INITIAL_FOCUS_COUNT - overdue.length));
  const hidden = Math.max(0, loadedFocusCount - INITIAL_FOCUS_COUNT);

  useEffect(() => {
    // A repeated click on the same anchor does not emit hashchange. Listen
    // to the link intent as well so the priority card always opens today's queue.
    const focusToday = () => {
      if (window.location.hash === "#followups") setView("today");
    };
    const onPriorityClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href="#followups"]')) {
        setView("today");
      }
    };
    window.addEventListener("hashchange", focusToday);
    document.addEventListener("click", onPriorityClick);
    return () => {
      window.removeEventListener("hashchange", focusToday);
      document.removeEventListener("click", onPriorityClick);
    };
  }, []);

  return (
    <Card className="rounded-2xl shadow-xs [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <LookIcon look={DASHBOARD_LOOK.followups} />
          {t("followups.title")}
          <Badge variant="secondary" className="tabular-nums">{focusCount + upcomingCount}</Badge>
        </CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("followups.subtitle")}</p>
      </CardHeader>
      <CardContent>
        <Tabs value={view} onValueChange={setView}>
          <TabsList className="mb-5 grid min-h-12 w-full grid-cols-2 rounded-xl" aria-label={t("followups.viewLabel")}>
            <TabsTrigger value="today" className="min-h-11 rounded-lg px-3 text-xs sm:text-sm">
              {t("followups.focus")}
              <span className="ml-1 rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs tabular-nums">{focusCount}</span>
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="min-h-11 rounded-lg px-3 text-xs sm:text-sm">
              {t("followups.upcoming")}
              <span className="ml-1 rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs tabular-nums">{upcomingCount}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="today" className="space-y-5">
            {focusCount === 0 ? (
              <EmptyState className="py-10" icon={<LookIcon look={DASHBOARD_LOOK.clear} />} title={t("followups.focusEmpty")} hint={t("followups.focusEmptyHint")} />
            ) : (
              <>
                {visibleOverdue.length > 0 ? (
                  <div className="space-y-2.5">
                    <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider">
                      <LookIcon look={DASHBOARD_LOOK.overdue} className="size-3.5" />
                      {t("followups.overdue")}
                      <span className="font-normal tabular-nums text-muted-foreground">{overdueCount}</span>
                    </p>
                    <ul className="space-y-2">{visibleOverdue.map((item) => <FollowupItem key={item.id} item={item} />)}</ul>
                  </div>
                ) : null}
                {visibleToday.length > 0 ? (
                  <div className="space-y-2.5">
                    <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <LookIcon look={DASHBOARD_LOOK.agenda} className="size-3.5" />
                      {t("followups.dueToday")}
                      <span className="font-normal tabular-nums">{todayCount}</span>
                    </p>
                    <ul className="space-y-2">{visibleToday.map((item) => <FollowupItem key={item.id} item={item} />)}</ul>
                  </div>
                ) : null}
                {hidden > 0 ? (
                  <Button variant="ghost" className="min-h-11 w-full text-xs text-muted-foreground" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                    {expanded ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
                    {expanded ? t("followups.showLess") : t("followups.showMore", { count: hidden })}
                  </Button>
                ) : null}
              </>
            )}
          </TabsContent>
          <TabsContent value="upcoming" className="space-y-4">
            <p className="text-xs text-muted-foreground">{t("followups.planningHorizon", { months })}</p>
            {upcomingCount === 0 ? (
              <EmptyState className="py-10" icon={<LookIcon look={DASHBOARD_LOOK.agenda} />} title={t("followups.upcomingEmpty")} />
            ) : <UpcomingFollowups groups={upcoming} />}
          </TabsContent>
        </Tabs>
        {truncated > 0 ? (
          <p className="mt-4 border-t pt-4 text-xs leading-relaxed text-muted-foreground">{t("followups.loadedLimit", { count: truncated })}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
