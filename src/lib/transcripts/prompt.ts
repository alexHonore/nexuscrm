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

export type TranscriptDetail = "brief" | "standard" | "detailed" | "exhaustive";
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
  /**
   * Repères de VOCABULAIRE tirés de la fiche (ville, adresse) : les noms
   * propres sont ce qu'un modèle entend le plus mal sur de l'audio téléphone
   * (« Sainte-Foy » → « cinq fois », mesuré). Les donner d'avance corrige la
   * transcription — mais ils ne doivent JAMAIS entrer dans la note s'ils ne
   * sont pas prononcés (le prompt le dit explicitement).
   */
  clientCity: string | null;
  clientAddress: string | null;
}

export interface TranscriptPromptInput {
  language: TranscriptLanguage;
  detail: TranscriptDetail;
  /** Faux = ne pas demander le verbatim (moins de jetons de sortie). */
  keepTranscript: boolean;
  call: TranscriptCallFacts;
}

/**
 * Bornes dures sur ce qu'on stocke/pousse — le modèle peut déborder ses
 * consignes. 6000 laisse de la marge au niveau « exhaustif » (cible 4000) ;
 * les autres niveaux visent bien en dessous.
 */
export const SUMMARY_MAX_CHARS = 6000;
export const TRANSCRIPT_MAX_CHARS = 100_000;

const DETAIL_FR: Record<TranscriptDetail, string> = {
  brief:
    "Rédige une note BRÈVE : une à trois phrases au maximum — l'essentiel de l'échange et la prochaine étape s'il y en a une. Vise moins de 300 caractères.",
  standard:
    "Rédige une note COURTE et structurée : l'objet de l'appel, les points clés (projet immobilier, échéance, secteur, budget s'ils sont mentionnés), les objections soulevées, et la prochaine étape convenue. Vise moins de 900 caractères.",
  detailed:
    "Rédige une note COMPLÈTE : résumé de l'échange, détails du projet immobilier (échéance, secteur, budget, motivation), objections et réponses données, ton et réceptivité du client, engagements pris de part et d'autre, et actions à prendre. Cite entre guillemets une ou deux phrases marquantes du client si utile. Vise moins de 2000 caractères.",
  exhaustive:
    "Rédige une note EXHAUSTIVE : un compte rendu chronologique où TOUT ce qui est dit est consigné, horodaté en [mm:ss] aux moments clés. Consigne chaque renseignement, même ceux qui semblent sans importance : noms, dates, montants, adresses, préférences, contraintes, détails personnels ou anecdotiques (famille, travail, horaires, humeur), hésitations et changements de ton, objections et formulations exactes, engagements des deux côtés. Structure : Objet · Déroulé horodaté · Renseignements factuels · Objections et réponses · Engagements et prochaine étape. Vise moins de 4000 caractères.",
};

const DETAIL_EN: Record<TranscriptDetail, string> = {
  brief:
    "Write a BRIEF note: one to three sentences at most — the gist of the exchange and the next step if there is one. Aim for under 300 characters.",
  standard:
    "Write a SHORT, structured note: the purpose of the call, the key points (real-estate project, timeline, area, budget if mentioned), objections raised, and the agreed next step. Aim for under 900 characters.",
  detailed:
    "Write a COMPLETE note: summary of the exchange, project details (timeline, area, budget, motivation), objections and how they were answered, the client's tone and receptiveness, commitments made on both sides, and actions to take. Quote one or two notable client sentences if useful. Aim for under 2000 characters.",
  exhaustive:
    "Write an EXHAUSTIVE note: a chronological account where EVERYTHING said is recorded, timestamped [mm:ss] at key moments. Record every piece of information, even those that seem unimportant: names, dates, amounts, addresses, preferences, constraints, personal or anecdotal details (family, work, schedule, mood), hesitations and shifts in tone, objections with their exact wording, commitments on both sides. Structure: Purpose · Timestamped account · Factual details · Objections and answers · Commitments and next step. Aim for under 4000 characters.",
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
      "Tu écoutes l'enregistrement d'un appel TÉLÉPHONIQUE (qualité téléphone, deux interlocuteurs, français québécois) entre un téléphoniste d'un courtier immobilier québécois et un client potentiel.",
      "Écoute la conversation EN ENTIER avant d'écrire quoi que ce soit.",
      wantTranscript
        ? "Tu rends DEUX choses : la note, PUIS le verbatim fidèle de la conversation, avec les interlocuteurs identifiés (« Téléphoniste : », « Client : »). La note s'écrit EN PREMIER — c'est elle que l'équipe lit."
        : null,
      // Les noms propres, montants et dates sont ce que l'audio téléphone
      // abîme le plus — et ce que l'équipe relit le plus attentivement.
      "Porte une attention particulière aux noms propres, adresses, secteurs, montants, dates et numéros. Un mot ou passage incompréhensible s'écrit [inaudible] — n'invente JAMAIS un mot plausible à la place.",
      DETAIL_FR[input.detail],
      "La note est écrite en français, pour l'équipe interne — factuelle, sans flatterie ni remplissage. N'invente RIEN : si un renseignement n'est pas dans l'appel, il n'est pas dans la note.",
      "Si l'enregistrement ne contient pas d'échange utile (silence, boîte vocale, faux numéro), dis-le en une phrase à la place de la note.",
      // L'ORDRE des clés n'est pas cosmétique : une réponse coupée perd sa fin.
      // Avec le verbatim en dernier, une coupure coûte le verbatim ; avec la
      // note en dernier, elle coûtait la note — et l'appel payé ne donnait
      // rien (8 notes sur 52 en production, constat du 2026-09-15).
      wantTranscript
        ? 'Réponds UNIQUEMENT avec un objet JSON, la note EN PREMIER : {"summary": "…", "transcript": "…"} — aucun texte hors du JSON.'
        : 'Réponds UNIQUEMENT avec un objet JSON : {"summary": "…"} — aucun texte hors du JSON.',
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "You are listening to a recorded PHONE call (telephone audio quality, two speakers, Québec French) between a phone agent working for a Québec real-estate broker and a potential client.",
    "Listen to the WHOLE conversation before writing anything.",
    wantTranscript
      ? 'You return TWO things: the note, THEN a faithful verbatim transcript with the speakers labelled ("Agent:", "Client:"). The note comes FIRST — it is what the team reads.'
      : null,
    "Pay particular attention to proper nouns, addresses, neighbourhoods, amounts, dates and numbers. Write [inaudible] for any word or passage you cannot make out — NEVER invent a plausible word instead.",
    DETAIL_EN[input.detail],
    "The note is written in English, for the internal team — factual, no filler. Do NOT invent anything: if a detail is not in the call, it is not in the note.",
    "If the recording contains no useful exchange (silence, voicemail, wrong number), say so in one sentence instead of the note.",
    input.keepTranscript
      ? 'Reply ONLY with a JSON object, the note FIRST: {"summary": "…", "transcript": "…"} — no text outside the JSON.'
      : 'Reply ONLY with a JSON object: {"summary": "…"} — no text outside the JSON.',
  ]
    .filter(Boolean)
    .join("\n");
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
  // Repères tirés de la fiche : ils GUIDENT l'oreille (orthographe des noms
  // propres), ils ne nourrissent pas la note — le garde-fou est dans la
  // phrase elle-même, pas seulement dans le prompt système.
  const vocabFr = [
    call.clientCity ? `ville : ${call.clientCity}` : null,
    call.clientAddress ? `adresse : ${call.clientAddress}` : null,
  ].filter(Boolean);
  const vocabEn = [
    call.clientCity ? `city: ${call.clientCity}` : null,
    call.clientAddress ? `address: ${call.clientAddress}` : null,
  ].filter(Boolean);

  if (input.language === "fr") {
    return [
      `Appel ${call.direction === "outbound" ? "sortant" : "entrant"} du ${when} (durée ${mins} min ${secs} s).`,
      call.agentName ? `Téléphoniste : ${call.agentName}.` : null,
      call.clientName ? `Client (selon la fiche) : ${call.clientName}.` : null,
      vocabFr.length > 0
        ? `Repères d'orthographe tirés de la fiche, s'ils sont prononcés (${vocabFr.join(" ; ")}) — ne les mets PAS dans la note s'ils ne sont pas dits dans l'appel.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `${call.direction === "outbound" ? "Outbound" : "Inbound"} call on ${when} (duration ${mins} min ${secs} s).`,
    call.agentName ? `Agent: ${call.agentName}.` : null,
    call.clientName ? `Client (per the CRM record): ${call.clientName}.` : null,
    vocabEn.length > 0
      ? `Spelling hints from the CRM record, if spoken (${vocabEn.join("; ")}) — do NOT put them in the note unless actually said in the call.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface TranscriptOutput {
  summary: string;
  transcript: string | null;
  /**
   * Pourquoi la lecture n'a pas donné de note — null quand tout va bien.
   *
   * `malformed` : le modèle a VOULU répondre en JSON et a raté. C'est le cas
   * du 2026-09-15 (8 notes sur 52 en production) : le verbatim était complet,
   * puis la réponse s'arrêtait sans refermer la chaîne ni écrire `summary`.
   * `empty` : la réponse est lisible mais ne porte aucune note.
   *
   * Les deux valent une rangée `failed` côté cœur. La distinction n'est pas
   * cosmétique : `malformed` accuse le FORMAT (le modèle, le prompt), `empty`
   * accuse le CONTENU (l'audio, la consigne) — on ne corrige pas la même chose.
   */
  failure: "malformed" | "empty" | null;
}

/**
 * Le modèle a-t-il VOULU répondre dans notre format ?
 *
 * C'est la seule chose qui distingue « il a raté son format » de « il a écrit
 * sa note en prose » — et donc ce qui décide si un texte illisible devient un
 * échec ou une note. Une accolade en tête, une clôture de code, ou l'une de
 * nos deux clés employée comme clé JSON : tout cela est une tentative. Une
 * note en prose qui cite « {G1V 2M3} » n'en est pas une.
 */
function looksLikeJsonAttempt(text: string): boolean {
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith("```")) return true;
  return /"(?:summary|transcript)"\s*:/.test(text);
}

/**
 * Les objets `{…}` ÉQUILIBRÉS du texte, dans l'ordre.
 *
 * Pourquoi pas « de la première à la dernière accolade » : quand le modèle
 * écrit deux objets à la suite (son brouillon, puis sa réponse), ce découpage
 * les englobe tous les deux avec ce qu'il y a entre — le tronçon ne parse
 * jamais, et le texte ENTIER finissait en note sur la fiche. En les lisant un
 * par un, la vraie réponse est retrouvée au lieu d'être recrachée en brut.
 *
 * Le suivi des chaînes et des échappements est indispensable : une accolade à
 * l'intérieur du verbatim (« il m'a dit {sic} ») décalerait autrement toutes
 * les bornes.
 */
function jsonObjectCandidates(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) begin = i;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && begin !== -1) {
          found.push(text.slice(begin, i + 1));
          begin = -1;
        }
      }
    }
  }
  return found;
}

/**
 * Récupère le verbatim d'un JSON resté ouvert.
 *
 * Le cas mesuré : `{"transcript": "Allô… Bonne soirée, merci.` — l'appel a été
 * écouté et PAYÉ, la transcription est entière, seules la fermeture et la note
 * manquent. La jeter reviendrait à payer deux fois pour la même minute d'audio.
 * On referme donc la chaîne et l'objet, et on relit : si ça parse, le verbatim
 * est authentique (les échappements `\\n`, `\\"`, `\\u…` sont rendus par
 * JSON.parse lui-même, jamais par une expression régulière).
 */
function salvageObject(text: string): TranscriptOutput | null {
  const open = text.indexOf("{");
  if (open === -1) return null;
  const body = text.slice(open);
  // Une coupure tombe soit en plein texte, soit juste après une barre oblique
  // inverse (qui avalerait le guillemet qu'on ajoute), soit après un guillemet
  // déjà fermé. Trois réparations, de la plus probable à la moins.
  for (const candidate of [`${body}"}`, `${body.replace(/\\+$/, "")}"}`, `${body}}`]) {
    const read = readTranscriptObject(candidate);
    if (read) return read;
  }
  return null;
}

/**
 * Lit la réponse du modèle.
 *
 * Trois issues, jamais confondues : une note lisible, une réponse VIDE, une
 * réponse MALFORMÉE. Ce qui a changé le 2026-09-15 : le repli « tout le texte
 * est la note » ne s'applique plus qu'à de la PROSE. Un JSON raté ne devient
 * plus une note — il collait jusque-là `{ "transcript": "Allô…` en commentaire
 * sur la fiche du client, signé du nom du téléphoniste, et la rangée était
 * figée `done`, donc jamais rejouée.
 */
export function parseTranscriptOutput(raw: string): TranscriptOutput {
  const text = raw.trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (unfenced === "") return { summary: "", transcript: null, failure: "empty" };

  // Le JSON ENTIER d'abord : c'est la voie normale, et elle ne dépend d'aucune
  // accolade trouvée au hasard dans le verbatim.
  const direct = readTranscriptObject(unfenced);
  if (direct) return direct;

  // Puis chaque objet équilibré, un par un : le modèle écrit parfois son
  // brouillon puis sa réponse. On garde la première NOTE trouvée et le
  // premier VERBATIM trouvé, même s'ils viennent d'objets différents. Un objet
  // qui ne porte ni l'une ni l'autre de nos clés est ignoré — sans quoi une
  // note en prose citant « {"postal": "G1V 2M3"} » passait pour une réponse
  // valide et vide, et finissait à la poubelle.
  let summary = "";
  let transcript: string | null = null;
  for (const candidate of jsonObjectCandidates(unfenced)) {
    const read = readTranscriptObject(candidate);
    if (!read) continue;
    if (summary === "") summary = read.summary;
    if (transcript === null) transcript = read.transcript;
  }
  if (summary !== "") return { summary, transcript, failure: null };

  if (looksLikeJsonAttempt(unfenced)) {
    const repaired = salvageObject(unfenced);
    /**
     * Une réponse RÉPARÉE n'est fiable que là où la coupure n'a pas mordu.
     * Le verbatim vient APRÈS la note (le prompt le demande dans cet ordre
     * exprès) : s'il est là, c'est que la note l'a précédé et qu'elle est
     * entière. Sans verbatim, la coupure a pu tomber en plein milieu de la
     * note — et une note coupée en pleine phrase sur la fiche d'un client est
     * précisément ce qu'on refuse d'écrire.
     */
    if (repaired && repaired.summary !== "" && repaired.transcript !== null) {
      return { ...repaired, failure: null };
    }
    // Format raté. On sauve ce qui a été payé, on ne pousse RIEN sur la fiche.
    // `empty` quand la réponse était LISIBLE mais sans note : le reproche ne
    // s'adresse pas au même endroit (le contenu, pas le format).
    const salvaged = transcript ?? repaired?.transcript ?? null;
    return {
      summary: "",
      transcript: salvaged,
      failure: transcript !== null ? "empty" : "malformed",
    };
  }
  // De la prose : le modèle a répondu à côté du format, mais il a écrit une
  // note lisible par un humain. C'est le seul repli qui reste.
  const prose = unfenced.slice(0, SUMMARY_MAX_CHARS).trim();
  return { summary: prose, transcript: null, failure: prose === "" ? "empty" : null };
}

/** Lit un objet `{transcript?, summary?}` — null si le texte n'en est pas un,
 * ou s'il n'en porte aucune des deux clés (donc : pas une réponse à NOTRE
 * question, quoi qu'en dise `JSON.parse`). */
function readTranscriptObject(candidate: string): TranscriptOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const hasKey = typeof obj.summary === "string" || typeof obj.transcript === "string";
  if (!hasKey) return null;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const transcript = typeof obj.transcript === "string" ? obj.transcript.trim() : "";
  return {
    summary: summary.slice(0, SUMMARY_MAX_CHARS),
    transcript: transcript === "" ? null : transcript.slice(0, TRANSCRIPT_MAX_CHARS),
    // JSON lisible mais sans note : c'est un échec de CONTENU, pas de format.
    failure: summary === "" ? "empty" : null,
  };
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
