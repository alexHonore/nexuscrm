# Passerelle vocale Groupe Nexus (voip.ms ⇄ téléphones web)

Ce dossier contient tout le nécessaire pour monter la **passerelle vocale**
du CRM : un petit serveur (VPS) qui permet aux téléphonistes d'appeler et de
recevoir des appels **directement dans leur fureteur** (ordinateur ou
cellulaire), sans logiciel à installer.

Pourquoi une passerelle? Les fureteurs ne savent pas parler le SIP
« classique » (UDP) utilisé par voip.ms. Ils parlent SIP **sur WebSocket
sécurisé (WSS)** avec du média chiffré (DTLS-SRTP). La passerelle traduit
entre les deux mondes :

```
Téléphone web (CRM, JsSIP)                 PASSERELLE (ce VPS)                    voip.ms
┌───────────────────────┐   WSS 8443    ┌──────────────────────┐   UDP 5060   ┌─────────┐
│  SIP sur WebSocket    │──────────────►│  Kamailio (signal.)  │─────────────►│  SIP    │
│  DTLS-SRTP (média)    │◄─────────────►│  rtpengine (média)   │◄────────────►│  RTP    │
└───────────────────────┘  UDP 23000-   └──────────────────────┘              └─────────┘
                           33000        + Caddy (certificats HTTPS)
                                        + api-proxy (relais API voip.ms, IP fixe)
```

Chaque téléphoniste possède son **sous-compte voip.ms** : son fureteur
s'enregistre *à travers* la passerelle directement auprès de voip.ms avec ses
propres identifiants (la passerelle est un mandataire transparent, elle ne
stocke aucun mot de passe). Les appels entrants sur son numéro (DID)
reviennent par le même chemin jusqu'à son fureteur.

La passerelle héberge aussi le **relais API voip.ms** : l'API de voip.ms
n'accepte que des adresses IP autorisées; comme Vercel n'a pas d'IP fixe, le
CRM passe par `https://<domaine>/voipms-api` (protégé par un jeton secret).

---

## 1. Louer un serveur virtuel (VPS)

N'importe quel VPS Linux proche de Montréal convient :

| Fournisseur | Offre suggérée | Prix approximatif |
| --- | --- | --- |
| OVH (Montréal / Beauharnois) | VPS 2 vCPU / 4 Go (le 2 Go convient aussi) | 8-12 $/mois |
| DigitalOcean (Toronto) | Droplet Basic 2 Go | ~12 $ US/mois |

Recommandations :

- **Ubuntu 24.04 LTS**, 2 Go de RAM ou plus, IPv4 publique dédiée.
- Choisir la région **Montréal ou Toronto** (latence minimale vers le POP
  Montréal de voip.ms et vers les téléphonistes au Québec).
- Prendre en note l'**adresse IP publique** du serveur.

## 2. Créer l'enregistrement DNS

Chez votre registraire (là où le domaine est géré), créer un enregistrement :

```
Type : A
Nom  : voice            (donnera voice.votre-domaine.com)
Valeur : <IP publique du VPS>
TTL  : 300
```

Attendre quelques minutes et vérifier :

```bash
dig +short voice.votre-domaine.com    # doit afficher l'IP du VPS
```

## 3. Installer la passerelle

Copier ce dossier `gateway/` sur le VPS puis lancer le script :

```bash
# depuis votre ordinateur :
scp -r gateway/ root@IP_DU_VPS:/opt/nexus-gateway

# sur le VPS :
ssh root@IP_DU_VPS
cd /opt/nexus-gateway
chmod +x setup.sh scripts/sync-certs.sh
sudo ./setup.sh
```

Le script pose 3-4 questions (domaine, courriel, jeton — appuyez sur Entrée
pour générer le jeton automatiquement) puis fait tout le reste : Docker,
pare-feu, certificat Let's Encrypt, démarrage des services, tâche cron de
renouvellement. Il est **relançable sans danger** si quelque chose échoue
(par exemple si le DNS n'était pas encore propagé).

Ports ouverts par le script :

| Port | Usage |
| --- | --- |
| 22/tcp | SSH |
| 80/tcp + 443/tcp | Certificats Let's Encrypt + relais API voip.ms (Caddy) |
| 8443/tcp | Téléphones web (SIP sur WSS) |
| 5060/udp | Signalisation SIP avec voip.ms |
| 23000-33000/udp | Audio (RTP, rtpengine) |

> Note : le port 5060/udp est exposé à Internet (nécessaire pour recevoir les
> appels entrants de voip.ms). La configuration rejette tout ce qui ne
> concerne pas voip.ms ou un téléphoniste enregistré, mais pour resserrer
> davantage, on peut restreindre la règle ufw aux adresses des serveurs
> voip.ms (voir la section Sécurité).

## 4. Configurer voip.ms

Dans le portail [voip.ms](https://voip.ms) :

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
   modification sur le VPS.
3. **API** (Main Menu → SOAP and REST/JSON API) :
   - Activer l'API, définir le mot de passe API;
   - **Enable IP Address : l'IP publique du VPS** (c'est elle qui parle à
     l'API via le relais).
4. **Numéros (DID)** : DID Numbers → Manage → Edit DID → Routing →
   **SIP/IAX : le sous-compte du ou de la téléphoniste**. Chaque appel entrant
   sur ce numéro sonnera alors dans son fureteur.
   - Conseil : régler aussi « CallerID Number » du sous-compte au DID de la
     personne pour que ses appels sortants affichent son numéro.

## 5. Configurer le CRM (Vercel)

Dans les variables d'environnement du projet Vercel :

```bash
# Téléphone web (fureteur -> passerelle)
NEXT_PUBLIC_SIP_WSS_URL=wss://voice.votre-domaine.com:8443

# Relais API voip.ms (Vercel -> passerelle -> voip.ms)
VOIPMS_API_PROXY_URL=https://voice.votre-domaine.com/voipms-api
VOIPMS_API_PROXY_TOKEN=<le jeton affiché à la fin de setup.sh — aussi dans /opt/nexus-gateway/.env>

# Identifiants API voip.ms (restent sur Vercel, jamais sur le VPS)
VOIPMS_API_USERNAME=<courriel du compte voip.ms>
VOIP_MS_API_PASSWORD=<mot de passe API>
```

Redéployer le CRM après modification.

## 6. Procédure de test

Dans l'ordre — chaque étape valide une couche de plus :

1. **Relais API** : ouvrir `https://voice.votre-domaine.com/healthz` → doit
   afficher `ok`. Puis, dans le CRM admin, la page téléphonie doit réussir à
   lister les sous-comptes (cela traverse Vercel → passerelle → voip.ms).
2. **Connexion WSS** : ouvrir le CRM, activer le téléphone web, puis dans la
   console du fureteur (F12) vérifier :
   - la connexion `wss://voice...:8443` passe à l'état *open* (aucune erreur
     de certificat) ;
   - JsSIP affiche `registered` (sinon : voir Dépannage, erreur 401).
3. **Sur le VPS, observer la signalisation** (très pratique) :
   ```bash
   sngrep -d any port 5060 or port 8443
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

## 7. Dépannage

| Symptôme | Cause probable | Vérification / correctif |
| --- | --- | --- |
| Audio dans un seul sens (ou aucun) | Interface média mal configurée ou ports RTP bloqués | `RTP_INTERFACE` dans `.env` = IP publique du VPS ; pare-feu 23000-33000/udp ouvert ; `docker compose logs rtpengine` (chercher les adresses annoncées) ; sur AWS/GCP, forme `privée!publique` |
| `REGISTER` refusé **401/403** en boucle | Mauvais identifiants du sous-compte, ou compte bloqué | Revalider usager (`123456_alex`) et mot de passe SIP dans la fiche utilisateur du CRM ; tester le sous-compte avec un softphone (Zoiper) en direct ; vérifier que le POP choisi est actif |
| La connexion `wss://` échoue tout de suite | Certificat absent/expiré ou port 8443 fermé | `https://voice...:8443` dans le fureteur (une erreur TLS est visible) ; `./scripts/sync-certs.sh` ; `docker compose logs caddy kamailio` ; ufw 8443/tcp |
| `wss` se connecte mais se coupe après ~1 min | Interception par un proxy d'entreprise, ou keepalive | Tester sur un autre réseau ; les Ping WebSocket sont envoyés toutes les 60 s par la passerelle |
| Appels sortants OK, mais les appels entrants ne sonnent pas | Routage DID, ou perte du lien enregistrement→fureteur | DID routé vers le bon sous-compte ? `sngrep` sur le VPS : l'INVITE de voip.ms arrive-t-il ? S'il arrive mais répond 404 → voir « Limites connues / Plan B » |
| Le CRM n'arrive pas à parler à l'API voip.ms | IP non autorisée ou jeton différent | L'IP du VPS est bien dans « Enable IP Address » chez voip.ms ; `VOIPMS_API_PROXY_TOKEN` (Vercel) = `PROXY_TOKEN` (`.env` du VPS) ; `curl -H "x-proxy-token: <jeton>" "https://voice...:443/voipms-api?method=getBalance&api_username=...&api_password=...&content_type=json"` |
| Écho ou coupures d'audio | Réseau du téléphoniste | Tester en filaire/LTE ; le POP Montréal ; codecs ulaw/opus |
| Plus rien ne marche après ~60-90 jours | Renouvellement de certificat non appliqué | `./scripts/sync-certs.sh` à la main ; vérifier `/etc/cron.d/nexus-gateway-certs` et `/var/log/nexus-certsync.log` |

Commandes utiles sur le VPS :

```bash
docker compose ps                        # état des services
docker compose run --rm --no-deps --entrypoint "kamailio -c" kamailio   # valider la syntaxe de kamailio.cfg
docker compose logs -f kamailio          # signalisation SIP
docker compose logs -f rtpengine         # média
sngrep -d any port 5060 or port 8443     # visualiser les échanges SIP en direct
docker compose exec kamailio kamcmd -s unix:/tmp/kamailio_ctl ws.dump   # connexions WebSocket actives
docker compose exec kamailio kamcmd -s unix:/tmp/kamailio_ctl htable.dump wsconn  # table usager->connexion
```

## 8. Sécurité

- **Garder `PROXY_TOKEN` secret** : il donne accès au relais API (et donc,
  combiné aux identifiants API, au compte voip.ms). Il vit dans
  `/opt/nexus-gateway/.env` (mode 600) et dans les variables Vercel. Le
  changer : modifier `.env`, `docker compose up -d api-proxy`, mettre à jour
  Vercel.
- Les identifiants API voip.ms ne sont **jamais stockés sur le VPS** : ils
  transitent seulement dans les requêtes chiffrées (HTTPS) du CRM.
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
  `docker compose pull && docker compose up -d` pour les images.

## 9. Limites connues et Plan B (à lire avant la mise en production)

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
   (voip.ms enverra tous les INVITE au VPS sans dépendre du REGISTER), la
   passerelle gardant la correspondance sous-compte → fureteur comme en 1.

Les deux variantes demandent une évolution du fichier `kamailio/kamailio.cfg`
(module `uac`/`registrar`+`usrloc`) mais aucun changement côté CRM. Le mode
transparent (Plan A) reste préférable : aucun secret SIP sur le VPS.

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

## 10. Entretien

| Quoi | Quand | Comment |
| --- | --- | --- |
| Certificats TLS | Automatique (cron 4 h 17) | Vérifier `/var/log/nexus-certsync.log` en cas de doute |
| Mises à jour système | 1×/mois | `apt update && apt upgrade` |
| Mises à jour des images | Au besoin | `docker compose pull && docker compose up -d` |
| Sauvegarde | Après tout changement | Copier `.env` (le reste du dossier est dans le dépôt Git) |
| Redémarrage complet | En dernier recours | `docker compose down && docker compose up -d` |
