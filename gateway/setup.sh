#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Groupe Nexus — Passerelle vocale : installation sur Ubuntu 24.04
#
# Script IDEMPOTENT : peut être relancé sans danger (il ne refait que ce qui
# manque). À exécuter en root (sudo ./setup.sh) depuis le dossier gateway/
# copié sur le VPS (ex. /opt/nexus-gateway).
#
# Ce qu'il fait :
#   1. Installe Docker + le greffon docker compose (et sngrep pour les tests).
#   2. Crée le fichier .env (questions interactives) : DOMAIN, ACME_EMAIL,
#      PROXY_TOKEN, PUBLIC_IP (détectée), RTP_INTERFACE.
#   3. Ouvre le pare-feu ufw : 22/tcp, 80/tcp, 443/tcp, 8443/tcp,
#      5060/udp, 23000-33000/udp.
#   4. Démarre Caddy + api-proxy, attend le certificat Let's Encrypt,
#      le copie pour Kamailio, puis démarre le reste (kamailio, rtpengine).
#   5. Installe la tâche cron de synchronisation des certificats.
#   6. Affiche les prochaines étapes (voip.ms, CRM, tests).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Ce script doit être lancé en root : sudo ./setup.sh" >&2
  exit 1
fi

if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
  echo "AVERTISSEMENT : ce script vise Ubuntu 24.04 ; poursuite quand même..." >&2
fi

echo "══════════════════════════════════════════════════════════════"
echo " Passerelle vocale Groupe Nexus — installation"
echo "══════════════════════════════════════════════════════════════"

# ── 1. Paquets de base ───────────────────────────────────────────────────────
echo
echo "── Étape 1/6 : paquets de base ──"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl ufw dnsutils sngrep cron >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  echo "Installation de Docker (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker déjà installé : $(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Installation du greffon docker compose..."
  apt-get install -y -qq docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 2. Fichier .env ──────────────────────────────────────────────────────────
echo
echo "── Étape 2/6 : configuration (.env) ──"

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
  read -rp "Nom de domaine de la passerelle (ex. voice.groupenexus.com) : " DOMAIN
  read -rp "Courriel pour Let's Encrypt (avis d'expiration) : " ACME_EMAIL
  read -rp "IP publique du VPS [${DETECTED_IP}] : " PUBLIC_IP
  PUBLIC_IP="${PUBLIC_IP:-$DETECTED_IP}"
  DEFAULT_TOKEN="$(openssl rand -hex 32)"
  read -rp "Jeton du relais API voip.ms [générer automatiquement] : " PROXY_TOKEN
  PROXY_TOKEN="${PROXY_TOKEN:-$DEFAULT_TOKEN}"

  if [[ -z "$DOMAIN" || -z "$ACME_EMAIL" || -z "$PUBLIC_IP" ]]; then
    echo "ERREUR : DOMAIN, ACME_EMAIL et PUBLIC_IP sont obligatoires." >&2
    exit 1
  fi

  cat > .env <<EOF
# Généré par setup.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ) — voir .env.example
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
PROXY_TOKEN=${PROXY_TOKEN}
PUBLIC_IP=${PUBLIC_IP}
# Nuage avec NAT 1:1 (AWS/GCP/Azure) : RTP_INTERFACE=IP_privée!IP_publique
RTP_INTERFACE=${PUBLIC_IP}
EOF
  chmod 600 .env
  echo "Fichier .env créé."
fi

# Vérification DNS (non bloquante mais essentielle pour Let's Encrypt).
DNS_IP="$(dig +short "$DOMAIN" A | tail -n1 || true)"
if [[ -z "$DNS_IP" ]]; then
  echo "AVERTISSEMENT : « $DOMAIN » ne résout vers aucune IP." >&2
  echo "Créez l'enregistrement DNS A -> $PUBLIC_IP avant de continuer," >&2
  echo "sinon Let's Encrypt échouera. (Relancez ce script ensuite.)" >&2
elif [[ "$DNS_IP" != "$PUBLIC_IP" ]]; then
  echo "AVERTISSEMENT : $DOMAIN résout vers $DNS_IP, pas vers $PUBLIC_IP." >&2
fi

# ── 3. Pare-feu ──────────────────────────────────────────────────────────────
echo
echo "── Étape 3/6 : pare-feu (ufw) ──"
ufw allow 22/tcp    comment "SSH" >/dev/null
ufw allow 80/tcp    comment "Let's Encrypt HTTP-01" >/dev/null
ufw allow 443/tcp   comment "Caddy HTTPS (relais API voip.ms)" >/dev/null
ufw allow 8443/tcp  comment "SIP WSS (fureteurs)" >/dev/null
ufw allow 5060/udp  comment "SIP UDP (voip.ms)" >/dev/null
ufw allow 23000:33000/udp comment "RTP (rtpengine)" >/dev/null
if ufw status | grep -q "Status: inactive"; then
  ufw --force enable
fi
echo "Règles ufw en place."

# ── 4. Certificat puis démarrage complet ─────────────────────────────────────
echo
echo "── Étape 4/6 : certificat Let's Encrypt ──"
mkdir -p certs caddy/data caddy/config
chmod 644 rtpengine/rtpengine.conf kamailio/kamailio.cfg kamailio/tls.cfg
chmod +x scripts/sync-certs.sh

docker compose up -d caddy api-proxy

# shellcheck disable=SC1091
set -a; source ./.env; set +a
echo "Attente du certificat pour ${DOMAIN} (jusqu'à 3 minutes)..."
CERT_OK=0
for _ in $(seq 1 36); do
  for f in caddy/data/caddy/certificates/*/"$DOMAIN"/"$DOMAIN".crt; do
    if [[ -f "$f" ]]; then CERT_OK=1; break; fi
  done
  [[ "$CERT_OK" -eq 1 ]] && break
  sleep 5
done

if [[ "$CERT_OK" -eq 1 ]]; then
  ./scripts/sync-certs.sh
else
  echo "AVERTISSEMENT : certificat toujours absent après 3 minutes." >&2
  echo "Vérifiez le DNS puis : docker compose logs caddy" >&2
  echo "Kamailio (WSS) ne démarrera pas correctement sans certificat ;" >&2
  echo "relancez ./setup.sh une fois le DNS corrigé." >&2
fi

echo
echo "── Étape 5/6 : démarrage des services ──"
docker compose up -d
docker compose ps

# ── 5. Cron de renouvellement ────────────────────────────────────────────────
GATEWAY_DIR="$(pwd)"
cat > /etc/cron.d/nexus-gateway-certs <<EOF
# Synchronisation quotidienne des certificats Let's Encrypt vers Kamailio
17 4 * * * root cd ${GATEWAY_DIR} && ./scripts/sync-certs.sh >> /var/log/nexus-certsync.log 2>&1
EOF
chmod 644 /etc/cron.d/nexus-gateway-certs
echo "Tâche cron installée : /etc/cron.d/nexus-gateway-certs"

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
   NEXT_PUBLIC_SIP_WSS_URL=wss://${DOMAIN}:8443
   VOIPMS_API_PROXY_URL=https://${DOMAIN}/voipms-api
   VOIPMS_API_PROXY_TOKEN=${PROXY_TOKEN}

3. Tests (détaillés dans README.md, section « Procédure de test ») :
   - https://${DOMAIN}/healthz  doit répondre « ok »
   - Connexion du téléphone web depuis le CRM, puis appel au test
     d'écho voip.ms : 4443.
   - Sur le VPS : sngrep -d any port 5060 or port 8443

Journaux : docker compose logs -f kamailio | rtpengine | caddy | api-proxy
EOF
echo "Installation terminée."
