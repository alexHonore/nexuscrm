/**
 * La surcouche ANGLAISE de la référence des droits — des mots, rien d'autre.
 *
 * Ce fichier ne décide de RIEN : il ne peut ni ajouter une entrée, ni en
 * retirer une. `docs.ts` (français) est la source ; ici on traduit ce qui
 * existe. Une clé absente retombe sur le français.
 */
import type { DocOverlay } from "./docs";

export const PERMISSION_TEXT_EN: Record<string, DocOverlay> = {
  // ── Records ────────────────────────────────────────────────────────────────
  "clients.create": {
    label: "Create a record",
    what: "Opens the \"Add a client\" button on the Clients list, and the manual entry behind it. It is the only creation path that goes through a person.",
    why: "A record typed by hand often duplicates one that is already there under a different spelling: you close it for roles whose job is to call what comes in, not to feed the database.",
    pitfalls: "Closing it does not stop the intake: leads keep arriving through /api/webhooks/leads and through the CSV import, which are not caller gestures and do not read this right.",
  },
  "clients.edit": {
    label: "Edit a record",
    what: "Opens the \"Information\" card of the client record — contact details, project, notes — and its \"Save\" button.",
    why: "Contact details are what makes a record callable. A careless edit only shows up on the next call, the one that rings into the void.",
    pitfalls: "It covers neither the category nor the assignment: \"Change category\" has its own right, and so does the \"Assign to\" picker. Removing this one alone leaves a record nobody can correct but everybody can still recategorize and hand over.",
  },
  "clients.delete": {
    label: "Delete a record",
    what: "Opens the \"Delete\" button on the client record and deletion from the selection bar. Deletion is permanent: it takes the calls, appointments, follow-ups and comments with it.",
    why: "There is no bin and no copy: nothing can be restored. So the right is written separately instead of being a special case of \"Edit a record\".",
    pitfalls: "No relation can hand it back: the \"Delete the record\" box is capped by this right, and none of the built-in roles opens it — not even the supervisor on their own records. Every deletion is written to the audit log.",
  },
  "clients.comment": {
    label: "Comment on a record",
    what: "Opens the \"Comments\" card on the record and its \"Post\" button, @teammate mentions included.",
    why: "A comment is an internal note, never sent to the client: it is the team's memory between two calls, and it is signed.",
    pitfalls: "The SMS assistant writes into that same card as well (the \"add_client_comment\" tool). Closing the right closes the button, not the machine's pen: notes keep appearing.",
  },
  "clients.call": {
    label: "Place calls",
    what: "Opens the \"Call\" button on the record and the web phone. Closed, the button stays inert even when telephony is configured.",
    why: "A role that only watches must not be able to dial a number. That is exactly what the observer closes.",
    pitfalls: "With the shared rule \"Calling a record from the pool takes it\", this right also becomes an assignment right: the call changes who holds the record, without any assignment button being touched.",
  },
  "clients.sms": {
    label: "Send a text message",
    what: "The ceiling for every hand-written text message: the SMS card on the client record as well as the thread in the Conversations screen. It is what caps the \"Write a text message\" box of a relation.",
    why: "A text message LEAVES the application. It goes to the carrier, it is billed per segment, and once handed over it cannot be called back.",
    pitfalls: "A manual send needs BOTH rights: this one, through the record's \"Write a text message\" box, and \"Reply in a thread\". Closing either one closes the send — and diagnosing that is painful when you thought you had only closed the other. Neither the opt-out (STOP) nor quiet hours are rights: those do not reopen here.",
  },
  "clients.book": {
    label: "Book an appointment",
    what: "Opens the \"Book an appointment\" button on the record and the slot picker. The event is created in the broker's Google calendar, with the Meet link.",
    why: "An appointment commits the broker's calendar and the client's travel: it is the record action whose mistakes are paid for in hours.",
    pitfalls: "The booking windows and the minimum notice from Settings apply on top: granting the right does not make a slot appear less than three hours out.",
  },
  "clients.followup": {
    label: "Plan a follow-up",
    what: "Opens the \"Follow-ups\" card on the record: create a reminder, change its due date, complete it.",
    why: "Follow-ups feed \"To call today\" on the dashboard and the due-date notification: they decide tomorrow's work.",
    pitfalls: "A follow-up created on a colleague's record is assigned to the record's HOLDER, not to its author: it shows up on the other person's dashboard. Closing the right does not erase follow-ups already planned, which keep coming due.",
  },
  "clients.category": {
    label: "Change the category",
    what: "Opens \"Change category\" on the record and, above all, the after-call buttons: every disposition writes a pipeline status.",
    why: "The pipeline status decides what shows up in analytics, what the filters find, and which audience campaigns are allowed to enroll.",
    pitfalls: "It looks like a display detail and it drives the whole after-call step: without it a caller can call but not conclude, and the call ends with no disposition.",
  },
  "clients.assign": {
    label: "Touch assignment",
    what: "Opens the \"Assign to\" picker on the record. It is only the master switch: to WHOM, and from whom one may TAKE, is set in the role's \"Assignment\" tab.",
    why: "Keeping the switch apart from the rules means a role's assignment can be closed with one box, instead of undoing the four rules one by one.",
    pitfalls: "Granted alone it does nothing: with all of the role's assignment rules closed, the picker refuses every choice. Closed, no rule applies at all — even \"Take from the pool\" stays a dead letter.",
  },
  "clients.bulk": {
    label: "Bulk actions",
    what: "Opens the selection bar on the Clients list: assign, recategorize, change the source, enroll in a campaign, delete — on every ticked record at once.",
    why: "The gesture is the same as record by record; what changes is the scale. A mistake multiplied by two hundred records cannot be undone by hand.",
    pitfalls: "It does not replace the rights it triggers: deleting in bulk also needs \"Delete a record\", enrolling in a campaign needs the campaign. Every record touched gets its own audit line, marked \"bulk\".",
  },
  "clients.export": {
    label: "Export to CSV",
    what: "Opens the export side of the \"Import / Export\" screen: the records, filtered or not, in a downloadable file — names, phone numbers, e-mail addresses, notes.",
    why: "An export is a copy of the client base that leaves the application and that nothing protects afterwards. It is the heaviest gesture on the whole screen.",
    pitfalls: "A CSV holds contact details in the clear: granting it to a role whose phone numbers you hide (\"See contact details\" closed) undoes that hiding in one download. The export is written to the audit log.",
  },
  "clients.import": {
    label: "Import a CSV",
    what: "Opens the import side of the \"Import / Export\" screen: create records in bulk from a file and — in \"update\" mode — overwrite the ones that already exist.",
    why: "An import writes into the database without a single record being opened. It is bulk creation, not data entry.",
    pitfalls: "Matching is done on the phone number: in \"update\" mode, a badly prepared file overwrites fields on records that belong to someone else. It is a separate door from \"Create a record\": closing that one does not close this one.",
  },
  "clients.contact": {
    label: "See contact details",
    what: "Shows the phone number and the e-mail address in the clear. Closed, the record stays readable but the contact details are hidden (•••-4512).",
    why: "It is what lets you show a colleague's work — their history, their category, how far they got — without handing over the number that would let you call their client instead of them.",
    pitfalls: "It is the ceiling, not the tap: even granted, the \"Contact details in the clear\" box still has to be open on that record's relation. And it hides nothing inside an exported CSV.",
  },
  "clients.recordings": {
    label: "Listen to recordings",
    what: "Opens playback of a call recording, from the record's history as well as from the call log.",
    why: "A recording holds everything the client said, including what was written down nowhere and what they never expected to circulate.",
    pitfalls: "Every playback is written to the audit log, by name — access is given, it is not forgotten. The right to open the call log does not grant the audio: those are two boxes.",
  },
  "clients.history": {
    label: "See the history",
    what: "Opens the \"History\" card on the record: calls, appointments, and the change log.",
    why: "History says WHO worked the record and what has already been tried. It is what you close to leave a record readable without exposing the team's work.",
    pitfalls: "Closed, the record still shows: only the card disappears, and it takes with it what would have prevented a duplicate call — the record looks brand new although it has been called three times. To make a record stop existing, it is the \"The record exists\" box you close.",
  },

  // ── SMS conversations ──────────────────────────────────────────────────────
  "conversations.view": {
    label: "See conversations",
    what: "Opens the Conversations screen — \"To handle\", \"Awaiting client\", \"Send queue\", \"Refusals\" — and the SMS card on the client record.",
    why: "What the assistant wrote is part of the client's story just as much as a call: it is half of what has been said to them.",
    pitfalls: "Closed, the entry disappears from the navigation AND the thread disappears from the record: the caller will not know the assistant has just written to that client, and will call right over it.",
  },
  "conversations.reply": {
    label: "Reply in a thread",
    what: "Opens the composer of a thread and its \"Send\" button: a text message written by hand, going out under the company's number.",
    why: "Taking the keyboard back is what you do when the assistant no longer has the right answer. It is a right to write outbound, not a bigger reading right.",
    pitfalls: "It is not enough on its own: the send also checks the \"Write a text message\" box on the target record, itself capped by the \"Send a text message\" right. And writing by hand does not pause the assistant — without \"Steer a conversation\", it will reply right over you on the next message.",
  },
  "conversations.control": {
    label: "Steer a conversation",
    what: "Opens \"Take control\" and \"Hand back to AI\", assigning the thread, marking it handled, and cancelling a send still in the queue. CHOOSING which assistant holds the thread is a separate right.",
    why: "It is the SMS engine's emergency gesture: it stops the assistant on ONE conversation that is going wrong, without cutting it off for everybody.",
    pitfalls: "Cancelling is only possible while the message has not been handed to the carrier. Past that point the screen says so and refuses: a text message that left cannot be called back.",
  },

  "conversations.assistant": {
    label: "Put an assistant on a client",
    what: "Opens the \"Assistant\" picker on the client record and in the inbox: hand this thread to an assistant, switch it, or take it off. Without the right the picker is not rendered, and the action is refused server-side.",
    why: "Taking a thread back is a caller's decision; putting a robot on a client is a commercial one. You may want the first without the second — hence two rights rather than one.",
    pitfalls: "The right is the ceiling, the bucket's \"Assistant\" case decides record by record: granted everywhere, it still leaves a caller without the case on a colleague's records. Removing the right does NOT unplug the assistants already in place — threads under way carry on.",
  },

  // ── Administration ─────────────────────────────────────────────────────────
  "admin.analytics": {
    label: "Analytics",
    what: "Opens /admin/analytics: call volumes, dispositions, conversions, by period and by caller.",
    why: "This is the screen that compares callers with one another. Granting it decides that everyone's output is readable by that role.",
    pitfalls: "A statistics screen always says something about the records you cannot see: a total, an average, the name of whoever converted. Grant it knowing that.",
  },
  "admin.calls": {
    label: "Call log",
    what: "Opens /admin/calls: the whole team's calls, inbound and outbound, with their duration, their disposition and the pointer to the recording.",
    why: "It is the only view that gathers the team's calls: missed inbound calls read there, record by record they do not.",
    pitfalls: "The pointer to the recording only opens the audio with \"Listen to recordings\". Seeing the line and hearing the call are two rights.",
  },
  "admin.pipeline": {
    label: "Pipeline and sources",
    what: "Opens /admin/pipeline: create, rename, colour and reorder the pipeline categories and the lead sources.",
    why: "Categories are the CRM's skeleton: they name the board columns, the after-call buttons, the filters and the campaign audiences.",
    pitfalls: "Deleting a category forces its clients to be moved elsewhere: the gesture touches thousands of records at once. Renaming a category also renames the after-call button that carries it.",
  },
  "admin.users": {
    label: "User accounts",
    what: "Opens /admin/users: create an account, deactivate it, reset a password, and choose everyone's role.",
    why: "Whoever manages accounts manages roles: they only have to make themselves an administrator, or create an account that is one.",
    pitfalls: "Locked box: the administrator alone holds it, whatever is ticked (\"LOCKED_TO_ADMIN\"). The screen greys it out, and the server strips it on save even when the request comes from somewhere else.",
  },
  "admin.roles": {
    label: "Roles & rights",
    what: "Opens this very screen: create roles, tick their rights, set the relations and the assignment rules.",
    why: "A role that can edit the matrix grants itself everything else within the minute. The lock is not a precaution: it is what makes the matrix safe to open wide elsewhere.",
    pitfalls: "Locked box, like \"User accounts\". \"sanitizeRole\" strips it from every non-administrator role on save: ticking it through another path yields nothing.",
  },
  "admin.settings": {
    label: "Settings",
    what: "Opens /admin/settings: the Google Calendar account, the booking windows and minimum notice, the telephony provider.",
    why: "These settings apply to the whole installation. They are not set per role, and nothing on screen signals that they changed.",
    pitfalls: "One single gesture stops the entire team: disconnecting Google removes booking for everybody, switching telephony provider kills the web phone.",
  },
  "admin.assistants": {
    label: "See the assistants",
    what: "Opens /admin/assistants READ-ONLY: the list, an assistant's configuration, its compiled prompt, its runs and its version history. Nothing saves, and nothing LEAVES: downloading the file belongs to \"Edit the assistants\".",
    why: "What the robot tells clients is team information: knowing what it promises keeps you from contradicting it on the phone. Changing it is another job — see \"Edit the assistants\".",
    pitfalls: "The assistant's language is ITS setting, not the screen's: changing the interface language changes nothing in what it writes.",
  },
  "admin.assistantsEdit": {
    label: "Edit the assistants",
    what: "Create an assistant, edit it, activate or deactivate it, import one, EXPORT it, and run the sandbox. Without this right the assistants screen opens READ-ONLY: the configuration and the compiled prompt are readable, the save, activate and download buttons stay shut.",
    why: "A supervisor has good reason to read what the robot is meant to say to their clients, and none to rewrite it on a Tuesday evening. Reading breaks nothing; writing changes what the company says to hundreds of people.",
    pitfalls: "Export sits here and not under \"See the assistants\": reading a configuration on screen and carrying the file out are not the same gesture — a file is re-imported elsewhere and outlives the right being taken away. Every sandbox run calls a model and costs money, same reasoning. Objection packs are SHARED — editing one changes every assistant that uses it.",
  },

  "admin.campaigns": {
    label: "Campaigns",
    what: "Opens /admin/campaigns: the audience, the follow-up ladder, the enrollments and the trigger for sends.",
    why: "A campaign turns a list of records into a run of billed text messages, filterable by carriers and impossible to recall.",
    pitfalls: "Editing a ladder never catches up with people already enrolled: \"Restart the finished ones\" is the only path, and a record cannot be enrolled twice in the same campaign.",
  },
  "admin.guardrails": {
    label: "Guardrails",
    what: "Opens /admin/guardrails: the rules that block a message before it is sent — amounts, links, length, number of questions, AI review.",
    why: "Guardrails are what is left when the prompt fails. They are the last filter before the carrier.",
    pitfalls: "The right opens loosening as much as tightening, and neither shows before the next send: a rule removed lets the assistant write what it used to forbid, a rule set too broad makes it fail in silence.",
  },
  "admin.deliverability": {
    label: "Deliverability",
    what: "Opens /admin/deliverability: what arrives, what carriers filter out, and where to fix it.",
    why: "A filtered text message never comes back to say so. Without this screen, a drop in delivery reads six weeks later in the appointment book.",
    pitfalls: "The screen never fixes anything by itself: it reports. Three known gaps are permanently flagged there — seeing them is not a failure.",
  },
  "admin.webhooks": {
    label: "Webhook keys",
    what: "Opens /admin/webhooks: create the API keys for n8n, Facebook Lead Ads or the website, reveal a key, delete it.",
    why: "A webhook key creates records with no account and no session: it is write access to the database, handed to a machine.",
    pitfalls: "Deleting a key cuts the integration that same second: leads stop coming in with nothing else to signal it. A key revealed is a key in circulation — that is why it is shown only once.",
  },
  "admin.audit": {
    label: "Audit log",
    what: "Opens /admin/audit: who deleted, exported, imported, listened to a recording or touched an account, with the date and the author.",
    why: "It is the counterweight to the rest of this screen: rights say what is allowed, the log says what was done.",
    pitfalls: "Reading it means watching client names go by, and gestures made on records the role would not otherwise see.",
  },
  "admin.billing": {
    label: "Usage & spending",
    what: "Opens /admin/billing: what each caller uses, what voip.ms bills for the period, and the account balance.",
    why: "The voip.ms balance drops to zero without warning, and an empty balance makes buying a number fail at the worst moment.",
    pitfalls: "The screen is a per-person view: it makes each caller's activity readable to whoever opens it, minutes and cost included.",
  },
  "admin.docs": {
    label: "Documentation",
    what: "Opens /admin/docs: the reference for assistants, guardrails and campaigns, assembled from the very registries that feed the inline help.",
    why: "The page has no buttons and touches nothing: it is read. It is the quietest right on the list.",
  },
};

export const GRANT_TEXT_EN: Record<string, DocOverlay> = {
  visible: {
    label: "The record exists",
    what: "Closed, the record is ABSENT for that viewer: not in the Clients list, not in search, not on the pipeline board, not on the dashboard, and its direct address answers \"not found\".",
    why: "This is the original request: a record the broker has taken disappears for the team, rather than showing a refusal that would confirm it exists.",
    pitfalls: "It commands all the rest: the other eleven boxes have no effect while this one is closed. It is also the only box with no right capping it — who sees what is set here, and nowhere else.",
  },
  contact: {
    label: "Contact details in the clear",
    what: "Opens the phone number and the e-mail address on this record. Closed, they show hidden (•••-4512) and the call button has nothing to dial.",
    why: "It is the box that separates \"seeing a colleague's work\" from \"being able to call their client\".",
    pitfalls: "Capped by the \"See contact details\" right: ticking it achieves nothing while the right is closed above, and the screen then says \"Right not granted above\". Closed, search also stops finding the record by its number — otherwise typing \"418555\" would reveal digit by digit what you just hid.",
  },
  history: {
    label: "Record history",
    what: "Opens the calls, appointments, SMS thread, comments and change log of this record.",
    pitfalls: "Capped by the \"See the history\" right. Closed on other people's records, it also hides what would prevent a duplicate call: the record looks brand new although it has already been worked.",
  },
  comment: {
    label: "Comment",
    what: "Opens the \"Comments\" card for writing on this record.",
    why: "It is the safest box to open on someone else's record: it adds without changing anything, and every note is signed.",
    pitfalls: "Capped by the \"Comment on a record\" right.",
  },
  edit: {
    label: "Edit the record",
    what: "Opens the \"Information\" card for writing on this record: contact details, project, notes.",
    pitfalls: "Capped by the \"Edit a record\" right. Open on a colleague's records, it allows their notes to be rewritten without them being told: the record's change log is the only place it shows.",
  },
  category: {
    label: "Change the category",
    what: "Opens the pipeline status change on this record, after-call buttons included.",
    pitfalls: "Capped by the \"Change the category\" right. Closed while \"Call this client\" is open, the call ends with no disposition: the work is done, the record does not move.",
  },
  call: {
    label: "Call this client",
    what: "Opens the \"Call\" button on this record.",
    pitfalls: "Capped by the \"Place calls\" right. Open on the pool together with the \"Calling a record from the pool takes it\" rule, it becomes an assignment box: the call hands over the record.",
  },
  sms: {
    label: "Write a text message",
    what: "Opens the hand-written text message towards this record, from its SMS card as well as from the Conversations screen.",
    pitfalls: "Capped by the \"Send a text message\" right, and the send additionally needs \"Reply in a thread\". Open on a colleague's record, it puts two people in the same thread without the client knowing there are two.",
  },
  book: {
    label: "Book an appointment",
    what: "Opens \"Book an appointment\" on this record.",
    pitfalls: "Capped by the \"Book an appointment\" right. The appointment lands in the broker's calendar, not in the calendar of whoever books it: opening this box wide fills a single calendar.",
  },
  followup: {
    label: "Plan a follow-up",
    what: "Opens the \"Follow-ups\" card for writing on this record.",
    pitfalls: "Capped by the \"Plan a follow-up\" right. The follow-up is assigned to the record's holder: planned on a colleague's record, it shows up on the other person's dashboard.",
  },
  assign: {
    label: "Change the holder",
    what: "Opens taking, returning to the pool and reassigning this record. This is the box the assignment rules then refine.",
    why: "It says WHERE a role may touch assignment; the rules say WHAT it may do with it. The two are read together.",
    pitfalls: "Capped by the \"Touch assignment\" right, and never sufficient on its own: on a record already taken, you still need \"Take a record from its holder\", or the lock to have expired.",
  },
  assistant: {
    label: "Put an assistant on",
    what: "Hand this record's thread to an assistant, switch it, or take it off. Capped by the \"Put an assistant on a client\" right.",
    why: "This is the case that decides whether a caller may put a robot on a colleague's client, or only on their own.",
    pitfalls: "Closing the case does NOT stop an assistant already in place: it prevents switching. To cut the robot off a thread, use \"Take control\" (Steer a conversation).",
  },
  delete: {
    label: "Delete the record",
    what: "Opens the permanent deletion of this record, with its calls, appointments, follow-ups and comments.",
    why: "A deleted record takes the whole team's history with it, not only the work of whoever deletes it.",
    pitfalls: "Capped by the \"Delete a record\" right. No built-in role opens it, not even on their own records: it is the only gesture on this screen that cannot be undone.",
  },
};

export const GROUP_TEXT_EN: Record<string, DocOverlay> = {
  clients: {
    label: "Client records",
    what: "Everything done on a record: reading it, calling it, editing it, categorizing it, handing it over, taking it out of the application.",
    why: "These rights are the CEILING. The \"Other people's records\" tab then says which records they apply to: an action needs both open.",
    pitfalls: "A right closed here cannot be handed back by any relation. That is what makes the next tab safe to open wide without ever exceeding the role.",
  },
  conversations: {
    label: "SMS conversations",
    what: "The Conversations screen and the record's SMS card: reading threads, writing in them by hand, taking control back from the assistant.",
    why: "The SMS thread is the one place where a machine speaks to the client in your name. Reading, writing and stopping are three separate rights because they are three separate responsibilities.",
  },
  admin: {
    label: "Administration",
    what: "The screens under \"Administration\": settings, accounts, assistants, campaigns, guardrails, logs, usage.",
    why: "These rights open screens, not records: relations have no say there. What is granted here is granted across the whole installation.",
    pitfalls: "\"User accounts\" and \"Roles & rights\" stay administrator-only whatever is ticked: without that lock, a role would grant itself everything else in one visit.",
  },
};

export const ASSIGNMENT_TEXT_EN: Record<string, DocOverlay> = {
  // ── Per role ───────────────────────────────────────────────────────────────
  claimPool: {
    label: "Take from the pool",
    what: "Allows \"Take this record\" on a record nobody holds. Without it the pool can be read but not taken from.",
    why: "It is a caller's normal way of working: they help themselves, they call, they keep.",
    pitfalls: "The rule is not enough: the \"Change the holder\" box must also be open on the \"The pool\" relation. The rule says what they may do, the relation says where.",
  },
  release: {
    label: "Return to the pool",
    what: "Allows \"Return to the pool\" on a record they hold: it goes back to nobody, and becomes takeable by someone else.",
    why: "Without it the cap on records held becomes a dead end: at 50, the caller can no longer take anything and cannot let anything go.",
  },
  assignToOthers: {
    label: "Give to someone else",
    what: "Allows picking ANOTHER recipient in \"Assign to\". Closed, the picker only leads to themselves or to the pool.",
    pitfalls: "Giving the record to oneself is not covered by this rule: that is a take, with the cap on records held that comes with it.",
  },
  takeFromOthers: {
    label: "Take from its holder",
    what: "Allows taking or reassigning a record ALREADY held by someone else, without waiting for their lock to expire.",
    why: "It is the anti-theft lock of the whole scheme: closed, a record already taken only changes hands through a role that has this rule, or after the delay set in the shared rules.",
    pitfalls: "It is the most harmless-looking box and it decides everything: opened for a role of callers, everyone can help themselves from their neighbour, and the notification to the previous holder is the only signal they get.",
  },
  maxOwned: {
    label: "Cap on records held",
    what: "The maximum number of records held beyond which they can no longer HELP THEMSELVES from the pool. 0 = no cap.",
    why: "A caller who takes the whole pool in the morning dries it up for the team, without calling back what they took.",
    pitfalls: "It only blocks taking: a record GIVEN to them always goes through, even beyond the count. And it only loosens by returning — a cap without \"Return to the pool\" ends up freezing everything.",
  },

  // ── Shared by every role ───────────────────────────────────────────────────
  staleDays: {
    label: "Lock expiry",
    what: "Days without contact after which a record that was taken becomes takeable again by someone else. 0 = never: only a role that may take it away can then hand it over.",
    why: "A lead forgotten inside someone's records is not a protected lead, it is a lost one. The delay puts back into play what is asleep.",
    pitfalls: "The lock expires, the record does NOT free itself: it stays under the same name until somebody claims it, and there is no background job to watch. The countdown starts from the last contact, or failing that from the record's last edit.",
  },
  claimOnCall: {
    label: "Calling takes the record",
    what: "Calling a record from the pool assigns it to whoever calls, at the moment of the call.",
    why: "It is what makes the lock livable: without this rule, two callers reach the same lead three minutes apart and nobody stole anything.",
    pitfalls: "The take is silent — no assignment button was touched. Only the line \"Record taken: you have just called them\" says so.",
  },
  notifyAssignee: {
    label: "Notify the recipient",
    what: "Sends a notification to the person a record has just been assigned to: \"Record assigned — so-and-so handed you this record\".",
    why: "A record that appears silently in the middle of a list does not get worked: nobody re-reads their list looking for new arrivals.",
  },
  notifyPreviousOwner: {
    label: "Notify the previous holder",
    what: "Sends a notification to the person a record is taken from: \"Record taken back — so-and-so took this record\".",
    why: "Taking a record away in silence is what breeds suspicions of theft. The message costs one line and settles the matter.",
    pitfalls: "Switched off, a take-over allowed by the lock expiring becomes invisible: the record vanishes from its holder's list with no explanation.",
  },
};
