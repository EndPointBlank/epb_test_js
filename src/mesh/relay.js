'use strict';

/**
 * The mesh relay handler: one hop of the sc-263 ring.
 *
 * Implements `docs/superpowers/specs/2026-09-08-hop-budget-contract.md` from
 * the deploy repository. In short:
 *
 *   n <= 0  answer, call nobody, `terminated: true`.
 *   n >  0  make exactly one downstream call carrying `n - 1`, then answer
 *           with that call's response nested verbatim.
 *
 * Two failures are deliberately not termination, and each has its own status:
 *
 *   500  `n > 0` and nothing is configured to call. A silent stop here would
 *        make a broken mesh look like a working one, and a load run against it
 *        would report clean numbers for traffic that never happened.
 *   502  the downstream call failed — refused, timed out, non-200. A refusal
 *        is the negative control's entire output; swallowing it into a 200
 *        would delete the measurement.
 */

const { parseHops, runIdentifier, HOPS_HEADER, RUN_HEADER } = require('./hops');
const { postJson } = require('./http-client');
const { downstreamAuthHeader } = require('./downstream-auth');

/** The repository name, per the contract. Not the hyphenated EPB_APP_NAME. */
const DEFAULT_APP_NAME = 'epb_test_js';

/** Appended to the configured base URL. The ring always calls the relay. */
const RELAY_PATH = '/mesh/relay';

/** The contract's ceiling on `downstream_error`. */
const MAX_ERROR_CHARS = 500;

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the Express handler shared by `/mesh/relay` and `/mesh/reports`.
 *
 * Every dependency is an option with a default, so the whole contract is
 * testable against local doubles: no staging, no AWS, no intake, no mesh.
 *
 * @param {object} [options]
 * @param {string|Function} [options.appName] reported as `app`.
 * @param {string|Function} [options.downstreamUrl] base URL of the next
 *   application; blank or absent means nothing is configured.
 * @param {Function} [options.authHeader] `(url) => Promise<string>`, the SDK
 *   authorization seam.
 * @param {Function} [options.postJson] the outbound HTTP call.
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @returns {Function} an Express handler.
 */
function createRelayHandler(options = {}) {
  const appName = resolver(options.appName, () => process.env.EPB_MESH_APP_NAME || DEFAULT_APP_NAME);
  const downstreamUrl = resolver(options.downstreamUrl, () => process.env.EPB_MESH_DOWNSTREAM_URL);
  const authHeader = options.authHeader || downstreamAuthHeader;
  const call = options.postJson || postJson;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  return async function meshRelay(req, res, next) {
    try {
      const app = appName();
      const hopsReceived = parseHops(req.headers[HOPS_HEADER]);
      const run = runIdentifier(req.headers[RUN_HEADER]);
      const payload = readPayload(req);

      if (hopsReceived <= 0) {
        return res.status(200).json({
          app,
          hops_received: hopsReceived,
          hops_forwarded: null,
          terminated: true,
          run,
          payload,
          downstream: null,
        });
      }

      const base = trimmed(downstreamUrl());
      if (!base) {
        // Loud, and distinguishable from an exhausted budget both here and in
        // the log. This is the one branch that must never be quietly friendly.
        console.error(
          `[mesh] ${app} received a hop budget of ${hopsReceived} with no ` +
          'EPB_MESH_DOWNSTREAM_URL configured. Refusing to answer as though ' +
          'the budget had been exhausted.',
        );
        return res.status(500).json({
          app,
          hops_received: hopsReceived,
          error: 'downstream_not_configured',
          missing_configuration: 'EPB_MESH_DOWNSTREAM_URL',
          message:
            'EPB_MESH_DOWNSTREAM_URL is not set, so this application has ' +
            `nowhere to forward a hop budget of ${hopsReceived} to.`,
        });
      }

      const target = `${base.replace(/\/+$/, '')}${RELAY_PATH}`;
      const hopsForwarded = hopsReceived - 1;

      const headers = { [HOPS_HEADER]: String(hopsForwarded) };
      // Absent means forward nothing, rather than forwarding an empty header.
      if (run !== null) headers[RUN_HEADER] = run;
      headers.authorization = await authHeader(target);

      let response;
      try {
        response = await call(target, {
          headers,
          body: JSON.stringify(payload === null ? {} : { payload }),
          connectTimeoutMs,
          requestTimeoutMs,
        });
      } catch (err) {
        // No status: the call never landed.
        return failed(res, app, hopsReceived, null, err.message);
      }

      if (response.status !== 200) {
        return failed(res, app, hopsReceived, response.status, response.body);
      }

      let downstream;
      try {
        downstream = JSON.parse(response.body);
      } catch {
        return failed(
          res, app, hopsReceived, response.status,
          `downstream answered 200 with a body that is not JSON: ${response.body}`,
        );
      }

      return res.status(200).json({
        app,
        hops_received: hopsReceived,
        hops_forwarded: hopsForwarded,
        terminated: false,
        run,
        payload,
        downstream,
      });
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * The 502. A downstream refusal is a result to report, never one to swallow.
 */
function failed(res, app, hopsReceived, downstreamStatus, message) {
  const downstreamError = truncate(String(message ?? ''), MAX_ERROR_CHARS);
  console.error(
    `[mesh] ${app} downstream call failed ` +
    `(status ${downstreamStatus === null ? 'none' : downstreamStatus}): ${downstreamError}`,
  );
  return res.status(502).json({
    app,
    hops_received: hopsReceived,
    error: 'downstream_failed',
    downstream_status: downstreamStatus,
    downstream_error: downstreamError,
  });
}

/**
 * The echoed payload, or null.
 *
 * The body may be `{}`, absent entirely, or never parsed at all when the
 * caller sent no JSON content type — all of which the contract requires this
 * to accept.
 */
function readPayload(req) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body.payload === undefined ? null : body.payload;
}

/**
 * Accepts a value or a getter, and always answers with a getter.
 *
 * Only `undefined` — the option not being supplied at all — falls back to the
 * environment. An explicit `null` means "deliberately nothing", which is how a
 * test builds the last node of a chain.
 */
function resolver(value, fallback) {
  if (typeof value === 'function') return value;
  if (value === undefined) return fallback;
  return () => value;
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value;
}

module.exports = { createRelayHandler, RELAY_PATH, MAX_ERROR_CHARS };
