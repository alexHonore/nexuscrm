import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalShell, P, Section, UL } from "../legal-shell";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: t("privacy.title"),
    description: t("privacy.intro"),
    robots: { index: true, follow: true },
  };
}

export default async function PrivacyPage() {
  const t = await getTranslations("legal");
  const list = (key: string): string[] => t.raw(key) as string[];

  return (
    <LegalShell title={t("privacy.title")} updated={t("updatedDate")}>
      <P>{t("privacy.intro")}</P>

      <Section heading={t("privacy.controller.h")}>
        <P>{t("privacy.controller.p")}</P>
      </Section>

      <Section heading={t("privacy.collected.h")}>
        <P>{t("privacy.collected.p")}</P>
        <UL items={list("privacy.collected.items")} />
      </Section>

      <Section heading={t("privacy.purpose.h")}>
        <UL items={list("privacy.purpose.items")} />
        <P>{t("privacy.purpose.noAds")}</P>
      </Section>

      <Section heading={t("privacy.google.h")}>
        <P>{t("privacy.google.p")}</P>
        <UL items={list("privacy.google.items")} />
        <P className="font-medium">{t("privacy.google.limitedUse")}</P>
        <P>{t("privacy.google.revoke")}</P>
      </Section>

      <Section heading={t("privacy.recording.h")}>
        <P>{t("privacy.recording.p")}</P>
      </Section>

      <Section heading={t("privacy.sharing.h")}>
        <P>{t("privacy.sharing.p")}</P>
        <UL items={list("privacy.sharing.items")} />
        <P>{t("privacy.sharing.noSale")}</P>
      </Section>

      <Section heading={t("privacy.security.h")}>
        <UL items={list("privacy.security.items")} />
      </Section>

      <Section heading={t("privacy.retention.h")}>
        <P>{t("privacy.retention.p")}</P>
      </Section>

      <Section heading={t("privacy.rights.h")}>
        <P>{t("privacy.rights.p")}</P>
        <UL items={list("privacy.rights.items")} />
        <P>{t("privacy.rights.how")}</P>
      </Section>

      <Section heading={t("privacy.dncl.h")}>
        <P>{t("privacy.dncl.p")}</P>
      </Section>

      <Section heading={t("privacy.contact.h")}>
        <P>{t("privacy.contact.p")}</P>
      </Section>
    </LegalShell>
  );
}
