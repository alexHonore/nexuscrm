# Groupe Nexus — CRM immobilier

CRM de centre d'appels pour Groupe Nexus (Alex-Honoré Nshimiyimana, courtier immobilier). Interface français/anglais (français par défaut).

- **Téléphonistes** : appellent les clients depuis le navigateur (voip.ms), classent chaque appel (boutons colorés), prennent des rendez-vous sur le calendrier Google du courtier (visio Meet ou visite), gèrent leurs suivis, commentent et mentionnent les collègues.
- **Admin** : gestion des utilisateurs et de leurs lignes voip.ms (sous-comptes + DID), pipeline/catégories, import/export CSV, webhooks (n8n / Facebook Lead Ads), analytique par téléphoniste (appels, minutes, RDV), journal d'appels avec enregistrements, journal d'audit, bascule voip.ms ⇄ Twilio.

## Architecture

```
Navigateur (téléphoniste)                    n8n / Facebook Lead Ads
   │  HTTPS                │ WSS (SIP)               │ POST /api/webhooks/leads
   ▼                       ▼                         ▼
Vercel (Next.js) ◄──── Passerelle vocale VPS ──► voip.ms (SIP/RTP + API REST)
   │                   (Kamailio + rtpengine         POP Montréal
   ▼                    + proxy API, IP fixe)
Neon Postgres          Google Calendar API (RDV + FreeBusy)
```

## Démarrage local

```bash
pnpm install
cp .env.example .env        # remplir les valeurs
docker compose -f docker-compose.dev.yml up -d    # Postgres :5455 (ou Postgres natif)
pnpm db:push && pnpm db:seed                      # le seed affiche le mot de passe admin UNE FOIS
pnpm dev                                          # http://localhost:3000
```

## Déploiement production — checklist complète

### 1. Google Cloud (une fois, ~5 min)

Le client OAuth existe déjà (projet `nexuscrm-504621`). Il reste :

1. [console.cloud.google.com](https://console.cloud.google.com) → projet **nexuscrm-504621** → **API et services → Bibliothèque** → activer **Google Calendar API**.
2. **API et services → Identifiants** → votre client OAuth → **URI de redirection autorisés**, ajouter :
   - `http://localhost:3000/api/google/callback`
   - `https://VOTRE-DOMAINE/api/google/callback` (une fois le domaine Vercel connu)
3. **Écran de consentement OAuth** : ajouter `nsh.alexhonore@gmail.com` comme **utilisateur test**, **OU** publier l'application (« En production »). ⚠️ Important : en mode « Test », Google **expire le refresh token après 7 jours** → il faudrait reconnecter le calendrier chaque semaine. Publiez l'app (même « non validée » — seul votre compte l'utilise, cliquez « Paramètres avancés → Continuer » lors de la connexion).
4. Dans le CRM : **Admin → Réglages → Connecter Google** → consentement → terminé. Les réservations vérifient ensuite vos disponibilités en direct (FreeBusy 6 h–23 h) et créent les événements (Meet ou visite) sur votre calendrier.

### 2. Vercel + Neon

```bash
npm i -g vercel
vercel login
vercel link          # créer le projet
```

1. **Base de données** : dashboard Vercel → Storage → **Neon Postgres** (Marketplace) → connecter au projet. Récupérer `DATABASE_URL` (`vercel env pull .env.production.local`).
2. **Variables d'environnement** (Settings → Environment Variables — copier depuis `.env.example`) :
   `DATABASE_URL`, `AUTH_SECRET` (nouveau : `openssl rand -base64 32`), `APP_ENCRYPTION_KEY` (⚠️ générer UNE FOIS et ne plus changer — chiffre les secrets en base), `NEXT_PUBLIC_APP_URL`, `VOIPMS_API_USERNAME`, `VOIP_MS_API_PASSWORD`, `VOIPMS_SIP_DOMAIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET` (`openssl rand -hex 24`), puis après l'étape 3 : `NEXT_PUBLIC_SIP_WSS_URL`, `VOIPMS_API_PROXY_URL`, `VOIPMS_API_PROXY_TOKEN`.
3. **Schéma + seed** vers Neon (depuis votre poste) :
   ```bash
   DATABASE_URL="postgres://...neon..." pnpm db:push
   DATABASE_URL="postgres://...neon..." pnpm db:seed   # note le mot de passe admin affiché
   ```
4. `vercel deploy --prod`. Les crons (`vercel.json`) tournent automatiquement : synchronisation CDR/enregistrements voip.ms chaque heure, rappels de suivis chaque 30 min.

### 3. Passerelle vocale (VPS, ~30 min)

Suivre **`gateway/README.md`** (guide pas-à-pas en français) : VPS Ubuntu (OVH Montréal / DigitalOcean Toronto, x86, 2 Go), DNS `voice.votre-domaine`, `setup.sh`, certificats automatiques. Ensuite reporter dans Vercel : `NEXT_PUBLIC_SIP_WSS_URL=wss://voice.votre-domaine:8443`, `VOIPMS_API_PROXY_URL=https://voice.votre-domaine/voipms-api`, `VOIPMS_API_PROXY_TOKEN`.

### 4. voip.ms

1. **Menu principal → SOAP/REST API** : API activée, mot de passe API (déjà en env), **IP autorisée = IP du VPS** (et votre IP locale pour le dev).
2. Par téléphoniste : **Admin → Utilisateurs → [utilisateur] → VoIP** : « Créer le sous-compte » (mot de passe SIP généré et chiffré automatiquement), choisir un DID dans la liste, « Router le DID vers ce sous-compte ». C'est tout — l'utilisateur peut appeler et recevoir dès sa prochaine connexion.
3. (Optionnel) Activer **Call Recording** sur le compte voip.ms pour que le cron rattache les enregistrements au journal d'appels.

### 5. n8n / Facebook Lead Ads

Remplacer le nœud Notion par un nœud **HTTP Request** :

- **POST** `https://VOTRE-DOMAINE/api/webhooks/leads`
- Header `x-api-key` : la clé affichée dans **Admin → Webhooks**
- Body (JSON) — le point d'entrée accepte directement les noms de champs Facebook accentués :

```json
{
  "data": {
    "nom_complet": "={{ $json.data.nom_complet }}",
    "numéro_de_téléphone": "={{ $json.data['numéro_de_téléphone'] }}",
    "e-mail": "={{ $json.data['e-mail'] }}",
    "quel_est_votre_besoin_?": "={{ $json.data['quel_est_votre_besoin_?'] }}",
    "votre_projet_est_prévu_pour_quand_?": "={{ $json.data['votre_projet_est_prévu_pour_quand_?'] }}"
  }
}
```

Doublons dédupliqués par numéro de téléphone ; chaque lead crée une notification pour les admins.

## Scripts

| Commande | Effet |
| --- | --- |
| `pnpm dev` / `pnpm build` | dev / build production |
| `pnpm db:push` | applique le schéma Drizzle |
| `pnpm db:seed` | catégories, sources, compte admin, réglages (idempotent) |
| `pnpm db:studio` | explorateur de base Drizzle Studio |

Conventions de code : voir `AGENTS.md`.
Tester, abandonner une branche, mettre en ligne : voir `WORKFLOW.md`.
