import type { Metadata } from "next";
import { LegalShell, P, Section, UL, legalTranslator, resolveLegalLocale } from "../legal-shell";

/**
 * Page PUBLIQUE : la langue se force par `?lang=` (lecteur sans cookie —
 * vérification Google, lien partagé), le cookie ne sert que de repli.
 */
type PageProps = { searchParams: Promise<{ lang?: string }> };

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { lang } = await searchParams;
  const t = await legalTranslator(await resolveLegalLocale(lang));
  return {
    title: t("terms.title"),
    description: t("terms.intro"),
    robots: { index: true, follow: true },
  };
}

export default async function TermsPage({ searchParams }: PageProps) {
  const { lang } = await searchParams;
  const locale = await resolveLegalLocale(lang);
  const t = await legalTranslator(locale);
  const list = (key: string): string[] => t.raw(key) as string[];

  return (
    <LegalShell locale={locale} title={t("terms.title")} updated={t("updatedDate")}>
      <P>{t("terms.intro")}</P>

      <Section heading={t("terms.service.h")}>
        <P>{t("terms.service.p")}</P>
      </Section>

      <Section heading={t("terms.access.h")}>
        <UL items={list("terms.access.items")} />
      </Section>

      <Section heading={t("terms.acceptable.h")}>
        <P>{t("terms.acceptable.p")}</P>
        <UL items={list("terms.acceptable.items")} />
      </Section>

      <Section heading={t("terms.google.h")}>
        <P>{t("terms.google.p")}</P>
      </Section>

      <Section heading={t("terms.telephony.h")}>
        <P>{t("terms.telephony.p")}</P>
      </Section>

      <Section heading={t("terms.availability.h")}>
        <P>{t("terms.availability.p")}</P>
      </Section>

      <Section heading={t("terms.liability.h")}>
        <P>{t("terms.liability.p")}</P>
      </Section>

      <Section heading={t("terms.termination.h")}>
        <P>{t("terms.termination.p")}</P>
      </Section>

      <Section heading={t("terms.law.h")}>
        <P>{t("terms.law.p")}</P>
      </Section>

      <Section heading={t("terms.contact.h")}>
        <P>{t("terms.contact.p")}</P>
      </Section>
    </LegalShell>
  );
}
