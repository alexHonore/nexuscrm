import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { categoryDispositionValue } from "@/lib/dispositions";
import { apiPerm } from "@/lib/permissions/server";
import { classificationSettingsSchema, getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

/**
 * Les règles de classement — remplacées EN BLOC, pas rustinées.
 *
 * Une liste ordonnée dont on retire une entrée n'a pas de « rustine » qui
 * veuille dire quelque chose : envoyer la liste entière est la seule façon de
 * dire « celle-ci n'existe plus ». C'est aussi ce que l'écran manipule — il
 * édite un tableau et l'enregistre.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, classificationSettingsSchema);
  if (body instanceof NextResponse) return body;

  // Une règle qui pointe vers une catégorie disparue serait invisible côté
  // assistant (le résolveur l'ignore) tout en restant à l'écran : on la refuse
  // à l'enregistrement, pendant qu'on sait encore laquelle et pourquoi.
  const rows = await db.select().from(categories).orderBy(asc(categories.sortOrder));
  const known = new Set(rows.map(categoryDispositionValue));
  const unknown = body.rules.filter((rule) => !known.has(rule.category)).map((r) => r.category);
  if (unknown.length > 0) {
    return NextResponse.json({ error: "unknown_category", categories: unknown }, { status: 400 });
  }

  const current = await getSetting("classification");
  await setSetting("classification", body);

  await logAudit({
    userId: actor.user.id,
    action: "settings.classification",
    entity: "settings",
    entityId: "classification",
    detail: {
      from: current.rules.length,
      to: body.rules.length,
      active: body.rules.filter((r) => r.enabled).length,
    },
  });

  return NextResponse.json({ ok: true });
}
