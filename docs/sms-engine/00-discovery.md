# SMS Campaign Engine + AI Assistants — Phase 0 Discovery

> Status: **awaiting approval** — no code written. Per the mission brief, Phases 1–8 start
> only after the decisions at the bottom of this document are settled.
>
> Method: nine parallel read-only discovery agents swept the repo (infrastructure, DB,
> auth, lead webhook, client page, UI kit/i18n, telephony, booking/cron, API/tests);
> load-bearing claims were then spot-verified by hand. Every file path below was read,
> not inferred.

---

## 1. Infrastructure

### 1.1 Framework & tooling

| Item | Finding |
| --- | --- |
| Framework | **Next.js 16.3.0, App Router**, React 19.2.8. Middleware is renamed: `src/proxy.ts` (cookie-presence guard only; **everything under `/api/` is exempt** — routes do their own auth). Route-handler `params` is a `Promise`; the repo uses the Next 16 pattern everywhere (`const { id } = await ctx.params`). `RouteContext<'/path'>` typegen is enabled via tsconfig. |
| Package manager | pnpm 10.26.1. `pnpm-workspace.yaml` is **not** a multi-package workspace (only `ignoredBuiltDependencies`). |
| TypeScript | `strict: true`, path alias `@/* → ./src/*`. ESLint = `eslint-config-next` + `typescript-eslint` recommended → **`no-explicit-any` is an error** (matches brief rule 4). |
| Validation | zod **v4** (`^4.4.3`), already used at every API boundary. |

### 1.2 Database

- **Postgres via Drizzle ORM** (`drizzle-orm ^0.45.2`) + postgres.js. Client in `src/db/index.ts`:
  `prepare: false` (transaction-pooler compatible), `max: 10`, pool cached on `globalThis`.
  **New code must not rely on prepared statements or session state.**
- Prod provider ambiguity: `README.md` says **Neon** (Vercel Marketplace); memory/ops notes
  say **Supabase pooler (Supavisor)**. Either way it is external-pooled Postgres over
  `DATABASE_URL` → Decision D10.
- **No migration files exist.** `drizzle.config.ts` points `out: "./drizzle"` but the folder
  is absent; the documented flow is `pnpm db:push` (drizzle-kit push) run from the dev
  machine against prod. There is no `db:migrate` script and no migrations journal in prod.
  This collides with brief rule 8 (timestamped SQL migrations) → Decision D2.
- **No RLS, no DB triggers, no policies** anywhere. Authorization is 100 % application-level.
  The brief's §11.4 "enforce with a DB trigger" would introduce the repo's first trigger →
  noted in D2.
- Advisory-lock precedent exists (exactly what the agent runtime needs):
  `pg_advisory_xact_lock(874511)` guards booking (`src/app/(app)/appointments/actions.ts:240`),
  `pg_try_advisory_xact_lock(874512)` guards CDR sync (`src/lib/cdr-sync.ts:237`). Both are
  inside transactions, so they work under a transaction pooler.
- `drizzle-kit` config accepts `schema: string | string[]` (verified in
  `node_modules/drizzle-kit/index.d.mts:119`) → new tables can live in a **separate**
  `src/db/schema-sms.ts` without touching the frozen `src/db/schema.ts` (D1).

### 1.3 Auth

- Home-grown: **jose HS256 JWT** in cookie `nexus_session` (`src/lib/auth/session.ts`),
  payload `{ uid, role, tv, remember }`. `getCurrentUser()` (React `cache()`) re-reads the
  user row per request and enforces `isActive` + `tokenVersion` — sessions are revocable.
- Exactly two roles: **`admin`** (the broker) and **`caller`** (téléphoniste).
- Guards (`src/lib/auth/guards.ts`): pages use `requireUser()` / `requireAdmin()`
  (redirect); API routes use `apiUser()` / `apiAdmin()` + `if (x instanceof NextResponse)
  return x;`. Server actions use `getCurrentUser()` + inline role checks and return
  discriminated unions (`{ ok: true } | { ok: false, error: "..." }`), never throw.
- Machine auth patterns already in place, ready to copy:
  - **Cron**: `Authorization: Bearer ${CRON_SECRET}`, plain compare, fails closed
    (`src/app/api/cron/*/route.ts`).
  - **Inbound webhook**: `x-api-key` or `Bearer` → SHA-256 hash lookup in `webhook_keys`
    (`src/app/api/webhooks/leads/route.ts:97-107`).
  - **Twilio signature**: `X-Twilio-Signature` HMAC-SHA1 validation is **already
    implemented by hand** in `src/app/api/telephony/twiml/route.ts` (permissive only when
    no auth token AND not production) — the exact scheme the brief requires for
    `/api/webhooks/twilio/inbound`.
- Secrets at rest: `encryptSecret`/`decryptSecret` (`src/lib/crypto.ts`, AES-256-GCM, key =
  `APP_ENCRYPTION_KEY`). Audit: `logAudit()` (`src/lib/audit.ts`) with automatic secret
  masking in `detail`; action naming `entity.verb`.

### 1.4 Deployment & background work

- **Vercel**, region pinned `["pdx1"]`, prod URL `https://groupe-nexus.vercel.app`.
  Pushes to `origin/main` auto-deploy prod (Git integration).
- `vercel.json` crons: `sync-cdr` daily 11:00 UTC, `followup-reminders` daily 11:30 UTC —
  **once a day only** (Hobby-plan-shaped). The real high-frequency scheduler is the
  **existing n8n instance** on the Hostinger KVM: `n8n/cron-crm.json` hits the same two
  endpoints every 30 min / hourly with the same `CRON_SECRET` bearer. Any new dispatcher
  cadence has to come from n8n or a plan upgrade → Decision D5.
- **No job queue exists** — no queue table, no queue library, no outbox. `scheduled_jobs`
  from the brief will be the first. No `after()`/`waitUntil` usage anywhere yet; Next 16's
  `after()` is available and is the right tool for "call `matchCampaigns(leadId)` after the
  200" (brief §9). Long-running route precedent: `export const maxDuration = 300`.
- Tests: vitest, `fileParallelism: false`, integration suites run **real route handlers,
  real guards, real JWTs, real DB** against `nexus_test` (hard-fails if `DATABASE_URL`
  doesn't contain `nexus_test`). `tests/helpers/db.ts` `resetDb()` truncates all 14 tables —
  new tables must be appended there. `.env.test` is gitignored (copy into worktrees).

### 1.5 Environment variables (today)

Read in app code: `DATABASE_URL`, `AUTH_SECRET`, `APP_ENCRYPTION_KEY`,
`NEXT_PUBLIC_APP_URL`, `VOIPMS_API_USERNAME`, `VOIP_MS_API_PASSWORD`,
`VOIPMS_API_PROXY_URL/_TOKEN`, `VOIPMS_SIP_DOMAIN`, `NEXT_PUBLIC_SIP_WSS_URL`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID/_SECRET`,
`TWILIO_TWIML_APP_SID`, `CRON_SECRET`, `GOOGLE_CLIENT_ID/_SECRET`, `RESEND_API_KEY`,
`EMAIL_FROM`, `WEBHOOK_SEED_KEY`.
**Absent**: every SMS/LLM var from brief §6 (`SMS_MODE`, `TWILIO_MESSAGING_SERVICE_SID`,
`OPENROUTER_*`, `ANTHROPIC_API_KEY`, `CAL_*`, `GUARDRAIL_POLICY`, `TRACE_RETENTION_DAYS`, …).
`LEAD_WEBHOOK_SECRET` does not exist under that name — lead-webhook auth is the
`webhook_keys` table, which is better (revocable, per-key defaults) and will be kept as-is.

---

## 2. Domain

### 2.1 The leads table is `clients` (uuid PK)

`src/db/schema.ts:92-131`. Exact columns:

| Brief concept | Actual column | Notes |
| --- | --- | --- |
| id | `id` uuid PK `defaultRandom()` | all FKs in brief §5 point here (`leads(id)` → `clients.id`) |
| first name | **none** — `full_name` text NOT NULL only | `{{lead.prenom}}` must be derived (first token) or added |
| phone | `phone` text NOT NULL, E.164 | indexed, **NOT unique**; `phone_alt` nullable; matching convention = last 10 digits (`phoneMatchKey`) |
| email | `email` nullable | |
| language | `language` enum fr/en, default fr | useful audience filter |
| stage/category | `category_id` int FK → `categories` (serial PK, seeded system keys: new, voicemail, callback, booked, not_interested, not_qualified, dncl + 6 business ones) | pipeline = dispositions (see `src/lib/dispositions.ts`) |
| source | `source_id` int FK → `sources` (seeded: "Facebook Acheteur", "Facebook Vendeur", …) | webhook resolves source **by name**, case-insensitive |
| type/need | `project_type` text (acheter/vendre/les_deux/free text) | plus `timing`, `budget`, `city`, `address` (all free text) |
| assigned user | `assigned_to_id` uuid FK → users | |
| do-not-contact | `do_not_call` boolean NOT NULL default false | voice-only today → Decision D8 |
| qualification | `qualification` jsonb | already exists — booking flow snapshots it |
| raw payload | `meta` jsonb | webhook stores the full raw payload here |
| created | `created_at` timestamptz | brief's "lead younger than 90 days" guard reads this |

Related tables that already exist and will be **reused, not duplicated**: `users` (uuid PK,
`did_number`, `sip_username`, encrypted SIP password), `calls`, `appointments`
(with `google_event_id`, `meet_link`, `status`), `comments`, `followups`, `notifications`
(free-text `type` — a new `sms_needs_attention` type needs no schema change),
`webhook_keys`, `settings` (text key → jsonb, typed via `src/lib/settings.ts` — designed to
be extended with an `sms` key), `audit_logs`, `login_throttle`, `password_resets`.
**No messages/conversations/SMS table of any kind exists.**

### 2.2 The lead webhook (`POST /api/webhooks/leads`)

`src/app/api/webhooks/leads/route.ts`. Auth = `webhook_keys` (above). Validation is a
hand-rolled alias extractor (not zod): fields read at root **and** under `.data`
(n8n shape), keys normalized and matched against FR/EN aliases (`nom_complet`,
`numéro_de_téléphone`, `quel_est_votre_besoin_?`, …). Only hard requirement: a
normalizable phone. Dedupe by last-10-digits against `phone`/`phone_alt` → update path
(fill-empty-only) or insert path (raw payload → `meta`). After write: notifications to
active admins + assignee, `lastUsedAt`, `logAudit("webhook.lead")`. Response
`{ ok, clientId, created }`.

**There is no post-lead-creation hook point.** Client rows are inserted at three
independent sites (webhook, `createClientAction`, CSV import). The enrollment hook will be
added in the webhook route after the insert/update branches (everything needed is in
scope: `clientId`, `created`, key defaults, raw payload), wrapped in `after()` so the 200
is never blocked — exactly as the brief demands. The n8n pipeline is untouched.

### 2.3 The client page (`/clients/[id]`)

- Pure Server Component (`src/app/(app)/clients/[id]/page.tsx`): one relational Drizzle
  query loads client + calls + appointments + comments + followups; everything serialized
  to props. Mutations are Server Actions in `src/app/(app)/clients/actions.ts` with an
  optimistic-update house pattern (local state + `inFlightRef` + snapshot rollback +
  `toast` + `emitDataChange(scope)` + `router.refresh()`).
- Layout is **container-responsive** (`@container` / `@3xl:` — a persistent list panel
  steals width). Right column ("the caller's workspace") holds `FollowupsCard` +
  `CommentsTimeline`; left column holds `ClientInfoForm` + `ClientHistory` (tabs
  Appels | Rendez-vous).
- **The Conversation SMS card goes in the right column under `CommentsTimeline`**, using
  the established Card pattern (`CardHeader` with icon + `CardAction` for the AI
  pause/resume toggle — same slot as FollowupsCard's "+ Ajouter" button).
  `CommentsTimeline` is the direct template for the thread (bubbles, composer,
  Cmd/Ctrl+Enter). The `doNotCall` red banner in `client-header.tsx` is the template for
  the amber "Vous avez le contrôle" takeover banner.
- Live updates: no WebSocket/SSE anywhere. The house mechanism is `src/lib/live.ts`
  (NOT frozen): `emitDataChange(scope)` CustomEvent bus + `useVisiblePolling` (20–30 s,
  only while tab visible+focused). The thread will add a `"sms"` LiveScope + polling.
- Telephony context (`useTelephony()`) wraps the whole app — the SMS card can offer
  "Appeler" via the same `dial()`.

### 2.4 Existing telephony/messaging

- Voice only, everywhere. `TelephonyEngine` (JsSIP / Twilio Voice SDK) has **no message
  method**. `src/lib/voipms.ts` has **no SMS endpoints** (only an `sms` capability flag on
  purchasable DIDs). The **`twilio` server SDK is NOT installed** — the repo hand-builds
  Twilio access tokens with jose and validates Twilio signatures with node crypto. This
  is the house style: **external providers are called with plain `fetch`** (voip.ms REST,
  Resend, Twilio TwiML). The SMS engine and LLM providers will follow it → zero new
  dependencies → `package.json` stays frozen (D1).
- voip.ms API calls from Vercel must transit the fixed-IP relay on the KVM
  (`VOIPMS_API_PROXY_URL`) — irrelevant for Twilio SMS, which has no IP whitelist.

### 2.5 Booking — Cal.com does NOT exist; a full in-house system does

Grep for `cal.com|calcom|CAL_` across the entire repo: **zero hits**. Instead:

- `GET /api/availability?date&type` → `computeAvailability()`
  (`src/app/api/availability/slots.ts`): 30-min grid, 45-min min lead, subtracts Google
  FreeBusy on the broker's calendar **and** local `scheduled` appointments (+buffer).
  Failure semantics matter for the AI's `get_slots` tool: a Google **error** fails closed
  (throws), but a **disconnected** Google account (`GoogleNotConnectedError`) silently
  degrades to local-appointments-only and still returns slots (`googleConnected: false`).
  The agent's `get_slots` wrapper will refuse to offer slots when `googleConnected` is
  false — an autonomous texter must not book blind to the broker's real calendar.
- `createAppointment` server action: re-checks the slot, inserts under
  `pg_advisory_xact_lock(874511)` with overlap detection, creates the Google Calendar
  event (Meet link for `meet`, location for `inperson`, `sendUpdates: "all"` → **Google
  sends the invitations**, broker email from booking settings), moves the client to the
  `booked` category, writes a journal comment + audit + admin notifications.
- Booking settings (`src/lib/settings.ts`): days, hours, durations (meet 30 / in-person
  60), buffer, timezone, broker email.

This is materially better positioned than Cal.com for the brief's `get_slots` /
`book_meeting` tools: real slots, the broker's real calendar, zero new external service
(brief rule 6). → Decision D4.

### 2.6 UI kit & i18n

- **shadcn on Base UI, not Radix**: composition via the `render` prop
  (`<DialogTrigger render={<Button …/>}>`), never `asChild`. 29 component files in
  `src/components/ui/` incl. `EmptyState`, `SidePanel` (non-modal right panel designed to
  keep a live call usable — a candidate surface for the debug inspector). Known landmine:
  Base UI `DropdownMenuLabel` must sit inside a `DropdownMenuGroup` or React error #31
  unmounts the app.
- Forms: no react-hook-form. Three coexisting patterns; the dominant one for CRM entities
  is client component → Server Action returning a discriminated union → `toast` +
  `router.refresh()`. Admin area uses a shared `api()` fetch helper with typed
  `ApiError.code` → `errorMessage(t, err)`.
- Tables→cards: `hidden md:block` `<Table>` + `md:hidden` card list, whole card is the
  ≥44 px tap target; edit flows in a `Sheet`.
- Charts: recharts, one consumer (`src/components/analytics/charts.tsx`), themed via
  CSS vars (`viz-theme.tsx`) — reuse for the health strip/metrics.
- i18n: 12 namespaces × fr/en. **The namespace list is hardcoded in the frozen
  `src/i18n/request.ts`** → adding `assistants`/`conversations`/`campaigns` namespaces
  requires a one-line-per-namespace edit to a frozen file → Decision D7. Repo rule is
  fr **and** en for every string (brief says fr-CA only) — we will author fr-CA first and
  mirror en, per repo convention.
- Nav: `src/components/shell/app-shell.tsx` (NOT frozen) — `MAIN_NAV` / `ADMIN_NAV`
  arrays + `nav.*` keys in `common.json`. Mobile bottom nav is hard-coded
  `grid grid-cols-5`; new caller-facing routes go through the More/avatar menu or replace
  a tab → minor UX decision folded into D6.
- Timezone: `America/Toronto` hardcoded in ~23 files under `src/` (14 of them declare a
  local `APP_TZ`/`TZ` const; the rest inline the string); only booking reads it from
  settings. Display via `formatInTimeZone`, parse via `fromZonedTime`. The engine's
  quiet-hours code will use the same helpers.

---

## 3. Brief ⇄ repo mapping (what "repo wins on conventions" means concretely)

| Brief says | This repo does | Resolution |
| --- | --- | --- |
| `lib/agent/…`, `app/(admin)/…` | `src/lib/…`, `src/app/(app)/admin/…` | `src/lib/{sms,llm,agent,guardrails,campaigns,booking,jobs,assistants,docs}/` — still framework-agnostic per brief rule 11 (injected `db`/`llm`/`sms`/`clock`/`logger`) |
| `/assistants`, `/campaigns`, `/settings/guardrails` | admin routes live under `/admin/*` | `/admin/assistants`, `/admin/campaigns`, `/admin/guardrails` (D6) |
| `/conversations` | caller-facing routes are top-level (`/calls`, `/appointments`) | `/conversations`, caller-accessible (D6) |
| `leads(id)` | `clients` table, uuid PK | all FKs → `clients.id` |
| `users(id)` | `users`, uuid PK | matches |
| timestamped SQL migrations | `drizzle-kit push`, no migration files | D2 |
| `LEAD_WEBHOOK_SECRET` env | `webhook_keys` table (hashed, revocable, per-key defaults) | keep the table; no new env var |
| Twilio SDK | no server SDK; fetch + hand-rolled signatures (house style) | plain fetch for Twilio REST, LLM providers, Cal.com if used — **no new npm dependencies** |
| roles admin vs member | admin vs caller | assistants/campaigns/guardrails/kill-switch = admin; conversations = both (D6) |
| Cal.com | in-house availability + Google Calendar | D4 |
| structured JSON logging | `console.error` best-effort + `audit_logs` + (new) `agent_turn_traces` | one-line JSON to stdout for agent turns + the trace table (traces hold the PII, stdout log holds ids/metrics only, per brief §24) |
| cron dispatch every minute | Vercel crons are daily; n8n runs the high-frequency schedules | D5 |
| table names unprefixed | no prefix convention in repo | keep brief's names (`sms_numbers`, `consents`, `suppressions`, `assistants`, …) |
| `America/Toronto` from `APP_TIMEZONE` env | hardcoded per-file `APP_TZ` consts | follow brief: one `APP_TIMEZONE` env read in the new libs; leave the 28 existing consts alone |

Existing-table touch points (all additive):
- `consents`: seeded `implied_inquiry` on webhook lead creation (evidence = raw payload
  reference), CASL/Loi 25 ledger.
- `conversations.lead_id` → `clients.id`; inbound SMS→client matching reuses
  `phoneMatchKey` last-10-digit convention.
- `book_meeting` writes a real `appointments` row through the existing creation path
  (advisory lock, Google event, `booked` category) if D4 = internal.
- New notifications types (`sms_needs_attention`, `sms_optout`, …) via the existing
  `notifications` table + `notificationContent()` per-recipient locale mechanism.
- `tests/helpers/db.ts` `resetDb()` gains the new tables; new factories follow
  `makeClient`/`makeUser` style.

---

## 4. Gaps the brief assumes that do not exist (build list)

1. No SMS anything — tables, provider, webhook, UI, i18n keys. Greenfield.
2. No job queue / outbox / `after()` usage — `scheduled_jobs` + dispatcher is new
   infrastructure, first of its kind here.
3. No LLM anything — no SDK, no key, no call site. All four providers will be
   fetch-based implementations of the brief's `LLMProvider` interface.
4. No Cal.com (D4). No `twilio` server SDK (stays that way). No `TEST_PHONE_ALLOWLIST`.
5. No zod on the existing lead webhook (kept as-is — out of scope; new webhooks will be
   zod-validated per brief rule 4).
6. Vercel crons are daily-only today (D5).
7. No first-name column — L7's `{{lead.prenom}}` needs a derivation rule (first word of
   `full_name`) — flagged, not silently decided (see D11).

---

## 5. Decisions I need from you

Each with my recommended default. Reply "defaults" to accept all recommendations, or
override per item.

**D1 — Frozen files (AGENTS.md rule 7) vs the brief's data model.**
The brief requires ~20 new tables; `src/db/schema.ts`, `drizzle.config.ts` and
`package.json` are frozen.
**Recommendation:** new tables live in a new `src/db/schema-sms.ts` (imports
`clients`/`users` for FKs; `src/db/schema.ts` untouched); one-line edit to
`drizzle.config.ts` → `schema: ["./src/db/schema.ts", "./src/db/schema-sms.ts"]`
(drizzle-kit officially supports arrays); `src/db/index.ts` (not frozen) merges both
schemas. **Zero `package.json` changes** — all providers are fetch-based per house style.
I need your explicit OK for: (a) the one-line `drizzle.config.ts` edit, (b) the
`NAMESPACES` additions in `src/i18n/request.ts` (D7).

**D2 — Migrations: push vs SQL files.**
Repo deploys schema with `pnpm db:push` (no journal in prod); brief rule 8 wants
forward-only timestamped SQL.
**Recommendation:** keep `db:push` as the apply mechanism (repo wins on conventions;
switching to `drizzle-kit migrate` would require baselining the existing prod DB), with
all new tables strictly additive so push emits only `CREATE`/`ALTER ADD` — and commit the
`drizzle-kit generate` SQL output per phase under `drizzle/` as the reviewable,
forward-only record the brief asks for. Seeds (prompt core v1, default guardrails,
fixtures, objection packs, 4 assistants, 1 campaign, param docs) go in an idempotent
`src/db/seed-sms.ts` (`onConflictDoNothing`, like the existing seed). The §11.4 activation
gate will be enforced in the server action **and** a DB trigger shipped in that SQL — the
repo's first trigger; if you'd rather stay trigger-free, say so and I'll enforce it with a
`CHECK`-guarded update path + test instead.

**D3 — Which number sends the SMS.**
Your voice DIDs are on voip.ms; the brief contracts Twilio for SMS. A new Twilio Canadian
number means texts come from a different number than your calls.
**Recommendation:** follow the brief — Twilio Messaging Service with (a) new Canadian
number(s), registered for A2P, behind the `SmsProvider` interface (with `dry_run` /
`sandbox` / `live` modes). The interface leaves room for a voip.ms SMS implementation
later (your DIDs show the SMS-capable flag) but I will not build it now. If
same-number-for-voice-and-text matters to you, say so before Phase 1 — that changes the
provider plan (Twilio Hosted SMS on a voip.ms DID, or voip.ms SMS instead of Twilio).

**D4 — Booking provider: internal vs Cal.com.**
Cal.com does not exist here; a complete in-house availability + Google Calendar system
does (slots, double-booking lock, invitations, booked-category move).
**Recommendation:** implement the brief's `BookingProvider` interface with an **internal
implementation backed by your existing system** — `get_slots` wraps
`computeAvailability()` (2–3 real slots, French labels "jeudi 14 h"), `book_meeting`
books through the existing appointment path with lead + conversation id in the
appointment record. No Cal.com account, no `CAL_API_KEY`, no new external service, and
the meeting lands on the calendar you already use. The Cal.com implementation can be
added later behind the same interface for the commercial product. The brief's Cal
webhooks (§9) map to the internal equivalents (booking created/cancelled fire directly).
Reminders at 24 h/1 h: your Google events currently rely on Google's own reminders — I'll
schedule SMS reminders via `scheduled_jobs` instead (they're conversation-native), unless
you prefer none.

**D5 — Dispatcher cadence.**
The queue needs `/api/cron/dispatch` roughly every minute; Vercel crons here run daily
(Hobby-plan pattern) and your n8n already runs the 30-min/hourly schedules.
**Recommendation:** add a 1-minute schedule to the existing n8n cron workflow (same
`CRON_SECRET` bearer, same pattern as `n8n/cron-crm.json` — I'll ship an updated
importable JSON) + a daily `vercel.json` backstop entry. Alternative: upgrade the Vercel
plan and schedule `* * * * *` in `vercel.json` directly. Confirm n8n can take the
1-minute schedule.

**D6 — Routes and role split.**
**Recommendation:** `/admin/assistants` (11-tab editor), `/admin/assistants/docs`,
`/admin/campaigns`, `/admin/guardrails` — admin-only (nav via `ADMIN_NAV`).
`/conversations` (inbox + health strip) — **caller-accessible**, like `/calls`.
On `/clients/[id]`, callers can: see the thread, pause/resume the AI, and send manual
messages; admin-only: kill switch, manual suppression, assistant/campaign editing.
Caller restrictions from AGENTS.md rule 1 (no delete/export/bulk) apply unchanged.

**D7 — i18n namespaces.**
**Recommendation:** three new namespaces — `assistants`, `campaigns`, `conversations`
(fr + en each) — requiring three lines added to `NAMESPACES` in the frozen
`src/i18n/request.ts`. Alternative if you refuse the frozen-file edit: everything under
the existing `phone` namespace (it will get very large). All UI copy fr-CA, vouvoiement;
en mirror per repo rule.

**D8 — `do_not_call` ⇄ SMS suppression.**
Voice DNC and SMS opt-out are legally distinct channels.
**Recommendation:** keep them separate ledgers, but **fail closed both ways at send
time**: a client with `do_not_call = true` or in the `dncl` category is never enrolled
and never texted (treated as suppressed), and an SMS STOP writes to `suppressions` +
revokes the `sms` consent row **without** flipping `do_not_call` (a human decides that).
Suppression state is shown on the client page rail either way.

**D9 — LLM provider account.**
Default per brief: OpenRouter (`data_collection: deny`, `zdr: true`,
`allow_fallbacks: false`), with direct Anthropic/Google presets one dropdown away.
**You need to create the OpenRouter key** (and set account-wide privacy settings to
deny/ZDR — belt and braces per §18.3), plus optionally an Anthropic key for the direct
preset and the provider-parity test. Nothing sends until Phase 7 regardless (`dry_run`
default). Tell me which keys you'll have so I wire the right defaults.

**D10 — Prod DB provider confirmation.**
README says Neon; ops memory says Supabase (Supavisor pooler). Both work with the current
`prepare: false` client and in-transaction advisory locks. It matters for connection
budgeting once a 1-minute dispatcher + webhook bursts run concurrently.
**Just confirm which it is** — no code difference expected, but I'll size pool usage in
the dispatcher accordingly.

**D11 — `{{lead.prenom}}` with no first-name column.**
**Recommendation:** derive as the first whitespace-separated token of `full_name` when it
doesn't look like a phone-number fallback; render empty otherwise (the L7 contract
already tolerates empty variables). No schema change to `clients`.

---

## 6. What Phase 1 will contain once you approve

Per the brief's build order: `src/db/schema-sms.ts` (numbers/consents/suppressions +
committed generated SQL), consent seeding from the lead webhook, suppression list,
kill switch (`POST /api/kill-switch`, admin), Twilio inbound/status webhooks with
signature validation, `SmsProvider` (dry_run/sandbox/live + `SMS_LIVE_CONFIRMED`
double-flag), GSM-7/UCS-2 segment linter, opt-out keyword detection (FR+EN), and the
Phase 1 tests (STOP suppresses across all paths; dry-run send logs; idempotent webhook).
Checkpoint demo before Phase 2.
