import { asc, eq } from "drizzle-orm";
import { Webhook } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { CopyButton } from "@/components/admin/copy-button";
import type { OptionDto, WebhookDefaults, WebhookKeyDto } from "@/components/admin/types";
import { WebhookKeysCard } from "@/components/admin/webhooks-client";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { categories, sources, users, webhookKeys } from "@/db/schema";
import { requirePerm } from "@/lib/permissions/server";

const N8N_EXAMPLE = `{
  "name": "{{ $json.data.nom_complet }}",
  "phone": "{{ $json.data['numéro_de_téléphone'] }}",
  "email": "{{ $json.data['e-mail'] }}",
  "type": "{{ $json.data['quel_est_votre_besoin_?'] }}",
  "timing": "{{ $json.data['votre_projet_est_prévu_pour_quand_?'] }}",
  "city": "{{ $json.data.ville }}",
  "source": "Facebook Acheteur",
  "notes": "{{ $json.data.notes }}"
}`;

const PAYLOAD_FIELDS: { aliases: string; key: string; required?: boolean }[] = [
  { aliases: "name · nom_complet · full_name", key: "name" },
  { aliases: "phone · numéro_de_téléphone · telephone", key: "phone", required: true },
  { aliases: "email · e-mail · courriel", key: "email" },
  { aliases: "type · quel_est_votre_besoin_?", key: "type" },
  { aliases: "timing · votre_projet_est_prévu_pour_quand_?", key: "timing" },
  { aliases: "source", key: "source" },
  { aliases: "notes · note · message", key: "notes" },
  { aliases: "city · ville", key: "city" },
];

export default async function AdminWebhooksPage() {
  await requirePerm("admin.webhooks");
  const [t, locale] = await Promise.all([getTranslations("admin"), getLocale()]);

  const endpoint = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/webhooks/leads`;

  const [keys, cats, srcs, activeUsers] = await Promise.all([
    db.query.webhookKeys.findMany({ orderBy: [asc(webhookKeys.createdAt)] }),
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
  ]);

  const keyDtos: WebhookKeyDto[] = keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyLast4: k.keyLast4,
    defaults: (k.defaults ?? {}) as WebhookDefaults,
    isActive: k.isActive,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  }));

  const categoryOptions: OptionDto[] = cats.map((c) => ({
    value: String(c.id),
    label: locale === "fr" ? c.nameFr : c.nameEn,
  }));
  const sourceOptions: OptionDto[] = srcs.map((s) => ({ value: String(s.id), label: s.name }));
  const userOptions: OptionDto[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <PageHeader
        icon={<Webhook />}
        title={t("webhooks.title")}
        subtitle={t("webhooks.subtitle")}
        titleAccessory={
          <Badge variant="secondary" className="tabular-nums">
            {t("webhooks.keyCount", { count: keys.length })}
          </Badge>
        }
      />

      {/* ── Explication de l'endpoint ── */}
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="size-4" />
            {t("webhooks.explain.title")}
          </CardTitle>
          <CardDescription>{t("webhooks.explain.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("webhooks.explain.endpoint")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="shrink-0">POST</Badge>
              <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">{endpoint}</code>
              <CopyButton value={endpoint} size="xs" />
            </div>
            <p className="text-xs text-muted-foreground">{t("webhooks.explain.auth")}</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("webhooks.explain.fields")}
            </p>
            <div className="overflow-x-auto rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left text-[11px] font-medium tracking-wider uppercase">
                      {t("webhooks.explain.fieldCol")}
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-medium tracking-wider uppercase">
                      {t("webhooks.explain.statusCol")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PAYLOAD_FIELDS.map((f) => (
                    <tr key={f.key} className="border-b transition-colors last:border-0 hover:bg-muted/50">
                      <td className="px-3 py-1.5 font-mono text-xs break-all">{f.aliases}</td>
                      <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                        {f.required ? (
                          <Badge variant="destructive">{t("webhooks.explain.required")}</Badge>
                        ) : (
                          t("webhooks.explain.optional")
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t("webhooks.explain.nested")}</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("webhooks.explain.n8nExample")}
              </p>
              <CopyButton value={N8N_EXAMPLE} size="xs" />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
              {N8N_EXAMPLE}
            </pre>
            <p className="text-xs text-muted-foreground">{t("webhooks.explain.n8nHint")}</p>
          </div>
        </CardContent>
      </Card>

      {/* ── Clés ── */}
      <WebhookKeysCard
        initialKeys={keyDtos}
        categories={categoryOptions}
        sources={sourceOptions}
        users={userOptions}
      />
    </div>
  );
}
