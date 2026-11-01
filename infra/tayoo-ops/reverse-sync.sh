#!/usr/bin/env bash
# ── Synchronisation inverse : Tayoo Ops (nexuscrm) → ancienne base Supabase ──
#
# Pendant la période de repli, la NOUVELLE version (VPS) est la seule active ;
# l'ancienne (Vercel + Supabase cloud weasuzxazxjnfzxzqtsw) dort. Ce script
# recopie toutes les données de l'application dans l'ancienne base pour qu'un
# retour arrière reparte d'un état à jour (au pire 15 min de retard, zéro
# après la synchronisation finale du runbook).
#
#   reverse-sync.sh              synchronise (une transaction, tout ou rien)
#   reverse-sync.sh --check      fait TOUT, vérifications comprises, puis ROLLBACK
#                                (verrouille les tables cibles le temps de la
#                                transaction : ancienne version ARRÊTÉE seulement)
#   reverse-sync.sh --preflight  LECTURE SEULE des deux côtés : connexion,
#                                gardes 2 à 4 (la 4 est rapportée, pas fatale).
#                                Sans risque contre une base encore en service.
#
# Lancé par nexuscrm-reverse-sync.timer (toutes les 15 min), en root, SUR LE VPS.
#
# Ce qui protège l'ancienne base (chaque garde fait échouer AVANT d'écrire) :
#   1. fichier DISABLED dans STATE_DIR → sortie immédiate, rien n'est touché.
#      Le runbook de retour arrière le pose : une fois l'ancienne version
#      revenue en service, la recopier depuis le VPS EFFACERAIT ses écritures ;
#   2. l'URL cible doit contenir la référence du projet cloud attendu et ne
#      ressembler à rien du VPS ;
#   3. schémas identiques des deux côtés (gel du schéma, sinon refus + diff) ;
#   4. l'ancienne base n'a PAS été écrite depuis la dernière copie : sa
#      dernière ligne de journal d'audit (chaque connexion en écrit une) doit
#      exister à l'identique côté source ;
#   5. dans la transaction : nombre de lignes de chaque table = celui de
#      l'instantané copié ; sinon ROLLBACK.
#
# Source lue par pg_dump dans UN instantané cohérent ; le chargement se fait
# en TRUNCATE + COPY dans l'ordre des clés étrangères, triggers utilisateur
# suspendus le temps de la transaction (sur Supabase cloud, `postgres` n'est
# pas superutilisateur : pas de session_replication_role, mais il possède les
# tables, ce qui suffit pour ALTER TABLE … DISABLE TRIGGER).
#
# Aucun secret en argument de commande : mots de passe passés aux conteneurs
# par variables d'environnement nommées (`docker run -e PGPASSWORD`).
set -Eeuo pipefail
umask 077

CONF="${REVERSE_SYNC_CONF:-/srv/supabase/apps/nexuscrm/reverse-sync.env}"

MODE=commit
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --preflight) MODE=preflight ;;
  -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--check|--preflight]" >&2; exit 2 ;;
esac

# ── Réglages : défauts, puis le fichier de conf (600, jamais `source`) ───────
OLD_DATABASE_URL=""
OLD_PROJECT_REF="weasuzxazxjnfzxzqtsw"
SOURCE_CONTAINER="sb-nexuscrm-db-1"
SOURCE_ENV="/srv/supabase/projects/nexuscrm/.env"
STATE_DIR="/srv/supabase/apps/nexuscrm/reverse-sync"
PG_CLIENT_IMAGE=""

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s reverse-sync: %s\n' "$(ts)" "$*" | tee -a "${STATE_DIR}/sync.log" >&2; }
die() { local code="$1"; shift; log "ÉCHEC — $*"; printf '%s %s\n' "$(ts)" "$*" > "${STATE_DIR}/last-failure"; exit "$code"; }

[ -f "$CONF" ] || { echo "conf absente : $CONF" >&2; exit 2; }
perm="$(stat -c '%a' "$CONF")"
case "$perm" in 600|400) ;; *) echo "conf $CONF en mode $perm : 600 exigé" >&2; exit 2 ;; esac

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  case "$key" in
    OLD_DATABASE_URL|OLD_PROJECT_REF|SOURCE_CONTAINER|SOURCE_ENV|STATE_DIR|PG_CLIENT_IMAGE)
      printf -v "$key" '%s' "$val" ;;
    *) echo "clé inconnue dans $CONF : $key" >&2; exit 2 ;;
  esac
done < "$CONF"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# ── Garde 1 : interrupteur de retour arrière ─────────────────────────────────
if [ -e "${STATE_DIR}/DISABLED" ]; then
  log "DÉSACTIVÉ (${STATE_DIR}/DISABLED) — rien n'est touché."
  exit 0
fi

exec 9> "${STATE_DIR}/lock"
flock -n 9 || { log "une synchronisation tourne déjà — on passe ce tour."; exit 0; }

# ── Garde 2 : la cible est bien l'ANCIENNE base cloud ────────────────────────
[ -n "$OLD_DATABASE_URL" ] || die 2 "OLD_DATABASE_URL absent de $CONF"
[ -n "$OLD_PROJECT_REF" ] || die 2 "OLD_PROJECT_REF vide"
case "$OLD_DATABASE_URL" in
  *"$OLD_PROJECT_REF"*) ;;
  *) die 2 "OLD_DATABASE_URL ne contient pas la référence $OLD_PROJECT_REF — refus." ;;
esac
case "$OLD_DATABASE_URL" in
  *tayoo.app*|*@db:*|*@localhost*|*@127.0.0.1*|*"@${SOURCE_CONTAINER}"*)
    die 2 "OLD_DATABASE_URL désigne le VPS lui-même — refus." ;;
esac

# URL → variables libpq (jamais d'URL avec mot de passe dans argv).
eval "$(OLD_DATABASE_URL="$OLD_DATABASE_URL" python3 -I -c '
import os, shlex
from urllib.parse import urlsplit, unquote, parse_qs
u = urlsplit(os.environ["OLD_DATABASE_URL"])
q = parse_qs(u.query)
out = {
  "T_HOST": u.hostname or "",
  "T_PORT": str(u.port or 5432),
  "T_USER": unquote(u.username or ""),
  "T_PASS": unquote(u.password or ""),
  "T_DB": (u.path or "/postgres").lstrip("/") or "postgres",
  "T_SSLMODE": (q.get("sslmode") or ["require"])[0],
}
for k, v in out.items():
    print(f"{k}={shlex.quote(v)}")
')"
[ -n "$T_HOST" ] && [ -n "$T_USER" ] || die 2 "OLD_DATABASE_URL illisible"

# ── Source : l'instance nexuscrm, par son réseau Docker privé ────────────────
docker inspect "$SOURCE_CONTAINER" >/dev/null 2>&1 || die 2 "conteneur source $SOURCE_CONTAINER introuvable"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$SOURCE_CONTAINER" | head -1)"
[ -n "$NET" ] || die 2 "réseau de $SOURCE_CONTAINER introuvable"
# Même image que la base source ⇒ pg_dump/psql de la même version majeure.
IMG="${PG_CLIENT_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "$SOURCE_CONTAINER")}"
[ -f "$SOURCE_ENV" ] || die 2 "fichier $SOURCE_ENV introuvable"
S_PASS="$(grep -m1 '^POSTGRES_PASSWORD=' "$SOURCE_ENV" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
[ -n "$S_PASS" ] || die 2 "POSTGRES_PASSWORD absent de $SOURCE_ENV"

src() {
  PGPASSWORD="$S_PASS" docker run --rm -i --network "$NET" \
    -e PGHOST="$SOURCE_CONTAINER" -e PGPORT=5432 -e PGUSER=postgres -e PGDATABASE=postgres \
    -e PGPASSWORD -e PGSSLMODE=disable -e PGAPPNAME=nexuscrm_reverse_sync -e PGCONNECT_TIMEOUT=15 \
    --entrypoint "" "$IMG" "$@"
}
dst() {
  PGHOST="$T_HOST" PGPORT="$T_PORT" PGUSER="$T_USER" PGPASSWORD="$T_PASS" PGDATABASE="$T_DB" \
  PGSSLMODE="$T_SSLMODE" docker run --rm -i --network "$NET" \
    -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE \
    -e PGAPPNAME=nexuscrm_reverse_sync -e PGCONNECT_TIMEOUT=15 \
    --entrypoint "" "$IMG" "$@"
}
q_src() { src psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }
q_dst() { dst psql -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

log "début ($MODE) : $SOURCE_CONTAINER → $T_HOST/$T_DB"

# ── Garde 3 : schémas identiques ─────────────────────────────────────────────
SCHEMA_SQL="SELECT c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
  || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY 1"
q_src "$SCHEMA_SQL" > "${STATE_DIR}/schema.source" || die 3 "lecture du schéma source impossible"
q_dst "$SCHEMA_SQL" > "${STATE_DIR}/schema.target" || die 3 "lecture du schéma cible impossible"
[ -s "${STATE_DIR}/schema.source" ] || die 3 "aucune table publique côté source"
if ! diff -u "${STATE_DIR}/schema.target" "${STATE_DIR}/schema.source" > "${STATE_DIR}/schema.diff"; then
  die 4 "les schémas divergent (gel du schéma non respecté) — voir ${STATE_DIR}/schema.diff"
fi

# ── Garde 4 : l'ancienne base n'a pas été écrite depuis la dernière copie ────
AUDIT_SQL_TAIL="SELECT id || '|' || extract(epoch FROM created_at)::text || '|' || md5(action || coalesce(entity_id, ''))
FROM public.audit_logs"
last_dst="$(q_dst "$AUDIT_SQL_TAIL ORDER BY id DESC LIMIT 1")" || die 5 "lecture d'audit_logs (cible) impossible"
if [ -n "$last_dst" ]; then
  last_id="${last_dst%%|*}"
  [[ "$last_id" =~ ^[0-9]+$ ]] || die 5 "identifiant d'audit inattendu"
  same_src="$(q_src "$AUDIT_SQL_TAIL WHERE id = ${last_id}")" || die 5 "lecture d'audit_logs (source) impossible"
  if [ "$same_src" != "$last_dst" ]; then
    if [ "$MODE" = preflight ]; then
      log "garde 4 : l'ancienne base a des écritures que le VPS n'a pas (audit_logs #${last_id}) — attendu tant que l'ancienne version tourne ; une copie serait REFUSÉE."
    else
      die 6 "l'ancienne base a reçu des écritures que le VPS n'a pas (audit_logs #${last_id}) — l'ancienne version tourne-t-elle encore ? Refus d'écraser."
    fi
  elif [ "$MODE" = preflight ]; then
    log "garde 4 : OK — dernière ligne d'audit de l'ancienne base (#${last_id}) présente à l'identique sur le VPS."
  fi
fi

if [ "$MODE" = preflight ]; then
  log "PRÉVOL OK — connexions, cible et schémas vérifiés ; rien n'a été écrit."
  exit 0
fi

# ── Instantané de la source ──────────────────────────────────────────────────
DUMP="${STATE_DIR}/dump.sql"
LOAD="${STATE_DIR}/load.sql"
cleanup() { rm -f "$LOAD" "${DUMP}.err"; }
trap cleanup EXIT

src pg_dump --data-only --schema=public --no-owner --no-privileges --no-comments \
  --quote-all-identifiers > "$DUMP" 2> "${DUMP}.err" || { cat "${DUMP}.err" >&2; die 7 "pg_dump a échoué"; }
if grep -q "circular" "${DUMP}.err"; then
  log "avertissement pg_dump : $(tr '\n' ' ' < "${DUMP}.err")"
fi

# ── Script de chargement : prélude + instantané + vérification ───────────────
END_STMT="COMMIT;"
[ "$MODE" = check ] && END_STMT="ROLLBACK;"

python3 -I - "$DUMP" "$LOAD" "$END_STMT" "${STATE_DIR}/expected-counts" <<'PY' || die 8 "préparation du chargement impossible"
import re, sys
dump_path, load_path, end_stmt, counts_path = sys.argv[1:5]
ident = re.compile(r'^COPY ("(?:[^"]|"")+"\."(?:[^"]|"")+") \(.*\) FROM stdin;$')
counts, order, current = {}, [], None
with open(dump_path, encoding="utf-8") as f:
    for line in f:
        line = line.rstrip("\n")
        if current is None:
            if line.startswith("COPY "):
                m = ident.match(line)
                if not m:
                    sys.exit(f"ligne COPY illisible : {line[:120]}")
                current = m.group(1)
                if current in counts:
                    sys.exit(f"table en double : {current}")
                counts[current] = 0
                order.append(current)
        elif line == "\\.":
            current = None
        else:
            counts[current] += 1
if current is not None:
    sys.exit("instantané tronqué (COPY sans fin)")
if not order:
    sys.exit("instantané sans aucune table")

prelude = r"""\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '60s';
CREATE TEMP TABLE _rs_triggers ON COMMIT DROP AS
  SELECT format('%I.%I', n.nspname, c.relname) AS tbl, t.tgname::text AS tg
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'D';
DO $rs$ DECLARE r record; BEGIN
  FOR r IN SELECT tbl, tg FROM pg_temp._rs_triggers LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.tbl, r.tg);
  END LOOP;
END $rs$;
DO $rs$ DECLARE l text; BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO l
  FROM pg_catalog.pg_tables WHERE schemaname = 'public';
  IF l IS NOT NULL THEN EXECUTE 'TRUNCATE TABLE ' || l; END IF;
END $rs$;
"""

checks = [
    "DO $rs$ DECLARE n bigint; t int; BEGIN",
    "  SELECT count(*) INTO t FROM pg_catalog.pg_tables WHERE schemaname = 'public';",
    f"  IF t <> {len(order)} THEN RAISE EXCEPTION 'reverse-sync: % tables cible, {len(order)} copiées', t; END IF;",
]
for tbl in order:
    label = tbl.replace("'", "''")
    checks.append(f"  SELECT count(*) INTO n FROM {tbl};")
    checks.append(
        f"  IF n <> {counts[tbl]} THEN RAISE EXCEPTION 'reverse-sync: {label} % lignes, {counts[tbl]} attendues', n; END IF;"
    )
checks.append("END $rs$;")

postlude = r"""
DO $rs$ DECLARE r record; BEGIN
  FOR r IN SELECT tbl, tg FROM pg_temp._rs_triggers LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', r.tbl, r.tg);
  END LOOP;
END $rs$;
"""

with open(load_path, "w", encoding="utf-8") as out:
    out.write(prelude)
    with open(dump_path, encoding="utf-8") as f:
        for chunk in iter(lambda: f.read(1 << 20), ""):
            out.write(chunk)
    out.write("\n" + "\n".join(checks) + "\n")
    out.write(postlude)
    out.write(end_stmt + "\n")

with open(counts_path, "w", encoding="utf-8") as c:
    for tbl in order:
        c.write(f"{tbl}\t{counts[tbl]}\n")
print(f"{len(order)} tables, {sum(counts.values())} lignes", file=sys.stderr)
PY

# ── Chargement : une seule transaction, tout ou rien ─────────────────────────
dst psql -X -q -v ON_ERROR_STOP=1 < "$LOAD" > "${STATE_DIR}/load.out" 2>&1 \
  || {
    # Seulement les lignes ERROR : CONTEXT/DETAIL recopient des rangées
    # (fiches clients) qui n'ont rien à faire dans le journal système.
    grep -E '(^|: )ERROR:' "${STATE_DIR}/load.out" | cut -c1-240 | tail -5 >&2 || true
    die 9 "chargement refusé — ROLLBACK, l'ancienne base est inchangée (détail : ${STATE_DIR}/load.out)"
  }

tables="$(wc -l < "${STATE_DIR}/expected-counts")"
rows="$(awk -F'\t' '{s+=$2} END {print s+0}' "${STATE_DIR}/expected-counts")"
if [ "$MODE" = check ]; then
  log "VÉRIFICATION OK — ${tables} tables, ${rows} lignes chargées puis annulées (ROLLBACK)."
else
  printf '{"at":"%s","tables":%s,"rows":%s}\n' "$(ts)" "$tables" "$rows" > "${STATE_DIR}/last-success"
  rm -f "${STATE_DIR}/last-failure"
  log "OK — ${tables} tables, ${rows} lignes copiées."
fi
# L'instantané contient toutes les fiches clients : on ne le garde pas.
rm -f "$DUMP"
