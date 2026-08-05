import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { webhookKeys } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { encryptSecret, generateApiKey, sha256Hex } from "@/lib/crypto";
import { readJson } from "../_helpers";

const defaultsSchema = z.object({
  categoryId: z.number().int().nullable().optional(),
  sourceId: z.number().int().nullable().optional(),
  assignedToId: z.uuid().nullable().optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  defaults: defaultsSchema.default({}),
});

/** Crée une clé webhook — la clé complète est retournée UNE seule fois. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const key = generateApiKey();
  const [created] = await db
    .insert(webhookKeys)
    .values({
      name: body.name,
      keyEnc: encryptSecret(key),
      keyHash: sha256Hex(key),
      keyLast4: key.slice(-4),
      defaults: body.defaults,
    })
    .returning();

  await logAudit({
    userId: admin.id,
    action: "webhook.key_create",
    entity: "webhookKey",
    entityId: String(created.id),
    detail: { name: created.name },
  });

  return NextResponse.json({
    id: created.id,
    name: created.name,
    keyLast4: created.keyLast4,
    key,
  });
}
