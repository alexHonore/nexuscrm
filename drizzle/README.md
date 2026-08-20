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
