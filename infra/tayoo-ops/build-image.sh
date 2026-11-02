#!/usr/bin/env bash
# ── Construit l'image Groupe Nexus CRM pour Tayoo Ops et la pousse au registre ─
#
#   build-image.sh <dossier-source> [app.env]
#
# Sur le VPS, en root. <dossier-source> = un export du dépôt À UN COMMIT DONNÉ
# (git archive, jamais le dossier de travail du Mac). Le commit est lu dans
# <dossier-source>/../src.commit s'il existe, sinon passé par COMMIT=….
#
# Ne lit dans app.env QUE les deux réglages inlinés au build
# (NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_SIP_WSS_URL) — aucun secret n'entre dans
# l'image. Imprime la référence épinglée (@sha256:…) à donner au portail
# (« Host app ») ou à build-and-deploy.sh. N'héberge rien lui-même.
set -Eeuo pipefail
umask 077

SRC="${1:?usage: $0 <dossier-source> [app.env]}"
APP_ENV="${2:-/srv/supabase/apps/nexuscrm/app.env}"
REGISTRY="${REGISTRY:-127.0.0.1:5000}"
NAME="${IMAGE_NAME:-nexuscrm}"
# Options docker build en plus, ex. BUILD_FLAGS="--no-cache --pull".
read -r -a EXTRA <<< "${BUILD_FLAGS:-}"

# Le build tourne sur LE serveur de production (4 vCPU partagés avec la base, n8n
# et la passerelle vocale, dont l'audio des appels supporte mal la contention) :
# pas pendant les heures d'appel (lun.–sam. 8 h–21 h, heure de Toronto), sauf
# FORCE=1 pour un correctif urgent.
if [ "${FORCE:-0}" != 1 ]; then
  dow="$(TZ=America/Toronto date +%u)"; hour="$(TZ=America/Toronto date +%H)"
  if [ "$dow" -le 6 ] && [ "$((10#$hour))" -ge 8 ] && [ "$((10#$hour))" -lt 21 ]; then
    echo "heures d'appel à Toronto ($(TZ=America/Toronto date '+%a %H:%M')) : build refusé — relancer après 21 h, ou FORCE=1 pour un correctif urgent" >&2
    exit 3
  fi
fi

[ -f "$SRC/infra/tayoo-ops/Dockerfile" ] || { echo "pas de infra/tayoo-ops/Dockerfile dans $SRC" >&2; exit 2; }
[ -f "$APP_ENV" ] || { echo "app.env introuvable : $APP_ENV" >&2; exit 2; }

read_var() {
  grep -m1 "^$1=" "$APP_ENV" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true
}
APP_URL="$(read_var NEXT_PUBLIC_APP_URL)"
WSS_URL="$(read_var NEXT_PUBLIC_SIP_WSS_URL)"
[ -n "$APP_URL" ] || { echo "NEXT_PUBLIC_APP_URL absent de $APP_ENV" >&2; exit 2; }
case "$APP_URL" in https://*) ;; *) echo "NEXT_PUBLIC_APP_URL doit être en https:// ($APP_URL)" >&2; exit 2 ;; esac

COMMIT="${COMMIT:-$(cat "$SRC/../src.commit" 2>/dev/null || true)}"
COMMIT="${COMMIT:-manual-$(date -u +%Y%m%dT%H%M%SZ)}"
TAG="${REGISTRY}/${NAME}:${COMMIT:0:12}"

echo "→ build $TAG (APP_URL=$APP_URL)"
docker build "${EXTRA[@]}" -f "$SRC/infra/tayoo-ops/Dockerfile" \
  --build-arg NEXT_PUBLIC_APP_URL="$APP_URL" \
  --build-arg NEXT_PUBLIC_SIP_WSS_URL="$WSS_URL" \
  --label org.opencontainers.image.revision="$COMMIT" \
  -t "$TAG" "$SRC"
docker push "$TAG" >/dev/null
DIGEST="$(docker inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$TAG" | grep -m1 "^${REGISTRY}/${NAME}@")"
echo "✓ image poussée : $TAG"
echo "  référence épinglée : $DIGEST"
