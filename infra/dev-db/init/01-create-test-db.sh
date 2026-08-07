#!/bin/sh
# Exécuté UNE SEULE FOIS, à la première initialisation du volume Postgres.
# Crée la base dédiée aux tests à côté de la base de développement.
# (tests/setup.ts refuse de démarrer si DATABASE_URL ne contient pas
# « nexus_test » — c'est le garde-fou qui protège la production.)
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE nexus_test OWNER $POSTGRES_USER;
EOSQL

echo "nexus-devdb: bases « $POSTGRES_DB » et « nexus_test » prêtes."
