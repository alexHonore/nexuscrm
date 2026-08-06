#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Groupe Nexus — Passerelle vocale : synchronisation des certificats
#
# ⚠ MODE AUTONOME SEULEMENT (docker-compose.standalone.yml, annexe du README).
# En mode Traefik (par défaut), Kamailio ne termine aucun TLS : les
# certificats sont entièrement gérés par le Traefik de la pile n8n et ce
# script est inutile.
#
# Copie le certificat Let's Encrypt obtenu par Caddy
#   (caddy/data/caddy/certificates/<autorité>/<domaine>/<domaine>.{crt,key})
# vers ./certs/{fullchain.pem,privkey.pem} (montés dans Kamailio), puis
# demande à Kamailio de recharger ses certificats sans coupure.
#
# Exécuté (mode autonome) :
#   - une fois à l'installation ;
#   - chaque nuit par cron (/etc/cron.d/nexus-gateway-certs) pour couvrir les
#     renouvellements (Let's Encrypt renouvelle ~30 jours avant l'expiration).
#
# Idempotent : ne fait rien si le certificat n'a pas changé.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

# Le mode autonome utilise son propre fichier compose.
COMPOSE=(docker compose -f docker-compose.standalone.yml)

if [[ ! -f .env ]]; then
  echo "ERREUR : fichier .env introuvable (lancer setup.sh d'abord)." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source ./.env; set +a

if [[ -z "${DOMAIN:-}" ]]; then
  echo "ERREUR : DOMAIN manquant dans .env." >&2
  exit 1
fi

# Localiser le certificat le plus récent produit par Caddy (le nom du
# répertoire de l'autorité ACME peut varier, d'où le motif générique).
CRT=""
for f in caddy/data/caddy/certificates/*/"$DOMAIN"/"$DOMAIN".crt; do
  [[ -f "$f" ]] && CRT="$f"
done
KEY="${CRT%.crt}.key"

if [[ -z "$CRT" || ! -f "$KEY" ]]; then
  echo "ERREUR : certificat pour $DOMAIN introuvable dans caddy/data/." >&2
  echo "Caddy a-t-il réussi à obtenir le certificat ? (docker compose logs caddy)" >&2
  exit 1
fi

mkdir -p certs

changed=0
if ! cmp -s "$CRT" certs/fullchain.pem 2>/dev/null; then changed=1; fi
if ! cmp -s "$KEY" certs/privkey.pem 2>/dev/null; then changed=1; fi

if [[ "$changed" -eq 0 ]]; then
  echo "Certificats déjà à jour ($DOMAIN) — rien à faire."
  exit 0
fi

install -m 644 "$CRT" certs/fullchain.pem
install -m 600 "$KEY" certs/privkey.pem
echo "Certificats copiés vers ./certs ($DOMAIN)."

# Recharger Kamailio s'il tourne (sinon il les lira au démarrage).
if "${COMPOSE[@]}" ps --status running kamailio 2>/dev/null | grep -q kamailio; then
  if "${COMPOSE[@]}" exec -T kamailio kamcmd -s unix:/tmp/kamailio_ctl tls.reload; then
    echo "Kamailio : certificats rechargés à chaud (tls.reload)."
  else
    echo "tls.reload a échoué — redémarrage du conteneur Kamailio..." >&2
    "${COMPOSE[@]}" restart kamailio
  fi
else
  echo "Kamailio n'est pas démarré — il chargera les certificats au démarrage."
fi
