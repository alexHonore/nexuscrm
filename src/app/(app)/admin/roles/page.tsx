import { ShieldCheck } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  RolesClient,
  type RoleDocText,
  type RolesDocs,
} from "@/components/admin/roles-client";
import { PageHeader } from "@/components/shell/page-header";
import { docLocale } from "@/lib/docs/types";
import { GRANT_KEYS, PERMISSION_GROUPS, PERMISSION_KEYS } from "@/lib/permissions/catalog";
import {
  GRANT_DOCS,
  GROUP_DOCS,
  PERMISSION_DOCS,
  type DocEntry,
  type DocLocale,
  type DocOverlay,
  resolveDoc,
} from "@/lib/permissions/docs";
import { GRANT_TEXT_EN, GROUP_TEXT_EN, PERMISSION_TEXT_EN } from "@/lib/permissions/docs.en";
import { loadDirectory, memberCounts, requirePerm } from "@/lib/permissions/server";

/**
 * Une fiche du registre, RÉSOLUE dans la langue de l'interface.
 *
 * La résolution se fait ici et pas dans l'écran : le registre est un module
 * pur (il alimente aussi bien un test qu'un prompt), et le composant client
 * n'a donc rien à savoir de `next-intl` pour afficher ces textes-là — il
 * reçoit des chaînes toutes faites.
 *
 * Une entrée absente du registre ne rend pas la case muette : elle retombe sur
 * sa clé technique, qui reste identifiable, plutôt que sur du vide.
 */
function textOf(
  entry: DocEntry | undefined,
  overlay: DocOverlay | undefined,
  locale: DocLocale,
  fallback: string,
): RoleDocText {
  if (!entry) return { label: fallback };
  const text = resolveDoc(entry, overlay, locale);
  return { label: text.label, what: text.what, why: text.why, pitfalls: text.pitfalls };
}

export default async function AdminRolesPage() {
  // Le droit qui garde CET écran est celui que personne d'autre que
  // l'administrateur ne peut se donner (`LOCKED_TO_ADMIN`) : la matrice ne
  // s'ouvre donc jamais à un rôle qui l'aurait cochée pour lui-même.
  await requirePerm("admin.roles");

  const t = await getTranslations("admin");
  const locale = docLocale(await getLocale());

  // `loadDirectory` rend la configuration ET l'annuaire en une lecture mise en
  // cache par requête ; `memberCounts` la relit sans requête neuve.
  const [directory, counts] = await Promise.all([loadDirectory(), memberCounts()]);
  const { cfg, rows, roleOf } = directory;

  // Qui porte quel rôle : des noms de comptes, pas des identifiants — un
  // compteur seul ne dit pas si c'est le bon monde qui est dedans.
  const members: Record<string, string[]> = {};
  for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
    const roleId = roleOf.get(row.id)?.id;
    if (!roleId) continue;
    (members[roleId] ??= []).push(row.name);
  }

  const docs: RolesDocs = {
    permissions: Object.fromEntries(
      PERMISSION_KEYS.map((key) => [
        key,
        textOf(PERMISSION_DOCS[key] as DocEntry | undefined, PERMISSION_TEXT_EN[key], locale, key),
      ]),
    ),
    grants: Object.fromEntries(
      GRANT_KEYS.map((key) => [
        key,
        textOf(GRANT_DOCS[key] as DocEntry | undefined, GRANT_TEXT_EN[key], locale, key),
      ]),
    ),
    groups: Object.fromEntries(
      PERMISSION_GROUPS.map((key) => [
        key,
        textOf(GROUP_DOCS[key] as DocEntry | undefined, GROUP_TEXT_EN[key], locale, key),
      ]),
    ),
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<ShieldCheck />} title={t("roles.title")} subtitle={t("roles.subtitle")} />
      <p className="text-sm text-muted-foreground">{t("roles.intro")}</p>

      <RolesClient
        config={cfg}
        counts={counts}
        members={members}
        docs={docs}
        locale={locale}
      />
    </div>
  );
}
