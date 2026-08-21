import { NextResponse } from "next/server";
import { z } from "zod";
import { apiAdmin } from "@/lib/auth/guards";
import {
  CAMPAIGN_CREATOR_SYSTEM,
  briefToCampaignConfig,
  campaignCreatorReplySchema,
} from "@/lib/campaigns/creator";
import { configuredProviders, getLlmProvider } from "@/lib/llm-server";
import { UTILITY_MODEL_BY_PROVIDER } from "@/lib/llm/defaults";

/**
 * POST /api/campaigns/draft — un tour de création assistée de campagne.
 * N'écrit rien : la création a lieu au POST /api/campaigns, après relecture.
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
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

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

  // Un identifiant DU fournisseur configuré — pas un identifiant Claude envoyé
  // à Google ou OpenAI quand ce sont les seuls à avoir une clé.
  const provider = providers[0];
  let text: string;
  try {
    const out = await getLlmProvider(provider).generate({
      system: CAMPAIGN_CREATOR_SYSTEM,
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

  const reply = campaignCreatorReplySchema.safeParse(extractJson(text));
  if (!reply.success) {
    return NextResponse.json({ error: "unreadable_reply" }, { status: 422 });
  }

  if (!reply.data.done) {
    return NextResponse.json({
      done: false,
      question: reply.data.question,
      suggestions: reply.data.suggestions,
    });
  }

  return NextResponse.json({
    done: true,
    summary: reply.data.summary,
    config: briefToCampaignConfig(reply.data.brief),
  });
}

export const maxDuration = 60;
