import type { ApiEndpointTextEn, PageText } from "./api";

/**
 * English text for the public HTTP reference — one file per language, like
 * `messages/<locale>/<ns>.json`. French (`./api`) decides WHAT exists; this
 * file only carries the words.
 *
 * Deliberately absent: field NAMES, aliases, status codes and machine codes.
 * Those are the wire contract — translating `phone` to `téléphone` would
 * document an endpoint that does not exist.
 */
export const API_TEXT_EN: Record<string, ApiEndpointTextEn> = {
  leads: {
    label: "Post a lead",
    what: "Creates a client record, or fills in the one that already exists for that number, then notifies the admins and the assignee. Campaigns whose audience matches are evaluated right after the response.",
    why: "This is the front door for leads: Facebook Lead Ads through n8n, a website form, or any in-house tool. Everything that enters the CRM without being typed by hand comes through here.",
    fields: {
      phone:
        "The number to call back. Accepted in any readable shape; it is normalised to E.164. It is also the deduplication key.",
      name: "The full name. If absent, the record takes the formatted number as its name.",
      email: "The e-mail address, if one was collected.",
      city: "The city or area.",
      projectType:
        "What the person wants to do — \"buy\", \"sell\", \"appraisal\". Free text.",
      timing:
        "The timeframe they gave — \"in 3 months\", \"as soon as possible\". Free text.",
      source:
        "The name of an EXISTING CRM source, matched case-insensitively. Unknown or absent, the key's default source applies.",
      notes: "Anything that does not fit elsewhere. Kept verbatim on the record.",
    },
    responses: {
      "200":
        "The lead is in. The body returns `{ ok: true, clientId, created }` — `created: false` means a record already existed for that number and was filled in.",
      invalid_json: "The body is not a JSON object. An array or a string is refused.",
      unauthorized: "Key missing, unknown, or deactivated.",
      payload_too_large: "The body is over 100,000 bytes.",
      invalid_phone:
        "The \"phone\" field is missing or yields no usable number. It is the only field without which the call fails.",
    },
    notes: [
      "Fields are looked up at the ROOT of the body and inside `.data` — the shape n8n produces. What is in `.data` wins.",
      "Field names are compared lowercased, with spaces turned into underscores: \"Full Name\" and \"full_name\" are the same field.",
      "Deduplication runs on the LAST TEN digits of the number, and also checks the record's secondary number. Sending the same lead twice does not create two clients.",
      "On a record that already exists, a field is only filled if it was EMPTY: the webhook never destroys data typed by a caller.",
      "The response is sent before campaigns are evaluated: a 200 does not mean a campaign started. That is deliberate — making the caller wait ended in timeouts and leads sent twice.",
    ],
  },
};

/** The page's own words. Same shape as the French source — a missing key is a type error. */
export const PAGE_TEXT_EN: PageText = {
  title: "Developer reference",
  subtitle:
    "What an outside tool can send to the Groupe Nexus CRM, and how an AI assistant is configured — in JSON, field by field.",
  toc: "On this page",
  copy: "Copy",
  copied: "Copied",
  scopeTitle: "What this page covers",
  scopeBody:
    "The inbound lead webhook, and the configuration format for assistants and campaigns. The application's other routes serve its screens, change with them, and are not a contract: do not call them from a tool.",
  sections: {
    start: "Getting started",
    auth: "Authentication",
    endpoints: "Endpoints",
    assistant: "Assistant configuration",
    campaign: "Campaign configuration",
    guardrails: "Guardrails",
    tools: "Agent tools",
    spec: "Machine-readable spec",
  },
  start: {
    p1: "Every address is relative to your instance's domain. Bodies and responses are UTF-8 JSON.",
    p2: "Nothing here needs a login: this page is public so an integrator can read it before having CRM access.",
    baseUrl: "Base address",
  },
  auth: {
    p1: "Every call carries an API key, in either header. The two are equivalent; the first is the easier one to set in n8n.",
    p2: "A key is shown ONCE, when it is created — the CRM keeps only a fingerprint and cannot hand it back. Each key carries its own defaults (category, source, assignee), applied to the leads it posts.",
    keyName: "Getting a key",
    howTo:
      "An administrator creates one under Administration → Webhooks. Ask them for the source name to send as well, if you want your leads attributed to the right origin.",
  },
  request: "Request body",
  response: "Response",
  fields: {
    name: "Field",
    required: "required",
    optional: "optional",
    aliases: "Also accepted",
    what: "What it is",
  },
  statuses: "Response codes",
  notes: "Worth knowing",
  assistant: {
    p1: "An assistant is a JSON object. The same format drives export, import and the editor's \"Advanced (JSON)\" tab: a tool that produces this format produces an importable assistant.",
    p2: "Each path below is a key in that object. \"goal.primary.type\" means { goal: { primary: { type: … } } }.",
    example: "Full example",
  },
  campaign: {
    p1: "A campaign decides WHO gets messages and WHEN. Same principle: the JSON you export is the JSON you import.",
    example: "Full example",
  },
  guardrails: {
    p1: "Guardrails re-read every message before it is sent. These are the rule types a configuration can declare, and what each severity does to the message.",
  },
  tools: {
    p1: "The actions an assistant can take during a conversation. A tool absent from \"tools\" is not offered to the model — so it cannot do it. The descriptions below are reproduced VERBATIM: this is the text the model receives, and it is written in the assistant's language, not in the language of this page.",
  },
  spec: {
    p1: "The same reference, as JSON, to generate a client or a validator without reading this page.",
    open: "Open the spec",
  },
  columns: {
    path: "JSON path",
    type: "Type",
    default: "Default",
    allowed: "Allowed values",
    what: "What it is",
    kind: "Rule type",
    when: "When to choose it",
    tool: "Tool",
  },
};
