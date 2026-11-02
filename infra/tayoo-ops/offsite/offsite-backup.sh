#!/usr/bin/env bash
# ── Copie hors serveur des sauvegardes Tayoo Ops vers Cloudflare R2 ─────────
#
#   offsite-backup.sh run                   envoie les sauvegardes locales pas encore
#                                           copiées (instances activées, 35 derniers jours)
#   offsite-backup.sh status                instances, interrupteurs, clés, dernières copies
#   offsite-backup.sh enable|disable SLUG   active / désactive la copie d'une instance
#   offsite-backup.sh list SLUG             copies présentes dans R2
#   offsite-backup.sh restore-test [SLUG…]  télécharge la dernière copie, déchiffre,
#                                           vérifie MANIFEST.sha256 et lit db.dump
#
# Chiffrement AVANT l'envoi (age, une clé par instance : keys/<slug>.key, 600) :
# Cloudflare ne voit jamais rien en clair. SANS CES CLÉS, LES COPIES SONT
# ILLISIBLES — en garder une copie hors du serveur (gestionnaire de mots de passe).
# Seau `tayoo-backups` : verrou de 30 jours (rien ne s'efface ni ne s'écrase avant)
# + suppression automatique à 35 jours — règles posées dans le tableau de bord.
# Échec = courriel (SMTP partagé, /srv/supabase/smtp.env). Identifiants R2 :
# r2.env (600), passés à rclone par fichier d'environnement, jamais en argument.
set -Eeuo pipefail
umask 077

D=/srv/supabase/offsite
BACKUPS=/srv/supabase/backups
PROJECTS=/srv/supabase/projects
CONF=$D/r2.env
ENABLED=$D/enabled
KEYS=$D/keys
STATE=$D/state
TMP=$D/tmp
ALERT_TO="${ALERT_TO:-alex@alexhonore.com}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.68}"
MAX_AGE_DAYS=35      # au-delà, R2 les efface de toute façon
STALE_HOURS=36       # sauvegarde locale plus vieille que ça = le job nocturne est cassé

[ -f "$CONF" ] || { echo "identifiants R2 absents : $CONF" >&2; exit 2; }
mkdir -p "$KEYS" "$STATE" "$TMP"; chmod 700 "$D" "$KEYS" "$STATE" "$TMP"; touch "$ENABLED"
B=$(grep -m1 '^R2_BUCKET=' "$CONF" | cut -d= -f2-)

log() { printf '%s offsite: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATE/offsite.log" >&2; }

notify() {  # notify "sujet" "texte"
  python3 -I - "$1" "$2" "$ALERT_TO" <<'PY' || log "courriel impossible"
import smtplib, ssl, sys
from email.message import EmailMessage
cfg = dict(l.split('=', 1) for l in open('/srv/supabase/smtp.env').read().splitlines() if '=' in l and not l.startswith('#'))
m = EmailMessage(); m['From'] = cfg['SMTP_ADMIN_EMAIL']; m['To'] = sys.argv[3]
m['Subject'] = 'Tayoo Ops · ' + sys.argv[1]; m.set_content(sys.argv[2])
port = int(cfg['SMTP_PORT']); ctx = ssl.create_default_context()
s = smtplib.SMTP_SSL(cfg['SMTP_HOST'], port, timeout=30, context=ctx) if port == 465 else smtplib.SMTP(cfg['SMTP_HOST'], port, timeout=30)
with s:
    if port != 465: s.starttls(context=ctx)
    s.login(cfg['SMTP_USER'], cfg['SMTP_PASS']); s.send_message(m)
PY
}

rc() {  # rclone dans un conteneur jetable ; $TMP est monté sur /work
  local e st=0; e=$(mktemp "$TMP/.rc.XXXX")
  python3 -I - "$CONF" > "$e" <<'PY'
import sys
c = dict(l.split('=', 1) for l in open(sys.argv[1]).read().splitlines() if '=' in l and not l.startswith('#'))
print('RCLONE_CONFIG_R2_TYPE=s3\nRCLONE_CONFIG_R2_PROVIDER=Cloudflare\nRCLONE_CONFIG_R2_NO_CHECK_BUCKET=true')
print('RCLONE_CONFIG_R2_ACCESS_KEY_ID=' + c['R2_ACCESS_KEY_ID'])
print('RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=' + c['R2_SECRET_ACCESS_KEY'])
print('RCLONE_CONFIG_R2_ENDPOINT=' + c['R2_ENDPOINT'])
PY
  docker run --rm --env-file "$e" -v "$TMP:/work" "$RCLONE_IMAGE" -q "$@" </dev/null || st=$?
  rm -f "$e"; return $st
}

pubkey() {  # crée la clé de l'instance au besoin, imprime sa clé publique
  local k="$KEYS/$1.key"
  if [ ! -f "$k" ]; then age-keygen -o "$k" 2>/dev/null; chmod 600 "$k"; log "clé créée pour $1 — À COPIER HORS DU SERVEUR"; fi
  age-keygen -y "$k"
}

remote_size() { rc lsjson "r2:$B/$1" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["Size"] if d else -1)'; }

cmd_run() {
  exec 9> "$STATE/lock"; flock -n 9 || { log "une copie tourne déjà"; return 0; }
  local fails=() sent=0 slug dir pub f newest age_h
  while read -r slug; do
    [ -n "$slug" ] || continue
    [ -d "$BACKUPS/$slug" ] || { fails+=("$slug : aucun dossier de sauvegarde locale"); continue; }
    pub=$(pubkey "$slug"); touch "$STATE/$slug.uploaded"; newest=""
    while read -r dir; do
      [ -n "$dir" ] || continue
      newest=$dir
      grep -qx "$dir" "$STATE/$slug.uploaded" && continue
      [ -f "$BACKUPS/$slug/$dir/MANIFEST.sha256" ] || { fails+=("$slug/$dir : pas de MANIFEST.sha256 (sauvegarde incomplète ?)"); continue; }
      f="$slug--$dir.tar.age"
      if tar -C "$BACKUPS/$slug" -cf - "$dir" | age -r "$pub" -o "$TMP/$f" \
         && rc copyto "/work/$f" "r2:$B/$slug/$dir.tar.age" \
         && [ "$(remote_size "$slug/$dir.tar.age")" = "$(stat -c %s "$TMP/$f")" ]; then
        echo "$dir" >> "$STATE/$slug.uploaded"; sent=$((sent + 1)); log "$slug/$dir envoyé ($(du -h "$TMP/$f" | cut -f1))"
      else
        fails+=("$slug/$dir : envoi ou vérification échoué")
      fi
      rm -f "$TMP/$f"
    done < <(find "$BACKUPS/$slug" -mindepth 1 -maxdepth 1 -type d -mtime "-$MAX_AGE_DAYS" -printf '%f\n' | sort)
    if [ -z "$newest" ]; then
      fails+=("$slug : aucune sauvegarde locale des $MAX_AGE_DAYS derniers jours")
    else
      age_h=$(( ( $(date +%s) - $(stat -c %Y "$BACKUPS/$slug/$newest") ) / 3600 ))
      [ "$age_h" -le "$STALE_HOURS" ] || fails+=("$slug : dernière sauvegarde LOCALE vieille de ${age_h} h ($newest) — le job nocturne supabase-backup ne tourne plus ?")
      date -u +%FT%TZ > "$STATE/$slug.last-run"
    fi
  done < "$ENABLED"
  if [ ${#fails[@]} -gt 0 ]; then
    printf '%s\n' "${fails[@]}" > "$STATE/last-failure"
    log "ÉCHEC : ${fails[*]}"
    notify "échec de la copie hors serveur" "$(printf 'Copie des sauvegardes vers Cloudflare R2 (seau %s) :\n\n' "$B"; printf -- '- %s\n' "${fails[@]}"; printf '\n%s copie(s) réussie(s) quand même.\nJournal : %s/offsite.log sur le VPS ; état : offsite-backup.sh status\n' "$sent" "$STATE")"
    return 1
  fi
  rm -f "$STATE/last-failure"; date -u +%FT%TZ > "$STATE/last-success"; log "OK — $sent copie(s) envoyée(s)"
}

cmd_restore_test() {
  local slugs=("$@") report=() bad=0 slug last w d n img
  [ ${#slugs[@]} -gt 0 ] || mapfile -t slugs < <(grep -v '^[[:space:]]*$' "$ENABLED")
  for slug in "${slugs[@]}"; do
    [ -f "$KEYS/$slug.key" ] || { report+=("$slug : ÉCHEC — pas de clé"); bad=1; continue; }
    last=$(rc lsf "r2:$B/$slug/" | grep '\.tar\.age$' | sort | tail -1 || true)
    [ -n "$last" ] || { report+=("$slug : ÉCHEC — aucune copie dans R2"); bad=1; continue; }
    w=$(mktemp -d "$TMP/rt.XXXX"); d="$w/${last%.tar.age}"
    img=$(docker inspect -f '{{.Config.Image}}' "sb-$slug-db-1" 2>/dev/null || docker inspect -f '{{.Config.Image}}' sb-nexuscrm-db-1)
    if rc copyto "r2:$B/$slug/$last" "/work/$(basename "$w")/$last" \
       && age -d -i "$KEYS/$slug.key" "$w/$last" | tar -C "$w" -xf - \
       && (cd "$d" && sha256sum -c --quiet MANIFEST.sha256) \
       && n=$(docker run --rm --user 0 -v "$d:/r:ro" --entrypoint pg_restore "$img" --list /r/db.dump | grep -c ';'); then
      report+=("$slug : OK — $last téléchargé, déchiffré, empreintes conformes, db.dump lisible ($n entrées)")
    else
      report+=("$slug : ÉCHEC sur $last (téléchargement, déchiffrement, empreintes ou db.dump)"); bad=1
    fi
    rm -rf "$w"
  done
  printf '%s\n' "${report[@]}" | tee "$STATE/last-restore-test" >&2
  date -u +%FT%TZ >> "$STATE/last-restore-test"
  notify "test de restauration hors serveur : $([ $bad = 0 ] && echo OK || echo ÉCHEC)" "$(printf 'Test mensuel des copies R2 (seau %s) :\n\n' "$B"; printf -- '- %s\n' "${report[@]}")"
  return $bad
}

cmd_status() {
  echo "seau : $B · instances activées : $(tr '\n' ' ' < "$ENABLED")"
  local slug
  for slug in $(ls "$PROJECTS"); do
    printf '  %-10s copie %-3s · clé %-8s · copies envoyées : %-3s · dernier passage : %s\n' "$slug" \
      "$(grep -qx "$slug" "$ENABLED" && echo oui || echo non)" "$([ -f "$KEYS/$slug.key" ] && echo présente || echo absente)" \
      "$( [ -f "$STATE/$slug.uploaded" ] && wc -l < "$STATE/$slug.uploaded" || echo 0)" "$(cat "$STATE/$slug.last-run" 2>/dev/null || echo jamais)"
  done
  echo "dernier succès : $(cat "$STATE/last-success" 2>/dev/null || echo jamais) · dernier échec : $(head -1 "$STATE/last-failure" 2>/dev/null || echo aucun)"
  echo "dernier test de restauration : $(tail -1 "$STATE/last-restore-test" 2>/dev/null || echo jamais)"
}

case "${1:-}" in
  run) cmd_run ;;
  status) cmd_status ;;
  enable|disable)
    s="${2:?slug}"; [ -d "$PROJECTS/$s" ] || { echo "instance inconnue : $s" >&2; exit 2; }
    grep -vx "$s" "$ENABLED" > "$ENABLED.new" || true
    [ "$1" = enable ] && echo "$s" >> "$ENABLED.new"
    sort -u "$ENABLED.new" -o "$ENABLED"; rm -f "$ENABLED.new"
    [ "$1" = enable ] && pubkey "$s" >/dev/null
    log "copie hors serveur $( [ "$1" = enable ] && echo activée || echo désactivée ) pour $s"; cmd_status ;;
  list) rc lsl "r2:$B/${2:?slug}/" ;;
  restore-test) shift; cmd_restore_test "$@" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
