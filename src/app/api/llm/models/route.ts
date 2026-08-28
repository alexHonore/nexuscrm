import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiPerm } from "@/lib/permissions/server";
import { LlmUnconfiguredError, configuredProviders, getModelCatalog } from "@/lib/llm-server";
import { PROVIDER_IDS } from "@/lib/assistants/schema";

/**
 * GET /api/llm/models?provider=openrouter — catalogue de modèles, admin
 * seulement. Alimente le sélecteur de modèle d'un assistant : le support des
 * outils est renvoyé tel quel (badgé dans l'UI plutôt que masqué — un agent à
 * sept outils sur un modèle qui n'en gère pas échoue en silence et ressemble à
 * un bogue de prompt). Réponse mise en cache six heures côté serveur.
 */

const querySchema = z.object({ provider: z.enum(PROVIDER_IDS).default("openrouter") });

export async function GET(req: NextRequest) {
  const auth = await apiPerm("admin.assistants");
  if (auth instanceof NextResponse) return auth;

  const parsed = querySchema.safeParse({
    provider: req.nextUrl.searchParams.get("provider") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  try {
    const models = await getModelCatalog(parsed.data.provider);
    return NextResponse.json({
      provider: parsed.data.provider,
      configured: configuredProviders(),
      models: [...models].sort((a, b) => a.label.localeCompare(b.label)),
    });
  } catch (err) {
    if (err instanceof LlmUnconfiguredError) {
      return NextResponse.json({ error: "provider_unconfigured" }, { status: 503 });
    }
    return NextResponse.json({ error: "provider_unavailable" }, { status: 502 });
  }
}
