# Retour arrière vers l'ancienne infrastructure — guide pour un agent IA

Revenir de **Tayoo Ops** (VPS, `https://web-nexuscrm.tayoo.app`) à **l'ancienne
version** (Vercel `groupe-nexus` + Supabase cloud `weasuzxazxjnfzxzqtsw`,
`https://groupe-nexus.vercel.app`).

À lire **en entier** avant d'agir. Complète `README.md` §7 (le runbook humain)
avec : comment savoir où l'on en est, les commandes exactes, quoi faire quand
une étape refuse, et ce qu'il ne faut jamais faire. Faits vérifiés le
2026-11-01 ; vérifier l'état réel (§2) plutôt que de les croire.

---

## 0. Règles pour l'agent

- **✋ = action vers l'extérieur** (production, Vercel, Twilio, n8n, les
  téléphonistes). La décrire à l'exploitant (Alex), attendre son « go »
  explicite, **une étape à la fois**. Un accord ne vaut que pour l'étape nommée.
- **Ne rien supprimer** : ni instance, ni base, ni sauvegarde, ni fichier, ni
  déploiement Vercel. Avant de modifier un fichier sur le VPS :
  `cp -p <fichier> <fichier>.bak-$(date -u +%Y%m%dT%H%M%SZ)`.
- **Aucune valeur secrète affichée** : jamais de `cat` de `.env`, `.env.local`,
  `app.env`, `reverse-sync.env` ou du `.env` d'une instance. Noms seulement
  (`cut -d= -f1`).
- Une commande qui transporte un secret depuis le Mac (`cat .env | ssh …`) est
  refusée par le classifieur de Claude Code : la donner à Alex, qu'il la lance
  lui-même dans son Terminal. Ne pas chercher de détour.
- Sur le VPS, ne toucher **qu'à NexusCRM** : jamais Traefik, ollama, la
  passerelle vocale (`/opt/nexus-gateway` : Kamailio, rtpengine, ws-bridge,
  api-proxy), les autres instances (`sb-maa`, `sb-tayoo`), le routeur et le
  tunnel (le Caddyfile est généré par le portail). Dans n8n, seulement
  activer / désactiver les deux workflows nommés au §1, avec le go d'Alex.
- **Au moindre doute : s'arrêter et rapporter.** Un retour arrière lent vaut
  mieux qu'une perte de données.

## 1. Repères

| | Ancienne version (repli) | Nouvelle version (Tayoo Ops) |
|---|---|---|
| Adresse | `https://groupe-nexus.vercel.app` | `https://web-nexuscrm.tayoo.app` |
| Hébergement | Vercel, équipe `table-ronde`, projet `groupe-nexus` (`prj_TDi1WQGl6gGJBVRoRHBrKJ161xio`) | conteneur `web-nexuscrm-web-1` (projet compose `web-nexuscrm`, fichier `/srv/supabase/projects/nexuscrm/website.compose.json`) |
| Base | Supabase cloud `weasuzxazxjnfzxzqtsw`, pooler session `aws-1-us-west-2.pooler.supabase.com:5432` | instance `nexuscrm` (slot 3), conteneur `sb-nexuscrm-db-1` |
| Crons n8n | workflow « Groupe Nexus CRM — crons » (`n8n/cron-crm.json`) | workflow « Groupe Nexus CRM — crons (Tayoo Ops) » (`n8n/cron-crm.tayoo-ops.json`, + notes d'appel à 11 h 45) |
| Réglages | variables Vercel (presque toutes « Sensitive » : illisibles, même par `vercel env pull`) | `/srv/supabase/apps/nexuscrm/app.env` (600) |

- **Copie inverse** (nouvelle → ancienne base, toutes les 15 min) :
  `/srv/supabase/apps/nexuscrm/reverse-sync.sh`, unités
  `nexuscrm-reverse-sync.service` / `.timer`, état dans
  `/srv/supabase/apps/nexuscrm/reverse-sync/` (`last-success`, `last-failure`,
  `sync.log`, `schema.diff`, `load.out`, et `DISABLED` = copie coupée).
- **Entrées externes** (mêmes chemins sur les deux domaines) :
  Twilio Messaging Service → `/api/webhooks/twilio/inbound` (entrant) et
  `/api/webhooks/twilio/status` (statut) ; TwiML App « Voice Request URL » →
  `/api/telephony/twiml` (seulement si la voix passe par Twilio) ; webhook de
  leads → `/api/webhooks/leads` (même clé) ; Google OAuth →
  `/api/google/callback` (l'URI d'origine reste enregistrée : rien à faire).
- ⚠️ Le **compte Supabase** propriétaire de `weasuzxazxjnfzxzqtsw` était
  inconnu au 2026-11-01. Si ce projet cloud est en pause, seul ce compte peut
  le relancer : c'est un préalable au retour arrière.

**Accès au VPS.** Depuis une session Claude Code sur le Mac d'Alex :
`ssh tayoo-vps '…'` (alias de `~/.ssh/config` + `~/.ssh/tayoo-sshproxy.py`,
qui passe par le proxy du bac à sable ; il faut `31.97.147.222` dans
`sandbox.network.allowedDomains` et la règle `Bash(ssh tayoo-vps *)` dans
`.claude/settings.local.json`). Hors bac à sable : `ssh root@31.97.147.222`.
Pour plusieurs lignes, éviter les guillemets imbriqués :
`ssh tayoo-vps 'bash -s' <<'EOF'` … `EOF`.

**Le portail et ses boutons.** Dans `ops.tayoo.app`, **Start / Stop /
Restart agissent sur l'instance ENTIÈRE (base comprise) ET sur l'app**. Pour
n'arrêter que l'app, utiliser la commande du §4.1.

## 2. D'abord : où en est-on ? (lecture seule)

```bash
ssh tayoo-vps 'bash -s' <<'EOF'
d=/srv/supabase/apps/nexuscrm
echo "timer copie inverse : $(systemctl is-enabled nexuscrm-reverse-sync.timer) / $(systemctl is-active nexuscrm-reverse-sync.timer)"
echo "DISABLED            : $([ -e $d/reverse-sync/DISABLED ] && echo présent || echo absent)"
echo "dernière copie OK   : $(cat $d/reverse-sync/last-success 2>/dev/null || echo jamais)"
echo "dernier échec       : $(cat $d/reverse-sync/last-failure 2>/dev/null || echo aucun)"
echo "app VPS             : $(docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' web-nexuscrm-web-1 2>/dev/null || echo absente)"
echo "base VPS            : $(docker inspect -f '{{.State.Status}}' sb-nexuscrm-db-1)"
grep -E '^(SMS_MODE|SMS_LIVE_CONFIRMED)=' $d/app.env
EOF
```

Puis, côté extérieur : le projet Vercel `groupe-nexus` est-il **en pause** ?
(tableau de bord, ou outil MCP Vercel `get_project`) ; lequel des deux
workflows n8n est **actif** ? (interface n8n, ou outil MCP n8n
`search_workflows`) ; où pointent les webhooks Twilio ? (console Twilio — à
demander à Alex).

| Constat | Situation | Procédure |
|---|---|---|
| Vercel actif, timer `disabled`, `SMS_MODE=dry_run` | **Avant la bascule** : l'ancienne version EST la production | §3 |
| Vercel en pause, timer `enabled`, `SMS_MODE=live` | **Après la bascule** | §4 |
| Tout autre mélange | **Bascule interrompue** | §5 |

## 3. Avant la bascule : rien à rendre

La production n'a jamais quitté Vercel ; le VPS ne fait tourner qu'un essai.

- Arrêter l'essai (✋, sans effet sur la production) : la commande du §4.1,
  rien d'autre.
- **Ne PAS lancer la copie inverse** (`reverse-sync.sh` sans option,
  `--check`, ni le service) : elle remplacerait la vraie production par les
  données de l'essai. La garde 4 devrait refuser ; on ne vérifie pas.
- Ce qui a été saisi sur l'essai n'existe **pas** en production, et la
  recopie finale de la bascule (`migrate-from-url.sh … --resync`) l'effacera
  du VPS : c'est voulu. Si c'était du vrai travail, le refaire sur
  `groupe-nexus.vercel.app`. Les écritures de l'essai sont dans `audit_logs`
  de l'instance (`docker exec sb-nexuscrm-db-1 psql -U postgres -c "select …"`).

## 4. Après la bascule : retour arrière complet (≈ 15 min)

L'ordre compte : **écritures arrêtées sur le VPS → dernière copie → copie
coupée → ancienne version rallumée → entrées externes rebranchées.**

### 4.1 ✋ Arrêter les écritures sur le VPS

L'app **seulement** : la base de l'instance doit rester allumée, la dernière
copie (§4.2) la lit.

```bash
ssh tayoo-vps 'cd /srv/supabase/projects/nexuscrm && docker compose -p web-nexuscrm -f website.compose.json stop --timeout 45; docker ps -a --filter name=web-nexuscrm --format "{{.Names}} {{.Status}}"; docker inspect -f "base : {{.State.Status}}" sb-nexuscrm-db-1'
```

Attendu : `web-nexuscrm-web-1 Exited …` et `base : running`. L'app reste
arrêtée même après un redémarrage du serveur (`restart: unless-stopped`).

⚠️ Pas « Stop » du portail : il arrête aussi la base. Si c'est déjà fait,
rallumer **la base seule** (l'instance, sans l'app) :
`ssh tayoo-vps 'cd /srv/supabase/projects/nexuscrm && docker compose up -d --wait --wait-timeout 180'`.

Puis ✋ désactiver le workflow n8n « Groupe Nexus CRM — crons (Tayoo Ops) ».

### 4.2 Dernière copie nouvelle → ancienne

```bash
ssh tayoo-vps 'systemctl start nexuscrm-reverse-sync.service; echo "code : $?"; cat /srv/supabase/apps/nexuscrm/reverse-sync/last-success; journalctl -u nexuscrm-reverse-sync -n 30 --no-pager'
```

`last-success` doit dater de **maintenant** (UTC). S'il refuse : **ne pas
forcer, ne pas modifier le script ni ses gardes.** Lire
`reverse-sync/last-failure` et le code de sortie
(`/srv/supabase/apps/nexuscrm/reverse-sync.sh` sans le service donne le code
directement) :

| Code | Motif | Que faire |
|---|---|---|
| 2 | configuration (`reverse-sync.env` absent ou pas en 600, URL sans la référence attendue) | corriger la conf ; ne jamais retirer la garde de référence |
| 0 + « DÉSACTIVÉ » dans `sync.log` | `DISABLED` déjà posé | quelqu'un a déjà coupé la copie : demander à Alex avant tout |
| 3 ou 5 | lecture impossible | base VPS arrêtée (voir §4.1) ou ancienne base injoignable (projet cloud en pause ? réseau ?) |
| 4 | schémas différents | lire `reverse-sync/schema.diff` ; seule issue : appliquer à l'ANCIENNE base la migration qui lui manque (pooler session, voir `drizzle/README.md`) avec le go d'Alex, puis relancer. Jamais modifier le VPS pour « égaliser ». |
| 6 | l'ancienne base a des écritures que le VPS n'a pas | l'ancienne version a servi (Vercel repris trop tôt ? ancien workflow n8n actif ?). Arrêter, rapporter : copier effacerait ces écritures. Alex décide. |
| 7 ou 8 | `pg_dump` / préparation | lire `sync.log` ; une seule nouvelle tentative ; rapporter |
| 9 | chargement refusé (`ROLLBACK`, ancienne base inchangée) | lire `reverse-sync/load.out` ; rapporter |

Si la copie ne passe pas, l'ancienne base est dans l'état de `last-success`
(normalement moins de 15 min avant l'incident). Alex peut décider de revenir
quand même en perdant ce qui a été écrit depuis : le lui chiffrer d'abord, en
lecture seule sur le VPS (par exemple `select action, count(*) from audit_logs
where created_at > '<last-success>' group by 1`).

### 4.3 Couper la copie pour de bon — AVANT de rallumer l'ancienne version

```bash
ssh tayoo-vps 'touch /srv/supabase/apps/nexuscrm/reverse-sync/DISABLED && systemctl disable --now nexuscrm-reverse-sync.timer; systemctl is-enabled nexuscrm-reverse-sync.timer; ls /srv/supabase/apps/nexuscrm/reverse-sync/'
```

Attendu : `disabled` et `DISABLED` dans la liste. Une copie qui repasserait
après la reprise effacerait ce que l'ancienne version vient d'écrire.

### 4.4 ✋ Rallumer l'ancienne version

Reprendre le projet Vercel `groupe-nexus` (tableau de bord → reprendre le
projet, ou outil MCP Vercel `unpause_project`). **Même déploiement**, ne pas
redéployer. Ses crons Vercel (`vercel.json`) reprennent avec lui. Si le
projet Supabase cloud est en pause, le relancer d'abord (voir §1).

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://groupe-nexus.vercel.app/login   # 200 attendu
```

### 4.5 ✋ Rebrancher les entrées externes vers `https://groupe-nexus.vercel.app`

- Twilio : Messaging Service → entrant `…/api/webhooks/twilio/inbound`,
  statut `…/api/webhooks/twilio/status` ; TwiML App → `…/api/telephony/twiml`
  si elle avait été changée ; tout numéro qui pointait directement vers le VPS.
- Expéditeurs de leads → `…/api/webhooks/leads` (même clé).
- n8n : activer « Groupe Nexus CRM — crons » (il porte le `CRON_SECRET` de
  Vercel, différent de celui du VPS) et vérifier que « … (Tayoo Ops) » est
  bien inactif.
- Google OAuth : rien, l'URI d'origine est toujours enregistrée.

### 4.6 Essai

Sur `groupe-nexus.vercel.app` : connexion ; une fiche client ; une donnée
modifiée sur le VPS juste avant l'incident est bien là (preuve que la dernière
copie a marché) ; un appel ; un texto reçu et un envoyé ; une notification ;
`/admin/audit` montre la connexion.

### 4.7 Ensuite

- Prévenir les téléphonistes : retour à `https://groupe-nexus.vercel.app` ;
  l'ancienne app (PWA) refonctionne si elle est encore installée ; réactiver
  les notifications sur cette adresse s'ils les avaient retirées.
- VPS : laisser l'app arrêtée, **garder l'instance et ses données** (point de
  reprise). Remettre `SMS_MODE=dry_run` et retirer `SMS_LIVE_CONFIRMED` dans
  `app.env` (sauvegarde d'abord) pour qu'un redémarrage accidentel n'envoie
  rien — sans redémarrer l'app pour autant.
- Laisser `DISABLED` en place. Écrire pour Alex : date, cause, heure de la
  dernière copie réussie, ce qui a été perdu s'il y a lieu.

## 5. Bascule interrompue (état mixte)

Question unique : **quelle base a reçu les dernières écritures réelles ?**

- **Personne n'a encore écrit sur le VPS** (SMS encore en `dry_run`, Twilio
  et leads pas rebranchés, téléphonistes pas prévenus) : l'ancienne base est
  toujours la vérité. Arrêter l'app VPS (§4.1), reprendre Vercel s'il est en
  pause, réactiver l'ancien workflow n8n, remettre Twilio s'il a été changé.
  **Pas de copie inverse.** Poser `DISABLED` et désactiver le timer (§4.3)
  s'il avait été activé.
- **Des écritures réelles sont arrivées sur le VPS** : c'est un retour
  arrière complet (§4), dernière copie comprise.
- Ne jamais lancer `migrate-from-url.sh … --resync` (ancienne → nouvelle)
  quand des écritures réelles sont sur le VPS : il vide la base du VPS avant
  de la recopier.

## 6. Ne jamais

- Lancer `reverse-sync.sh` (sans option), `--check` ou le service pendant que
  l'ancienne version tourne : la production serait écrasée.
- Retirer `DISABLED` ou réactiver le timer après un retour arrière, sauf dans
  une nouvelle bascule (`README.md` §6).
- Supprimer l'instance `nexuscrm`, le projet Vercel, le projet Supabase cloud,
  une sauvegarde ou un déploiement.
- Toucher aux gardes de `reverse-sync.sh`, ou corriger un écart de schéma en
  modifiant le VPS.
- Afficher un secret, ou faire passer soi-même un `.env` par `ssh`.

## 7. Revenir ensuite vers le VPS

C'est une nouvelle bascule : `README.md` §6 à partir de l'étape 2, en
retirant d'abord `DISABLED`.
