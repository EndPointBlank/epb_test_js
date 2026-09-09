'use strict';

/**
 * The two mesh endpoints, mounted at `/mesh`.
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
 */

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { createRelayHandler } = require('./relay');

/**
 * @param {object} [options] passed to {@link createRelayHandler}. Defaults
 *   read `EPB_MESH_DOWNSTREAM_URL` and `EPB_MESH_APP_NAME` per request.
 * @returns {import('express').Router}
 */
function createMeshRouter(options = {}) {
  const router = Router();
  const relay = createRelayHandler(options);

  router.post('/relay', authorized, versioned(['1']), relay);
  router.post('/reports', authorized, versioned(['1']), relay);

  return router;
}

module.exports = { createMeshRouter };
