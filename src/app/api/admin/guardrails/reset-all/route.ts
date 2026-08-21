import { NextResponse } from "next/server";
import { db } from "@/db";
import { guardrailAudit } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import { invalidateAssistantsForGuardrails, resetGuardrailDefaults } from "@/lib/guardrails/store";

/**
 * POST /api/admin/guardrails/reset-all — « Tout réinitialiser aux valeurs par
 * défaut » (§16.6) : restaure chaque règle et fixture d'origine `default`
 * depuis son instantané, ET recrée celles qui avaient été supprimées.
 *
 * C'est le bouton d'annulation de toute la section : après une séance
 * d'expérimentation, il ramène les garde-fous à l'état livré — et périme donc
 * chaque assistant, dont le L6 et la suite reflétaient l'état expérimental.
 */
export async function POST() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const counts = await resetGuardrailDefaults();
  const staleAssistants = await invalidateAssistantsForGuardrails({ assistantId: null });
  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "reset_all",
    target: "guardrails:core",
    before: null,
    after: { ...counts, staleAssistants },
  });

  return NextResponse.json({ ok: true, ...counts, staleAssistants });
}
