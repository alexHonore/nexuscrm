# Base de dev/tests sur le KVM (au lieu de Docker Desktop)

Postgres tourne sur le KVM Hostinger et se rejoint depuis le Mac par un tunnel
SSH sur le **même port qu'avant (5455)**. `.env`, `.env.test` et toutes les
commandes (`pnpm dev`, `pnpm test`, `pnpm db:push`, `pnpm db:seed`) fonctionnent
**sans aucune modification** — Docker Desktop n'est plus nécessaire en local.

```
Mac  localhost:5455  ──tunnel SSH──►  KVM 127.0.0.1:5455  ──►  nexus-devdb :5432
                                       (jamais exposé sur Internet)
```

## Pourquoi un tunnel plutôt qu'un port ouvert

Le KVM a une IP publique. Un Postgres publié sur `0.0.0.0` avec les
identifiants de dev (`nexus`/`nexus`) est trouvé et compromis en quelques
heures par les balayages automatisés — et ce serveur héberge aussi n8n, la
passerelle vocale et Traefik. Le port est donc lié à `127.0.0.1` sur le KVM :
la frontière de sécurité est SSH (déjà en authentification par clé).

**Ne jamais remplacer `127.0.0.1:5455:5432` par `5455:5432`** dans
`docker-compose.yml`.

## Installation (une seule fois)

Depuis le Mac, à la racine du dépôt :

```bash
# 1. Vérifier que le port 5455 est libre sur le KVM
ssh root@31.97.147.222 'ss -lntp | grep -E ":(5455|5432)\b" || echo "5455 et 5432 libres"'

# 2. Copier la configuration
ssh root@31.97.147.222 'mkdir -p /opt/nexus-devdb'
scp -r infra/dev-db/docker-compose.yml infra/dev-db/init \
    root@31.97.147.222:/opt/nexus-devdb/

# 3. Démarrer
ssh root@31.97.147.222 'cd /opt/nexus-devdb && docker compose up -d && docker compose ps'
```

Vérifier que les deux bases existent :

```bash
ssh root@31.97.147.222 \
  'docker exec nexus-devdb psql -U nexus -lqt | cut -d"|" -f1 | grep -E "nexus|nexus_test"'
```

## ⚠️ `db:push` vise ce que dit DATABASE_URL — et `.env` pointe sur la PRODUCTION

`drizzle.config.ts` lit `process.env.DATABASE_URL`, et le `.env` du dépôt
contient l'URL **Supabase de production**. Un `pnpm db:push` nu pousse donc le
schéma en production. Toujours préciser la cible :

```bash
# Base de DÉVELOPPEMENT sur le KVM
DATABASE_URL="postgres://nexus:nexus@localhost:5455/nexus" pnpm db:push
DATABASE_URL="postgres://nexus:nexus@localhost:5455/nexus" pnpm db:seed

# Base de TESTS sur le KVM (les tests ne font que TRUNCATE : le schéma doit
# déjà exister — voir tests/helpers/db.ts)
DATABASE_URL="postgres://nexus:nexus@localhost:5455/nexus_test" pnpm db:push
```

Une variable exportée dans le shell l'emporte sur `.env` (dotenv n'écrase pas
l'existant) — l'override ci-dessus est donc fiable.

## Usage quotidien

```bash
scripts/db-tunnel.sh up       # ouvre le tunnel (une fois par session)
pnpm test                     # suite complète (utilise .env.test → nexus_test)
pnpm dev                      # app locale ; décommenter la ligne dev de .env
scripts/db-tunnel.sh status   # état + pg_isready réel
scripts/db-tunnel.sh down     # ferme le tunnel
```

`pnpm test` n'a besoin d'aucun override : `.env.test` cible déjà
`localhost:5455/nexus_test`, et `tests/setup.ts` refuse de démarrer si l'URL ne
contient pas « nexus_test ».

Le tunnel se reconnecte mal après une veille prolongée du Mac : en cas
d'erreur de connexion, `scripts/db-tunnel.sh down && scripts/db-tunnel.sh up`.

Hôte et ports surchargeables : `NEXUS_KVM_HOST`, `NEXUS_DB_PORT`,
`NEXUS_DB_REMOTE_PORT`.

## Bascule depuis Docker Desktop

Le port 5455 ne peut pas être pris deux fois — arrêter l'ancien conteneur local
avant d'ouvrir le tunnel (`db-tunnel.sh up` le détecte et refuse sinon) :

```bash
docker compose -f docker-compose.dev.yml down
```

`docker-compose.dev.yml` reste dans le dépôt : il dépanne hors ligne, quand le
KVM est injoignable.

## Notes

- `fsync=off` : ces bases sont **jetables**. En cas de coupure brutale du KVM,
  la base peut être corrompue — on la recrée avec `pnpm db:push && pnpm db:seed`.
  Ne jamais utiliser cette configuration pour des données réelles (la
  production, c'est Supabase).
- La base `nexus_test` est créée à la **première** initialisation du volume. Si
  elle manque, c'est que le volume existait déjà :
  `ssh root@31.97.147.222 'docker exec nexus-devdb createdb -U nexus nexus_test'`
- Ressources : ce Postgres cohabite avec n8n, Kamailio et rtpengine. Il est
  plafonné à 100 connexions ; `pnpm test` n'en ouvre que quelques-unes.
