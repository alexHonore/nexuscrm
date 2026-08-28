import type { FindingText } from "./findings";

/**
 * English words for the deliverability findings — one file per language,
 * exactly like `messages/<locale>/<ns>.json`.
 *
 * French (`./findings`) is the source: it decides WHICH findings exist, their
 * family, their baseline severity, the metric that fires them, the kind of
 * deep link they carry and their order. This file carries the words only, and
 * nothing else — no structure, no threshold, no metric id. A translation that
 * quietly changes a severity would make two languages disagree about how bad
 * a thing is, and only one of them could be right.
 *
 * `tests/unit-docs-locale.test.ts` fails when a finding has no entry here,
 * when an entry points at an id the registry dropped, or when a string here
 * still reads as French.
 *
 * Also missing on purpose: `sourceUrl`. A link to a Twilio error page or to
 * the CTIA best practices document is evidence, not prose — translating it
 * would send a reader to a document that does not exist.
 *
 * Deliberately absent, as everywhere else in this repository: anything the SMS
 * assistant itself reads. Its messages are written in the language of its own
 * configuration, never in the language of whoever is looking at the screen.
 */
export const FINDING_TEXT_EN: Record<string, FindingText> = {
  // ── Did it arrive? ────────────────────────────────────────────────────────

  low_delivery_rate: {
    label: "Some messages never arrive",
    why: "Delivery rate is the first number a carrier weighs when deciding whether a sending number still deserves to be carried: below 90 %, every send is billed and nobody reads it. The 95 % / 90 % bar is a vendor benchmark, not a rule published by Canadian carriers — none of them publishes its own.",
    fix: "In the \"By sending number\" table, work on the error code listed first under the offending number: a single code almost always accounts for most of the rate.",
  },

  no_dlr_backlog: {
    label: "Messages stay \"sent\" and are never confirmed",
    why: "Without a delivery receipt the database cannot know whether a message arrived: the thread stays \"queued\", nobody follows up, and nothing looks broken. That was the exact shape of the 2026-08-25 outage — sends went out, status callbacks came back as 403. An operational bar, not a carrier rule.",
    fix: "Check that TWILIO_AUTH_TOKEN in Vercel belongs to the account actually sending: a rejected signature makes the status callback fail silently.",
  },

  stuck_in_flight: {
    label: "Messages have been frozen in flight over an hour",
    why: "A message still \"queued\" an hour later is neither gone nor lost: it is waiting on a dispatcher that never runs. The contact simply believes nobody answered. An operational bar, aligned with the go-live preflight so both screens cannot disagree.",
    fix: "Open Go live and look at when the dispatcher last ran: past fifteen minutes, the queue no longer drains on its own.",
  },

  carrier_filtered: {
    label: "Messages are being filtered by the phone carrier",
    why: "Error 30007 means a carrier judged the message unwanted and dropped it without ever delivering it. It is THE junk-message signal, and it is charged against the reputation of the whole sending number, never against the one offending message. Re-sending the same text digs the hole deeper.",
    fix: "Open the Content tab and remove the link from the most-sent template: a link in a first message is the commonest trigger.",
  },

  carrier_blocked: {
    label: "Some phones are refusing your messages",
    why: "Error 30004 means the recipient or their carrier blocks the line; 21610 means Twilio refuses to send because this number already replied STOP. Writing to those phones again is precisely how a sender gets suspended.",
    fix: "Open the client record and tick \"Do not call\": the number then drops out of every campaign audience.",
  },

  hard_invalid_numbers: {
    label: "You are texting numbers that cannot receive SMS",
    why: "30005 is an unknown number, 30006 a landline. A rising rate says nothing about your messages: it says the LIST is bad — stale, mistyped or bought numbers. Carriers read this pattern as harvesting and filter the sender accordingly. Vendor benchmark.",
    fix: "Open the record and correct the phone number, or clear it: a landline will never receive a text, whatever the message says.",
  },

  unreachable_spike: {
    label: "\"Unreachable\" results are climbing period over period",
    why: "Error 30003 (\"handset off or out of range\") has a normal background level; it is the RISE that betrays quiet filtering, which likes to disguise itself as a switched-off phone. Twilio documents the mechanism; the drift bar (+2 points) is ours.",
    fix: "Compare it against the \"Filtered\" column for the same number in the \"By sending number\" table: if both climb together, treat the content, not the list.",
  },

  error_rate_high: {
    label: "Too many sends end in an error",
    why: "One send in ten failing, all codes taken together, is the profile of a sender carriers begin to set aside: they do not see an intent, they see a number that produces failures. A vendor benchmark (6 % / 10 %), not a published bar.",
    fix: "Work on the code listed first under the offending number in the \"By sending number\" table before any other: the long tail of rare codes weighs almost nothing.",
  },

  registration_block: {
    label: "A send was refused for want of A2P registration",
    why: "These codes mean the sender is not registered in the A2P 10DLC program, which is mandatory to text AMERICAN mobiles. Québec-to-Québec traffic should never see them: their presence means an American number entered the list.",
    fix: "Open the record whose area code is American and take it out of the campaign — registering a brand is not the answer while you are not deliberately texting into the United States.",
  },

  us_bound_traffic: {
    label: "You are texting American mobiles",
    why: "A2P 10DLC registration is triggered by the DESTINATION, never by the sender: while the list stays Canadian there is nothing to register anywhere. As soon as an American mobile receives a message, the traffic falls under American rules and gets blocked for want of a declared brand.",
    fix: "Take records whose area code is American out of the audience — destination creates the obligation, not your own number.",
  },

  throughput_block: {
    label: "The number's send queue overflowed",
    why: "These codes mean too many messages were pushed at once through one number: the queue outruns what a long code can drain, roughly one message a second. The overflow is refused, not delayed — it will never go out.",
    fix: "Lower the number's \"Cap / day\" in Settings: a spread-out departure gets through where a burst is refused.",
  },

  // ── Who said stop? ────────────────────────────────────────────────────────

  optout_rate_high: {
    label: "Too many people reply STOP",
    why: "Opt-out is the one signal carriers act on without argument, and it runs several days ahead of filtering. The 1 % / 2 % bar is a vendor benchmark — no Canadian carrier publishes its own — but the mechanism behind it is entirely real.",
    fix: "Open the assistant, Approach tab, and take its persistence down one notch: it is the count of unanswered follow-ups that drives people to STOP, long before wording does.",
  },

  suppression_leak: {
    label: "A message went out to an opted-out number",
    why: "Someone who replied STOP must never receive anything again: the CTIA best practices allow exactly ONE acknowledgement after the keyword. A single extra message is enough to get a sender suspended, and this is the one SMS rule nobody negotiates.",
    fix: "Open the record and tick \"Do not call\": it is the barrier every sending path honours, including the one that just leaked.",
  },

  carrier_suppressions: {
    label: "Numbers were blocklisted automatically after a failure",
    why: "Every failure treated as final writes a permanent suppression: the phone leaves every campaign without anyone deciding so. A burst of suppressions means either a whole bad list, or filtering being mistaken for a dead handset. Operational counter.",
    fix: "Look under each number in the \"By sending number\" table at which code produced those blocks: 30003 in bulk is disguised filtering, not switched-off phones.",
  },

  harsh_suppression_30003: {
    label: "We permanently blocklist numbers over a transient error",
    why: "A STRUCTURAL finding, read in the code rather than in the figures: `src/lib/sms/status.ts` files 30003 among final failures (`HARD_FAILURE_CODES`) and writes a permanent suppression, while Twilio documents that code as transient — \"the handset is off or out of range\". A phone flat for an hour therefore costs a contact forever.",
    fix: "The remedy is a code change — drop 30003 from `HARD_FAILURE_CODES`; already-lost numbers are released by deleting their rows from the `suppressions` table.",
  },

  missing_optout_language: {
    label: "The first message does not say how to stop it",
    why: "The CTIA best practices ask the opening message to say how to opt out, and carriers use it as a seriousness marker. Without the word STOP, someone wanting it to end reports the message instead of answering it — and a report weighs far heavier than an opt-out.",
    fix: "Add \"Reply STOP to opt out\" at the end of the opening message.",
  },

  hostile_replies: {
    label: "Contacts are replying with hostility",
    why: "Real spam reports (7726) land at the aggregator, never on the message row: they are structurally beyond our reach. A hostile reply is what we can see — a PROXY, an indication, never the measurement — and it almost always runs ahead of filtering starting.",
    fix: "Open the record and read the thread: nine times in ten it is one follow-up too many on a contact already served.",
  },

  // ── What shape does the traffic have? ─────────────────────────────────────

  template_spread: {
    label: "The same text goes out from several numbers",
    why: "Spreading one identical text across several senders has a name — snowshoeing — and it is named word for word in the CTIA best practices (§5.5.2) and in Twilio's messaging policy, which judges on \"intent OR effect\". Done without intent, effect alone is enough to get an account suspended.",
    fix: "Pin the campaign to ONE single sending number, in the General tab of its editor.",
  },

  sender_inconsistency: {
    label: "One contact receives messages from two numbers",
    why: "To the recipient, two numbers saying the same thing are two strangers, and they block. To a carrier, it is the signature of snowshoeing. A thread is pinned to one number, so two senders reaching one contact means two threads open on the same handset.",
    fix: "Pin the campaign to ONE single sending number (the General tab of its editor): that setting is what decides, and it stops the next contact from being reached twice.",
  },

  daily_cap_pressure: {
    label: "A number is nearing its daily cap",
    why: "The cap is what keeps a number from looking like a mailing machine. Pressed against it, two things happen together: evening sends roll over to tomorrow, and volume reaches the level at which carriers start looking closely.",
    fix: "Lower the daily enrollment cap of the campaign feeding this number: raising the number's own cap only moves the problem onto its reputation.",
  },

  burst_traffic: {
    label: "Sends leave in bursts",
    why: "A number going from zero to a hundred segments inside one minute and then falling back draws exactly the profile an anti-spam system hunts for: a machine, not a conversation. The peak-over-median ratio is an operational measurement; the profile itself is genuinely what gets spotted.",
    fix: "Lower the campaign's daily enrollment cap: departures then spread themselves across the day.",
  },

  quiet_hours_violation: {
    label: "Automated messages went out outside permitted hours",
    why: "The CTIA best practices set sending between 8 a.m. and 9 p.m. in the RECIPIENT's own time: a text at 10 p.m. is the commonest complaint trigger, and the easiest to avoid. Having no way to know the recipient's zone, this check counts sends outside 9 a.m. – 8 p.m. TORONTO time — the engine's default window, tighter than the CTIA one. The window that actually decides is the assistant's.",
    fix: "Open the assistant, Approach tab, and tighten its send window: that window decides at send time, this dashboard does not.",
  },

  low_reply_rate: {
    label: "Almost nobody replies",
    why: "Traffic nobody reads ends up filtered even when every word is clean: engagement is the counterweight to volume in every carrier model. Below 5 % of threads replying, the number looks like a broadcast. Vendor benchmark; the mechanism is real, the bar is indicative.",
    fix: "Rewrite the assistant's opening so it asks ONE closed question: a message that invites no answer receives none.",
  },

  unanswered_tail: {
    label: "We keep writing to people who never replied",
    why: "Four outbound and zero inbound is talking to oneself. Each further follow-up adds volume without engagement — the exact mixture that tips a number onto the filtered side — and the contact has already decided.",
    fix: "Shorten the campaign ladder to three rungs: the fourth does not convert, it costs reputation.",
  },

  reach_concentration: {
    label: "The same people receive nearly everything",
    why: "A hundred messages for twenty recipients is no longer a campaign: to the contact it reads as harassment, and to a carrier it is tight repetition over a small set of numbers — the easiest pattern of all for a filter to spot.",
    fix: "Add \"not contacted for N days\" to the campaign audience: it is the filter that stops you rewriting to the same people.",
  },

  // ── What does the text say? ───────────────────────────────────────────────

  merge_field_leak: {
    label: "A merge field ships as-is inside the message",
    why: "A `{{prenom}}` written into a campaign rung is replaced by nothing at all: the rung body is shipped literally, never going through the prompt template. Your contact receives \"Hello {{prenom}}\", the most recognisable mark of a botched automated send.",
    fix: "Leave the rung body EMPTY: the assistant then writes the message and places the first name itself.",
  },

  public_shortener: {
    label: "A public shortened link sits in the message",
    why: "Shared shorteners (bit.ly, tinyurl…) hide the destination, and one abuser burns the domain for everyone using it: North American carriers block them outright, and Twilio's messaging policy forbids them in A2P traffic.",
    fix: "Replace the shortened link with the full website address.",
  },

  link_in_opener: {
    label: "The first message carries a link",
    why: "A link sent to somebody who has replied nothing yet is the most reliable junk-message signal a carrier filter knows. It is also the easiest one to remove: the link can wait for a second reply.",
    fix: "Remove the link from the opening message and keep it for a message answering an actual question.",
  },

  missing_brand: {
    label: "The first message does not say who it comes from",
    why: "CASL requires every commercial message to identify its sender, and Twilio's messaging policy makes it a condition of service. A contact who does not recognise the sender never replies: they report.",
    fix: "Open the assistant, Identity tab, and check the organization name: that word is what the \"identify_sender\" rule looks for in a first message.",
  },

  caps_and_punctuation: {
    label: "The message shouts",
    why: "Capitals and strings of exclamation marks are counted by content filters as an advertising marker: never decisive alone, they add to everything else. The calculation already excludes STOP, ARRÊT and the company name, which are capitalised for good reasons.",
    fix: "Put the sentence back into lower case and keep one single exclamation mark per message.",
  },

  promo_language: {
    label: "The message reads like an advertisement",
    why: "\"Free\", \"limited offer\", \"guaranteed\" are the first words content filters count — and a broker needs none of them, because an appointment is won on a question, never on a promise. Operational word list, not a list published by any carrier.",
    fix: "Swap the promise for a question: \"when would you be available?\" converts better than an offer.",
  },

  shaft_language: {
    label: "The message uses high-risk words (credit, mortgage, pre-approval)",
    why: "The so-called SHAFT categories and consumer credit are filtered outright by carriers, and \"bad credit\", \"pre-approval\" or \"refinancing\" appear in every public list (CTIA) — including when the broker writing them is entirely legitimate.",
    fix: "Add those words to the \"Forbid specific words\" guardrail rule: the assistant will talk about a meeting rather than about financing.",
  },

  evasion_characters: {
    label: "The message hides invisible characters or mixes two alphabets",
    why: "A zero-width character, or a Cyrillic \"а\" slipped inside a Latin word, serves one purpose only: slipping under a filter. Twilio's messaging policy judges on \"intent OR effect\" — pasted in by accident from a word processor, the effect is identical, and so is the penalty.",
    fix: "Retype the message into an empty field instead of pasting it: an invisible character almost always arrives through copy-paste.",
  },

  ucs2_inflation: {
    label: "One typographic character triples what a message costs",
    why: "A single curly apostrophe tips the WHOLE message into UCS-2: 70 characters per segment instead of 160, so three times the price and three times the network volume, over a mark nobody notices. This is not a carrier rule, it is billing.",
    fix: "Replace the curly apostrophe ’ with the straight one ' — offending characters and their replacement are listed under the finding.",
  },

  ladder_body_unguarded: {
    label: "A hand-written rung escapes EVERY guardrail",
    why: "A STRUCTURAL finding, read in the code rather than in the figures: a rung body filled in by hand travels through `runTouch` → `send_sms` → `handleSendSms`, a path that runs no content check whatsoever — no maximum length, no link policy, no forbidden terms, no sender identification.",
    fix: "Leave the rung body EMPTY so the assistant writes it and guardrails apply — otherwise, know that this screen is the only review this text will ever get.",
  },

  // ── Is the machine running? ───────────────────────────────────────────────

  dispatcher_stale: {
    label: "The dispatcher has not run in a long while",
    why: "Nothing leaves until the dispatcher runs: messages sit in the queue, threads look handled, and the contact waits. Fifteen minutes is the go-live preflight bar, reused verbatim so the two screens can never contradict each other.",
    fix: "Open Go live: its checklist names whatever is keeping the dispatcher from running.",
  },

  dispatch_cron_daily: {
    label: "The queue only drains while somebody is using the app",
    why: "A STRUCTURAL finding, read in the file rather than in the figures: `vercel.json` declares `/api/cron/dispatch` at \"30 12 * * *\", so ONCE a day, while the code is commented as though it ran every minute. The queue therefore advances on `kickDispatch()` calls made by ordinary navigation — a day with nobody in the app is a day with no sends, silently.",
    fix: "Change the schedule in `vercel.json` (\"*/5 * * * *\", say) if sends have to go out with nobody opening the app.",
  },

  queue_backlog: {
    label: "Sends are piling up in the queue",
    why: "A growing queue means the dispatcher is not draining what campaigns drop into it. Messages are not lost, they are late — and a follow-up landing three hours behind reaches a contact who has lost the thread.",
    fix: "Open Go live and look at the age of the oldest waiting job: over an hour, the dispatcher is not running.",
  },

  kill_switch_on: {
    label: "The kill switch is down",
    why: "While it is down no automated message goes out: intended the day it was pulled, forgotten three days later. Campaigns keep enrolling people all the same, and the whole backlog leaves at once when sending resumes — exactly the burst worth avoiding.",
    fix: "Open Settings and lift the kill switch if the reason shown no longer holds.",
  },

  smart_encoding_off: {
    label: "Twilio is not fixing typographic characters (Smart Encoding off)",
    why: "Smart Encoding swaps curly apostrophes, curly quotes and long dashes for their GSM equivalent before sending. Switched off, every French message risks costing three segments instead of one: it is the single most profitable checkbox on this screen.",
    fix: "Turn \"Smart Encoding\" on for the messaging service, in the Twilio console.",
  },

  sender_pool_mismatch: {
    label: "An active CRM number is not attached to the messaging service",
    why: "A number active here yet absent from the Twilio pool will send nothing: messages leave from another number and the contact sees an unknown sender. Conversely, a pool wider than needed rotates senders, which carriers read as snowshoeing.",
    fix: "Attach the number to the messaging service in the Twilio console.",
  },

  status_callback_missing: {
    label: "The messaging service returns no delivery receipts",
    why: "Without a status callback the database will never learn whether a message arrived: every thread stays \"queued\" and a sending outage becomes invisible. It was the hidden half of the 2026-08-25 incident.",
    fix: "Point the messaging service status callback at …/api/webhooks/twilio/status, in the Twilio console.",
  },

  twilio_key_scope: {
    label: "The Twilio key cannot reach everything this screen asks for",
    why: "A restricted API key can happily send messages while being unable to read Monitor or A2P compliance: Twilio answers 401 or 403 and the affected cards stay blank. It is not an outage, it is a scope — confusing one with the other sends you hunting a problem nobody has.",
    fix: "Create a standard API key in the Twilio console, then replace TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET in Vercel.",
  },

  a2p_campaign_problem: {
    label: "The A2P campaign declared at Twilio is in trouble",
    why: "A suspended or rejected 10DLC campaign blocks sends toward American mobiles. For a broker writing only inside Québec it blocks nothing: registration is triggered by destination, never by the sender. Read it as information while no American number is targeted.",
    fix: "Open the messaging service compliance page in the Twilio console and read the error code shown — begin a registration only if you genuinely text into the United States.",
  },

  account_suspended: {
    label: "The Twilio account is suspended",
    why: "A suspended account sends nothing at all, and suspension always travels alongside error codes 30002 and 30037. It is the one line on this screen that makes every other line moot while it holds true.",
    fix: "Open the Twilio console and follow the reinstatement steps shown on the account.",
  },
};
