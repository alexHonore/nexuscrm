# syntax=docker/dockerfile:1.7
# ── Groupe Nexus CRM — image pour Tayoo Ops (VPS, Supabase auto-hébergé) ─────
#
# Construite DEPUIS LE DÉPÔT (contexte = racine du dépôt) :
#
#   docker build -f infra/tayoo-ops/Dockerfile \
#     --build-arg NEXT_PUBLIC_APP_URL=https://web-nexuscrm.tayoo.app \
#     --build-arg NEXT_PUBLIC_SIP_WSS_URL=wss://… \
#     -t 127.0.0.1:5000/nexuscrm:<commit> .
#
# Ce que l'hébergeur du portail impose (op `website`) et que l'image respecte :
# utilisateur 10001, système de fichiers en LECTURE SEULE (seul /tmp est
# inscriptible), port 8080, réseau `sb-nexuscrm_default` (Postgres = `db:5432`).
#
# La version Vercel n'utilise PAS ce fichier : elle continue de se construire
# comme avant, ce qui garde le repli intact.

ARG NODE_IMAGE=node:22-alpine

# ── 1. dépendances (couche mise en cache tant que le verrou ne bouge pas) ────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── 2. construction ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Les NEXT_PUBLIC_* sont INLINÉES au build : une image par domaine.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SIP_WSS_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_SIP_WSS_URL=${NEXT_PUBLIC_SIP_WSS_URL} \
    NEXT_TELEMETRY_DISABLED=1
# `src/db/index.ts` lit DATABASE_URL à l'import ; postgres.js ne se connecte
# qu'à la première requête, et aucune page ne requête au build. URL factice,
# jamais la vraie (elle ne doit pas finir dans une couche d'image).
RUN test -n "$NEXT_PUBLIC_APP_URL" || (echo "NEXT_PUBLIC_APP_URL manquant (--build-arg)" >&2; exit 1)
RUN DATABASE_URL="postgres://build:build@localhost:5432/build" DATABASE_SSL=disable \
    AUTH_SECRET="build-only-not-a-secret-000000000000" \
    pnpm build

# ── 3. exécution ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=10001:10001 /app/package.json /app/next.config.ts ./
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/public ./public
COPY --from=build --chown=10001:10001 /app/messages ./messages
COPY --from=build --chown=10001:10001 /app/src ./src
COPY --from=build --chown=10001:10001 /app/.next ./.next
# Système de fichiers en lecture seule : le cache d'images/ISR de Next part
# dans /tmp (seul endroit inscriptible), recréé au démarrage.
RUN rm -rf /app/.next/cache && ln -s /tmp/next-cache /app/.next/cache
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1
CMD ["sh", "-c", "mkdir -p /tmp/next-cache && exec node node_modules/next/dist/bin/next start -p \"$PORT\" -H \"$HOSTNAME\""]
