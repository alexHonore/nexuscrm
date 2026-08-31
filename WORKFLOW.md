# Travailler sur ce dépôt — tester, abandonner, mettre en ligne

Le rituel pour un changement ou une nouvelle fonctionnalité, du premier fichier
touché jusqu'à la production.

**La règle qui commande tout :** `main` **EST** la production. Il n'y a pas
d'étape « déployer » séparée — Vercel suit la branche, et le `git push` sur
`main` met en ligne. Tout le reste de ce document découle de là.

Conventions de code : voir `AGENTS.md`. Installation : voir `README.md`.

---

## La boucle, en cinq lignes

```bash
git switch main && git pull
git switch -c feat/mon-truc          # 1. une branche
#   … travail …
pnpm test                            # 2. le filet
pnpm dev                             # 3. l'œil, en local
git push -u origin feat/mon-truc     # 4. (optionnel) prévisualisation au pouce
git switch main && git merge feat/mon-truc && git push    # 5. en ligne
```

Nommage des branches, tel qu'il est déjà employé : `feat/…` pour une
fonctionnalité, `fix/…` pour une correction.

---

## 1. Tester

### En local — pour tout ce qui se clique

```bash
git switch feat/mon-truc
brew services start postgresql@16    # la base locale sur :5455, si arrêtée
pnpm dev                             # → http://localhost:3000
```

C'est le seul endroit où la base est **jetable** : on peut y presser un bouton
de masse, importer un CSV pourri, casser une campagne, puis repartir à neuf
avec `pnpm db:push && pnpm db:seed`. Aucun environnement déployé n'offre cette
liberté — c'est ce qui fait du local le lieu du vrai test, pas un pis-aller.

Deux pièges qui coûtent chacun une demi-heure de confusion :

- **La branche touche `src/db/schema*.ts`** → `pnpm db:push` APRÈS le
  `git switch`. Sans ça, l'application parle à une base qui n'a pas les
  colonnes qu'elle attend, et l'erreur ne dit pas pourquoi.
- **La branche ajoute des textes** dans `messages/**/*.json` → redémarrer
  `pnpm dev`. Ces fichiers passent par un `import()` dynamique que Turbopack
  met en cache : sans redémarrage, l'écran affiche les clés brutes
  (`inbox.close.all`) et on croit avoir cassé l'i18n.

### La suite de tests — le vrai filet

```bash
pnpm test        # ~4 min : 149 fichiers, 3 280 tests (Postgres :5455 requis)
```

C'est là que se font prendre les défauts qui ne se voient pas à l'œil : une
fuite de droits, un prédicat SQL faux, un compte non filtré à côté d'une liste
filtrée, un libellé manquant dans une des deux langues, un concept sans
pictogramme. Un écran qui « a l'air bien » ne prouve rien de tout ça.

Les tests d'intégration partagent une base : ils s'exécutent en série
(`fileParallelism: false`). **Ne pas** lancer plusieurs fichiers `int-*` dans
des processus concurrents — ils se bloquent mutuellement et les échecs qui en
résultent ne veulent rien dire.

### Sur la prévisualisation de branche — pour ce que le local ne simule pas

Chaque branche poussée reçoit une adresse stable de la forme
`groupe-nexus-git-<branche>-table-ronde.vercel.app`. Elle sert à **trois**
choses, et ne vaut le détour que pour celles-là :

- **le téléphone réel** — c'est le poste de travail des téléphonistes
  (`AGENTS.md`, règle 6), et un navigateur rétréci n'apprend rien sur le pouce ;
- **la PWA et les notifications push** — elles exigent du HTTPS, donc elles ne
  se testent pas sérieusement sur `localhost` ;
- **la latence réelle** — région, démarrages à froid, préchargement.

> ⚠️ **Inconnue à lever une fois pour toutes.** L'environnement *Preview* de
> Vercel a son propre `DATABASE_URL`, mais Vercel masque la valeur des
> variables « Sensitive ». Tant que personne n'a vérifié dans le tableau de
> bord Supabase **combien de projets existent**, on ne sait pas si les
> prévisualisations écrivent dans une base de test ou dans les vraies fiches.
> Deux projets : les prévisualisations sont sûres. Un seul : n'y presser aucun
> bouton qui écrit.

Ce que la prévisualisation ne peut **pas** faire, et c'est tant mieux :
envoyer un texto. Les clés Twilio n'existent que dans l'environnement
*Production*.

---

## 2. Abandonner une branche

Rien à défaire : une branche non fusionnée n'a jamais touché la production.

```bash
git switch main
git branch -D feat/mon-truc                      # local
git push origin --delete feat/mon-truc           # distant + prévisualisation
```

En cas d'hésitation, **la laisser dormir**. Une branche non fusionnée ne coûte
rien, ne dérange personne, et se reprend six mois plus tard.

---

## 3. Mettre en ligne

```bash
pnpm test                                # d'abord. toujours.
git switch main
git pull                                 # au cas où
git merge feat/mon-truc
git push                                 # ← la production part ICI
```

Puis vérifier que c'est vraiment en ligne — l'absence d'erreur dans le terminal
ne prouve pas qu'un déploiement a réussi :

```bash
npx vercel ls groupe-nexus --prod        # le déploiement du haut doit être ● Ready
```

**Variante avec relecture** : ouvrir une pull request (`gh pr create --base main`),
relire le diff sur GitHub, fusionner de là. Même effet, avec une trace écrite.

### Le schéma de base, s'il a changé

`pnpm db:push` en local applique le schéma à la base locale — **jamais à la
production**. Si la branche modifie `src/db/schema*.ts`, la production a besoin
de son propre `db:push`, exécuté à la main contre l'URL de production, **via le
pooler SESSION (port 5432), pas le pooler transactionnel (6543)** — drizzle-kit
a besoin d'une vraie session.

C'est une étape manuelle et consciente : à faire **avant** que le code qui
attend les nouvelles colonnes ne soit en ligne.

### Si la production va mal

```bash
npx vercel ls groupe-nexus --prod        # relever l'URL du déploiement d'AVANT
npx vercel rollback <cette-url>          # elle repasse en ligne, en secondes
```

Ça règle le **code**. Ça ne défait pas des écritures en base — d'où le fait que
`pnpm test` et le passage en local viennent *avant*, pas après.

---

## Ce qui n'existe qu'en production

Deux choses ne se testent nulle part ailleurs. Les connaître évite de chercher
une panne qui n'en est pas une :

- **Les crons Vercel** (`vercel.json`) — répartition des envois SMS,
  synchronisation CDR voip.ms, rappels de suivis. Ils ne tournent **que** sur
  les déploiements de production. En local et en prévisualisation, le moteur ne
  se déclenche pas tout seul.
- **Twilio** — les clés (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `SMS_LIVE_CONFIRMED`) ne sont définies que dans l'environnement *Production*.
  Ailleurs, `resolveSmsMode` retombe en simulation et rien ne part.

---

## Avant de fusionner — la liste courte

Cinq questions qui recouvrent la plupart des retours de relecture. Elles
reprennent les règles non négociables d'`AGENTS.md`, du point de vue de
quelqu'un qui s'apprête à mettre en ligne.

1. **`pnpm test` passe** — et les tests ajoutés échoueraient vraiment si la
   fonctionnalité était cassée. Un test qui cherche une sous-chaîne présente
   ailleurs dans la page ne garde rien.
2. **Le serveur refuse tout seul.** Chaque nouvelle action vérifie le droit du
   rôle ET la case de la fiche (`AGENTS.md`, règles 1 et 13). Un bouton caché
   côté client ne protège rien ; à l'inverse, un bouton offert que le serveur
   refusera est une promesse qu'on ne tient pas.
3. **Rien en dur.** Aucune chaîne d'interface hors des deux fichiers de langue,
   aucune couleur hors de `src/components/look.tsx`.
4. **Un compte ne ment pas.** Toute liste filtrée par la visibilité a un
   compagnon de compte filtré de la même façon, et toute liste tronquée le dit.
5. **Ça se tient au pouce.** Cibles ≥ 44 px, tableaux en cartes sur téléphone.

---

## Repères

| Commande | Effet |
| --- | --- |
| `pnpm dev` | serveur local sur :3000 |
| `pnpm test` | toute la suite : 3 280 tests, ~4 min (Postgres :5455 requis) |
| `npx vitest run tests/unit-*.test.ts` | les unitaires seuls, ~45 s |
| `pnpm db:push` / `pnpm db:seed` | schéma / jeu de départ, base LOCALE |
| `brew services start postgresql@16` | la base locale sur :5455 |
| `npx vercel ls groupe-nexus --prod` | l'état des déploiements de production |
| `npx vercel rollback <url>` | remettre en ligne un déploiement précédent |
