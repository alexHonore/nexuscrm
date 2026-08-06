# Passerelle vocale Groupe Nexus (voip.ms ⇄ téléphones web)

Ce dossier contient tout le nécessaire pour monter la **passerelle vocale**
du CRM : elle permet aux téléphonistes d'appeler et de recevoir des appels
**directement dans leur fureteur** (ordinateur ou cellulaire), sans logiciel
à installer.

Pourquoi une passerelle? Les fureteurs ne savent pas parler le SIP
« classique » (UDP) utilisé par voip.ms. Ils parlent SIP **sur WebSocket
sécurisé (WSS)** avec du média chiffré (DTLS-SRTP). La passerelle traduit
entre les deux mondes.

**Scénario visé par ce guide : le KVM Hostinger existant qui héberge déjà
n8n.** Ce serveur fait déjà tourner la pile n8n officielle avec **Traefik**
lié aux ports 80/443 (conteneurs typiques : `root-traefik-1`, `root-n8n-1`).
On n'installe **aucun autre serveur web** : le Traefik existant termine le
TLS (certificats Let's Encrypt compris) et route deux chemins du domaine
`voice.<votre-domaine>` vers la passerelle. La voix (RTP), elle, **ne passe
jamais par Traefik** : elle va directement de la machine à voip.ms.

```
Téléphone web (CRM, JsSIP)              KVM HOSTINGER (n8n + passerelle)                voip.ms
┌───────────────────────┐          ┌────────────────────────────────────────┐
│ wss://voice.<dom>/ws  │──443────►│ TRAEFIK (existant, pile n8n)           │
│ https://.../voipms-api│          │   /ws ────► ws-bridge ─► Kamailio:5066 │──UDP 5060──► SIP
│                       │          │   /voipms-api ────────► api-proxy:8080 │
│ DTLS-SRTP (média)     │◄────────►│ rtpengine (réseau hôte, UDP)           │◄──RTP──────► RTP
└───────────────────────┘ 23000-   │ n8n : continue de tourner, inchangé    │
                          33000    └────────────────────────────────────────┘
```

Chaque téléphoniste possède son **sous-compte voip.ms** : son fureteur
s'enregistre *à travers* la passerelle directement auprès de voip.ms avec ses
propres identifiants (la passerelle est un mandataire transparent, elle ne
stocke aucun mot de passe). Les appels entrants sur son numéro (DID)
reviennent par le même chemin jusqu'à son fureteur.

La passerelle héberge aussi le **relais API voip.ms** : l'API de voip.ms
n'accepte que des adresses IP autorisées; comme Vercel n'a pas d'IP fixe, le
CRM passe par `https://voice.<domaine>/voipms-api` (protégé par un jeton
secret).

> Détail technique utile à comprendre une seule fois : Traefik termine le TLS,
> donc Kamailio reçoit du WebSocket **en clair** sur son port interne 5066
> (« déchargement TLS », pris en charge nativement — Traefik fait la mise à
> niveau WebSocket lui-même). Kamailio « annonce » (advertise) l'adresse
> publique dans ses en-têtes SIP pour que tout reste cohérent. Le port 5066
> n'est jamais exposé à Internet : seuls les conteneurs Docker peuvent le
> joindre.

---

## 1. Prérequis

- Le **KVM Hostinger** (Ubuntu) avec la pile n8n déjà fonctionnelle
  (Traefik répond sur les ports 80/443). Prendre en note son **adresse IPv4
  publique** (visible dans hPanel, ou `curl -4 ifconfig.me` sur le serveur).
- Un accès SSH root au serveur.
- Le domaine de l'entreprise, géré chez Hostinger (ou ailleurs).

Ressources : la passerelle est légère (quelques dizaines de Mo de RAM par
service) — elle cohabite sans problème avec n8n sur un KVM 4 Go et plus.

## 2. Créer l'enregistrement DNS

Dans **hPanel Hostinger → Domaines → Zone DNS** (ou chez votre registraire) :

```
Type   : A
Nom    : voice                (donnera voice.votre-domaine.com)
Valeur : <IPv4 publique du KVM>
TTL    : 300
```

Important : un enregistrement **A direct, sans proxy/CDN** (pas de Cloudflare
« nuage orange » — le WebSocket SIP et Let's Encrypt doivent joindre la
machine directement).

Attendre quelques minutes et vérifier :

```bash
dig +short voice.votre-domaine.com    # doit afficher l'IPv4 du KVM
```

## 3. Installer la passerelle

Copier ce dossier `gateway/` sur le KVM puis lancer le script :

```bash
# depuis votre ordinateur :
scp -r gateway/ root@IP_DU_KVM:/opt/nexus-gateway

# sur le KVM :
ssh root@IP_DU_KVM
cd /opt/nexus-gateway
chmod +x setup.sh
sudo ./setup.sh
```

Le script :

1. vérifie Docker (déjà présent pour n8n) et installe `sngrep` (outil de test);
2. **détecte votre Traefik** : son réseau Docker (`TRAEFIK_NETWORK`, en
   général `root_default` quand la pile n8n est dans `/root`), son entrypoint
   HTTPS (`websecure`) et son résolveur de certificats (`mytlschallenge`) —
   il propose ces valeurs et vous n'avez qu'à appuyer sur Entrée;
3. détecte l'IP publique et pose 2-3 questions (domaine, jeton — Entrée pour
   générer le jeton automatiquement), puis écrit `.env`;
4. ajuste le pare-feu ufw : **seulement 5060/udp et 23000-33000/udp**
   (80/443 sont déjà gérés par Traefik). Il n'active jamais ufw s'il est
   inactif, pour ne rien casser;
5. démarre les services (`docker compose up -d`) et vérifie que Traefik a
   bien créé les routes;
6. affiche les valeurs à copier dans Vercel.

Il est **relançable sans danger** (par exemple si le DNS n'était pas encore
propagé). **Rien n'est modifié dans la pile n8n** : ni son docker-compose, ni
sa configuration Traefik — la passerelle se déclare par simples étiquettes
(labels) Docker que Traefik découvre tout seul.

Ports réellement ouverts en plus pour la passerelle :

| Port | Usage |
| --- | --- |
| 5060/udp | Signalisation SIP directe avec voip.ms |
| 23000-33000/udp | Audio (RTP, rtpengine) |
| 5066/tcp | WebSocket interne Kamailio — **autorisé uniquement depuis les sous-réseaux Docker**, jamais depuis Internet |

> Si votre pare-feu est géré dans hPanel Hostinger (ou un pare-feu cloud),
> ouvrez-y aussi 5060/udp et 23000-33000/udp en entrée.

## 4. Vérifier que Traefik a pris la relève

Depuis n'importe quel ordinateur :

```bash
curl https://voice.votre-domaine.com/voipms-api/healthz
# -> ok
```

(Notez le chemin : la sonde de vie est **sous** `/voipms-api/healthz` — c'est
Traefik qui retire le préfixe avant de transmettre au relais.)

Si ça répond `ok` : le certificat est émis, la route API fonctionne, et la
route WebSocket `/ws` est déclarée par le même mécanisme. Pour aller plus
loin :

```bash
# Sur le KVM — Traefik a-t-il vu les deux routeurs « nexus-... » ?
docker logs root-traefik-1 2>&1 | grep -i nexus

# Les services de la passerelle tournent-ils ?
cd /opt/nexus-gateway && docker compose ps
```

## 5. Configurer voip.ms

Rien ne change par rapport à une installation classique. Dans le portail
[voip.ms](https://voip.ms) :

1. **Sous-comptes** (Sub Accounts → Create Sub Account) — un par téléphoniste :
   - Protocol : **SIP**
   - Authentication type : **User/Password** (retenir l'usager complet, de la
     forme `123456_alex`, et le mot de passe : ils seront saisis dans le CRM,
     panneau admin, fiche de l'utilisateur)
   - Device type : ATA / IP Phone / Softphone
   - **NAT : yes** (important — c'est ce qui fait que voip.ms renvoie les
     appels entrants vers la passerelle)
   - Allowed codecs : **ulaw** en premier, plus **opus** s'il est proposé
     (g729 facultatif)
   - DTMF : auto ; Lock international : au goût du courtier
   - *(Le CRM peut aussi créer les sous-comptes automatiquement via l'API —
     module admin — une fois le relais API branché.)*
2. **POP / serveur** : utiliser le POP de **Montréal** (ex. `montreal.voip.ms`
   — le portail affiche la liste à jour). C'est ce nom de serveur que le CRM
   utilise dans la configuration du téléphone web. La passerelle relaie vers
   n'importe quel serveur `*.voip.ms`, donc changer de POP ne demande aucune
   modification sur le serveur.
3. **API** (Main Menu → SOAP and REST/JSON API) :
   - Activer l'API, définir le mot de passe API;
   - **Enable IP Address : l'IPv4 publique du KVM** (c'est elle qui parle à
     l'API via le relais).
4. **Numéros (DID)** : DID Numbers → Manage → Edit DID → Routing →
   **SIP/IAX : le sous-compte du ou de la téléphoniste**. Chaque appel entrant
   sur ce numéro sonnera alors dans son fureteur.
   - Conseil : régler aussi « CallerID Number » du sous-compte au DID de la
     personne pour que ses appels sortants affichent son numéro.

## 6. Configurer le CRM (Vercel)

Dans les variables d'environnement du projet Vercel (le script les affiche à
la fin de l'installation) :

```bash
# Téléphone web (fureteur -> Traefik -> passerelle)
NEXT_PUBLIC_SIP_WSS_URL=wss://voice.votre-domaine.com/ws

# Relais API voip.ms (Vercel -> Traefik -> passerelle -> voip.ms)
VOIPMS_API_PROXY_URL=https://voice.votre-domaine.com/voipms-api
VOIPMS_API_PROXY_TOKEN=<le jeton affiché à la fin de setup.sh — aussi dans /opt/nexus-gateway/.env>

# Identifiants API voip.ms (restent sur Vercel, jamais sur le serveur)
VOIPMS_API_USERNAME=<courriel du compte voip.ms>
VOIP_MS_API_PASSWORD=<mot de passe API>
```

Notez le changement par rapport à l'ancien mode : l'URL WSS est en **443
standard avec le chemin `/ws`** (plus de port 8443). Redéployer le CRM après
modification.

## 7. Procédure de test

Dans l'ordre — chaque étape valide une couche de plus :

1. **Relais API** : `https://voice.votre-domaine.com/voipms-api/healthz` →
   doit afficher `ok`. Puis, dans le CRM admin, la page téléphonie doit
   réussir à lister les sous-comptes (cela traverse Vercel → Traefik →
   passerelle → voip.ms).
2. **Connexion WSS** : ouvrir le CRM, activer le téléphone web, puis dans la
   console du fureteur (F12) vérifier :
   - la connexion `wss://voice.../ws` passe à l'état *open* (aucune erreur
     de certificat) ;
   - JsSIP affiche `registered` (sinon : voir Dépannage, erreur 401).
3. **Sur le KVM, observer la signalisation** (très pratique) :
   ```bash
   sngrep -d any port 5060 or port 5066
   ```
   On doit voir le `REGISTER` sortir vers voip.ms et recevoir `200 OK`.
4. **Test d'écho (audio bidirectionnel)** : depuis le téléphone web, composer
   **4443** (numéro de test d'écho voip.ms). Parler : on doit s'entendre avec
   un léger délai. Si on s'entend → le chemin média complet (DTLS-SRTP ⇄ RTP)
   fonctionne dans les deux sens.
5. **Appel sortant réel** : appeler son propre cellulaire; vérifier l'audio
   dans les deux sens et l'afficheur (CallerID).
6. **Appel entrant** : appeler le DID depuis un cellulaire → le téléphone web
   doit sonner dans le CRM. Répondre et vérifier l'audio dans les deux sens.
   *(C'est le test le plus important : il valide le retour des INVITE de
   voip.ms vers le fureteur — voir « Limites connues » ci-dessous.)*
7. Recommencer les tests 4-6 depuis un **cellulaire sur réseau mobile**
   (LTE/5G, pas le wifi) : c'est le cas réel des téléphonistes.
8. Bonus : vérifier que **n8n répond toujours** normalement sur son domaine —
   il n'y a aucune raison que non, la passerelle n'y touche pas.

## 8. Dépannage

| Symptôme | Cause probable | Vérification / correctif |
| --- | --- | --- |
| `curl .../voipms-api/healthz` → erreur de connexion ou 404 « page inconnue » | Traefik n'a pas créé les routeurs | `docker logs root-traefik-1 2>&1 \| grep -i nexus` ; le conteneur `nexus-api-proxy` est-il sur le bon réseau ? (`TRAEFIK_NETWORK` dans `.env` = réseau du conteneur Traefik, vérifier avec `docker inspect root-traefik-1` et `docker network ls`) ; relancer `docker compose up -d` |
| 404 de Traefik alors que les routeurs existent | Règle Host ne correspond pas | Le DNS `voice...` pointe-t-il vers le KVM ? `DOMAIN` dans `.env` = le nom exact tapé dans le fureteur ; entrypoint correct (`TRAEFIK_ENTRYPOINT`, gabarit n8n : `websecure`) |
| Erreur de certificat TLS sur `voice...` | Résolveur de certificats mal nommé ou DNS pas propagé | `TRAEFIK_CERTRESOLVER` dans `.env` = nom réel chez Traefik (gabarit n8n : `mytlschallenge`, vérifier : `docker inspect root-traefik-1 \| grep -i certificatesresolvers`) ; `dig +short voice...` ; `docker logs root-traefik-1 \| grep -i acme` |
| La connexion `wss://.../ws` échoue (la mise à niveau WebSocket ne se fait pas) | Chaîne Traefik → ws-bridge → Kamailio rompue | `docker compose logs ws-bridge` (socat démarre ?) ; `docker compose logs kamailio` (le xhttp reçoit-il la poignée de main ? chercher `xhttp`) ; sur le KVM : `curl -i http://127.0.0.1:5066` doit répondre du Kamailio (404/403, pas « connexion refusée ») ; pare-feu : le port 5066 doit être joignable depuis le sous-réseau Docker (règle ufw posée par setup.sh) |
| `wss` se connecte mais se coupe après ~1 min | Interception par un proxy d'entreprise, ou keepalive | Tester sur un autre réseau ; les Ping WebSocket sont envoyés toutes les 60 s par la passerelle et traversent Traefik sans problème |
| `REGISTER` refusé **401/403** en boucle | Mauvais identifiants du sous-compte, ou compte bloqué | Revalider usager (`123456_alex`) et mot de passe SIP dans la fiche utilisateur du CRM ; tester le sous-compte avec un softphone (Zoiper) en direct ; vérifier que le POP choisi est actif |
| Audio dans un seul sens (ou aucun) | rtpengine annonce la mauvaise IP ou ports RTP bloqués | `RTP_INTERFACE` dans `.env` = IPv4 publique du KVM ; pare-feu 23000-33000/udp ouvert (ufw **et** hPanel le cas échéant) ; `docker compose logs rtpengine` (chercher les adresses annoncées dans le SDP) |
| Appels sortants OK, mais les appels entrants ne sonnent pas | Routage DID, ou perte du lien enregistrement→fureteur | DID routé vers le bon sous-compte ? `sngrep` sur le KVM : l'INVITE de voip.ms arrive-t-il sur 5060 ? S'il arrive mais répond 404 → voir « Limites connues / Plan B » |
| Le CRM n'arrive pas à parler à l'API voip.ms | IP non autorisée ou jeton différent | L'IPv4 du KVM est bien dans « Enable IP Address » chez voip.ms ; `VOIPMS_API_PROXY_TOKEN` (Vercel) = `PROXY_TOKEN` (`.env` du KVM) ; test direct : `curl -H "x-proxy-token: <jeton>" "https://voice.../voipms-api?method=getBalance&api_username=...&api_password=...&content_type=json"` |
| Écho ou coupures d'audio | Réseau du téléphoniste | Tester en filaire/LTE ; le POP Montréal ; codecs ulaw/opus |
| n8n ne répond plus après l'installation | (Ne devrait pas arriver : rien n'est modifié chez n8n) | `docker ps` : `root-traefik-1` et `root-n8n-1` tournent ? `docker compose -f /root/docker-compose.yml up -d` dans le dossier de n8n ; la passerelle n'occupe ni 80 ni 443 |

Commandes utiles sur le KVM :

```bash
cd /opt/nexus-gateway
docker compose ps                        # état des services de la passerelle
docker compose run --rm --no-deps --entrypoint "kamailio -c" kamailio   # valider la syntaxe de kamailio.cfg
docker compose logs -f kamailio          # signalisation SIP
docker compose logs -f rtpengine         # média
docker compose logs -f ws-bridge         # pont Traefik -> Kamailio
sngrep -d any port 5060 or port 5066     # visualiser les échanges SIP en direct
docker compose exec kamailio kamcmd -s unix:/tmp/kamailio_ctl ws.dump   # connexions WebSocket actives
docker compose exec kamailio kamcmd -s unix:/tmp/kamailio_ctl htable.dump wsconn  # table usager->connexion
docker logs root-traefik-1 2>&1 | grep -i nexus   # routeurs Traefik de la passerelle
```

## 9. Coexistence avec n8n

- **Rien ne change pour n8n** : la passerelle n'a modifié ni son
  docker-compose, ni sa configuration Traefik, ni ses certificats. Elle se
  contente de rejoindre le réseau Docker existant et de se déclarer par
  étiquettes ; Traefik la découvre automatiquement.
- Les deux applications servent des **domaines différents** (n8n sur le sien,
  la passerelle sur `voice.<domaine>`) : aucune collision de routes.
- **Ressources** : Kamailio + rtpengine + les deux petits conteneurs
  consomment ensemble ~150-250 Mo de RAM au repos et très peu de CPU (le
  média d'un appel ulaw ≈ 100 kbit/s). n8n ne verra pas la différence.
- Mise à jour de n8n (`docker compose pull` dans sa pile) : sans effet sur la
  passerelle, et réciproquement. Seul point d'attention : si vous recréez
  **complètement** la pile n8n (réseau Docker supprimé/recréé), relancez
  ensuite `docker compose up -d` dans `/opt/nexus-gateway`.

## 10. Sécurité

- **Garder `PROXY_TOKEN` secret** : il donne accès au relais API (et donc,
  combiné aux identifiants API, au compte voip.ms). Il vit dans
  `/opt/nexus-gateway/.env` (mode 600) et dans les variables Vercel. Le
  changer : modifier `.env`, `docker compose up -d api-proxy`, mettre à jour
  Vercel.
- Les identifiants API voip.ms ne sont **jamais stockés sur le serveur** :
  ils transitent seulement dans les requêtes chiffrées (HTTPS) du CRM.
- Le port WebSocket interne (5066) n'est **pas exposé à Internet** : la règle
  ufw ne l'autorise que depuis les sous-réseaux Docker. (Si ufw est inactif
  sur votre KVM, il reste protégé par le fait que rien ne le route
  publiquement — mais activer un pare-feu est recommandé; assurez-vous alors
  d'autoriser SSH d'abord.)
- La passerelle **n'est pas un relais ouvert** : les requêtes des fureteurs ne
  peuvent viser que `*.voip.ms`, et le port 5060 ne route que vers des
  téléphonistes enregistrés (sinon 404). Les scanneurs SIP connus sont
  ignorés silencieusement.
- **fail2ban (facultatif mais recommandé)** : `apt install fail2ban` puis une
  prison sur les journaux Kamailio pour bannir les IP qui insistent sur 5060.
- Resserrage possible du pare-feu : limiter 5060/udp aux serveurs voip.ms
  (`dig +short montreal.voip.ms` etc.), par exemple
  `ufw delete allow 5060/udp && ufw allow from <IP_voipms> to any port 5060 proto udp`.
  À refaire si voip.ms change ses adresses — d'où le choix « ouvert par
  défaut » ici.
- Mises à jour : `apt update && apt upgrade` régulièrement ;
  `docker compose pull && docker compose up -d` pour les images de la
  passerelle (celles de n8n se gèrent dans sa propre pile).

## 11. Limites connues et Plan B (à lire avant la mise en production)

Cette passerelle utilise la « traversée sans registrar » : le paramètre
`;alias=` ajouté au Contact à l'enregistrement permet de retrouver la
connexion WebSocket quand voip.ms renvoie un appel entrant. **voip.ms ne
prenant pas en charge l'en-tête Path (RFC 3327)**, ce mécanisme repose sur le
comportement des serveurs Asterisk de voip.ms avec `NAT=yes` :

- S'ils renvoient le Contact enregistré tel quel dans le R-URI → l'alias est
  décodé directement (cas nominal).
- S'ils réécrivent le Contact (perte de l'alias) → la passerelle retrouve la
  connexion via sa table interne (clé = usager du sous-compte **et** usager du
  Contact). C'est le filet de sécurité intégré.
- Si le R-URI de l'INVITE entrant ne contient **ni** alias **ni** un usager
  connu (par exemple seulement le numéro DID) → l'appel entrant répondrait
  404. **Ce point précis doit être validé lors du test d'appel entrant
  (étape 6 de la procédure).**

**Plan B si les appels entrants sont impossibles à fiabiliser en mode
transparent :** faire porter l'enregistrement par la passerelle elle-même,
c'est-à-dire :

1. *Mode enregistrement par la passerelle (Kamailio `uac_reg`)* : Kamailio
   s'enregistre lui-même auprès de voip.ms pour chaque sous-compte (les
   identifiants SIP seraient alors provisionnés sur la passerelle), garde en
   mémoire la correspondance sous-compte → connexion WebSocket, et joue le
   rôle de registrar local pour les fureteurs. Les INVITE entrants arrivent
   alors toujours pour un compte que Kamailio connaît.
2. *Variante encore plus simple* : passer les sous-comptes voip.ms en
   **« Static registration »** avec comme adresse l'IP de la passerelle
   (voip.ms enverra tous les INVITE au serveur sans dépendre du REGISTER), la
   passerelle gardant la correspondance sous-compte → fureteur comme en 1.

Les deux variantes demandent une évolution du fichier `kamailio/kamailio.cfg`
(module `uac`/`registrar`+`usrloc`) mais aucun changement côté CRM. Le mode
transparent (Plan A) reste préférable : aucun secret SIP sur le serveur.

Autres points honnêtes à savoir :

- **Tout ce qui touche la voix doit être validé en conditions réelles** (vrais
  cellulaires, vrai réseau mobile, vrais DID) : aucun test automatisé ne
  remplace l'étape 6.
- Le média passe en espace utilisateur (pas de module noyau rtpengine dans
  Docker) : parfait jusqu'à quelques dizaines d'appels simultanés, ce qui
  dépasse largement les besoins d'un petit centre d'appels.
- Si voip.ms impose un intervalle de réenregistrement différent, JsSIP suit
  automatiquement la valeur du `200 OK`.
- Les enregistrements d'appels, la messagerie vocale et les CDR restent gérés
  chez voip.ms (le CRM les lit par l'API via le relais).

## 12. Entretien

| Quoi | Quand | Comment |
| --- | --- | --- |
| Certificats TLS | Automatique | Gérés par le Traefik de la pile n8n (rien à faire côté passerelle) |
| Mises à jour système | 1×/mois | `apt update && apt upgrade` |
| Mises à jour des images | Au besoin | `cd /opt/nexus-gateway && docker compose pull && docker compose up -d` |
| Sauvegarde | Après tout changement | Copier `.env` (le reste du dossier est dans le dépôt Git) |
| Redémarrage complet | En dernier recours | `docker compose down && docker compose up -d` (n8n n'est pas touché) |

---

## Annexe — Mode autonome (VPS dédié avec Caddy) ⚠ ancien mode

> **N'utilisez PAS ce mode sur le KVM Hostinger qui héberge n8n** : Caddy
> entrerait en conflit avec Traefik sur les ports 80/443. Cette annexe ne
> sert que si la passerelle est déployée un jour sur un **VPS dédié** sans
> autre serveur web.

Dans ce mode, la passerelle se débrouille seule : Caddy occupe 80/443
(certificats Let's Encrypt + relais `/voipms-api`), et Kamailio termine
lui-même le TLS des fureteurs sur le port **8443** (WSS direct, variable
d'environnement `WITH_STANDALONE_TLS` définie par le fichier compose dédié).

Différences avec le mode Traefik :

| | Mode Traefik (défaut) | Mode autonome |
| --- | --- | --- |
| Fichier compose | `docker-compose.yml` | `docker-compose.standalone.yml` |
| URL du téléphone web | `wss://voice.<dom>/ws` | `wss://voice.<dom>:8443` |
| Sonde de vie API | `https://voice.<dom>/voipms-api/healthz` | `https://voice.<dom>/healthz` |
| Certificats | Traefik (rien à faire) | Caddy + `scripts/sync-certs.sh` (cron) |
| Ports à ouvrir | 5060/udp, 23000-33000/udp | 80, 443, 8443/tcp + 5060/udp, 23000-33000/udp |

Installation résumée (VPS dédié Ubuntu, dossier `/opt/nexus-gateway`) :

```bash
# 1. .env : copier .env.example et remplir DOMAIN, ACME_EMAIL, PROXY_TOKEN,
#    PUBLIC_IP, RTP_INTERFACE (l'actuel setup.sh est dédié au mode Traefik).
cp .env.example .env && nano .env && chmod 600 .env

# 2. Pare-feu : 22/tcp, 80/tcp, 443/tcp, 8443/tcp, 5060/udp, 23000:33000/udp
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 8443/tcp
ufw allow 5060/udp && ufw allow 23000:33000/udp && ufw enable

# 3. Démarrer Caddy + relais, attendre le certificat, le copier pour Kamailio
docker compose -f docker-compose.standalone.yml up -d caddy api-proxy
# ... attendre ~1 min que le certificat apparaisse dans caddy/data/... puis :
./scripts/sync-certs.sh

# 4. Tout démarrer
docker compose -f docker-compose.standalone.yml up -d

# 5. Renouvellement : cron quotidien de scripts/sync-certs.sh
cat > /etc/cron.d/nexus-gateway-certs <<'EOF'
17 4 * * * root cd /opt/nexus-gateway && ./scripts/sync-certs.sh >> /var/log/nexus-certsync.log 2>&1
EOF
```

Variables Vercel en mode autonome :

```bash
NEXT_PUBLIC_SIP_WSS_URL=wss://voice.votre-domaine.com:8443
VOIPMS_API_PROXY_URL=https://voice.votre-domaine.com/voipms-api
VOIPMS_API_PROXY_TOKEN=<jeton>
```

Le reste (voip.ms, procédure de test, limites/Plan B) est identique au corps
du guide — en remplaçant `/ws` par `:8443` et la sonde de vie par
`https://voice.<dom>/healthz`.
