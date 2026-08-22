import type { CampaignFieldText } from "./docs";

/**
 * English text for the campaign field registry — one file per language, like
 * `messages/<locale>/<ns>.json`. French (`./docs`) decides WHICH fields exist;
 * this file only carries their words.
 */
export const CAMPAIGN_FIELD_TEXT_EN: Record<string, CampaignFieldText> = {
  name: {
    label: "Name",
    what: "The campaign's name, as it appears in the list and in the statistics.",
    why: "It is never sent to the contact; it is there so you can find your way around. Name what it DOES: \"180-day reactivation\", not \"Campaign 3\".",
  },
  description: {
    label: "Description",
    what: "One sentence on what the campaign is for.",
    why: "When the assistant writes a rung itself, this sentence gives it the WHY of the message (reactivation, new lead, open house). It is never quoted verbatim.",
  },
  assistantId: {
    label: "Assistant",
    what: "The assistant that takes over the thread when the contact replies, and that writes the rungs left without text.",
    why: "Without an assistant, a reply from the contact waits for a human. A reactivation campaign without an assistant only makes sense if someone is watching the inbox.",
    pitfalls: "The assistant must be ACTIVE: an assistant still in draft does not reply, and the \"written by the assistant\" rung stays empty.",
  },
  smsNumberId: {
    label: "Sending number",
    what: "The SMS line the campaign writes from. Empty = the first active number.",
    why: "A contact who replies has to land back on the same thread; the number is what identifies the thread.",
  },
  "trigger.kind": {
    label: "Trigger",
    what: "What enrolls a contact: you yourself (manual), a lead arriving, a category change, or a periodic sweep of the audience.",
    why: "This is the setting that decides WHO gets an SMS and WHEN. The four answer different needs: a lead has to be contacted within the minute; an old database is reactivated in waves.",
  },
  "trigger.sourceIds": {
    label: "Triggering sources",
    what: "For \"new lead\": only enroll leads that came from these sources. Empty = all.",
    why: "This restricts the EVENT, not the population: a campaign can target Facebook leads without excluding people who came from elsewhere from its audience.",
  },
  "trigger.toCategoryIds": {
    label: "Arrival categories",
    what: "For \"category change\": enroll when a contact ENTERS one of these categories. Empty = any of them.",
    why: "\"To call back\" → \"Hot\" is a moment; the SMS has to go out at that moment, not at the next sweep.",
  },
  "trigger.everyHours": {
    label: "Sweep frequency",
    what: "For \"periodic sweep\": how many hours between two passes over the audience.",
    why: "Bounds how often the sweep runs, NOT the sending pace — the daily cap and the ladder are what set the pace.",
  },
  "audience.categoryIds": {
    label: "Target categories",
    what: "Contacts have to be in one of these categories. Empty = all.",
    why: "The category is your pipeline: it is the most natural filter for saying \"the people at this stage\".",
  },
  "audience.sourceIds": {
    label: "Target sources",
    what: "Contacts have to come from one of these sources. Empty = all.",
    why: "A message that says \"you filled in our Facebook form\" must only go to Facebook leads.",
  },
  "audience.assignedToIds": {
    label: "Assigned to",
    what: "Contacts have to be assigned to one of these users. Empty = doesn't matter.",
    why: "Lets a caller follow up on THEIR list without touching anyone else's.",
  },
  "audience.createdWithinDays": {
    label: "Created within (days)",
    what: "Number of days: only target contacts created recently.",
    why: "A \"welcome\" campaign only makes sense for new contacts.",
  },
  "audience.createdBeforeDays": {
    label: "Created more than (days) ago",
    what: "Number of days: only target contacts created a long time ago.",
    why: "The counterpart of the previous one, for a reactivation.",
  },
  "audience.notContactedForDays": {
    label: "Not contacted for (days)",
    what: "Number of days with no call and no SMS. The heart of a reactivation campaign.",
    why: "Writing to someone you had on the phone yesterday is harassment; writing to someone who has been silent for six months is a follow-up.",
    pitfalls: "\"Never contacted\" counts as \"not contacted since forever\": a freshly imported contact who has never been called IS in the audience. Combine with \"created more than\" if that is not what you want.",
  },
  "audience.languages": {
    label: "Languages",
    what: "Only target contacts whose record is in these languages. Empty = all.",
    why: "A rung written in French must not go out to an English-speaking contact — and the assistant writes in the language of its own configuration.",
  },
  "audience.excludeActiveInOtherCampaign": {
    label: "Exclude people already in another campaign",
    what: "Yes by default: a contact enrolled and active in ANOTHER campaign is not picked up here.",
    why: "Two campaigns writing to the same person in the same week is exactly what gets a number flagged as spam.",
  },
  "audience.excludeDoNotCall": {
    label: "Exclude \"do not call\"",
    what: "Yes by default: the record's \"do not call\" box excludes from SMS too.",
    why: "The flag is about voice; extending it to SMS is the cautious choice. Only uncheck it if you know the refusal was about calls.",
  },
  ladder: {
    label: "Ladder",
    what: "The ordered list of messages: opener, then follow-ups. Eight rungs at most.",
    why: "The ladder is what decides the pace. A single rung = one message and that is it; three = you are insisting. A reply from the contact stops the ladder.",
  },
  "ladder[].delayHours": {
    label: "Delay (hours)",
    what: "For the first rung: since enrollment. For the ones after it: since the PREVIOUS rung. In hours.",
    why: "Cumulative, not absolute: \"72\" on three rungs means three days between each one, so the last goes out on the ninth day. Quiet hours push a send to the next morning anyway.",
    pitfalls: "Reading the delays as absolute makes you underestimate how long the ladder runs.",
  },
  "ladder[].body": {
    label: "Rung text",
    what: "The message, verbatim. Empty (null) = the ASSISTANT writes it, taking the history into account.",
    why: "A dictated text is predictable, which is good for a legal opener. A follow-up gains from being written on the spot: it has to take into account what has been said in the meantime.",
    pitfalls: "An empty rung requires an ACTIVE assistant on the campaign; otherwise nothing goes out and the trace says so (\"skipped\").",
  },
  "ladder[].label": {
    label: "Label",
    what: "An internal name for the rung (\"opener\", \"follow-up 2\").",
    why: "It never appears in a message; it is there so you can read the statistics.",
  },
  variants: {
    label: "A/B variants",
    what: "Up to four wordings of the OPENER, drawn at random per contact according to their weight.",
    why: "Only the first rung varies: varying the whole ladder would make the result unattributable.",
  },
  "variants[].key": {
    label: "Variant key",
    what: "A short, stable identifier (\"direct\", \"soft\").",
    why: "It is what gets written on the enrollment; changing it breaks the history.",
  },
  "variants[].weight": {
    label: "Weight",
    what: "Relative share of the draw (0-100). 0 = variant taken out without losing its history.",
    why: "Two variants at 50/50 compare; 90/10 tests a new wording cautiously.",
  },
  "variants[].body": {
    label: "Variant text",
    what: "The opener specific to this variant. Empty = the opener of the first rung.",
    why: "Two variants with empty text are identical: the test is not a test.",
  },
  dailyEnrollmentCap: {
    label: "Daily enrollment cap",
    what: "Maximum number of PEOPLE enrolled per day (Toronto day).",
    why: "A base of 3,000 contacts must not get 3,000 SMS the same morning: that is what gets a number blocked, and it is too many replies to handle at once.",
    pitfalls: "This is NOT a message pace: \"1\" means one person per day — a campaign that looks active and writes to almost nobody.",
  },
  totalEnrollmentCap: {
    label: "Total cap",
    what: "Maximum number of people enrolled over the whole life of the campaign. Empty = no limit.",
    why: "Useful for a test: \"the first 50, then we look\".",
  },
  startsAt: {
    label: "Start",
    what: "Date before which the campaign enrolls nobody. Empty = as soon as it is activated.",
    why: "Lets you get everything ready and release the wave on a Monday morning.",
  },
  endsAt: {
    label: "End",
    what: "Date after which the campaign stops enrolling anyone. Empty = no end.",
    why: "Enrollments already under way finish their ladder; only new ones stop.",
  },
};
