import type { FixtureFieldText, GuardrailKindText, RulePresetText, SeverityText } from "./docs";

/**
 * English text for the guardrail help — one file per language, like
 * `messages/<locale>/<ns>.json`. French (`./docs`) decides WHAT exists; this
 * file only carries the words an administrator reads.
 *
 * Deliberately absent: a preset's `promptText` and its judge `criterion`.
 * Those go into the assistant's prompt, whose language is the assistant's
 * setting — not the language of whoever is looking at the screen.
 */
export const GUARDRAIL_KIND_TEXT_EN: Record<string, GuardrailKindText> = {
  forbidden_regex: {
    label: "Forbid a form (amount, percentage, e-mail address…)",
    what: "Blocks the message if one of the patterns is found in it. The pattern is a regular expression, so it can describe a FORM rather than one precise word.",
    when: "When what you want to forbid is a form: an amount, a percentage, an e-mail address, a number. A fixed word is better handled with \"Forbid specific words\".",
    config: "One or more patterns, together with the flags (default \"iu\": case-insensitive, Unicode).",
    passes: "\"I'll let Alex walk you through the details.\" — no amount appears.",
    caught: "\"Your house is worth about 450 000 $\" — caught by the pattern \\d[\\d\\s]{2,}\\s?\\$, which describes \"a number followed by $\".",
    pitfall: "A pattern that is too broad catches legitimate messages and the assistant starts failing for no visible reason. Patterns are tested when you save: a pattern that does not compile is refused.",
  },
  forbidden_terms: {
    label: "Forbid specific words",
    what: "Blocks the message if one of the terms in the list appears in it.",
    when: "When what you want to forbid is a precise word or phrase, and you do not want to write a regular expression.",
    config: "The list of terms, one per line.",
    passes: "\"I'd rather let Alex explain that to you in person.\"",
    caught: "\"Our commission is…\" — the term \"commission\" is in the list.",
    pitfall: "The search runs on the raw text: forbidding \"commission\" also catches \"commissionnaire\", and above all it stops the assistant from politely REFUSING to discuss it, since any refusal names the subject. Word the prompt instruction so it deflects without naming.",
  },
  max_chars: {
    label: "Limit the message length",
    what: "Blocks a message longer than the limit, in characters.",
    when: "To keep cost and readability in hand. Past 160 characters (70 with an accent outside the GSM table), the message is billed as several segments.",
    config: "The maximum number of characters.",
    passes: "A 140-character message — a single segment.",
    caught: "A 480-character message — three billed segments, and unreadable on a phone.",
    pitfall: "A limit set too low makes legitimate replies fail when they have to quote two openings. 300 leaves room for one question and two time slots.",
  },
  max_questions: {
    label: "Limit the number of questions",
    what: "Blocks a message that asks more questions than the limit.",
    when: "A text that asks three questions gets no answer at all. One single question per message is the rule that converts.",
    config: "The maximum number of question marks.",
    passes: "\"Thursday 2 p.m. or Friday 10 a.m.?\" — one single question, two choices.",
    caught: "\"What are you looking for? In which area? What budget?\" — three questions: the person answers none of them.",
    pitfall: "The count is on question marks. A question asked without a \"?\" is not seen by this rule.",
  },
  link_policy: {
    label: "Control links",
    what: "Blocks the message if it contains a link to a domain that is not in the allowed list. An EMPTY list forbids every link.",
    when: "A link in a first text message is the most reliable junk-message signal there is: carriers filter on exactly that.",
    config: "The allowed domains (suffixes). Empty = no link permitted.",
    passes: "\"I'll send you the address by e-mail.\" — no link.",
    caught: "\"See the photos here: bit.ly/xyz\" — domain not allowed, and a shortener on top of it.",
    pitfall: "Bare domains (without https://) count too: \"go to example.com\" is a link. Allowing a domain allows its subdomains.",
  },
  required_tool_on_intent: {
    label: "Require an action (stop, hand over to a human…)",
    what: "Requires the assistant to call a specific tool when the detected intent matches. The message is blocked if the tool was not called.",
    when: "When an intent MUST produce an effect and not just a sentence: an opt-out has to call \"stop\", not merely reply \"all right\".",
    config: "The intent (e.g. \"opt_out\") and the expected tool (e.g. \"stop\").",
    passes: "The person writes \"stop\" and the assistant calls the \"stop\" tool.",
    caught: "The person writes \"stop\", the assistant replies \"Understood!\" without calling \"stop\": the number stays subscribed and the follow-up starts up again.",
    pitfall: "The tool has to be enabled on the assistant, otherwise the rule always fails: the model cannot call a tool it is not offered.",
  },
  llm_judge: {
    label: "Have the AI check the meaning",
    what: "Has the classifier model assess the draft against a criterion written in French. The message is blocked if the criterion is not met.",
    when: "When the rule is about MEANING and not about words: \"invents no fact\", \"tells the truth if asked whether it is an AI\". No regular expression can describe that.",
    config: "The criterion, phrased as a verifiable sentence.",
    passes: "\"I can't put a value on your property, but Alex will do it with you.\" — no invented fact.",
    caught: "\"The market is going up 8% this year\" — an invented forecast that no word list would have caught.",
    pitfall: "Costs one model call on EVERY draft, and fails CLOSED: if the judge does not answer, the message is blocked. A criterion that depends on context the judge does not have (\"if this is the first message…\") blocks everything.",
  },
  custom_instruction: {
    label: "Plain writing instruction (blocks nothing)",
    what: "Analyses NOTHING. It simply adds its text to the guardrail layer of the compiled prompt.",
    when: "To guide the writing without imposing a block: a preference of tone, a turn of phrase to avoid.",
    config: "Nothing to configure — only the prompt text counts.",
    passes: "Everything passes: this rule has no blocking power.",
    caught: "Nothing is ever caught.",
    pitfall: "Its severity has NO effect: marking it \"blocking\" displays it as a hard guardrail when it cannot refuse anything. If the behaviour has to be guaranteed, use \"Have the AI check the meaning\".",
  },
};

export const GUARDRAIL_SEVERITY_TEXT_EN: Record<string, SeverityText> = {
  block: {
    label: "Blocks the message",
    what: "The message does not go out. The assistant rewrites once; if it fails again, the conversation is handed over to a human. This is also what turns a fixture red.",
  },
  warn: {
    label: "Lets it through, but records it",
    what: "The message DOES go out, but the deviation is recorded in the turn's trace. Useful to watch a rule before making it blocking.",
  },
  off: {
    label: "Disabled",
    what: "The rule is neither evaluated nor injected into the prompt. It stays in place so it can be switched back on without being rewritten.",
  },
};

export const FIXTURE_FIELD_TEXT_EN: Record<string, FixtureFieldText> = {
  inbound: {
    label: "Incoming message",
    what: "What the client writes. It is what triggers the scenario.",
    example: "\"stop writing to me please\"",
    pitfall: "An incoming message that is too polite or too long tests something other than what you think it does: write what a real client types, typos included.",
  },
  priorTurns: {
    label: "History",
    what: "The messages already exchanged, in order. \"out\" = the assistant, \"in\" = the client.",
    example: "out: \"Hello, this is Groupe Nexus…\" then in: \"what is this?\"",
    pitfall: "With no \"out\" turn at all, the scenario is a FIRST outgoing message: the CASL identification rule then requires the organization to be named in it, and the fixture fails for a reason that has nothing to do with what it tests.",
  },
  mustCallTool: {
    label: "Must call the tool",
    what: "The reply has to invoke this tool, otherwise the fixture fails.",
    example: "On \"stop\", the assistant has to call \"stop\".",
    pitfall: "The tool has to be enabled on the assistant under test: the model cannot call a tool it is not offered, and the fixture would be red forever.",
  },
  mustNotCallTool: {
    label: "Must NOT call the tool",
    what: "The reply must not invoke this tool.",
    example: "Before the required qualification is in hand, the assistant must not call \"book_meeting\".",
    pitfall: "This is the easiest check to render useless: if the tool is not enabled, it always passes without proving anything.",
  },
  mustMatch: {
    label: "Must match the pattern",
    what: "The reply has to contain something that matches the regular expression.",
    example: "/\\d{1,2}\\s?h/ to require that a time be proposed.",
    pitfall: "Describing a FORM holds up over time; requiring an exact sentence breaks at the first rewording, while the behaviour itself is still good. Prefer the judged criterion when it is the MEANING that counts.",
  },
  mustNotMatch: {
    label: "Must NOT match",
    what: "The reply must contain nothing that matches the pattern.",
    example: "/\\d[\\d\\s]{2,}\\s?\\$/ to forbid any amount.",
    pitfall: "A pattern that is too broad makes perfectly correct replies fail.",
  },
  judge: {
    label: "Criterion judged by the model",
    what: "A criterion in French, assessed by the classifier model. Use it when the rule is about meaning and not about words.",
    example: "\"The reply stops for good: no follow-up, no alternative offered.\"",
    pitfall: "Costs one model call per run and fails CLOSED: a criterion that depends on context the judge does not have turns the fixture red for no readable reason.",
  },
  maxChars: {
    label: "Limit the message length",
    what: "The reply must not exceed this length.",
    example: "200 to check that an acknowledgement stays brief.",
    pitfall: "Do not confuse it with the global length rule: here it is THIS scenario that you are bounding.",
  },
};

export const RULE_PRESET_TEXT_EN: Record<string, RulePresetText> = {
  aucun_prix: {
    label: "Never give a price or a value",
    what: "Blocks any message containing an amount or a percentage — appraising a property requires a licence.",
  },
  aucune_commission: {
    label: "Never discuss commission or fees",
    what: "Blocks messages that mention commission, fees or rates.",
  },
  une_question: {
    label: "One single question per message",
    what: "A text that asks three questions gets no answer at all. Blocks messages that ask more than one.",
  },
  message_court: {
    label: "Keep messages short",
    what: "Blocks anything past 300 characters. A long message reads like a mass mailing and costs several segments.",
  },
  aucun_lien: {
    label: "No links in messages",
    what: "A link in a first text message is the most reliable junk-message signal there is: carriers filter on exactly that.",
  },
  respecter_stop: {
    label: "Honour an opt-out",
    what: "Requires the assistant to really stop when someone asks it to stop — replying \"all right\" without stopping lets the follow-up start up again.",
  },
  rien_inventer: {
    label: "Invent nothing",
    what: "Has the AI re-read every message to check that it asserts no invented fact, figure or promise.",
  },
  verite_ia: {
    label: "Tell the truth when asked whether it is a bot",
    what: "Checks that the assistant never claims to be a human when asked.",
  },
};
