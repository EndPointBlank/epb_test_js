'use strict';

/**
 * POST /mesh/relay    — the sc-263 mesh call.
 * POST /mesh/reports  — the negative control, deliberately not granted.
 *
 * The hop-budget contract they implement lives in the deploy repository at
 * `docs/superpowers/specs/2026-09-08-hop-budget-contract.md`; the behaviour is
 * in `src/mesh/`. This file is the environment-configured instance of it, so
 * that it mounts exactly like the other route modules.
 *
 * `src/app.js` mounts it at `MESH_MOUNT`, not at a literal, because each route
 * forwards to the same path on the next application: where this router hangs is
 * part of the wire contract rather than a local naming choice.
 */

const { createMeshRouter } = require('../mesh/router');

module.exports = createMeshRouter();
