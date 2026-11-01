# Groupe Nexus CRM sur Tayoo Ops — déploiement, bascule, retour arrière

La même application, la même architecture (Next.js + Postgres + Drizzle), mais
hébergée sur le VPS (`ops.tayoo.app`, instance Supabase auto-hébergée
`nexuscrm`) au lieu de Vercel + Supabase cloud. L'ancienne version reste
**intacte et en sommeil** pendant la période de repli (2 à 4 semaines), et la
nouvelle lui recopie ses données toutes les 15 minutes : un retour arrière
repart d'un état à jour.

> Le code n'a qu'**un** chemin : sans les nouvelles variables, il se comporte
> exactement comme avant. La version Vercel n'a rien à changer pour rester le
> repli.

---

## 1. Ce qui tourne où

| | Avant la bascule | Après la bascule (période de repli) | Après un retour arrière |
|---|---|---|---|
| Application | Vercel `groupe-nexus` | conteneur hébergé par le portail, `https://web-nexuscrm.tayoo.app` | Vercel `groupe-nexus` |
| Base active | Supabase cloud `weasuzxazxjnfzxzqtsw` | instance `nexuscrm` (VPS, slot 3) | Supabase cloud |
| Copie | — | `nexuscrm` → cloud, toutes les 15 min (`reverse-sync.sh`) | **arrêtée** (`DISABLED`) |
| Crons n8n | workflow `cron-crm.json` → vercel.app | workflow `cron-crm.tayoo-ops.json` → tayoo.app | workflow `cron-crm.json` |
| Vercel | actif | **en pause** (repli = reprise) | actif |
| Passerelle vocale (`gateway/`) | inchangée, sur le VPS | inchangée | inchangée |

## 2. Ce qui a changé dans le code

Trois réglages, tous **inertes** quand ils sont absents (donc sur Vercel) :

| Variable | Tayoo Ops | Pourquoi |
|---|---|---|
| `DATABASE_SSL` | `disable` | Postgres de l'instance sur son réseau Docker privé (`db:5432`), sans TLS. Remplace l'astuce « `_localhost` » glissée dans `application_name`. Défaut : TLS exigé sauf URL `localhost`/`127.0.0.1` (comme avant). Valeur inconnue = erreur au démarrage. |
| `DATABASE_POOL_MAX` | (30, défaut) | Ajustable sans toucher au code. |
| `TRUSTED_PROXY` | `cloudflare` | Le trafic arrive par le tunnel Cloudflare : l'IP du visiteur est `cf-connecting-ip`. **Obligatoire** : sans lui, `x-vercel-forwarded-for` — que personne n'écrase hors de Vercel — serait cru, et le limiteur de tentatives de connexion contournable en changeant d'en-tête à chaque essai. |

Code : `src/db/connection.ts`, `src/db/index.ts`, `src/lib/audit.ts`
(`clientIpFromHeaders`). Tests : `tests/unit-self-hosting.test.ts`.

## 3. Les fichiers de ce dossier

| Fichier | Rôle | Va sur le VPS dans |
|---|---|---|
| `Dockerfile` (+ `.dockerignore`) | Image de l'app : uid 10001, FS en lecture seule (`/tmp` seul inscriptible), port 8080 | — (lu depuis l'export du dépôt) |
| `build-image.sh` | Construit depuis un export du dépôt, pousse au registre `127.0.0.1:5000`, imprime la référence `@sha256` | `/srv/supabase/apps/nexuscrm/` |
| `app.env.example` | Noms des réglages de l'app + ce qui diffère de Vercel | modèle de `app.env` |
| `reverse-sync.sh` | Copie `nexuscrm` → ancienne base cloud, une transaction, gardes | `/srv/supabase/apps/nexuscrm/` |
| `reverse-sync.env.example` | Modèle de sa conf (URL de l'ancienne base) | modèle de `reverse-sync.env` (600) |
| `systemd/nexuscrm-reverse-sync.{service,timer}` | Toutes les 15 min | `/etc/systemd/system/` |
| `../../n8n/cron-crm.tayoo-ops.json` | Les crons vers le nouveau domaine, **plus** les notes d'appel (`/api/cron/transcripts`) qui n'existaient que comme cron Vercel | import dans n8n, **inactif** jusqu'à la bascule |

---

## 4. Déployer (ou redéployer) la nouvelle version

Depuis le Mac, **sans toucher au dossier de travail** (on exporte un commit) :

```bash
cd /Volumes/SSD-1tb/NexusCRM && git fetch origin
```

```bash
COMMIT=$(git rev-parse origin/main) && git archive "$COMMIT" | ssh root@31.97.147.222 "set -e; d=/srv/supabase/apps/nexuscrm; rm -rf \$d/src.new; mkdir -p \$d/src.new; tar -x -C \$d/src.new; rm -rf \$d/src.prev; [ -d \$d/src ] && mv \$d/src \$d/src.prev; mv \$d/src.new \$d/src; echo $COMMIT > \$d/src.commit"
```

(Pour essayer une branche avant sa fusion : `origin/<branche>` à la place de
`origin/main`.)

Puis sur le VPS :

```bash
install -m 755 /srv/supabase/apps/nexuscrm/src/infra/tayoo-ops/build-image.sh /srv/supabase/apps/nexuscrm/build-image.sh
```

```bash
/srv/supabase/apps/nexuscrm/build-image.sh /srv/supabase/apps/nexuscrm/src
```

La dernière ligne donne `127.0.0.1:5000/nexuscrm@sha256:…` : c'est elle que
l'on héberge (portail → instance `nexuscrm` → **Host app**, ou l'étape
d'hébergement de `build-and-deploy.sh`), avec `app.env` et 1024 MiB.

> ⚠️ `build-and-deploy.sh`, préparé sur le VPS avant ce dossier, a **son
> propre** Dockerfile. Vérifier qu'il construit avec
> `src/infra/tayoo-ops/Dockerfile` (contexte `src/`) ou le remplacer par
> `build-image.sh` + l'hébergement — sinon `DATABASE_SSL` et `TRUSTED_PROXY`
> restent les seuls changements à reporter dans `app.env`.

`app.env` doit contenir, en plus des réglages de production : 
`DATABASE_SSL=disable`, `TRUSTED_PROXY=cloudflare`,
`NEXT_PUBLIC_APP_URL=https://web-nexuscrm.tayoo.app`, un **nouveau**
`CRON_SECRET`, et `SMS_MODE=dry_run` jusqu'à la bascule. `APP_ENCRYPTION_KEY`
et `AUTH_SECRET` doivent être **ceux de la production** (sinon : secrets SIP /
Google / webhooks illisibles, sessions refusées). Voir `app.env.example`.

**Vérifier** (toujours en `dry_run`, sans crons) : `https://web-nexuscrm.tayoo.app/login`
répond ; connexion avec un compte existant ; une fiche client s'ouvre ;
`/admin/audit` montre la connexion **avec la bonne IP** (preuve que
`TRUSTED_PROXY` est actif) ; journaux du conteneur propres.

---

## 5. Synchronisation inverse (nouvelle → ancienne base)

Installation, sur le VPS :

```bash
d=/srv/supabase/apps/nexuscrm; install -m 700 $d/src/infra/tayoo-ops/reverse-sync.sh $d/reverse-sync.sh; install -m 600 $d/src/infra/tayoo-ops/reverse-sync.env.example $d/reverse-sync.env; install -m 644 $d/src/infra/tayoo-ops/systemd/nexuscrm-reverse-sync.service $d/src/infra/tayoo-ops/systemd/nexuscrm-reverse-sync.timer /etc/systemd/system/; systemctl daemon-reload
```

Puis éditer `reverse-sync.env` : `OLD_DATABASE_URL` = l'ancienne base par le
pooler **session** (port 5432, `sslmode=require`). Le timer n'est **pas**
activé à l'installation : il ne doit tourner qu'APRÈS la bascule (avant, c'est
l'ancienne base qui vit, et la garde 4 refuserait de toute façon).

Ce que fait chaque passage :

1. `DISABLED` présent dans `reverse-sync/` → rien du tout (posé au retour arrière) ;
2. l'URL cible doit contenir `weasuzxazxjnfzxzqtsw` et ne désigner rien du VPS ;
3. colonnes des tables `public` identiques des deux côtés — sinon refus et
   `reverse-sync/schema.diff` ;
4. la dernière ligne d'`audit_logs` de l'ancienne base existe à l'identique
   côté VPS — sinon l'ancienne version a écrit (quelqu'un s'y est connecté),
   et on refuse d'écraser ;
5. `pg_dump` d'un instantané cohérent, puis dans **une** transaction :
   triggers utilisateur suspendus, `TRUNCATE` de toutes les tables, `COPY`,
   séquences, **contrôle du nombre de lignes de chaque table**, triggers
   rétablis, `COMMIT`. La moindre erreur = `ROLLBACK`, ancienne base inchangée.

Codes de sortie : 0 OK (ou désactivé / déjà en cours), 2 configuration,
3-5 lecture impossible, 4 schémas divergents, 6 ancienne base écrite,
7 `pg_dump`, 8 préparation, 9 chargement refusé.

Suivi :

```bash
systemctl list-timers nexuscrm-reverse-sync.timer; cat /srv/supabase/apps/nexuscrm/reverse-sync/last-success; journalctl -u nexuscrm-reverse-sync -n 30 --no-pager
```

Prévol, **lecture seule des deux côtés** — sans risque même pendant que
l'ancienne version est en service (connexion, cible, schémas ; la garde 4 y est
rapportée sans être fatale) :

```bash
/srv/supabase/apps/nexuscrm/reverse-sync.sh --preflight
```

Répétition complète (tout le chemin, puis `ROLLBACK` — rien n'est gardé) :

```bash
/srv/supabase/apps/nexuscrm/reverse-sync.sh --check
```

> ⚠️ `--check` prend des verrous exclusifs sur toutes les tables de l'ancienne
> base le temps de la transaction (quelques secondes) : ne le lancer qu'une
> fois l'ancienne version **arrêtée** (bascule, étape 3). Avant, `--preflight`.

> Testé ici sur deux Postgres 17 avec le schéma complet (41 tables) : copie
> octet pour octet identique (données + séquences), trigger d'activation des
> assistants rétabli, et chacune des gardes 1 à 5 refuse sans toucher la cible.
> **Pas encore exécuté contre la vraie base cloud** — le premier `--check`
> là-bas confirmera que `postgres` y possède bien les tables (nécessaire pour
> suspendre le trigger).

---

## 6. Bascule (fenêtre calme, ~30 min)

Chaque ligne marquée ✋ est une action vers l'extérieur : l'exploitant la
confirme au moment de la faire.

1. **Préalables** : section 4 vérifiée ; `reverse-sync.sh --preflight` OK
   **contre la vraie base cloud** (la garde 4 y signale les écritures de
   l'ancienne version — normal tant qu'elle tourne ; le `--check` complet se
   fait juste après l'étape 4) ; une répétition de retour
   arrière faite ; workflow `n8n/cron-crm.tayoo-ops.json` importé **inactif**
   avec le nouveau `CRON_SECRET` ; nouvelle URI de redirection
   `https://web-nexuscrm.tayoo.app/api/google/callback` **ajoutée** (pas
   remplacée) dans la console Google.
2. ✋ Désactiver le workflow n8n `cron-crm.json` (plus de crons vers Vercel).
3. ✋ Mettre Vercel `groupe-nexus` en pause (plus d'écriture dans l'ancienne base).
4. Recopie finale ancienne → nouvelle :
   `… | ssh root@31.97.147.222 /srv/supabase/bin/migrate-from-url.sh nexuscrm NexusCRM --resync`
   (commande complète dans la passation). Vérifier les comptes de lignes.
5. `app.env` : `SMS_MODE=live` et `SMS_LIVE_CONFIRMED=true` ; ré-héberger.
6. ✋ Twilio : webhooks SMS entrants / statut (Messaging Service) et, si
   utilisé, TwiML App → `https://web-nexuscrm.tayoo.app/api/...` (mêmes
   chemins). Expéditeurs du webhook de leads → nouveau domaine (même clé).
7. ✋ Activer le workflow `cron-crm.tayoo-ops.json`.
8. Démarrer la copie inverse :
   `systemctl enable --now nexuscrm-reverse-sync.timer`, puis
   `systemctl start nexuscrm-reverse-sync.service` et lire `last-success`.
9. Essai : connexion, un appel, un texto reçu et un envoyé, une notification.
10. Prévenir les téléphonistes : **nouvelle adresse**, réinstaller l'app (PWA)
    et réactiver les notifications — une PWA et ses abonnements push sont liés
    à l'origine.

## 7. Retour arrière (≈10 min)

1. ✋ Arrêter les écritures sur le VPS : arrêter l'app hébergée (portail →
   Stop) et désactiver le workflow `cron-crm.tayoo-ops.json`. App arrêtée
   d'abord : aucun job en cours ne reste « réclamé » dans la copie.
2. Dernière copie, à la main :
   `systemctl start nexuscrm-reverse-sync.service && cat /srv/supabase/apps/nexuscrm/reverse-sync/last-success`
   (doit dater de maintenant). S'il refuse, **ne pas forcer** : lire le motif.
3. **Couper la copie pour de bon — avant de rallumer quoi que ce soit** :
   ```bash
   touch /srv/supabase/apps/nexuscrm/reverse-sync/DISABLED && systemctl disable --now nexuscrm-reverse-sync.timer
   ```
   Une copie qui repasserait APRÈS le retour effacerait ce que l'ancienne
   version vient d'écrire. (La garde 4 l'arrêterait aussi, mais on ne compte
   pas sur la ceinture quand on a les bretelles.)
4. ✋ Reprendre le projet Vercel `groupe-nexus` (même déploiement qu'avant).
5. ✋ Twilio, expéditeurs de leads → `https://groupe-nexus.vercel.app/...` ;
   réactiver le workflow n8n `cron-crm.json`. L'URI Google d'origine est
   toujours enregistrée.
6. Essai : connexion, une fiche, un appel, un texto.

Revenir ensuite vers le VPS = refaire la bascule (section 6) à partir de
l'étape 2, en retirant `DISABLED`.

## 8. Pendant la période de repli : gel du schéma

Toute modification de `src/db/schema*.ts` doit être appliquée **aux deux
bases** avant que le code qui l'attend ne soit déployé : nouvelle base par une
migration (portail / `sb apply`), ancienne par `psql` sur le pooler session
(voir `drizzle/README.md`). Tant que les deux divergent, la copie inverse
refuse (garde 3) — c'est voulu : un retour arrière vers une base au mauvais
schéma casserait l'ancienne version.

Et `main` ne déploie plus rien tout seul : Vercel est en pause, le VPS se met
à jour par la section 4.

## 9. Fin de la période de repli

Quand la nouvelle version a tenu 2 à 4 semaines : arrêter et désactiver le
timer, garder une dernière sauvegarde de l'ancienne base, puis — décision de
l'exploitant — mettre en pause le projet Supabase cloud et supprimer le projet
Vercel.
