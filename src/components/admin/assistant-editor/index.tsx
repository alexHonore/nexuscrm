"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Play,
  Power,
  Save,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ASSISTANT_STATUS_LOOK,
  EDITOR_TAB_LOOK,
  LookGlyph,
  LookIcon,
  TONE,
  lookTint,
  type Look,
} from "@/components/look";
import type { AssistantConfig } from "@/lib/assistants/schema";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../api";
import { ParamDocsProvider, type ParamDocView } from "./param-help";
import {
  ApproachTab,
  GoalTab,
  IdentityTab,
  KnowledgeTab,
  ObjectionsTab,
  ToolsTab,
} from "./tabs-basic";
import { GuardrailsTab, JsonTab, PromptTab, TestTab } from "./tabs-advanced";
import { ModelTab } from "./tabs-model";
import { SandboxTab } from "./tab-sandbox";
import type { AssistantEditorData } from "./types";

/**
 * Les onglets, RANGÉS PAR FAMILLE.
 *
 * `EDITOR_TAB_LOOK` donnait déjà une couleur de famille à chacun, mais une
 * barre d'onglets sur une seule ligne ne montre pas de familles : elle montre
 * douze pastilles de couleur, dont trois seulement tiennent à l'écran. Rangés
 * en colonnes titrées, les douze tiennent d'un coup et l'ordre devient une
 * méthode — on règle ce que l'assistant DIT, puis ce qui le fait FONCTIONNER,
 * puis on VÉRIFIE.
 *
 * Le bac à sable reste AVANT la suite : on essaie d'abord, on teste ensuite.
 */
const TAB_GROUPS = [
  { id: "speech", tone: TONE.speech, tabs: ["identity", "goal", "approach", "knowledge", "objections"] },
  { id: "machinery", tone: TONE.machinery, tabs: ["tools", "model", "prompt"] },
  { id: "scrutiny", tone: TONE.scrutiny, tabs: ["guardrails", "sandbox", "test"] },
  { id: "raw", tone: TONE.raw, tabs: ["json"] },
] as const;

const TAB_IDS: readonly string[] = TAB_GROUPS.flatMap((g) => g.tabs);

type ChangeSummary = { changed: string[]; immediate: string[]; pending: string[] };

/**
 * Éditeur d'assistant.
 *
 * L'écran distingue trois états qui se confondent facilement : ce qui est
 * enregistré, ce qui est compilé, et ce qui a été testé. Un assistant peut être
 * enregistré sans être compilé (le prompt ment), compilé sans être vert (il se
 * comporte mal), et vert sans être actif. La barre du haut les montre tous les
 * trois ; le bandeau d'avertissement explique lequel manque.
 */
export function AssistantEditor({
  data,
  docs,
  initialTab,
}: {
  data: AssistantEditorData;
  docs: Record<string, ParamDocView>;
  /** Onglet ouvert au chargement — permet un lien direct « Tester ». */
  initialTab?: string;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();

  const [config, setConfig] = useState<AssistantConfig>(data.config);
  const [saved, setSaved] = useState<AssistantConfig>(data.config);
  const [busy, setBusy] = useState<null | "save" | "compile" | "suite" | "activate">(null);
  const [lastChanges, setLastChanges] = useState<ChangeSummary | null>(null);
  const [tab, setTab] = useState<string>(
    initialTab && TAB_IDS.includes(initialTab) ? initialTab : "identity",
  );

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved]);

  // Un onglet fermé avec des modifications non enregistrées les perd. Le
  // navigateur n'affiche notre texte que si l'événement est annulé.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = useCallback((mutate: (draft: AssistantConfig) => void) => {
    setConfig((current) => {
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  }, []);

  const save = async () => {
    setBusy("save");
    try {
      const res = await api<{ saved: boolean; changes: ChangeSummary }>(
        `/api/assistants/${data.id}`,
        { method: "PATCH", body: JSON.stringify(config) },
      );
      setSaved(config);
      setLastChanges(res.saved ? res.changes : null);
      toast.success(res.saved ? t("editor.saved") : t("editor.noChanges"));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("editor.errors.save"));
    } finally {
      setBusy(null);
    }
  };

  const compile = async () => {
    setBusy("compile");
    try {
      const res = await api<{ version: number }>(`/api/assistants/${data.id}/compile`, {
        method: "POST",
      });
      toast.success(t("editor.compiled", { version: res.version }));
      router.refresh();
    } catch (err) {
      // La compilation refuse quand l'assistant a changé entre-temps : le dire
      // vaut mieux qu'un « échec » qui laisse chercher.
      const code = err instanceof ApiError ? err.code : "";
      toast.error(
        code === "assistant_changed"
          ? t("editor.errors.changedDuringCompile")
          : t("editor.errors.compile"),
      );
    } finally {
      setBusy(null);
    }
  };

  const runSuite = async () => {
    setBusy("suite");
    try {
      await api(`/api/assistants/${data.id}/suite`, { method: "POST" });
      router.refresh();
    } catch {
      toast.error(t("editor.errors.suite"));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activate");
    try {
      await api(`/api/assistants/${data.id}/activate`, { method: "POST" });
      toast.success(t("editor.activated"));
      router.refresh();
    } catch (err) {
      // La porte renvoie POURQUOI elle refuse : le dire vaut mieux qu'un
      // « activation refusée » qui laisse chercher.
      const code = err instanceof ApiError ? String(err.data.reason ?? "") : "";
      toast.error(
        code === "stale_compile"
          ? t("editor.errors.staleCompile")
          : code === "suite_not_passed"
            ? t("editor.errors.suiteNotPassed")
            : code === "archived"
              ? t("editor.errors.archived")
              : t("editor.errors.activate"),
      );
    } finally {
      setBusy(null);
    }
  };

  /** Remettre en brouillon : l'assistant se tait sur tous ses fils sans être archivé. */
  const deactivate = async () => {
    setBusy("activate");
    try {
      await api(`/api/assistants/${data.id}/deactivate`, { method: "POST" });
      toast.success(t("list.deactivated"));
      router.refresh();
    } catch {
      toast.error(t("editor.errors.save"));
    } finally {
      setBusy(null);
    }
  };

  const tabProps = { config, update, data };

  const lifecycle =
    data.status === "active" ? (
      <Button
        variant="outline"
        onClick={() => void deactivate()}
        disabled={busy !== null}
        className="min-h-11 md:min-h-9"
      >
        {busy === "activate" ? <Loader2 className="animate-spin" /> : <Power />}
        {t("list.actions.deactivate")}
      </Button>
    ) : data.status !== "archived" ? (
      <Button
        variant="outline"
        onClick={() => void activate()}
        disabled={busy !== null || dirty || data.needsRecompile}
        className="min-h-11 md:min-h-9"
      >
        {busy === "activate" ? <Loader2 className="animate-spin" /> : <Zap />}
        {t("editor.activate")}
      </Button>
    ) : null;

  return (
    <ParamDocsProvider docs={docs}>
      <div className="space-y-5">
        {/* ── En-tête ──────────────────────────────────────────────────────
            L'écran ne disait NULLE PART quel assistant on éditait : le nom
            n'existait que dans le champ « Nom » du premier onglet, et l'état
            (actif? à jour? vert?) nulle part. Il est ici, avec les gestes, et
            il reste à l'écran quand on descend dans un onglet long. */}
        <header className="z-20 -mx-4 border-b bg-background/90 px-4 pb-3 backdrop-blur md:sticky md:top-0 md:-mx-6 md:px-6 md:pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-1 h-8 text-muted-foreground"
            render={<Link href="/admin/assistants" />}
          >
            <ArrowLeft /> {t("editor.back")}
          </Button>

          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <LookIcon look={ASSISTANT_STATUS_LOOK[data.status] ?? ASSISTANT_STATUS_LOOK.draft} size="lg" />
              <div className="min-w-0 flex-1">
                <h1 className="font-heading text-xl font-semibold tracking-tight break-words">
                  {config.name || t("editor.untitled")}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StateChip look={ASSISTANT_STATUS_LOOK[data.status] ?? ASSISTANT_STATUS_LOOK.draft}>
                    {t(`list.status.${data.status}` as never)}
                  </StateChip>
                  <CompileChip data={data} />
                  <SuiteChip data={data} />
                  <Badge variant="ghost" className="font-mono text-[11px] text-muted-foreground">
                    {t("editor.version", { n: data.version })}
                  </Badge>
                  {dirty ? <Badge variant="secondary">{t("editor.unsaved")}</Badge> : null}
                </div>
              </div>
            </div>

            {/* Les gestes, par ordre d'engagement. Sous `md` ils prennent
                leur propre rangée — serrés à côté du nom, ils réduisaient la
                colonne de gauche à une pastille par ligne — et seul le geste
                courant reste un bouton, les autres passent au menu. */}
            <div className="flex w-full shrink-0 items-center justify-end gap-2 md:w-auto">
              <Button
                onClick={() => void save()}
                disabled={busy !== null || !dirty}
                className="min-h-11 md:min-h-9"
              >
                {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />}
                {busy === "save" ? t("editor.saving") : t("editor.save")}
              </Button>
              <div className="hidden items-center gap-2 md:flex">
                <Button
                  variant="outline"
                  onClick={() => void compile()}
                  disabled={busy !== null || dirty}
                  className="min-h-11 md:min-h-9"
                >
                  {busy === "compile" ? <Loader2 className="animate-spin" /> : <Play />}
                  {busy === "compile" ? t("editor.compiling") : t("editor.compile")}
                </Button>
                {lifecycle}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 md:hidden"
                      aria-label={t("editor.more")}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      className="h-11"
                      disabled={busy !== null || dirty}
                      onClick={() => void compile()}
                    >
                      <Play /> {t("editor.compile")}
                    </DropdownMenuItem>
                    {data.status === "active" ? (
                      <DropdownMenuItem
                        className="h-11"
                        disabled={busy !== null}
                        onClick={() => void deactivate()}
                      >
                        <Power /> {t("list.actions.deactivate")}
                      </DropdownMenuItem>
                    ) : data.status !== "archived" ? (
                      <DropdownMenuItem
                        className="h-11"
                        disabled={busy !== null || dirty || data.needsRecompile}
                        onClick={() => void activate()}
                      >
                        <Zap /> {t("editor.activate")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {data.needsRecompile && data.compiledPrompt ? (
          <Alert>
            <AlertTriangle />
            <AlertTitle>{t("editor.stale.title")}</AlertTitle>
            <AlertDescription>
              {data.status === "active" ? t("editor.stale.bodyActive") : t("editor.stale.body")}
            </AlertDescription>
          </Alert>
        ) : null}

        {lastChanges && lastChanges.changed.length > 0 ? (
          <Alert>
            <CheckCircle2 />
            <AlertDescription>
              <span className="block">
                {t("editor.effects.immediate", { count: lastChanges.immediate.length })}
              </span>
              {lastChanges.pending.length > 0 ? (
                <span className="block">
                  {t("editor.effects.pending", { count: lastChanges.pending.length })}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          orientation="vertical"
          value={tab}
          onValueChange={(v) => setTab(String(v))}
          className="gap-4 max-md:flex-col! md:gap-6"
        >
          <TabRail value={tab} />

          <div className="min-w-0 flex-1">
            <TabsContent value="identity">
              <IdentityTab {...tabProps} />
            </TabsContent>
            <TabsContent value="goal">
              <GoalTab {...tabProps} />
            </TabsContent>
            <TabsContent value="approach">
              <ApproachTab {...tabProps} />
            </TabsContent>
            <TabsContent value="knowledge">
              <KnowledgeTab {...tabProps} />
            </TabsContent>
            <TabsContent value="objections">
              <ObjectionsTab {...tabProps} />
            </TabsContent>
            <TabsContent value="tools">
              <ToolsTab {...tabProps} />
            </TabsContent>
            <TabsContent value="guardrails">
              <GuardrailsTab {...tabProps} />
            </TabsContent>
            <TabsContent value="model">
              <ModelTab {...tabProps} />
            </TabsContent>
            <TabsContent value="prompt">
              <PromptTab {...tabProps} />
            </TabsContent>
            <TabsContent value="sandbox">
              <SandboxTab {...tabProps} />
            </TabsContent>
            <TabsContent value="test">
              <TestTab {...tabProps} onRunSuite={() => void runSuite()} running={busy === "suite"} />
            </TabsContent>
            <TabsContent value="json">
              {/* Remonté à chaque changement de configuration : l'onglet doit
                  montrer ce que les autres onglets viennent d'écrire. */}
              <JsonTab key={JSON.stringify(config)} {...tabProps} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </ParamDocsProvider>
  );
}

/**
 * La navigation des douze onglets.
 *
 * Sur écran large, une COLONNE : les douze tiennent d'un coup, rangés par
 * famille et titrés. La barre horizontale d'avant en montrait trois et demi,
 * coupait le quatrième au bord de l'écran et n'avait aucun signe qu'il y en
 * avait huit de plus.
 *
 * Sous `md`, la même liste redevient une bande qui défile — mais l'onglet
 * courant se ramène tout seul dans le champ de vision, et un dégradé au bord
 * droit dit qu'elle continue.
 */
function TabRail({ value }: { value: string }) {
  const t = useTranslations("assistants");
  const listRef = useRef<HTMLDivElement>(null);

  // Arriver sur « Vérification » par un lien direct plaçait l'onglet actif hors
  // du champ de vision sur téléphone : la bande semblait ouverte sur Identité.
  //
  // On déplace la BANDE, pas la page : `scrollIntoView` remonte à tous les
  // ancêtres défilables et emportait aussi le document, qui sautait alors sous
  // l'en-tête à chaque changement d'onglet.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(`[data-value="${value}"]`);
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({
      left: active.offsetLeft - (list.clientWidth - active.clientWidth) / 2,
      behavior: "smooth",
    });
  }, [value]);

  return (
    <div className="relative shrink-0 max-md:-mx-4 max-md:px-4 md:w-56">
      {/* Le dégradé ne dit qu'une chose : ça continue à droite. Décor pur. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent md:hidden"
      />
      <TabsList
        ref={listRef}
        variant="line"
        className={cn(
          "gap-0.5 bg-transparent p-0",
          "max-md:h-auto! max-md:w-full! max-md:flex-row! max-md:items-center! max-md:justify-start! max-md:overflow-x-auto max-md:pb-1",
          "md:w-full md:flex-col md:items-stretch",
        )}
      >
        {TAB_GROUPS.map((group) => (
          <div key={group.id} className="contents md:block md:space-y-0.5 md:pt-3 md:first:pt-0">
            <p
              aria-hidden
              className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:block"
            >
              {t(`editor.groups.${group.id}` as never)}
            </p>
            {group.tabs.map((id) => {
              const look = EDITOR_TAB_LOOK[id];
              const active = value === id;
              return (
                <TabsTrigger
                  key={id}
                  value={id}
                  data-value={id}
                  // La couleur de la famille passe par une variable : le
                  // filet de gauche ne se dessine qu'au-delà de `md`, et un
                  // style en ligne ne connaît pas les points de rupture.
                  style={
                    {
                      "--tab-accent": look.color,
                      ...(active ? { backgroundColor: lookTint(look).backgroundColor } : {}),
                    } as React.CSSProperties
                  }
                  className={cn(
                    "h-auto! min-h-11 shrink-0 justify-start gap-2 rounded-lg px-2.5 py-1.5 text-left font-normal md:min-h-9 md:w-full",
                    "data-active:font-medium data-active:text-foreground",
                    // L'indicateur intégré du variant « line » se dessine à
                    // DROITE et en noir : on l'éteint au profit du filet de
                    // famille, à gauche, dans la couleur du concept.
                    "after:hidden",
                    "md:data-active:shadow-[inset_3px_0_0_0_var(--tab-accent)]!",
                  )}
                >
                  <LookGlyph look={look} className="size-4" />
                  <span className="min-w-0 leading-tight max-md:truncate">
                    {t(`editor.tabs.${id}` as never)}
                  </span>
                </TabsTrigger>
              );
            })}
          </div>
        ))}
      </TabsList>
    </div>
  );
}

/**
 * Une lecture d'état, dans l'en-tête.
 *
 * Même habillage que dans la liste des assistants — bordure neutre, libellé au
 * ton du texte, toute la couleur dans la pastille — pour qu'une carte de la
 * liste et l'en-tête de l'éditeur se lisent pareil.
 */
function StateChip({ look, children }: { look: Look; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className="gap-1 pl-1 font-normal">
      <LookIcon look={look} size="sm" />
      {children}
    </Badge>
  );
}

function CompileChip({ data }: { data: AssistantEditorData }) {
  const t = useTranslations("assistants");
  if (data.compiledAt === null) {
    return (
      <StateChip look={ASSISTANT_STATUS_LOOK.compiled_never}>{t("list.compiled.never")}</StateChip>
    );
  }
  return data.needsRecompile ? (
    <StateChip look={ASSISTANT_STATUS_LOOK.compiled_stale}>{t("list.compiled.stale")}</StateChip>
  ) : (
    <StateChip look={ASSISTANT_STATUS_LOOK.compiled_fresh}>{t("list.compiled.fresh")}</StateChip>
  );
}

function SuiteChip({ data }: { data: AssistantEditorData }) {
  const t = useTranslations("assistants");
  if (data.compiledAt === null) return null;
  return data.suitePassed ? (
    <StateChip look={ASSISTANT_STATUS_LOOK.suite_passed}>{t("list.suite.passed")}</StateChip>
  ) : (
    <StateChip look={ASSISTANT_STATUS_LOOK.suite_failed}>{t("list.suite.failed")}</StateChip>
  );
}
