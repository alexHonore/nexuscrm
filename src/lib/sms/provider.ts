/**
 * Fournisseur SMS — résolution de mode, pipeline d'envoi gardé, transport
 * Twilio.
 *
 * Framework-agnostic (règle du module) : aucun import Next.js, aucun client de
 * base de données, aucune lecture d'environnement — tout arrive injecté via les
 * ports de `./types`. Le câblage env + Drizzle vit dans `src/lib/sms-server`.
 */
import { z } from "zod";
import { analyzeSms } from "./segments";
import type {
  Clock,
  Logger,
  SendGate,
  SendInput,
  SendResult,
  SmsMode,
  SmsProvider,
  SmsTransport,
  SuppressionStore,
} from "./types";

const E164_RE = /^\+[0-9]{8,15}$/;

// ── Résolution de mode ───────────────────────────────────────────────────────

/**
 * Mode d'envoi d'après l'environnement — toujours fermé par défaut :
 * `live` exige DEUX drapeaux (SMS_MODE=live ET SMS_LIVE_CONFIRMED=true) ;
 * `live` sans confirmation, valeur inconnue ou absente ⇒ `dry_run`.
 */
export function resolveSmsMode(env: Record<string, string | undefined>): SmsMode {
  if (env.SMS_MODE === "live") {
    return env.SMS_LIVE_CONFIRMED === "true" ? "live" : "dry_run";
  }
  if (env.SMS_MODE === "sandbox") return "sandbox";
  return "dry_run";
}

/** Liste de numéros E.164 séparés par des virgules — entrées invalides écartées. */
export function parseAllowlist(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => E164_RE.test(entry));
}

// ── Pipeline d'envoi ─────────────────────────────────────────────────────────

/** Journalisation : jamais le numéro complet — seulement les 4 derniers chiffres. */
function maskPhone(to: string): string {
  return `***${to.slice(-4)}`;
}

export interface SmsProviderDeps {
  mode: SmsMode;
  allowlist: string[];
  transport: SmsTransport;
  suppressions: SuppressionStore;
  gate: SendGate;
  logger: Logger;
  clock: Clock;
}

/**
 * Pipeline d'envoi, gardes DANS CET ORDRE : destination valide → interrupteur
 * global → liste de suppression → analyse → mode. Le transport n'est jamais
 * appelé pour un envoi bloqué ; en particulier, aucun chemin de code n'atteint
 * un numéro supprimé. Les erreurs du transport remontent telles quelles — la
 * couche file d'attente (phase 2) possède les reprises.
 */
export function createSmsProvider(deps: SmsProviderDeps): SmsProvider {
  const { mode, allowlist, transport, suppressions, gate, logger, clock } = deps;
  const allowed = new Set(allowlist);

  return {
    async send(input: SendInput): Promise<SendResult> {
      const { to, body, conversationId, idempotencyKey } = input;
      const skipped = (skippedReason: string): SendResult => {
        const { segments, encoding } = analyzeSms(body);
        return { segments, encoding, mode, sent: false, skippedReason };
      };

      if (!E164_RE.test(to)) return skipped("invalid_to");
      if (!(await gate.isSendingAllowed())) return skipped("kill_switch");
      if (await suppressions.isSuppressed(to)) return skipped("suppressed");

      const { segments, encoding } = analyzeSms(body);

      if (mode === "dry_run") {
        // Ni le texte du message ni le numéro complet (renseignements
        // personnels) — la ligne `messages` en base est le registre.
        logger.info("sms.send.dry_run", {
          at: clock.now().toISOString(),
          conversationId,
          idempotencyKey,
          to: maskPhone(to),
          bodyLength: body.length,
          segments,
          encoding,
        });
        return { segments, encoding, mode, sent: false, skippedReason: "dry_run" };
      }

      if (mode === "sandbox" && !allowed.has(to)) {
        logger.warn("sms.send.sandbox_blocked", {
          at: clock.now().toISOString(),
          conversationId,
          idempotencyKey,
          to: maskPhone(to),
        });
        return { segments, encoding, mode, sent: false, skippedReason: "sandbox_not_allowlisted" };
      }

      const { sid } = await transport({ to, body, idempotencyKey });
      return { sid, segments, encoding, mode, sent: true };
    },
  };
}

// ── Transport Twilio ─────────────────────────────────────────────────────────

const twilioMessageSchema = z.object({ sid: z.string() });

/** Corps d'erreur Twilio : { code: 21211, message: "Invalid 'To' …", … } */
const twilioErrorSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
});

function describeTwilioError(status: number, bodyText: string): string {
  let json: unknown = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // corps non JSON — on retombe sur le statut HTTP
  }
  const parsed = twilioErrorSchema.safeParse(json);
  if (parsed.success) return `${parsed.data.code} ${parsed.data.message}`;
  return `http ${status}`;
}

/**
 * Délai maximal d'un appel Twilio. Un socket qui pend n'est pas une erreur
 * visible : sans plafond il mangerait tout le budget du dispatcher
 * (maxDuration 300 s) et bloquerait la file derrière lui. Un abandon devient
 * une erreur normale — donc une reprise avec temporisation.
 */
const TWILIO_TIMEOUT_MS = 15_000;

/**
 * Transport réel : POST /2010-04-01/Accounts/{sid}/Messages.json authentifié
 * par clé API (Basic keySid:keySecret). `fetchFn` est injectable pour les
 * tests — jamais de vrai réseau hors production.
 */
export function createTwilioTransport(cfg: {
  accountSid: string;
  keySid: string;
  keySecret: string;
  messagingServiceSid: string;
  statusCallbackUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): SmsTransport {
  const { accountSid, keySid, keySecret, messagingServiceSid, statusCallbackUrl } = cfg;
  const fetchFn = cfg.fetchFn ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? TWILIO_TIMEOUT_MS;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authorization = `Basic ${btoa(`${keySid}:${keySecret}`)}`;

  return async ({ to, body }) => {
    const form = new URLSearchParams({
      To: to,
      Body: body,
      MessagingServiceSid: messagingServiceSid,
    });
    if (statusCallbackUrl) form.set("StatusCallback", statusCallbackUrl);

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Abandon sur délai : l'appel a probablement échoué AVANT acceptation,
      // mais rien ne le garantit — la garde anti-double-envoi du handler
      // (messages.job_id) est ce qui empêche un doublon à la reprise.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(`twilio_send_failed: timeout after ${timeoutMs}ms`);
      }
      throw err;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`twilio_send_failed: ${describeTwilioError(res.status, text)}`);
    }

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // réponse 2xx sans JSON valide — traitée comme malformée ci-dessous
    }
    const parsed = twilioMessageSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`twilio_send_failed: http ${res.status} malformed_response`);
    }
    return { sid: parsed.data.sid };
  };
}
