# Nexus Workspace

Branch: `feat/nexus-workspace`.

This iteration brings daily calling work to the foreground: identify the next
person who needs attention, open their record, and keep moving through a useful
queue. The default interface remains French, with complete English equivalents.

## Tour

1. Open `/dashboard` for the daily briefing, overdue follow-ups, missed calls,
   human handoffs, and upcoming appointments. The Today/Upcoming tabs keep
   longer-term follow-ups available without burying today's work.
2. Press Command-K, Control-K, or `/` from any authenticated screen (the
   dashboard search button opens the same palette). Search clients by name,
   phone, email, city, address, notes, project, comments, follow-ups, call
   notes, or SMS, or jump directly to an allowed app section. See **Client
   search** below.
3. Open `/clients`. Quick queues cover the whole directory, overdue follow-ups,
   today's follow-ups, first contact, and records without a planned follow-up.
   Saved views and custom filters remain available. Queue cards explain their
   scope; today's queue can overlap with overdue records.
4. Open a client record. The project brief summarizes project type, budget,
   and timing. Client navigation keeps the current list available and disables
   stale destinations while new filters load.
5. Expand the administration groups when needed. The sidebar, global search,
   and mobile More menu all use the same resolved permission list.

Explicit `/clients?q=…`, `/clients?categoryId=…`, and `/clients?focus=…` links
replace conflicting local filters. Manual edits retire those URL criteria so
returning from a record retains the user's working view.

## Implementation notes

- No database migration, dependency, or protected-file change is required.
- Counts and records remain subject to server visibility checks.
- Follow-up counts use typed Drizzle predicates, including across Toronto DST
  boundaries. A real database regression test covers date serialization.
- Search results stay in component memory only, with debounce, cancellation,
  and stale-response protection. No client data is persisted by the palette:
  the only thing kept is the list of recent *query strings*, locally, per user
  (see **Client search**).
- Calls, SMS, booking, opt-out, audit, and configurable permissions continue
  through the existing server paths.
- The desktop header adds 64px; affected sticky editors and scroll containers
  have matching offsets. Mobile cards wrap long content without page overflow.
- Two pre-existing unsupported route exports were moved into adjacent schema
  modules so Next.js production route validation succeeds.

## Client search

One engine answers every `q` sent to `GET /api/clients/list`. The palette and
the `/clients` panel send `match=all` (everything a record shows) and
`sort=relevance`; the campaign "add clients" dialog keeps the default
`match=identity` (name, city, phone, email) and activity order.

- **What is searched.** Accents, capitals and ligatures do not matter
  (`Côté` = `cote`, `Cœur` = `coeur`, `st-foy` = `Sainte-Foy`). Words are
  ANDed across fields. Comments, call notes, follow-ups and SMS are searched
  from 3 letters; 1–2 letter words only reach the name, city, address and
  project.
- **Operators.** `"exact phrase"`, `-word` to exclude, and field operators in
  French or English: `nom:`, `tel:`, `courriel:`, `ville:`, `adresse:`,
  `projet:`, `note:`, `commentaire:`, `sms:`/`texto:` (and `name:`, `phone:`,
  `email:`, `city:`, `address:`, `project:`, `comment:`). `dans:contact`,
  `dans:lieu`, `dans:notes` (`in:contact|place|notes`) restrict the search to
  one family; the scope chips write that token into the query, so a shared or
  reopened search says exactly what it looks for.
- **Permissions.** A record the viewer cannot see is never read. Phone and
  email (and any 7+ digit or email term) only match records whose `contact`
  box is open; comments, call notes and follow-ups need `history`; SMS also
  needs `conversations.view`. Match chips and snippets only ever come from
  those opened sources, and contact details inside a snippet are masked when
  `contact` is closed.
- **Ranking.** Each term counts once, in its best field: exact phone/email >
  whole-word name > name prefix > name infix > city > notes and history.
  Recent history breaks ties only when history is what found the record.
  Typing mistakes on names and cities fall back to a closest-match pass, which
  the palette and the panel announce.
- **Palette.** Up to 8 hits in server order, with highlighted name/city, the
  fields that matched, and a snippet (origin badge for AI notes and
  appointment logs). Enter never opens a record the person hasn't seen: it
  opens the selected row (the best hit, selected automatically) once the
  results are on screen, or a row picked with the arrows right away — even a
  dimmed one while the next term loads. Pressed before the results arrive, it
  waits and opens only a single exact match (a phone number); otherwise the
  list shows and a second Enter opens the best hit. On phones the keyboard's
  "Search" key only hides the keyboard. Shift+Enter opens all results in
  `/clients`. Full screen on phones.
- **Recent searches.** Written only when a search is used (a hit or "all
  results" opened), stored in `localStorage` under
  `nexus.search.recent.v1:<userId>` (in-memory fallback), at most 8, deduped
  ignoring accents. Only query strings are kept — never a client name or id,
  which would outlive a permission change.
- **Jumping to a comment.** A hit found in a comment links to
  `/clients/<id>#comment-<id>`; the comment is outlined for 2.5 s. The record
  page loads its first 200 comments, so an older match simply opens the record.
- **Limits.** Deep searches run with a 3 s statement timeout and at most 4 at a
  time per server process; past that, the panel and palette show a
  "quick search only" notice with results from the record fields alone.

## Verification

Verified on 2026-09-18: 164 test files / 3,632 tests passed; TypeScript and the
production Webpack build passed. ESLint completed with zero errors and 12
existing warnings.

Run `pnpm test`, `pnpm lint`, and `pnpm exec tsc --noEmit`.

The local environment intentionally overrides the remote `.env` database.
For a production bundle checked against local configuration:

```sh
DOTENV_CONFIG_PATH=.env.development.local NODE_OPTIONS=--require=dotenv/config pnpm build --webpack
```

Webpack is the verification fallback because Turbopack's build worker could
not bind a local port in the restricted execution environment. Development
continues to use the repository's normal `pnpm dev` command.

Browser checks cover French/English, desktop and 390px mobile, global search
from an existing client workspace, keyboard activation, follow-up tabs, and
client detail overflow. Synthetic development records used for visual QA are
local only; no production data or configuration was changed.
