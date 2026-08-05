import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { webhookKeys } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { decryptSecret } from "@/lib/crypto";

/** Révèle la clé complète (pour configurer n8n) — action auditée. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const target = await db.query.webhookKeys.findFirst({ where: eq(webhookKeys.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await logAudit({
    userId: admin.id,
    action: "webhook.key_reveal",
    entity: "webhookKey",
    entityId: String(id),
    detail: { name: target.name },
  });

  return NextResponse.json({ key: decryptSecret(target.keyEnc) });
}
