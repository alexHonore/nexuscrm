#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Groupe Nexus — Passerelle vocale : installation « mode Traefik »
#
# Scénario visé : KVM Hostinger (Ubuntu) qui héberge DÉJÀ la pile n8n
# officielle avec Traefik lié aux ports 80/443 (conteneurs typiques :
# root-traefik-1 et root-n8n-1). Ce script N'INSTALLE AUCUN autre serveur
# web/proxy : le Traefik existant termine le TLS et route
#   wss://voice.<domaine>/ws          -> Kamailio (WebSocket SIP)
#   https://voice.<domaine>/voipms-api -> relais API voip.ms
# Rien n'est modifié dans la pile n8n (ni son compose, ni sa config Traefik).
#
# Script IDEMPOTENT : peut être relancé sans danger (il ne refait que ce qui
# manque). À exécuter en root (sudo ./setup.sh) depuis le dossier gateway/
# copié sur le serveur (ex. /opt/nexus-gateway).
#
# Ce qu'il fait :
#   1. Installe quelques outils (sngrep pour les tests) ; Docker est déjà là
#      pour n8n (installé seulement s'il manque).
#   2. Détecte le conteneur Traefik : son réseau Docker (TRAEFIK_NETWORK),
#      son entrypoint HTTPS (TRAEFIK_ENTRYPOINT) et son résolveur de
#      certificats (TRAEFIK_CERTRESOLVER) — confirmés interactivement.
#   3. Détecte l'IP publique (curl -4) et crée le fichier .env
#      (DOMAIN, PUBLIC_IP, PROXY_TOKEN, RTP_INTERFACE, TRAEFIK_*, WS_PORT).
#   4. Pare-feu ufw : ouvre SEULEMENT 5060/udp + 23000-33000/udp (80/443 sont
#      déjà gérés par Traefik) et autorise le port WS interne (5066) depuis
#      les sous-réseaux Docker. N'ACTIVE JAMAIS ufw s'il est inactif (pour ne
#      pas risquer de couper SSH ou n8n).
#   5. docker compose up -d, puis vérifie que Traefik a bien créé les
#      routeurs : https://<domaine>/voipms-api/healthz doit répondre « ok ».
#   6. Affiche les valeurs à configurer dans Vercel.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root : sudo ./setup.sh" >&2
  exit 1
fi

if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
  echo "AVERTISSEMENT : ce script vise Ubuntu (KVM Hostinger) ; poursuite quand même..." >&2
fi

echo "══════════════════════════════════════════════════════════════"
echo " Passerelle vocale Groupe Nexus — installation (mode Traefik)"
echo "══════════════════════════════════════════════════════════════"

# ── 1. Paquets de base ───────────────────────────────────────────────────────
echo
echo "── Étape 1/6 : paquets de base ──"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl dnsutils sngrep >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker est absent (inattendu : n8n devrait déjà tourner ici)."
  echo "Installation de Docker (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
else
  echo "Docker déjà installé : $(docker --version)"
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker-compose-plugin >/dev/null
fi

# Restes d'une ancienne installation « autonome » (Caddy sur 80/443) ?
if docker ps -a --format '{{.Names}}' | grep -q '^nexus-caddy$'; then
  echo "AVERTISSEMENT : un conteneur « nexus-caddy » (ancien mode autonome)" >&2
  echo "existe. Il entre en conflit avec Traefik sur 80/443 :" >&2
  echo "  docker rm -f nexus-caddy" >&2
fi
rm -f /etc/cron.d/nexus-gateway-certs 2>/dev/null || true  # cron de l'ancien mode

# ── 2. Détection de Traefik ──────────────────────────────────────────────────
echo
echo "── Étape 2/6 : détection de Traefik ──"

TRAEFIK_CONTAINER="$(docker ps --format '{{.Names}}' | grep -i -m1 'traefik' || true)"
DETECTED_NETWORK=""
DETECTED_ENTRYPOINT=""
DETECTED_RESOLVER=""

if [[ -n "$TRAEFIK_CONTAINER" ]]; then
  echo "Conteneur Traefik trouvé : ${TRAEFIK_CONTAINER}"
  # Réseau(x) du conteneur Traefik (on écarte les réseaux spéciaux).
  DETECTED_NETWORK="$(docker inspect "$TRAEFIK_CONTAINER" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' 2>/dev/null \
    | grep -vE '^(bridge|host|none)$' | head -n1 || true)"
  # Entrypoint :443 et résolveur de certificats, lus dans les arguments de
  # lancement de Traefik (gabarit n8n : websecure / mytlschallenge).
  TRAEFIK_ARGS="$(docker inspect "$TRAEFIK_CONTAINER" \
    --format '{{join .Config.Cmd "\n"}}{{"\n"}}{{join .Args "\n"}}' 2>/dev/null || true)"
  DETECTED_ENTRYPOINT="$(printf '%s\n' "$TRAEFIK_ARGS" \
    | grep -iE '^--entrypoints\.[a-z0-9_-]+\.address=:?443(/tcp)?$' \
    | head -n1 | cut -d. -f2 || true)"
  DETECTED_RESOLVER="$(printf '%s\n' "$TRAEFIK_ARGS" \
    | grep -iE '^--certificatesresolvers\.' \
    | head -n1 | cut -d. -f2 || true)"
else
  echo "AVERTISSEMENT : aucun conteneur « traefik » en cours d'exécution." >&2
  echo "La pile n8n est-elle démarrée ? (docker ps)" >&2
fi

# Filet : premier réseau *_default listé (celui de la pile n8n dans /root
# s'appelle en général « root_default »).
if [[ -z "$DETECTED_NETWORK" ]]; then
  DETECTED_NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '_default$' | head -n1 || true)"
fi
DETECTED_NETWORK="${DETECTED_NETWORK:-root_default}"
DETECTED_ENTRYPOINT="${DETECTED_ENTRYPOINT:-websecure}"
DETECTED_RESOLVER="${DETECTED_RESOLVER:-mytlschallenge}"

echo "Valeurs détectées : réseau=${DETECTED_NETWORK}, entrypoint=${DETECTED_ENTRYPOINT}, résolveur=${DETECTED_RESOLVER}"

# ── 3. Fichier .env ──────────────────────────────────────────────────────────
echo
echo "── Étape 3/6 : configuration (.env) ──"

detect_public_ip() {
  curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
}

if [[ -f .env ]]; then
  echo "Fichier .env existant — valeurs conservées."
  # shellcheck disable=SC1091
  set -a; source ./.env; set +a
else
  DETECTED_IP="$(detect_public_ip || true)"
  echo "IP publique détectée : ${DETECTED_IP:-inconnue}"
  read -rp "Nom de domaine COMPLET de la passerelle (ex. voice.groupenexus.com) : " DOMAIN
  read -rp "IP publique du KVM [${DETECTED_IP}] : " PUBLIC_IP
  PUBLIC_IP="${PUBLIC_IP:-$DETECTED_IP}"
  DEFAULT_TOKEN="$(openssl rand -hex 32)"
  read -rp "Jeton du relais API voip.ms [générer automatiquement] : " PROXY_TOKEN
  PROXY_TOKEN="${PROXY_TOKEN:-$DEFAULT_TOKEN}"
  read -rp "Réseau Docker de Traefik [${DETECTED_NETWORK}] : " TRAEFIK_NETWORK
  TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-$DETECTED_NETWORK}"
  read -rp "Entrypoint HTTPS de Traefik [${DETECTED_ENTRYPOINT}] : " TRAEFIK_ENTRYPOINT
  TRAEFIK_ENTRYPOINT="${TRAEFIK_ENTRYPOINT:-$DETECTED_ENTRYPOINT}"
  read -rp "Résolveur de certificats Traefik [${DETECTED_RESOLVER}] : " TRAEFIK_CERTRESOLVER
  TRAEFIK_CERTRESOLVER="${TRAEFIK_CERTRESOLVER:-$DETECTED_RESOLVER}"
  WS_PORT="${WS_PORT:-5066}"

  if [[ -z "$DOMAIN" || -z "$PUBLIC_IP" ]]; then
    echo "ERREUR : DOMAIN et PUBLIC_IP sont obligatoires." >&2
    exit 1
  fi

  cat > .env <<EOF
# Généré par setup.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ) — voir .env.example
DOMAIN=${DOMAIN}
PROXY_TOKEN=${PROXY_TOKEN}
PUBLIC_IP=${PUBLIC_IP}
# Nuage avec NAT 1:1 (AWS/GCP/Azure) : RTP_INTERFACE=IP_privée!IP_publique
RTP_INTERFACE=${PUBLIC_IP}
# Intégration au Traefik existant (pile n8n)
TRAEFIK_NETWORK=${TRAEFIK_NETWORK}
TRAEFIK_ENTRYPOINT=${TRAEFIK_ENTRYPOINT}
TRAEFIK_CERTRESOLVER=${TRAEFIK_CERTRESOLVER}
# Port WebSocket en clair de Kamailio (interne, jamais exposé à Internet)
WS_PORT=${WS_PORT}
EOF
  chmod 600 .env
  echo "Fichier .env créé."
fi

# Le réseau Traefik doit exister, sinon docker compose refusera de démarrer.
if ! docker network inspect "${TRAEFIK_NETWORK:-root_default}" >/dev/null 2>&1; then
  echo "ERREUR : le réseau Docker « ${TRAEFIK_NETWORK:-root_default} » n'existe pas." >&2
  echo "Réseaux disponibles :" >&2
  docker network ls --format '  - {{.Name}}' >&2
  echo "Corrigez TRAEFIK_NETWORK dans .env puis relancez ./setup.sh" >&2
  exit 1
fi

# Vérification DNS (non bloquante mais essentielle pour le certificat).
DNS_IP="$(dig +short "$DOMAIN" A | tail -n1 || true)"
if [[ -z "$DNS_IP" ]]; then
  echo "AVERTISSEMENT : « $DOMAIN » ne résout vers aucune IP." >&2
  echo "Créez l'enregistrement DNS A -> $PUBLIC_IP avant de continuer," >&2
  echo "sinon Traefik ne pourra pas obtenir le certificat. (Relancez ensuite.)" >&2
elif [[ "$DNS_IP" != "$PUBLIC_IP" ]]; then
  echo "AVERTISSEMENT : $DOMAIN résout vers $DNS_IP, pas vers $PUBLIC_IP." >&2
fi

# ── 4. Pare-feu ──────────────────────────────────────────────────────────────
echo
echo "── Étape 4/6 : pare-feu (ufw) ──"
# 80/443 sont déjà publiés par Traefik (Docker les ouvre lui-même) : rien à
# faire pour eux. On n'ouvre que ce qui concerne la voix. Le port WS interne
# (5066) n'est autorisé QUE depuis le sous-réseau Docker de Traefik.
WS_PORT="${WS_PORT:-5066}"
DOCKER_SUBNET="$(docker network inspect "${TRAEFIK_NETWORK:-root_default}" \
  --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || echo 172.16.0.0/12)"
DOCKER_SUBNET="${DOCKER_SUBNET:-172.16.0.0/12}"

if command -v ufw >/dev/null 2>&1; then
  ufw allow 5060/udp  comment "SIP UDP (voip.ms)" >/dev/null
  ufw allow 23000:33000/udp comment "RTP (rtpengine)" >/dev/null
  ufw allow from "$DOCKER_SUBNET" to any port "$WS_PORT" proto tcp \
    comment "Kamailio WS interne (Traefik)" >/dev/null
  if ufw status | grep -q "Status: active"; then
    echo "Règles ufw en place (5060/udp, 23000-33000/udp, ${WS_PORT}/tcp depuis ${DOCKER_SUBNET})."
  else
    echo "ufw est INACTIF : règles enregistrées mais pare-feu non activé"
    echo "(on n'active jamais ufw ici pour ne pas risquer de couper SSH/n8n)."
  fi
else
  echo "ufw absent — aucune règle ajoutée."
fi
echo "NOTE : si le pare-feu est géré ailleurs (hPanel Hostinger, pare-feu"
echo "cloud), ouvrez-y aussi : 5060/udp et 23000-33000/udp (entrants)."

# ── 5. Démarrage et vérification ─────────────────────────────────────────────
echo
echo "── Étape 5/6 : démarrage des services ──"
chmod 644 rtpengine/rtpengine.conf kamailio/kamailio.cfg kamailio/tls.cfg
docker compose up -d
docker compose ps

# shellcheck disable=SC1091
set -a; source ./.env; set +a

echo
echo "Vérification des routeurs Traefik (jusqu'à 2 minutes — le premier"
echo "certificat Let's Encrypt peut prendre un moment)..."
HEALTH_OK=0
for _ in $(seq 1 24); do
  if curl -4fsS --max-time 5 "https://${DOMAIN}/voipms-api/healthz" 2>/dev/null | grep -q "^ok$"; then
    HEALTH_OK=1
    break
  fi
  sleep 5
done

if [[ "$HEALTH_OK" -eq 1 ]]; then
  echo "OK : https://${DOMAIN}/voipms-api/healthz répond « ok »"
  echo "     (Traefik -> api-proxy fonctionne ; le routeur /ws est déclaré"
  echo "      par le même mécanisme d'étiquettes)."
else
  echo "AVERTISSEMENT : https://${DOMAIN}/voipms-api/healthz ne répond pas encore." >&2
  echo "Pistes (voir README, section Dépannage) :" >&2
  echo "  - DNS : dig +short ${DOMAIN}  (doit donner ${PUBLIC_IP})" >&2
  echo "  - Routeurs créés ? docker logs ${TRAEFIK_CONTAINER:-root-traefik-1} 2>&1 | grep -i nexus" >&2
  echo "  - Réseau : TRAEFIK_NETWORK=${TRAEFIK_NETWORK:-?} correspond-il au réseau du conteneur Traefik ?" >&2
  echo "  - Entrypoint/résolveur : ${TRAEFIK_ENTRYPOINT:-?} / ${TRAEFIK_CERTRESOLVER:-?}" >&2
  echo "Relancez ./setup.sh après correction (sans danger)." >&2
fi

# ── 6. Prochaines étapes ─────────────────────────────────────────────────────
echo
echo "── Étape 6/6 : PROCHAINES ÉTAPES (voir README.md pour le détail) ──"
cat <<EOF

1. Côté voip.ms (https://voip.ms) :
   - Créer un sous-compte SIP par téléphoniste (protocole SIP, mot de passe,
     NAT = yes, codecs ulaw + opus si offert, POP Montréal).
   - Menu principal -> API : activer l'API et AUTORISER L'IP ${PUBLIC_IP}.
   - Router chaque DID vers le sous-compte du ou de la téléphoniste.

2. Côté CRM (variables d'environnement Vercel) :
   NEXT_PUBLIC_SIP_WSS_URL=wss://${DOMAIN}/ws
   VOIPMS_API_PROXY_URL=https://${DOMAIN}/voipms-api
   VOIPMS_API_PROXY_TOKEN=${PROXY_TOKEN}

3. Tests (détaillés dans README.md, section « Procédure de test ») :
   - https://${DOMAIN}/voipms-api/healthz  doit répondre « ok »
   - Connexion du téléphone web depuis le CRM, puis appel au test
     d'écho voip.ms : 4443.
   - Sur le KVM : sngrep -d any port 5060 or port ${WS_PORT:-5066}

n8n continue de fonctionner comme avant : rien n'a été modifié dans sa pile.
Journaux : docker compose logs -f kamailio | rtpengine | ws-bridge | api-proxy
EOF
echo "Installation terminée."
