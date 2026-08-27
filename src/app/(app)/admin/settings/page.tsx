import { asc } from "drizzle-orm";
import { Settings2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { BookingCard, GoogleCard, KillSwitchCard, TelephonyCard } from "@/components/admin/settings-client";
import { ClassificationCard } from "@/components/admin/classification-card";
import { SmsNumbersCard } from "@/components/admin/sms-numbers-card";
import { TranscriptsCard } from "@/components/admin/transcripts-card";
import { listSmsNumbersForAdmin } from "@/lib/sms-server/numbers";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { categoryDispositionValue } from "@/lib/dispositions";
import { docLocale } from "@/lib/docs/types";
import { getSetting } from "@/lib/settings";

export default async function AdminSettingsPage() {
  await requireAdmin();
  const t = await getTranslations("admin");

  const locale = docLocale(await getLocale());
  const [google, booking, telephony, sms, numbers, classification, transcripts, categoryRows] =
    await Promise.all([
      getSetting("google"),
      getSetting("booking"),
      getSetting("telephony"),
      getSetting("sms"),
      listSmsNumbersForAdmin(),
      getSetting("classification"),
      getSetting("transcripts"),
      db.select().from(categories).orderBy(asc(categories.sortOrder)),
    ]);

  // La MÊME valeur que les dispositions d'après-appel (`key` ou « cat:<id> ») :
  // un classement posé par l'assistant et un posé par un téléphoniste restent
  // ainsi comparables dans les statistiques.
  const categoryChoices = categoryRows.map((row) => ({
    value: categoryDispositionValue(row),
    label: locale === "en" ? row.nameEn : row.nameFr,
    color: row.color,
  }));

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

      <ClassificationCard
        initial={classification.rules}
        categories={categoryChoices}
      />

      <TranscriptsCard
        initial={{
          enabled: transcripts.enabled,
          detail: transcripts.detail,
          language: transcripts.language,
          model: transcripts.model,
          minSeconds: transcripts.minSeconds,
          maxMinutes: transcripts.maxMinutes,
          keepTranscript: transcripts.keepTranscript,
        }}
        // Booléen seulement — jamais la valeur.
        openrouterConfigured={Boolean(process.env.OPENROUTER_API_KEY)}
      />

      <KillSwitchCard
        initial={{ enabled: sms.killSwitch, reason: sms.killSwitchReason, at: sms.killSwitchAt }}
      />
      <SmsNumbersCard initial={numbers} twilioConfigured={twilioHints.TWILIO_ACCOUNT_SID} />

      <TelephonyCard initialProvider={telephony.provider} voipms={voipmsHints} twilio={twilioHints} />
    </div>
  );
}
