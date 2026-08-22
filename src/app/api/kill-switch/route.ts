import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { cancelPendingJobs } from "@/lib/jobs/queue";
import { getSetting, setSetting } from "@/lib/settings";

const bodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Interrupteur d'arrêt global du moteur SMS — admin seulement.
 *
 * Deux mécanismes complémentaires : le réglage `sms.killSwitch` est relu par
 * le fournisseur avant CHAQUE envoi (`settingsSendGate` de
 * `src/lib/sms-server`) et bloque les nouveaux envois ; activer
 * l'interrupteur annule EN PLUS tous les jobs `send_sms` encore en attente
 * dans la file. Ensemble, ils garantissent que l'interrupteur stoppe tout en
 * au plus un cycle du dispatcher. Désactiver ne ressuscite rien : les jobs
 * annulés restent annulés.
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
  // que le basculement de l'interrupteur ne doit pas remettre
  // à leurs défauts.
  const current = await getSetting("sms");
  await setSetting("sms", {
    ...current,
    killSwitch: enabled,
    killSwitchReason: enabled ? (reason ?? null) : null,
    killSwitchAt: enabled ? new Date().toISOString() : null,
  });

  // Les jobs déjà réclamés (`running`) sont laissés au dispatcher : leur
  // handler relit le réglage et refusera l'envoi lui-même.
  const cancelledJobs = enabled ? await cancelPendingJobs({ types: ["send_sms"] }) : 0;

  await logAudit({
    userId: auth.id,
    action: "sms.kill_switch",
    entity: "settings",
    detail: { enabled, reason: reason ?? null, cancelledJobs },
  });

  return NextResponse.json({ ok: true, enabled, cancelledJobs });
}
