import { NextResponse } from "next/server";
import { db } from "@/db";
import { smsNumbers } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { fetchTwilioServiceNumbers } from "@/lib/sms-server/numbers";

/**
 * POST /api/admin/sms-numbers/sync — importe les numéros du Messaging Service
 * Twilio. Les nouveaux arrivent INACTIFS : l'administrateur décide lequel
 * envoie, rien ne se met à écrire parce qu'un numéro existe chez Twilio.
 */
export async function POST() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let remote: { phoneNumber: string; sid: string }[];
  try {
    remote = await fetchTwilioServiceNumbers();
  } catch (err) {
    const message = err instanceof Error ? err.message : "twilio_failed";
    return NextResponse.json(
      { error: message === "twilio_unconfigured" ? "twilio_unconfigured" : "twilio_failed", message },
      { status: message === "twilio_unconfigured" ? 503 : 502 },
    );
  }
  let added = 0;
  for (const n of remote) {
    const inserted = await db
      .insert(smsNumbers)
      .values({
        e164: n.phoneNumber,
        label: "Twilio",
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
        active: false,
      })
      .onConflictDoNothing({ target: smsNumbers.e164 })
      .returning({ id: smsNumbers.id });
    if (inserted.length > 0) added += 1;
  }
  await logAudit({
    userId: admin.id,
    action: "sms_number.sync",
    entity: "sms_number",
    detail: { found: remote.length, added },
  });
  return NextResponse.json({ found: remote.length, added, numbers: remote.map((n) => n.phoneNumber) });
}
