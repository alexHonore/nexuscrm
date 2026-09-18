# Nexus Workspace

Branch: `feat/nexus-workspace`.

This iteration brings daily calling work to the foreground: identify the next
person who needs attention, open their record, and keep moving through a useful
queue. The default interface remains French, with complete English equivalents.

## Tour

1. Open `/dashboard` for the daily briefing, overdue follow-ups, missed calls,
   human handoffs, and upcoming appointments. The Today/Upcoming tabs keep
   longer-term follow-ups available without burying today's work.
2. Press Command-K or Control-K from any authenticated screen. Search clients
   by name, phone, email, or city, or jump directly to an allowed app section.
   Search uses the existing visibility- and contact-filtered server endpoint.
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
  and stale-response protection. No client data is persisted by the palette.
- Calls, SMS, booking, opt-out, audit, and configurable permissions continue
  through the existing server paths.
- The desktop header adds 64px; affected sticky editors and scroll containers
  have matching offsets. Mobile cards wrap long content without page overflow.
- Two pre-existing unsupported route exports were moved into adjacent schema
  modules so Next.js production route validation succeeds.

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
