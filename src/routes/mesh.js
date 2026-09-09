'use strict';

/**
 * POST /mesh/relay    — the sc-263 mesh call.
 * POST /mesh/reports  — the negative control, deliberately not granted.
 *
 * The hop-budget contract they implement lives in the deploy repository at
 * `docs/superpowers/specs/2026-09-08-hop-budget-contract.md`; the behaviour is
 * in `src/mesh/`. This file is the environment-configured instance of it, so
 * that it mounts exactly like the other route modules.
 */

const { createMeshRouter } = require('../mesh/router');

module.exports = createMeshRouter();
