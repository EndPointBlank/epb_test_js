#!/usr/bin/env bash
set -o errexit

cd "$(dirname "$0")"

# Local dev only: create the database if it doesn't exist. Tables are created
# on app startup by `dbSetup()` (CREATE TABLE IF NOT EXISTS).
if [ -z "$DATABASE_URL" ]; then
    PGPASSWORD="${PGPASSWORD:-postgres}" createdb \
        -h "${PGHOST:-localhost}" \
        -U "${PGUSER:-postgres}" \
        epb_test_js_development 2>/dev/null || true
fi

npm install

# npm pins git deps by SHA in package-lock.json and won't re-resolve when the
# package version is unchanged. Drop and reinstall end-point-blank-js so a
# fresh master commit gets picked up.
rm -rf node_modules/end-point-blank-js
npm uninstall end-point-blank-js --silent
npm install end-point-blank-js@git+https://github.com/EndPointBlank/end_point_blank_js.git
