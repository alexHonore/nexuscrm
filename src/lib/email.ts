import "server-only";

/**
 * Envoi de courriels transactionnels via Resend (intégration Vercel
 * Marketplace : la variable RESEND_API_KEY est fournie automatiquement).
 *
 * Tant que le domaine d'envoi n'est pas vérifié chez Resend, on utilise
 * l'expéditeur de test « onboarding@resend.dev », qui ne peut écrire qu'à
 * l'adresse du compte Resend. Configurer EMAIL_FROM après vérification du
 * domaine (ex. "Groupe Nexus <notifications@groupenexus.com>").
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("RESEND_API_KEY manquant");
    this.name = "EmailNotConfiguredError";
  }
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new EmailNotConfiguredError();

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Groupe Nexus <onboarding@resend.dev>",
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/** Gabarit du courriel de réinitialisation (FR/EN selon la langue du compte). */
export function passwordResetEmail(opts: {
  name: string;
  url: string;
  locale: "fr" | "en";
  expiresMinutes: number;
}): { subject: string; html: string; text: string } {
  const fr = opts.locale !== "en";
  const subject = fr
    ? "Réinitialisation de votre mot de passe — Groupe Nexus"
    : "Reset your password — Groupe Nexus";

  const body = fr
    ? {
        hi: `Bonjour ${opts.name},`,
        intro:
          "Vous avez demandé la réinitialisation de votre mot de passe pour l'espace Groupe Nexus.",
        cta: "Choisir un nouveau mot de passe",
        expires: `Ce lien expire dans ${opts.expiresMinutes} minutes et ne peut servir qu'une fois.`,
        ignore:
          "Si vous n'êtes pas à l'origine de cette demande, ignorez ce courriel : votre mot de passe reste inchangé.",
        fallback: "Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :",
      }
    : {
        hi: `Hello ${opts.name},`,
        intro: "You asked to reset your Groupe Nexus password.",
        cta: "Choose a new password",
        expires: `This link expires in ${opts.expiresMinutes} minutes and can be used only once.`,
        ignore: "If you didn't request this, ignore this email — your password stays unchanged.",
        fallback: "If the button doesn't work, copy this link into your browser:",
      };

  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px">
      <tr><td style="padding-bottom:20px">
        <span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;border-radius:9px;background:#1e3a5f;color:#fff;font-weight:700">N</span>
        <span style="font-size:17px;font-weight:600;margin-left:10px;vertical-align:middle">Groupe Nexus</span>
      </td></tr>
      <tr><td style="font-size:15px;line-height:1.6">
        <p style="margin:0 0 12px">${body.hi}</p>
        <p style="margin:0 0 20px">${body.intro}</p>
        <p style="margin:0 0 24px">
          <a href="${opts.url}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:600">${body.cta}</a>
        </p>
        <p style="margin:0 0 8px;color:#475569;font-size:13px">${body.expires}</p>
        <p style="margin:0 0 20px;color:#475569;font-size:13px">${body.ignore}</p>
        <p style="margin:0;color:#94a3b8;font-size:12px">${body.fallback}<br><span style="word-break:break-all">${opts.url}</span></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const text = `${body.hi}\n\n${body.intro}\n\n${opts.url}\n\n${body.expires}\n${body.ignore}\n`;

  return { subject, html, text };
}
