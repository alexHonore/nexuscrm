import type { FailureText } from "./error-text";
import type { ErrorFamily } from "./error-classes";

/**
 * English words for the Twilio failure catalogue — one file per language,
 * exactly like `messages/<locale>/<ns>.json`.
 *
 * French (`./error-text`) is the source: it decides WHICH codes carry a
 * sentence at all. This file carries the words only — no code, no family, no
 * retry flag. Those live in `./error-classes`, and a translation quietly
 * flipping one of them would make two languages disagree about whether sending
 * again can work, with only one of them right.
 *
 * `tests/unit-docs-locale.test.ts` fails the build when a catalogued code has
 * no entry here, when an entry points at a code the catalogue dropped, or when
 * a string here still reads as French.
 *
 * Missing on purpose, as everywhere in this folder: the Twilio doc URL. A link
 * to an error page is evidence, not prose, and translating it would send the
 * reader to a page that does not exist.
 *
 * Also deliberately absent: anything the SMS assistant reads. These sentences
 * are written for whoever is looking at the screen; the assistant writes in the
 * language of its own configuration, never in the language of this file.
 */
export const ERROR_TEXT_EN: Record<number, FailureText> = {
  // ── filtered ──────────────────────────────────────────────────────────────

  30007: {
    label: "Filtered by the carrier",
    why: "A carrier judged the message unwanted and dropped it without ever delivering it; sending the same text again only digs into the sending number's reputation, so rewrite it first.",
  },
  30039: {
    label: "Reply loop cut",
    why: "Twilio took the incoming message for a machine reply and cut the exchange, to stop two robots answering each other forever.",
  },

  // ── blocked ───────────────────────────────────────────────────────────────

  30004: {
    label: "Message blocked",
    why: "The line is closed at the other end — carrier blocklist, an earlier opt-out, or Twilio's own filter; only a START from the recipient reopens it.",
  },
  21610: {
    label: "Unsubscribed",
    why: "This number replied STOP, so Twilio refuses the send before even attempting it, and nothing will reach it again until the recipient writes START.",
  },

  // ── invalid ───────────────────────────────────────────────────────────────

  30005: {
    label: "No such number",
    why: "The network does not know this number, or knows it no longer; fix the phone on the client record, there is nothing to send again as is.",
  },
  30006: {
    label: "Landline",
    why: "It is a landline, or a carrier that does not carry SMS: this phone will never receive a text, whatever the message says.",
  },
  21614: {
    label: "Not a mobile",
    why: "Twilio refused the send outright because the number on the client record is not a mobile line — the record is what needs fixing.",
  },

  // ── unreachable ───────────────────────────────────────────────────────────

  30003: {
    label: "Handset unreachable",
    why: "The handset never answered — switched off, out of range, or set aside by the carrier after repeated failures; a later attempt stands a fair chance.",
  },
  30046: {
    label: "Delivery unconfirmed",
    why: "The message went out but the handset never confirmed receiving it; sending again after a delay is the only way to know.",
  },

  // ── registration ──────────────────────────────────────────────────────────

  30002: {
    label: "Account suspended",
    why: "The Twilio account was suspended between queueing and sending; check billing first, a declined card produces this very code.",
  },
  30024: {
    label: "Sender not provisioned",
    why: "The recipient's carrier requires a pre-registered sending number and this one is not registered yet — enrolment under way, or a freshly ported number.",
  },
  30032: {
    label: "Toll-free unverified",
    why: "The toll-free sending number is still awaiting verification; carriers have blocked such traffic since 2024, Canadian mobiles included.",
  },
  30033: {
    label: "A2P campaign suspended",
    why: "The A2P campaign declared at Twilio was suspended after approval; never move the same traffic onto another campaign, Twilio treats it as a serious violation.",
  },
  30034: {
    label: "Number not A2P registered",
    why: "The send targeted an American mobile from a number absent from the A2P 10DLC registry; for a broker writing only inside Québec, it means an American number slipped into the list.",
  },
  30035: {
    label: "Registration under way",
    why: "The sending number is finishing its enrolment: allow up to 24 hours, and do not detach it from the service, which would restart enrolment from scratch.",
  },
  30037: {
    label: "Sending disabled",
    why: "The Twilio subaccount holding the credentials may not send at all: an account setting, nothing to do with the recipient.",
  },

  // ── throughput ────────────────────────────────────────────────────────────

  30001: {
    label: "Queue overflow",
    why: "More messages were pushed than the number can drain — roughly one a second; the send waited in line, then was dropped, and it will go through once departures are spread out.",
  },
  30017: {
    label: "Carrier congestion",
    why: "The downstream network was congested at delivery time; nothing to fix on our side, the send goes through on its own later.",
  },
  30022: {
    label: "A2P rate exceeded",
    why: "The registered campaign went over its throughput, across all its numbers — often because too many messages went to a single recipient in a short window.",
  },
  30023: {
    label: "Daily cap reached",
    why: "The brand's daily allowance at T-Mobile is spent; it resets at midnight, Pacific time.",
  },
  30036: {
    label: "Expired in queue",
    why: "The message waited in line beyond its validity period and was dropped before delivery: the queue is what jammed, not the recipient.",
  },
  30450: {
    label: "Send held (anti-fraud)",
    why: "Twilio's pumping protection put a temporary hold on this destination, typically 15 to 30 minutes; look for the burst that triggered it rather than resending at once.",
  },
  30453: {
    label: "Traffic judged suspicious",
    why: "Twilio's fraud detection found traffic toward this destination unusual; false positives happen, try again in a few hours.",
  },
  30454: {
    label: "Account limit reached",
    why: "The account went over the number of messages Twilio accepts toward this destination; there is nothing to do but wait.",
  },
  21611: {
    label: "Sender queue full",
    why: "The sending number's queue was already overflowing: the message was refused at creation, never even held. Same remedy as a queue overflow, spread the departures out.",
  },

  // ── content ───────────────────────────────────────────────────────────────

  30883: {
    label: "Content rejected (A2P)",
    why: "The A2P campaign review rejected the declared content: this code sits on the campaign registered at Twilio, never on one message.",
  },
  30884: {
    label: "Campaign judged spam",
    why: "The A2P review classified the campaign as spam or phishing: it is the campaign declaration that needs rewriting, not the message.",
  },
  30885: {
    label: "Campaign high risk",
    why: "The A2P review found the declared use case too risky; the correction belongs in the campaign declaration, at Twilio.",
  },
  30886: {
    label: "Invalid description",
    why: "The use-case description filed with the A2P review is too vague or inconsistent; it has to be written again in the Twilio console.",
  },
  30892: {
    label: "Public link shortener",
    why: "The sample message filed with the A2P review carried a public shortener (bit.ly, TinyURL): carriers block those on sight, so use the full web address.",
  },
  30893: {
    label: "Sample off topic",
    why: "The sample message filed with the A2P review differs from the declared use case; both have to tell the same story.",
  },

  // ── carrier_other ─────────────────────────────────────────────────────────

  30008: {
    label: "Refused without reason",
    why: "The downstream carrier refused without saying why; one isolated case means nothing, but a cluster of this code is often filtering that will not announce itself.",
  },
  21612: {
    label: "Sender not routable",
    why: "This pairing of sending and receiving number cannot be routed; from a Canadian number toward Canada or the United States, it is almost always a wrong sender.",
  },

  // ── platform ──────────────────────────────────────────────────────────────

  30410: {
    label: "Provider timeout",
    why: "The downstream provider took too long to answer and Twilio will not retry by itself: sending again is the right move here.",
  },
  30500: {
    label: "Twilio outage",
    why: "The error came from Twilio, not from the recipient; send it again, and go look at the status page if it repeats.",
  },
  21408: {
    label: "Region disabled",
    why: "The recipient's country is switched off in the account's geographic permissions — a checkbox in the Twilio console, which sometimes closes itself after a change of plan.",
  },
};

/** The family alone, when there is no code — or when the code is too new. */
export const FAMILY_TEXT_EN: Record<ErrorFamily, FailureText> = {
  filtered: {
    label: "Filtered as spam",
    why: "A filter judged the CONTENT and dropped the message; the sending number's reputation pays for it, never the offending message.",
  },
  blocked: {
    label: "Line closed",
    why: "The recipient or their carrier refuses this line; only the recipient can reopen it.",
  },
  invalid: {
    label: "Invalid number",
    why: "The number does not exist or cannot receive a text: it is the client record that needs fixing, not the message.",
  },
  unreachable: {
    label: "Unreachable",
    why: "The handset never answered; the very same send may well go through later.",
  },
  registration: {
    label: "Sender not cleared",
    why: "Refused at the door: the account, the number or the campaign had no right to send, and the message content was never even read.",
  },
  throughput: {
    label: "Throughput saturated",
    why: "The queue or the sending rate is saturated; it clears on its own as soon as departures are spread out.",
  },
  content: {
    label: "Campaign rejected",
    why: "The A2P review rejected what was declared: the code belongs to the campaign at Twilio, never to a message.",
  },
  carrier_other: {
    label: "Carrier refusal",
    why: "The carrier refused without giving a reason; only a build-up of such refusals tells you anything.",
  },
  platform: {
    label: "Twilio fault or setting",
    why: "Twilio failed on its side, or an account setting closes this destination.",
  },
  other: {
    label: "Unknown error",
    why: "This code is absent from the catalogue; the Twilio error dictionary describes it.",
  },
};
