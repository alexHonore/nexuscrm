#!/usr/bin/env bash
# ── Écritures faites sur le VPS depuis la dernière recopie ancienne → nouvelle ──
#
#   trial-writes.sh            liste, table par table, les lignes créées ou
#                              modifiées sur l'instance nexuscrm depuis la
#                              dernière recopie
#   trial-writes.sh --export   idem, puis les exporte et prépare reapply.sql dans
#                              /srv/supabase/apps/nexuscrm/trial-writes/<horodatage>/
#
# Pourquoi : AVANT la bascule, la recopie finale (migrate-from-url.sh --resync)
# VIDE la base du VPS puis la recharge depuis l'ancienne. Ce qui a été saisi
# sur le site d'essai disparaîtrait sans bruit (une sauvegarde est prise, mais
# rien ne le signale). Lancer --export juste AVANT cette recopie, puis
# appliquer reapply.sql juste APRÈS (README §6, étape 4).
#
# reapply.sql = une seule transaction ; tables dans l'ordre des clés
# étrangères ; par table, INSERT … ON CONFLICT (id) :
#   - table avec updated_at : la ligne de l'essai ne remplace celle de la base
#     que si elle est PLUS RÉCENTE (une modification faite entre-temps dans
#     l'ancienne version gagne) ;
#   - sinon : insérée si absente, jamais écrasée.
# audit_logs est exporté pour mémoire mais pas ré-appliqué (ses identifiants
# entiers entreraient en collision avec ceux de l'ancienne base).
#
# Non détecté : les SUPPRESSIONS, et les tables sans created_at / updated_at
# (listées à la fin). Lecture seule sur la base ; n'écrit que dans trial-writes/.
set -Eeuo pipefail
umask 077

CONTAINER="${SOURCE_CONTAINER:-sb-nexuscrm-db-1}"
DUMPS="${DUMPS_DIR:-/srv/supabase/dumps/nexuscrm}"
OUT_ROOT="${OUT_ROOT:-/srv/supabase/apps/nexuscrm/trial-writes}"
SKIP_REAPPLY="audit_logs"

EXPORT=0
case "${1:-}" in
  "") ;;
  --export) EXPORT=1 ;;
  -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--export]" >&2; exit 2 ;;
esac

# ── Repère : SINCE=… (UTC), sinon le dossier de la dernière recopie ──────────
if [ -z "${SINCE:-}" ]; then
  last="$(basename "$(readlink -f "$DUMPS/latest" 2>/dev/null || true)")"
  [[ "$last" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$ ]] \
    || { echo "dernière recopie introuvable dans $DUMPS — SINCE='AAAA-MM-JJ HH:MM:SS' (UTC) pour la donner" >&2; exit 2; }
  SINCE="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
fi
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || { echo "SINCE invalide : $SINCE" >&2; exit 2; }

# SQL sur stdin (les variables psql :'x' ne marchent pas avec -c).
q() { docker exec -i "$CONTAINER" psql -U postgres -X -q -At -v ON_ERROR_STOP=1 "$@"; }

# Tables publiques horodatées, parents avant enfants (profondeur de clés étrangères).
TABLES="$(q -F ' ' <<'SQL'
with recursive fk as (
  select conrelid::regclass::text as child, confrelid::regclass::text as parent
  from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace and conrelid <> confrelid
), depth(t, d) as (
  select relname::text, 0 from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
  union all
  select fk.child, depth.d + 1 from fk join depth on fk.parent = depth.t where depth.d < 50
), ts as (
  select table_name::text as t,
         string_agg(column_name, ',' order by column_name) as cols,
         bool_or(column_name = 'updated_at') as has_upd
  from information_schema.columns
  where table_schema = 'public' and column_name in ('created_at', 'updated_at') and data_type like 'timestamp%'
  group by table_name
)
select ts.t, ts.cols, ts.has_upd from ts join (select t, max(d) as d from depth group by t) dd using (t) order by dd.d, ts.t;
SQL
)"
UNWATCHED="$(q <<'SQL'
select coalesce(string_agg(c.relname, ', ' order by c.relname), 'aucune') from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  and not exists (select 1 from information_schema.columns i where i.table_schema = 'public' and i.table_name = c.relname
                  and i.column_name in ('created_at', 'updated_at') and i.data_type like 'timestamp%');
SQL
)"

echo "repère (dernière recopie, UTC) : $SINCE"
if [ "$EXPORT" = 1 ]; then
  OUT="$OUT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"; chmod 700 "$OUT_ROOT" "$OUT"
  TAG="tw_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  printf -- '-- Écritures du VPS depuis %s (UTC), exportées le %s.\n-- Appliquer APRÈS la recopie finale : docker exec -i %s psql -U postgres -v ON_ERROR_STOP=1 < reapply.sql\nBEGIN;\n' \
    "$SINCE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CONTAINER" > "$OUT/reapply.sql"
fi

total=0; reapplied=0
while read -r t cols has_upd; do
  [ -n "$t" ] || continue
  cond="$(tr ',' '\n' <<< "$cols" | sed "s/.*/\"&\" > :'since'::timestamptz/" | paste -sd'|' | sed 's/|/ or /g')"
  n="$(q -v since="$SINCE" <<< "select count(*) from public.\"$t\" where $cond;")"
  [ "$n" -gt 0 ] || continue
  total=$((total + n))
  note=""; [[ " $SKIP_REAPPLY " == *" $t "* ]] && note="  (exportée pour mémoire, pas ré-appliquée)"
  printf '  %-28s %s ligne(s)%s\n' "$t" "$n" "$note"
  [ "$EXPORT" = 1 ] || continue
  q -v since="$SINCE" <<< "select to_jsonb(x)::text from public.\"$t\" x where $cond order by 1;" > "$OUT/$t.jsonl"
  [ -z "$note" ] || continue
  pk="$(q <<< "select string_agg(a.attname, ',') from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'public.\"$t\"'::regclass and i.indisprimary;")"
  if [ "$pk" != "id" ]; then echo "    ⚠ clé primaire « $pk » (pas « id ») : exportée, PAS dans reapply.sql — à traiter à la main"; continue; fi
  all="$(q <<< "select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute where attrelid = 'public.\"$t\"'::regclass and attnum > 0 and not attisdropped and attgenerated = '';")"
  upd="$(q <<< "select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute where attrelid = 'public.\"$t\"'::regclass and attnum > 0 and not attisdropped and attgenerated = '' and attname <> 'id';")"
  json="[$(paste -sd, "$OUT/$t.jsonl")]"
  [[ "$json" != *"\$$TAG\$"* ]] || { echo "étiquette de citation présente dans les données — relancer" >&2; exit 3; }
  {
    printf -- '-- %s : %s ligne(s)\n' "$t" "$n"
    printf 'INSERT INTO public."%s" (%s)\nSELECT %s FROM jsonb_populate_recordset(NULL::public."%s", $%s$%s$%s$::jsonb)\n' "$t" "$all" "$all" "$t" "$TAG" "$json" "$TAG"
    if [ "$has_upd" = t ] && [ -n "$upd" ]; then
      printf 'ON CONFLICT (id) DO UPDATE SET (%s) = ROW(%s)\n  WHERE public."%s".updated_at IS NULL OR public."%s".updated_at < excluded.updated_at;\n' \
        "$upd" "$(sed 's/\([^, ][^,]*\)/excluded.\1/g' <<< "$upd")" "$t" "$t"
    else
      printf 'ON CONFLICT (id) DO NOTHING;\n'
    fi
  } >> "$OUT/reapply.sql"
  reapplied=$((reapplied + 1))
done <<< "$TABLES"

[ "$total" -gt 0 ] || echo "  aucune écriture depuis la dernière recopie."
echo "non surveillées (sans created_at / updated_at — suppressions non plus) : $UNWATCHED"
if [ "$EXPORT" = 1 ]; then
  echo "COMMIT;" >> "$OUT/reapply.sql"
  echo "exporté : $OUT ($(cd "$OUT" && ls | tr '\n' ' '))"
  echo "reapply.sql : $reapplied table(s). Après la recopie finale :"
  echo "  docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 < $OUT/reapply.sql"
fi
