import { NextResponse } from "next/server";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { CAMPAIGN_FIELD_DOCS, campaignFieldText } from "@/lib/campaigns/docs";
import { API_AUTH, API_ENDPOINTS, apiEndpointText } from "@/lib/docs/api";
import { resolveParamDoc } from "@/lib/docs/locale";
import { listParamDocs } from "@/lib/docs/params";
import type { DocLocale } from "@/lib/docs/types";
import {
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  kindText,
  severityText,
} from "@/lib/guardrails/docs";

/**
 * La référence publique, en JSON — le pendant machine de `/developers`.
 *
 * Une page HTML se lit ; elle ne s'importe pas. Un intégrateur qui veut
 * valider une configuration d'assistant avant de l'envoyer, ou engendrer un
 * client typé, n'a d'autre choix que de gratter la page — et son outil casse
 * au premier changement de balisage. Ici, la même vérité sort en données.
 *
 * SANS authentification, et c'est délibéré : le contenu est identique à celui
 * de la page publique. Comme elle, il ne lit AUCUNE base — `listParamDocs()`
 * et non `getParamDocs()`, qui fusionnerait les réécritures administrateur.
 * Une route publique qui interroge la base est aussi une route publique qu'on
 * peut faire ramer depuis l'extérieur.
 */

/**
 * Rendue à la demande, PAS figée au build : en `force-static`, Next sert la
 * requête sans sa chaîne de requête et `?lang=en` n'arrive jamais ici — la
 * référence anglaise n'existait pas. Le contenu ne dépend que du code, alors
 * l'en-tête de cache ci-dessous suffit à garder la route bon marché.
 */
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const param = url.searchParams.get("lang");
  const locale: DocLocale = param === "en" ? "en" : "fr";

  const body = {
    /** Version du CONTRAT, pas de l'application : elle bouge quand la forme change. */
    version: 1,
    locale,
    auth: {
      headers: [API_AUTH.headerPrimary, "Authorization"],
      scheme: "api-key",
      note:
        locale === "en"
          ? "Send the key as `x-api-key: <key>` or `Authorization: Bearer <key>`. Keys are issued by an administrator."
          : "Envoyez la clé dans « x-api-key: <clé> » ou « Authorization: Bearer <clé> ». Les clés sont émises par un administrateur.",
    },
    endpoints: API_ENDPOINTS.map((e) => {
      const t = apiEndpointText(e, locale);
      return {
        id: t.id,
        method: t.method,
        path: t.path,
        summary: t.label,
        description: t.what,
        fields: t.fields.map((f) => ({
          name: f.name,
          required: f.required,
          type: "string",
          aliases: f.aliases,
          description: f.what,
        })),
        responses: t.responses.map((r) => ({
          status: r.status,
          code: r.code ?? null,
          description: r.what,
        })),
        notes: t.notes,
        example: { request: t.exampleBody, response: t.exampleResponse },
      };
    }),
    /** Le schéma de configuration d'un assistant, chemin par chemin. */
    assistantConfig: listParamDocs().map((d) => {
      const p = resolveParamDoc({ ...d, overridden: false }, locale);
      return {
        path: p.path,
        section: p.section,
        type: p.type,
        required: p.required,
        default: p.defaultValue ?? null,
        allowed: p.allowed?.map((a) => ({ value: a.value, label: a.label })) ?? null,
        label: p.label,
        description: p.what,
        example: p.example ?? null,
      };
    }),
    campaignConfig: CAMPAIGN_FIELD_DOCS.map((f) => {
      const t = campaignFieldText(f, locale);
      return { path: f.path, label: t.label, description: t.what };
    }),
    guardrails: {
      kinds: Object.values(GUARDRAIL_KIND_DOCS).map((k) => {
        const t = kindText(k, locale);
        return {
          kind: k.kind,
          label: t.label,
          description: t.what,
          when: t.when,
          costsModelCall: k.costsModelCall,
        };
      }),
      severities: Object.values(GUARDRAIL_SEVERITY_DOCS).map((s) => {
        const t = severityText(s, locale);
        return { severity: s.severity, label: t.label, description: t.what };
      }),
    },
    tools: Object.values(TOOL_DEFS).map((d) => ({
      name: d.name,
      description: d.description,
    })),
  };

  return NextResponse.json(body, {
    headers: {
      // Contenu qui ne dépend que du code (et de `?lang=`, partie de la clé de
      // cache). Un cache long évite qu'un outil qui interroge en boucle
      // réveille une fonction pour rien.
      "cache-control": "public, max-age=3600, s-maxage=86400",
      // Les outils s'écrivent depuis un navigateur (un carnet, une console) :
      // sans CORS, la première tentative échoue sans dire pourquoi.
      "access-control-allow-origin": "*",
    },
  });
}
