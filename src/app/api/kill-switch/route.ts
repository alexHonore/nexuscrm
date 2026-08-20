import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, setSetting } from "@/lib/settings";

const bodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Interrupteur d'arrêt global du moteur SMS — admin seulement.
 *
 * Le réglage `sms.killSwitch` est relu par le fournisseur avant CHAQUE envoi
 * (`settingsSendGate` de `src/lib/sms-server`) : basculer l'interrupteur
 * stoppe donc tous les SMS sortants en au plus un cycle du dispatcher. Les
 * phases suivantes étendront ce point d'entrée pour aussi mettre les
 * campagnes en pause et annuler les envois en attente dès que ces tables
 * existeront.
 */
export async function POST(req: Request) {
  const auth = await apiAdmin();
  if (auth instanceof NextResponse) return auth;

  const raw: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { enabled, reason } = parsed.data;

  // Fusion avec l'état courant : le réglage `sms` porte aussi d'autres champs
  // (consentValidity…) que le basculement de l'interrupteur ne doit pas remettre
  // à leurs défauts.
  const current = await getSetting("sms");
  await setSetting("sms", {
    ...current,
    killSwitch: enabled,
    killSwitchReason: enabled ? (reason ?? null) : null,
    killSwitchAt: enabled ? new Date().toISOString() : null,
  });

  await logAudit({
    userId: auth.id,
    action: "sms.kill_switch",
    entity: "settings",
    detail: { enabled, reason: reason ?? null },
  });

  return NextResponse.json({ ok: true, enabled });
}
