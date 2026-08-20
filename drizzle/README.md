# Migrations SQL — registre de revue, PAS le mécanisme de déploiement

Le schéma de ce dépôt se déploie avec **`pnpm db:push`** (drizzle-kit push),
comme documenté dans le README racine — c'était déjà le cas avant ces fichiers
et ça le reste. La base de production a été construite par push : elle n'a
**aucune table `__drizzle_migrations`**.

Les fichiers `NNNN_*.sql` ici sont générés par `pnpm db:generate` à chaque
phase du moteur SMS comme **registre relisible et forward-only** de ce que le
push va appliquer (aucun énoncé destructeur — vérifiable à l'œil).

⚠️ **Ne PAS exécuter `drizzle-kit migrate` contre la base de production.**
`0000_baseline.sql` recrée les tables existantes sans `IF NOT EXISTS` : sur la
vraie base il échoue au premier `CREATE TYPE` et rien ne s'applique. Si un jour
on veut basculer vers un vrai flux migrate, il faudra d'abord marquer 0000
comme appliquée (baseline) dans `__drizzle_migrations`.

Application locale (dev/test) :

```bash
DATABASE_URL=postgres://nexus:nexus@localhost:5455/nexus pnpm db:push
DATABASE_URL=postgres://nexus:nexus@localhost:5455/nexus_test pnpm db:push
```

(Toujours préfixer `DATABASE_URL` — le `.env` du dépôt pointe la prod.)

## Production (Supabase, PostgreSQL 17)

⚠️ **`pnpm db:push` PLANTE contre la prod** (vérifié 2026-08-20) : drizzle-kit
0.31.10 crashe à l'introspection (`TypeError … reading 'replace'`) parce que
PostgreSQL 17 catalogue les contraintes NOT NULL dans `pg_constraint` et que
drizzle-kit les prend pour des CHECK sans définition. Le crash survient AVANT
tout DDL — rien n'est appliqué. En local (PG 16) tout fonctionne ; la mise à
niveau de drizzle-kit attendra (package.json gelé).

Chemin sanctionné pour la prod : appliquer le fichier SQL de la phase,
purement additif et déjà relu, en une seule transaction :

```bash
set -a; source .env; set +a
/opt/homebrew/opt/postgresql@16/bin/psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f drizzle/0001_phase1-sms.sql
```

(`-1` = tout-ou-rien : réexécutable sans état partiel.)
