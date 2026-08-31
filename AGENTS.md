# Groupe Nexus — CRM immobilier (conventions du dépôt)

CRM de centre d'appels pour un courtier immobilier québécois. Interface **français par défaut**, anglais disponible. Déployé sur Vercel. Les RÔLES sont configurables par l'administrateur (règle 13) ; `users.role` en base ne dit plus que le plancher, `admin` (le courtier) ou `caller` (tout le reste).

## Stack

- Next.js 16 App Router + TypeScript strict, Tailwind v4, shadcn/ui (`src/components/ui`), lucide-react, sonner (toasts)
- **⚠️ shadcn est basé sur Base UI, PAS Radix** : pas de prop `asChild` — utiliser la prop `render` (ex. `<Button render={<Link href="…" />}>Texte</Button>`, `<DialogTrigger render={<Button />}>…`). Vérifier l'API réelle dans `src/components/ui/*.tsx` avant usage.
- Drizzle ORM + Postgres — schéma complet dans `src/db/schema.ts`, client dans `src/db/index.ts` (`db`)
- Auth maison JWT (jose) — cookie `nexus_session`
- i18n : next-intl **sans routage i18n** (cookie `NEXT_LOCALE`, défaut `fr`)
- Téléphonie : voip.ms via passerelle SIP-WSS (JsSIP) ou Twilio — abstraction `src/lib/telephony/types.ts`
- Fuseau horaire d'affichage : America/Toronto (`date-fns` + `date-fns-tz`)

## Règles non négociables

1. **RBAC serveur partout.** Chaque page : `requireActor()` / `requirePerm("<droit>")` (`src/lib/permissions/server.ts`) — `requireUser()` / `requireAdmin()` (`src/lib/auth/guards.ts`) restent pour l'authentification et pour ce qui est réservé à l'administrateur par nature. Chaque route API : `apiActor()` / `apiPerm("<droit>")` et vérifier `instanceof NextResponse`. Ce qu'un rôle peut faire n'est plus écrit en dur : c'est un réglage (règle 13). Pas de bouton caché côté client comme seule protection — le serveur refuse. **Une fiche qu'on n'a pas le droit de voir se comporte comme une fiche ABSENTE** : `notFound()` / 404 / `error: "notFound"`, jamais 403 — un refus confirmerait son existence.
2. **i18n obligatoire.** Aucune chaîne UI en dur. Chaque module remplit SON namespace : `messages/fr/<ns>.json` + `messages/en/<ns>.json` (ns : common, auth, legal, home, dashboard, clients, pipeline, phone, booking, admin, analytics, notifications, assistants, campaigns, conversations). Usage : `useTranslations("<ns>")` (client) / `getTranslations("<ns>")` (serveur). Ne PAS toucher aux fichiers des autres namespaces ni à `src/i18n/request.ts`.
   - Un REGISTRE de textes en code (documentation des paramètres, aide des garde-fous, champs de campagne) suit la même règle avec un fichier frère : `params.ts` + `params.en.ts`, `docs.ts` + `docs.en.ts`. Le français est la source ; un résolveur (`resolveParamDoc`, `kindText`, `campaignFieldText`…) tranche la langue, et `tests/unit-docs-locale.test.ts` refuse une fiche non traduite.
   - **La langue de l'INTERFACE n'est pas celle de l'ASSISTANT.** Ce que l'agent SMS écrit vient de sa configuration (`language`), jamais du cookie `NEXT_LOCALE`. Aucun module de `src/lib/agent`, `src/lib/sms*`, `src/lib/guardrails` (hors `docs*.ts`), `src/lib/campaigns` (hors `docs*.ts`) ni `src/lib/assistants` n'a le droit d'importer `next-intl` — `tests/unit-agent-locale.test.ts` le vérifie.
3. **Téléphones en E.164** en base — toujours passer par `normalizePhone()` / `formatPhone()` (`src/lib/phone.ts`).
4. **Secrets chiffrés** en base via `encryptSecret`/`decryptSecret` (`src/lib/crypto.ts`) — jamais en clair (mots de passe SIP, tokens Google, clés webhook).
5. **Audit** des actions sensibles via `logAudit()` (`src/lib/audit.ts`) : create/update/delete client, export, import, login, changements d'utilisateurs, écoute d'enregistrement.
6. **Mobile d'abord.** Tout doit être utilisable sur téléphone (les téléphonistes appellent depuis leur cellulaire). Cibles tactiles ≥ 44px, tableaux → cartes sur mobile, `pb-safe` disponible.
7. **Ne pas modifier** : `package.json` (toutes les dépendances sont déjà installées), `src/db/schema.ts`, `src/app/globals.css`, `src/i18n/request.ts`, `src/app/(app)/layout.tsx`, `drizzle.config.ts`. Si un changement y semble nécessaire, le signaler dans le rapport final au lieu de le faire.
8. **Réglages typés** via `getSetting`/`setSetting` (`src/lib/settings.ts`) — clés : `booking`, `google`, `telephony`, `sms`, `classification`, `consumption`, `transcripts`, `permissions`.
9. Dates en base : `timestamptz` (objets `Date` UTC). Affichage : `formatInTimeZone(date, "America/Toronto", …)`.
10. Server Components par défaut ; `"use client"` seulement quand nécessaire. Mutations : Server Actions (`"use server"`) ou routes API sous `src/app/api/`.
11. **Un pictogramme et une couleur par concept, définis une seule fois.** Le couple vit dans `src/components/look.tsx` (`GOAL_LOOK`, `TOOL_LOOK`, `SEVERITY_LOOK`, `EDITOR_TAB_LOOK`, `CHANNEL_LOOK`, familles `TONE`) ou dans `src/components/admin/trigger-look.tsx`. Jamais de couleur en dur dans un écran. Une icône DOUBLE un libellé (elle est `aria-hidden`), elle ne le remplace pas, et la couleur ne porte jamais le sens toute seule. `tests/unit-look.test.ts` refuse un concept sans pictogramme.
    - Le **canal SMS** a sa couleur réservée (`CHANNEL_LOOK.sms`) : sur une fiche client, cette carte SORT de l'application, ses voisines non. Ne pas la réutiliser ailleurs.
12. **Pas de notion de consentement SMS** (décision de l'exploitant, 2026-08-22). Toute fiche entrée dans ce CRM est réputée joignable : ni porte, ni registre, ni réglage. Ce qui reste et qui est ABSOLU : le désabonnement (table `suppressions`, mot-clé STOP traité dans `/api/webhooks/twilio/inbound`) et `clients.doNotCall`. Ne pas réintroduire de condition de consentement dans `canEnroll` / `canSendTouch`.
13. **Rôles et droits sont un RÉGLAGE, pas du code** (`src/lib/permissions/`, clé `permissions`). Deux listes fermées : les DROITS (`PERMISSION_KEYS`, le plafond par rôle) et les CASES DE RELATION (`GRANT_KEYS`, ce qui s'ouvre fiche par fiche selon à qui elle est assignée : `own`, `unassigned`, `role:<id>`). L'effet net est toujours l'ET des deux. L'administrateur crée ses rôles depuis `/admin/roles` ; les quatre livrés (administrateur, superviseur, téléphoniste, observateur) ne sont qu'un point de départ.
    - `users.role` (énumération figée du schéma) n'est plus que le PLANCHER : « administrateur ou pas ». Le rôle réel vit dans le réglage, et `setUserRole()` écrit les deux ensemble — ne jamais écrire `users.role` à la main.
    - Toute nouvelle lecture de fiches passe par `withVisibility()` / `visibilityCondition()`, y compris les COMPTES et les agrégats : une liste filtrée sous un total non filtré annonce le nombre de fiches qu'on cache.
    - Les chemins MACHINE (`src/lib/agent`, `src/lib/campaigns*`, `src/lib/sms*`, `src/lib/booking`, `/api/cron/*`, `/api/webhooks/*`) n'ont pas de regard : ils ne sont jamais filtrés.
    - Ajouter un droit au catalogue oblige à écrire sa fiche dans `docs.ts` **et** `docs.en.ts` — `tests/unit-permissions-docs-locale.test.ts` refuse un interrupteur anonyme.
14. **La langue de l'assistant est un réglage** (`language` + `secondaryLanguage`, onglet Identité), compilé en L3. Elle n'a rien à voir avec la langue de l'interface — voir la règle 2.

## Fichiers clés

| Chemin | Rôle |
| --- | --- |
| `src/db/schema.ts` | Schéma complet (users, clients, categories, sources, calls, appointments, comments, followups, notifications, webhookKeys, settings, auditLogs) |
| `src/lib/auth/guards.ts` | `requireUser`, `requireAdmin`, `apiUser`, `apiAdmin`, `getCurrentUser` |
| `src/lib/dispositions.ts` | Boutons colorés d'après-appel → catégorie pipeline |
| `src/lib/voipms.ts` | Client REST voip.ms (sous-comptes, DIDs, CDR, enregistrements) |
| `src/lib/telephony/types.ts` | Interface moteur téléphonie (JsSIP / Twilio) |
| `src/components/telephony/telephony-context.tsx` | Contexte `useTelephony()` — `dial({number, clientId, clientName})` |
| `src/components/shell/app-shell.tsx` | Coquille (sidebar desktop + nav basse mobile) |
| `src/lib/settings.ts` | Réglages typés (booking / google / telephony) |
| `src/components/look.tsx` | Vocabulaire visuel : un pictogramme et une couleur par concept |
| `src/lib/permissions/catalog.ts` | Les deux listes fermées : droits et cases de relation |
| `src/lib/permissions/access.ts` | La résolution, PURE : `can`, `grantsFor`, `readScope`, `canClaim` |
| `src/lib/permissions/server.ts` | Les gardes : `requirePerm`, `apiPerm`, `guardClient`, `withVisibility`, `verifyAssignment` |
| `src/lib/permissions/defaults.ts` | Les quatre rôles livrés et les règles d'assignation par défaut |
| `src/lib/classification-server/` | Règles de classement : la MÊME liste pour le prompt et pour l'outil |
| `src/app/api/objection-packs/` | CRUD des paquets d'objections — ressource PARTAGÉE entre assistants |

## Routes de l'app

- Téléphoniste : `/dashboard`, `/clients`, `/clients/[id]`, `/appointments`, `/notifications`
- Admin : `/admin/users`, `/admin/roles`, `/admin/pipeline`, `/admin/analytics`, `/admin/calls`, `/admin/import-export`, `/admin/webhooks`, `/admin/audit`, `/admin/settings`
- API : `src/app/api/…` (webhooks entrants : `/api/webhooks/leads`)

## Dev local

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres :5455
pnpm db:push && pnpm db:seed                     # schéma + admin/catégories
pnpm dev
```

Le rituel complet — brancher, tester, abandonner, mettre en ligne (`main` EST la
production) — est dans `WORKFLOW.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
