# Groupe Nexus — CRM immobilier (conventions du dépôt)

CRM de centre d'appels pour un courtier immobilier québécois. Interface **français par défaut**, anglais disponible. Déployé sur Vercel. Deux rôles : `admin` (le courtier) et `caller` (téléphoniste).

## Stack

- Next.js 16 App Router + TypeScript strict, Tailwind v4, shadcn/ui (`src/components/ui`), lucide-react, sonner (toasts)
- **⚠️ shadcn est basé sur Base UI, PAS Radix** : pas de prop `asChild` — utiliser la prop `render` (ex. `<Button render={<Link href="…" />}>Texte</Button>`, `<DialogTrigger render={<Button />}>…`). Vérifier l'API réelle dans `src/components/ui/*.tsx` avant usage.
- Drizzle ORM + Postgres — schéma complet dans `src/db/schema.ts`, client dans `src/db/index.ts` (`db`)
- Auth maison JWT (jose) — cookie `nexus_session`
- i18n : next-intl **sans routage i18n** (cookie `NEXT_LOCALE`, défaut `fr`)
- Téléphonie : voip.ms via passerelle SIP-WSS (JsSIP) ou Twilio — abstraction `src/lib/telephony/types.ts`
- Fuseau horaire d'affichage : America/Toronto (`date-fns` + `date-fns-tz`)

## Règles non négociables

1. **RBAC serveur partout.** Chaque page : `requireUser()` / `requireAdmin()` (`src/lib/auth/guards.ts`). Chaque route API : `apiUser()` / `apiAdmin()` et vérifier `instanceof NextResponse`. Les téléphonistes (`caller`) ne peuvent JAMAIS : supprimer, créer des clients à la main, importer, exporter, faire des actions en masse. Pas de bouton caché côté client comme seule protection — le serveur refuse.
2. **i18n obligatoire.** Aucune chaîne UI en dur. Chaque module remplit SON namespace : `messages/fr/<ns>.json` + `messages/en/<ns>.json` (ns: dashboard, clients, phone, booking, admin, analytics, notifications). Usage : `useTranslations("<ns>")` (client) / `getTranslations("<ns>")` (serveur). Ne PAS toucher aux fichiers des autres namespaces ni à `src/i18n/request.ts`.
3. **Téléphones en E.164** en base — toujours passer par `normalizePhone()` / `formatPhone()` (`src/lib/phone.ts`).
4. **Secrets chiffrés** en base via `encryptSecret`/`decryptSecret` (`src/lib/crypto.ts`) — jamais en clair (mots de passe SIP, tokens Google, clés webhook).
5. **Audit** des actions sensibles via `logAudit()` (`src/lib/audit.ts`) : create/update/delete client, export, import, login, changements d'utilisateurs, écoute d'enregistrement.
6. **Mobile d'abord.** Tout doit être utilisable sur téléphone (les téléphonistes appellent depuis leur cellulaire). Cibles tactiles ≥ 44px, tableaux → cartes sur mobile, `pb-safe` disponible.
7. **Ne pas modifier** : `package.json` (toutes les dépendances sont déjà installées), `src/db/schema.ts`, `src/app/globals.css`, `src/i18n/request.ts`, `src/app/(app)/layout.tsx`, `drizzle.config.ts`. Si un changement y semble nécessaire, le signaler dans le rapport final au lieu de le faire.
8. **Réglages typés** via `getSetting`/`setSetting` (`src/lib/settings.ts`) — clés : `booking`, `google`, `telephony`.
9. Dates en base : `timestamptz` (objets `Date` UTC). Affichage : `formatInTimeZone(date, "America/Toronto", …)`.
10. Server Components par défaut ; `"use client"` seulement quand nécessaire. Mutations : Server Actions (`"use server"`) ou routes API sous `src/app/api/`.

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

## Routes de l'app

- Téléphoniste : `/dashboard`, `/clients`, `/clients/[id]`, `/appointments`, `/notifications`
- Admin : `/admin/users`, `/admin/pipeline`, `/admin/analytics`, `/admin/calls`, `/admin/import-export`, `/admin/webhooks`, `/admin/audit`, `/admin/settings`
- API : `src/app/api/…` (webhooks entrants : `/api/webhooks/leads`)

## Dev local

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres :5455
pnpm db:push && pnpm db:seed                     # schéma + admin/catégories
pnpm dev
```
