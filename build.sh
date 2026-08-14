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

# The SDK comes from package.json, which pins an exact tag. There used to be a
# drop-and-reinstall from master here: package.json tracked the SDK's default
# branch, and npm won't re-resolve a git dep whose version string is unchanged
# even though the source moved underneath it.
#
# That reinstall named the repo directly with no ref, so it overrode the pin --
# this script installed master no matter what package.json said, and a deploy
# could not reproduce a known-good SDK. The early-warning it provided is now the
# `sdk-canary` job in .github/workflows/ci.yml, which installs from master, is
# allowed to fail, and does not decide what this build ships.
