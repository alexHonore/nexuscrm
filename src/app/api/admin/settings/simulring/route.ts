import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

/**
 * POST /api/admin/settings/simulring — la sonnerie sur le cellulaire.
 *
 * Deux gestes seulement : l'interrupteur de la maison, et l'ouverture de la
 * ligne d'UNE personne. Ce que la route ne fait PAS, délibérément :
 *
 * - elle n'enregistre aucun numéro. Le cellulaire est un renseignement
 *   personnel : il est saisi par son propriétaire dans /profile, chiffré, et
 *   accompagné de son consentement. Un administrateur qui pourrait taper le
 *   numéro d'un employé ferait sonner un téléphone privé sans que celui-ci
 *   l'ait jamais accepté ;
 * - elle ne touche pas à voip.ms. L'approvisionnement (renvoi, groupe de
 *   sonnerie, routage du DID) est un travail réseau qui échoue de dix façons ;
 *   il a son propre écran et son propre bouton, pour que l'erreur se lise là
 *   où elle se répare.
 */

const schema = z.object({
  enabled: z.boolean().optional(),
  line: z.object({ userId: z.string().uuid(), enabled: z.boolean() }).optional(),
});

export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("telephony");
  const simulRing = {
    enabled: body.enabled ?? current.simulRing.enabled,
    lines: { ...current.simulRing.lines },
  };

  if (body.line) {
    const existing = simulRing.lines[body.line.userId];
    simulRing.lines[body.line.userId] = {
      // Les identifiants voip.ms d'un renvoi déjà créé sont CONSERVÉS quand on
      // éteint puis rallume : sans eux, chaque bascule empilerait un nouveau
      // renvoi orphelin dans le compte voip.ms, que plus personne ne saurait
      // rattacher à qui.
      forwardId: existing?.forwardId ?? "",
      ringGroupId: existing?.ringGroupId ?? "",
      enabled: body.line.enabled,
    };
  }

  await setSetting("telephony", { ...current, simulRing });

  await logAudit({
    userId: actor.user.id,
    action: "settings.simulring",
    entity: "settings",
    detail: {
      enabled: simulRing.enabled,
      ...(body.line ? { line: body.line.userId, lineEnabled: body.line.enabled } : {}),
    },
  });

  return NextResponse.json({ simulRing });
}
