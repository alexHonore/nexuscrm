#!/usr/bin/env bash
# Tunnel SSH vers la base de dev/tests hébergée sur le KVM.
#
#   localhost:5455 (Mac)  ──►  127.0.0.1:5455 (KVM)  ──►  conteneur nexus-devdb
#
# Le port local est le MÊME qu'avec Docker Desktop : .env, .env.test et toutes
# les commandes (pnpm dev, pnpm test, pnpm db:push) fonctionnent sans
# modification.
#
#   scripts/db-tunnel.sh up      ouvre le tunnel (en arrière-plan)
#   scripts/db-tunnel.sh status  état + test de connexion réel
#   scripts/db-tunnel.sh down    ferme le tunnel
set -euo pipefail

KVM_HOST="${NEXUS_KVM_HOST:-root@31.97.147.222}"
LOCAL_PORT="${NEXUS_DB_PORT:-5455}"
REMOTE_PORT="${NEXUS_DB_REMOTE_PORT:-5455}"
# Socket de contrôle : permet un « down » propre sans chercher de PID.
CTRL="${TMPDIR:-/tmp}/nexus-db-tunnel-${LOCAL_PORT}.sock"

port_owner() {
  lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1
}

tunnel_alive() {
  ssh -S "$CTRL" -O check "$KVM_HOST" >/dev/null 2>&1
}

case "${1:-up}" in
  up)
    if tunnel_alive; then
      echo "✅ Tunnel déjà ouvert sur localhost:${LOCAL_PORT}."
      exit 0
    fi
    owner="$(port_owner || true)"
    if [ -n "$owner" ]; then
      echo "❌ Le port ${LOCAL_PORT} est déjà pris par le PID ${owner} :" >&2
      ps -p "$owner" -o command= >&2 || true
      echo "   (Docker Desktop local ? \`docker compose -f docker-compose.dev.yml down\`)" >&2
      exit 1
    fi
    ssh -f -N -M -S "$CTRL" \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
      "$KVM_HOST"
    echo "✅ Tunnel ouvert : localhost:${LOCAL_PORT} → ${KVM_HOST} (127.0.0.1:${REMOTE_PORT})"
    ;;

  down)
    if tunnel_alive; then
      ssh -S "$CTRL" -O exit "$KVM_HOST" >/dev/null 2>&1 || true
      echo "🔌 Tunnel fermé."
    else
      echo "Aucun tunnel ouvert."
    fi
    ;;

  status)
    if tunnel_alive; then
      echo "✅ Tunnel actif sur localhost:${LOCAL_PORT}."
    else
      echo "❌ Aucun tunnel actif."
      exit 1
    fi
    # Vérification réelle : un tunnel ouvert ne prouve pas que Postgres répond.
    if command -v pg_isready >/dev/null 2>&1; then
      pg_isready -h 127.0.0.1 -p "${LOCAL_PORT}" -U nexus -d nexus_test
    else
      echo "   (pg_isready absent — test applicatif : pnpm test)"
    fi
    ;;

  *)
    echo "Usage: $0 {up|status|down}" >&2
    exit 2
    ;;
esac
