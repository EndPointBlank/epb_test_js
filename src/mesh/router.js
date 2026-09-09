'use strict';

/**
 * The two mesh endpoints, mounted at {@link MESH_MOUNT}.
 *
 *   POST /mesh/relay    the `core` API package — the mesh call itself.
 *   POST /mesh/reports  the `reports` package — the negative control. Same
 *                       shape, same behaviour; it exists so that an
 *                       authorization refusal can be observed, and sc-263
 *                       deliberately does not grant it.
 *
 * Both sit behind `authorized`, the SDK middleware the demo CRUD routes use.
 * That is the point of the mesh: an unprotected relay would prove nothing,
 * because the thing being measured is cross-organization authorization.
 * `versioned(['1'])` matches the demo routes too, so the registrar publishes
 * these endpoints and a grant can be written against them.
 *
 * The two differ in exactly one respect: **the path is preserved across hops**,
 * so each route forwards to the same path on the next application rather than
 * both funnelling into `/mesh/relay`. If `reports` were wrongly granted at hop
 * one, forwarding it to `relay` would convert that provisioning error into
 * ordinary successful traffic and the run would look clean. This file is
 * therefore the single place the pairing lives: the route registered and the
 * path forwarded to are derived from one list, so they cannot drift apart.
 */

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { createRelayHandler } = require('./relay');

/**
 * Where this router is mounted. The forwarded path is this plus the route, so
 * `src/app.js` and the tests mount using this constant rather than a literal:
 * mounting it elsewhere would send every hop to a path the ring does not serve.
 */
const MESH_MOUNT = '/mesh';

/** The inbound routes, per the contract's "Inbound endpoints" table. */
const MESH_ROUTES = Object.freeze(['/relay', '/reports']);

/**
 * The absolute path a request that arrived on *route* forwards to — the same
 * path it was itself called on.
 *
 * @param {string} route one of {@link MESH_ROUTES}.
 * @returns {string}
 */
function forwardPathFor(route) {
  return `${MESH_MOUNT}${route}`;
}

/**
 * @param {object} [options] passed to {@link createRelayHandler}. Defaults
 *   read `EPB_MESH_DOWNSTREAM_URL` and `EPB_MESH_APP_NAME` per request.
 *   `forwardPath` is set per route and cannot be overridden here.
 * @returns {import('express').Router}
 */
function createMeshRouter(options = {}) {
  const router = Router();

  for (const route of MESH_ROUTES) {
    const relay = createRelayHandler({ ...options, forwardPath: forwardPathFor(route) });
    router.post(route, authorized, versioned(['1']), relay);
  }

  return router;
}

module.exports = { createMeshRouter, MESH_MOUNT };
