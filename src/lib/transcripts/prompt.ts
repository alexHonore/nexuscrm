import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";

/**
 * Notes d'appel par IA — la partie PURE : prompts, lecture de la réponse,
 * corps du commentaire. Aucun réseau, aucune base : tout est testable à sec.
 *
 * La langue vient du RÉGLAGE `transcripts.language`, jamais du cookie de
 * langue de l'écran : la note est une donnée de la fiche (comme un SMS
 * d'assistant), pas un texte d'interface — `tests/unit-agent-locale.test.ts`
 * interdit d'ailleurs next-intl dans ce dossier.
 */

export type TranscriptDetail = "brief" | "standard" | "detailed";
export type TranscriptLanguage = "fr" | "en";

export interface TranscriptCallFacts {
  direction: "outbound" | "inbound";
  /** Durée totale de l'appel, en secondes. */
  durationSec: number;
  startedAt: Date;
  /** Nom du téléphoniste (aide le modèle à distinguer les voix). */
  agentName: string | null;
  /** Nom du client sur la fiche. */
  clientName: string | null;
}

export interface TranscriptPromptInput {
  language: TranscriptLanguage;
  detail: TranscriptDetail;
  /** Faux = ne pas demander le verbatim (moins de jetons de sortie). */
  keepTranscript: boolean;
  call: TranscriptCallFacts;
}

/** Bornes dures sur ce qu'on stocke/pousse — le modèle peut déborder ses consignes. */
export const SUMMARY_MAX_CHARS = 3000;
export const TRANSCRIPT_MAX_CHARS = 100_000;

const DETAIL_FR: Record<TranscriptDetail, string> = {
  brief:
    "Rédige une note BRÈVE : une à trois phrases au maximum — l'essentiel de l'échange et la prochaine étape s'il y en a une. Vise moins de 300 caractères.",
  standard:
    "Rédige une note COURTE et structurée : l'objet de l'appel, les points clés (projet immobilier, échéance, secteur, budget s'ils sont mentionnés), les objections soulevées, et la prochaine étape convenue. Vise moins de 900 caractères.",
  detailed:
    "Rédige une note COMPLÈTE : résumé de l'échange, détails du projet immobilier (échéance, secteur, budget, motivation), objections et réponses données, ton et réceptivité du client, engagements pris de part et d'autre, et actions à prendre. Cite entre guillemets une ou deux phrases marquantes du client si utile. Vise moins de 2000 caractères.",
};

const DETAIL_EN: Record<TranscriptDetail, string> = {
  brief:
    "Write a BRIEF note: one to three sentences at most — the gist of the exchange and the next step if there is one. Aim for under 300 characters.",
  standard:
    "Write a SHORT, structured note: the purpose of the call, the key points (real-estate project, timeline, area, budget if mentioned), objections raised, and the agreed next step. Aim for under 900 characters.",
  detailed:
    "Write a COMPLETE note: summary of the exchange, project details (timeline, area, budget, motivation), objections and how they were answered, the client's tone and receptiveness, commitments made on both sides, and actions to take. Quote one or two notable client sentences if useful. Aim for under 2000 characters.",
};

/**
 * Consignes système. Écrites dans la langue de la note : demander en français
 * une note en anglais (ou l'inverse) fait dériver les modèles vers la langue
 * des consignes.
 */
export function buildTranscriptSystem(input: TranscriptPromptInput): string {
  const wantTranscript = input.keepTranscript;
  if (input.language === "fr") {
    return [
      "Tu écoutes l'enregistrement d'un appel entre un téléphoniste d'un courtier immobilier québécois et un client potentiel.",
      wantTranscript
        ? "Transcris d'abord fidèlement la conversation en identifiant les interlocuteurs (« Téléphoniste : », « Client : »)."
        : "Écoute la conversation en entier avant de rédiger.",
      DETAIL_FR[input.detail],
      "La note est écrite en français, pour l'équipe interne — factuelle, sans flatterie ni remplissage. N'invente RIEN : si un renseignement n'est pas dans l'appel, il n'est pas dans la note.",
      "Si l'enregistrement ne contient pas d'échange utile (silence, boîte vocale, faux numéro), dis-le en une phrase à la place de la note.",
      wantTranscript
        ? 'Réponds UNIQUEMENT avec un objet JSON : {"transcript": "…", "summary": "…"} — aucun texte hors du JSON.'
        : 'Réponds UNIQUEMENT avec un objet JSON : {"summary": "…"} — aucun texte hors du JSON.',
    ].join("\n");
  }
  return [
    "You are listening to a recorded call between a phone agent working for a Québec real-estate broker and a potential client.",
    wantTranscript
      ? 'First transcribe the conversation faithfully, labelling the speakers ("Agent:", "Client:").'
      : "Listen to the whole conversation before writing.",
    DETAIL_EN[input.detail],
    "The note is written in English, for the internal team — factual, no filler. Do NOT invent anything: if a detail is not in the call, it is not in the note.",
    "If the recording contains no useful exchange (silence, voicemail, wrong number), say so in one sentence instead of the note.",
    input.keepTranscript
      ? 'Reply ONLY with a JSON object: {"transcript": "…", "summary": "…"} — no text outside the JSON.'
      : 'Reply ONLY with a JSON object: {"summary": "…"} — no text outside the JSON.',
  ].join("\n");
}

/** Le contexte factuel qui accompagne l'audio (métadonnées de l'appel). */
export function buildTranscriptUserText(input: TranscriptPromptInput): string {
  const { call } = input;
  const mins = Math.floor(call.durationSec / 60);
  const secs = call.durationSec % 60;
  const when = formatInTimeZone(
    call.startedAt,
    "America/Toronto",
    input.language === "fr" ? "d MMMM yyyy, HH 'h' mm" : "MMMM d, yyyy, h:mm a",
    { locale: input.language === "fr" ? fr : enUS },
  );
  if (input.language === "fr") {
    return [
      `Appel ${call.direction === "outbound" ? "sortant" : "entrant"} du ${when} (durée ${mins} min ${secs} s).`,
      call.agentName ? `Téléphoniste : ${call.agentName}.` : null,
      call.clientName ? `Client (selon la fiche) : ${call.clientName}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `${call.direction === "outbound" ? "Outbound" : "Inbound"} call on ${when} (duration ${mins} min ${secs} s).`,
    call.agentName ? `Agent: ${call.agentName}.` : null,
    call.clientName ? `Client (per the CRM record): ${call.clientName}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface TranscriptOutput {
  summary: string;
  transcript: string | null;
}

/**
 * Lit la réponse du modèle. Un JSON propre est la voie normale ; tout le reste
 * (clôtures de code, prose autour, JSON cassé) se replie sur « le texte entier
 * est la note » plutôt que de perdre un appel déjà payé.
 */
export function parseTranscriptOutput(raw: string): TranscriptOutput {
  const text = raw.trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
        const transcript = typeof obj.transcript === "string" ? obj.transcript.trim() : "";
        // JSON valide = la voie normale, MÊME avec une note vide : le repli
        // texte-entier transformerait `{"summary": ""}` en note « {"summary":
        // "" } » sur la fiche, au lieu de laisser le cœur classer en échec.
        return {
          summary: summary.slice(0, SUMMARY_MAX_CHARS),
          transcript: transcript === "" ? null : transcript.slice(0, TRANSCRIPT_MAX_CHARS),
        };
      }
    } catch {
      // JSON cassé : repli ci-dessous.
    }
  }
  return { summary: unfenced.slice(0, SUMMARY_MAX_CHARS).trim(), transcript: null };
}

/**
 * Corps du commentaire poussé sur la fiche. Même convention que l'outil
 * `add_client_comment` de l'agent SMS : le préfixe 🤖 SIGNE la machine dans le
 * corps — l'équipe ne doit jamais croire qu'un humain l'a écrit (l'auteur
 * porté par la rangée est le téléphoniste de l'appel, faute de colonne).
 */
export function buildNoteBody(opts: {
  language: TranscriptLanguage;
  call: TranscriptCallFacts;
  summary: string;
}): string {
  const { call } = opts;
  const mins = Math.floor(call.durationSec / 60);
  const secs = call.durationSec % 60;
  const duration = `${mins} min ${secs} s`;
  const when = formatInTimeZone(
    call.startedAt,
    "America/Toronto",
    opts.language === "fr" ? "d MMMM yyyy, HH 'h' mm" : "MMMM d, yyyy, h:mm a",
    { locale: opts.language === "fr" ? fr : enUS },
  );
  const header =
    opts.language === "fr"
      ? `🤖 Notes d'appel (IA) — appel ${call.direction === "outbound" ? "sortant" : "entrant"} du ${when} (${duration})`
      : `🤖 AI call notes — ${call.direction === "outbound" ? "outbound" : "inbound"} call, ${when} (${duration})`;
  return `${header}\n\n${opts.summary}`;
}
