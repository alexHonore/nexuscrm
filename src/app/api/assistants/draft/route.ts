import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { apiPerm } from "@/lib/permissions/server";
import {
  CREATOR_SYSTEM,
  briefToConfig,
  creatorReplySchema,
} from "@/lib/assistants/creator";
import { configuredProviders, getLlmProvider } from "@/lib/llm-server";
import { UTILITY_MODEL_BY_PROVIDER } from "@/lib/llm/defaults";

/**
 * POST /api/assistants/draft — un tour de la création assistée.
 *
 * Le modèle pose UNE question, ou rend un brief. Nous en dérivons la
 * configuration : ce qui est renvoyé est donc toujours enregistrable tel quel,
 * ou bien c'est une question — jamais une configuration à moitié plausible.
 *
 * Rien n'est écrit ici. La création n'a lieu qu'au POST /api/assistants, quand
 * l'utilisateur a relu le résumé.
 */
const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
});

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Le modèle enrobe parfois le JSON de prose ou de balises de code.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function POST(req: Request) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  const providers = configuredProviders();
  if (providers.length === 0) {
    return NextResponse.json({ error: "no_provider" }, { status: 503 });
  }

  // Un modèle économique suffit : la tâche est une extraction guidée. Et un
  // identifiant DU fournisseur configuré — pas un identifiant Claude envoyé à
  // Google ou OpenAI quand ce sont les seuls à avoir une clé.
  const provider = providers[0];
  let text: string;
  try {
    const out = await getLlmProvider(provider).generate({
      system: CREATOR_SYSTEM,
      messages: parsed.data.messages,
      model: UTILITY_MODEL_BY_PROVIDER[provider],
      maxTokens: 900,
      temperature: 0.3,
    });
    text = out.text;
  } catch (err) {
    return NextResponse.json(
      { error: "model_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }

  const reply = creatorReplySchema.safeParse(extractJson(text));
  if (!reply.success) {
    // Une sortie illisible n'est pas une configuration : on redemande plutôt
    // que de deviner ce que le modèle voulait dire.
    return NextResponse.json({ error: "unreadable_reply" }, { status: 422 });
  }

  if (!reply.data.done) {
    return NextResponse.json({
      done: false,
      question: reply.data.question,
      suggestions: reply.data.suggestions,
    });
  }

  const broker = await db.query.users.findFirst({
    where: eq(users.id, actor.user.id),
    columns: { name: true },
  });

  const config = briefToConfig(reply.data.brief, {
    orgName: "Groupe Nexus",
    brokerName: broker?.name ?? "Alex-Honoré",
    brokerUserId: actor.user.id,
  });

  return NextResponse.json({ done: true, summary: reply.data.summary, config });
}

/** Un tour de création peut enchaîner plusieurs secondes de réflexion. */
export const maxDuration = 60;
