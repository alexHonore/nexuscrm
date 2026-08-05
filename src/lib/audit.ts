import "server-only";
import { headers } from "next/headers";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export async function logAudit(entry: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    let ip: string | null = null;
    try {
      const h = await headers();
      ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
    } catch {
      // hors contexte requête (cron, seed) — pas d'IP
    }
    await db.insert(auditLogs).values({
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      detail: entry.detail ?? null,
      ip,
    });
  } catch (err) {
    // L'audit ne doit jamais faire échouer l'action principale.
    console.error("audit log failed", err);
  }
}
