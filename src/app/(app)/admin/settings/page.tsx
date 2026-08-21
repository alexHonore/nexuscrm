import { Settings2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { BookingCard, GoogleCard, KillSwitchCard, SmsCard, TelephonyCard } from "@/components/admin/settings-client";
import { SmsNumbersCard } from "@/components/admin/sms-numbers-card";
import { listSmsNumbersForAdmin } from "@/lib/sms-server/numbers";
import { PageHeader } from "@/components/shell/page-header";
import { requireAdmin } from "@/lib/auth/guards";
import { getSetting } from "@/lib/settings";

export default async function AdminSettingsPage() {
  await requireAdmin();
  const t = await getTranslations("admin");

  const [google, booking, telephony, sms, numbers] = await Promise.all([
    getSetting("google"),
    getSetting("booking"),
    getSetting("telephony"),
    getSetting("sms"),
    listSmsNumbersForAdmin(),
  ]);

  const voipmsHints = {
    sipWss: Boolean(process.env.NEXT_PUBLIC_SIP_WSS_URL),
    apiCreds: Boolean(process.env.VOIPMS_API_USERNAME && process.env.VOIP_MS_API_PASSWORD),
  };
  // Booléens seulement — jamais les valeurs.
  const twilioHints = {
    TWILIO_ACCOUNT_SID: Boolean(process.env.TWILIO_ACCOUNT_SID),
    TWILIO_AUTH_TOKEN: Boolean(process.env.TWILIO_AUTH_TOKEN),
    TWILIO_API_KEY_SID: Boolean(process.env.TWILIO_API_KEY_SID),
    TWILIO_API_KEY_SECRET: Boolean(process.env.TWILIO_API_KEY_SECRET),
    TWILIO_TWIML_APP_SID: Boolean(process.env.TWILIO_TWIML_APP_SID),
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<Settings2 />} title={t("settings.title")} subtitle={t("settings.subtitle")} />

      <GoogleCard
        connected={Boolean(google.refreshTokenEnc)}
        email={google.email}
        connectedAt={google.connectedAt}
        calendarId={google.calendarId}
      />

      <BookingCard
        initial={{
          days: booking.days,
          startHour: booking.startHour,
          endHour: booking.endHour,
          meetDurationMin: booking.meetDurationMin,
          inPersonDurationMin: booking.inPersonDurationMin,
          bufferMin: booking.bufferMin,
          inPersonDefaultLocation: booking.inPersonDefaultLocation,
          brokerEmail: booking.brokerEmail,
        }}
      />

      <KillSwitchCard
        initial={{ enabled: sms.killSwitch, reason: sms.killSwitchReason, at: sms.killSwitchAt }}
      />
      <SmsNumbersCard initial={numbers} twilioConfigured={twilioHints.TWILIO_ACCOUNT_SID} />
      <SmsCard initialValidity={sms.consentValidity} />

      <TelephonyCard initialProvider={telephony.provider} voipms={voipmsHints} twilio={twilioHints} />
    </div>
  );
}
