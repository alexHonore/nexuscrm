"use client";

import { AlertTriangleIcon, FileWarningIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ROOT_PATH, type ImportIssue, type JsonSyntaxProblem } from "@/lib/import-diagnostics";

/**
 * Pourquoi un fichier d'import a été refusé.
 *
 * L'écran disait « ce fichier n'est pas un export valide » et rien d'autre.
 * Sur un document rédigé à la main, c'est une impasse : on ne sait ni quel
 * champ, ni ce qu'il fallait écrire, ni où regarder. Chaque ligne d'ici porte
 * les trois — le champ (nommé comme la référence le nomme), la ligne du
 * fichier, et ce qui était attendu à la place de ce qui s'y trouve.
 *
 * Le texte vit dans le namespace `common` : les deux imports (assistant et
 * campagne) échouent de la même façon et méritent les mêmes phrases.
 */
export function ImportIssues({
  issues,
  syntax,
}: {
  issues: ImportIssue[];
  /** Le fichier ne se lit même pas comme du JSON — une autre erreur. */
  syntax?: JsonSyntaxProblem | null;
}) {
  const t = useTranslations("common");

  if (syntax) {
    return (
      <Alert variant="destructive">
        <FileWarningIcon />
        {/* `min-w-0` : sans lui, l'extrait en <pre> refuse de rétrécir et
            élargit toute l'alerte — le dialogue déborde sur un téléphone. */}
        <AlertDescription className="min-w-0 space-y-2">
          <p className="font-medium">{t("importIssues.syntax.title")}</p>
          {/* Le moteur ne sait pas toujours dire OÙ : annoncer « ligne 1 » par
              défaut enverrait chercher au mauvais endroit. */}
          {syntax.line !== undefined && syntax.column !== undefined ? (
            <p>{t("importIssues.syntax.where", { line: syntax.line, column: syntax.column })}</p>
          ) : null}
          {syntax.excerpt ? (
            <pre className="max-w-full overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs">
              {syntax.excerpt}
            </pre>
          ) : null}
          <p className="text-xs">{t("importIssues.syntax.hint")}</p>
        </AlertDescription>
      </Alert>
    );
  }

  if (issues.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertDescription className="space-y-2">
        <p className="font-medium">{t("importIssues.title", { count: issues.length })}</p>
        <p className="text-xs">{t("importIssues.intro")}</p>
        <ul className="space-y-2.5">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`} className="rounded-md bg-background/60 p-2">
              <IssueRow issue={issue} />
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function IssueRow({ issue }: { issue: ImportIssue }) {
  const t = useTranslations("common");

  // « other » est le fourre-tout : plutôt qu'une phrase creuse, on montre le
  // message du schéma, qui dit au moins quelque chose de précis.
  const explanation =
    issue.code === "other"
      ? issue.raw
      : t(`importIssues.code.${issue.code}`, {
          expected: issue.expected ?? "?",
          received: issue.received ?? "?",
          limit: issue.limit ?? "?",
        });

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {issue.field ? <span className="text-sm font-medium">{issue.field.label}</span> : null}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
          {issue.path === ROOT_PATH ? t("importIssues.root") : issue.path}
        </code>
        {issue.line ? (
          <Badge variant="outline" className="text-[10px]">
            {t("importIssues.line", { line: issue.line })}
          </Badge>
        ) : null}
      </div>

      <p className="text-xs">{explanation}</p>

      {/* Ce qui rend une valeur refusée réparable : la liste de ce qui passe… */}
      {issue.options && issue.options.length > 0 ? (
        <p className="text-xs">
          <span className="font-medium">{t("importIssues.allowed")}</span>{" "}
          <span className="font-mono break-all">{issue.options.join(" · ")}</span>
        </p>
      ) : null}

      {/* …ou, quand il n'y a qu'une valeur possible, cette valeur. Sans elle,
          un « format » erroné disait seulement « pas acceptée ici » et laissait
          deviner la chaîne exacte à écrire. */}
      {!issue.options && issue.expected && issue.code !== "wrong_type" ? (
        <p className="text-xs">
          <span className="font-medium">{t("importIssues.expected")}</span>{" "}
          <code className="font-mono break-all">{issue.expected}</code>
        </p>
      ) : null}

      {issue.value ? (
        <p className="text-xs">
          <span className="font-medium">{t("importIssues.found")}</span>{" "}
          <code className="font-mono break-all">{issue.value}</code>
        </p>
      ) : null}

      {issue.field?.what ? (
        <p className="text-xs text-muted-foreground">{issue.field.what}</p>
      ) : null}
    </div>
  );
}
