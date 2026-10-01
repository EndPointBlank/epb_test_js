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
 *
 * A 502 also carries `origin`: who actually refused, readable at the entry
 * point. See {@link failureOrigin} — it is the one rule here that fails
 * silently and plausibly when it is got wrong.
 */

const { parseHops, runIdentifier, HOPS_HEADER, RUN_HEADER } = require('./hops');
const { postJson } = require('./http-client');
const { downstreamAuthHeader } = require('./downstream-auth');

/** The repository name, per the contract. Not the hyphenated EPB_APP_NAME. */
const DEFAULT_APP_NAME = 'epb_test_js';

/**
 * Appended to the configured base URL when nothing else is supplied.
 *
 * The path a hop forwards to is the path it was itself called on: `/mesh/relay`
 * forwards to the next application's `/mesh/relay`, and `/mesh/reports`
 * forwards to its `/mesh/reports`. The router supplies the right one per route;
 * this is only the default for a handler built without one.
 */
const DEFAULT_FORWARD_PATH = '/mesh/relay';

/** The contract's ceiling on `downstream_error`. */
const MAX_ERROR_CHARS = 500;

/**
 * The contract's ceiling on `origin.error`, deliberately far below
 * {@link MAX_ERROR_CHARS}. `origin` exists because a nested error truncates
 * away with depth; a reason long enough to be truncated inside `origin` would
 * reintroduce the very problem, so it is short by construction and never
 * nested.
 */
const MAX_ORIGIN_ERROR_CHARS = 200;

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the Express handler for one mesh endpoint.
 *
 * `/mesh/relay` and `/mesh/reports` behave identically apart from the path they
 * forward to, which is the path they were called on, so the router builds one
 * of these per route rather than sharing a single handler between them.
 *
 * Every dependency is an option with a default, so the whole contract is
 * testable against local doubles: no staging, no AWS, no intake, no mesh.
 *
 * @param {object} [options]
 * @param {string|Function} [options.appName] reported as `app`.
 * @param {string|Function} [options.downstreamUrl] base URL of the next
 *   application; blank or absent means nothing is configured.
 * @param {string} [options.forwardPath] the absolute path appended to that base
 *   URL. Defaults to `/mesh/relay`.
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
  const forwardPath = options.forwardPath || DEFAULT_FORWARD_PATH;
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
        // No `origin` here, and no `terminated`. `origin` names the hop whose
        // own downstream call failed, and this hop made no call at all; the
        // hop above sees this 500, finds no origin in it, and mints one naming
        // itself and status 500 — which is the correct attribution, because an
        // unconfigured node is a fact about the edge into it.
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

      // The path is PRESERVED across hops. `/mesh/reports` is a negative
      // control on an API package sc-263 deliberately does not grant, and
      // forwarding it to `/mesh/relay` would turn a wrongly granted `reports`
      // at hop one into ordinary successful relay traffic -- a provisioning
      // error rendered invisible, on the very endpoint that exists to catch it.
      // Preserving the path keeps it failing, and loud, at every hop.
      const target = `${base.replace(/\/+$/, '')}${forwardPath}`;
      const hopsForwarded = hopsReceived - 1;

      const headers = { [HOPS_HEADER]: String(hopsForwarded) };
      // Absent means forward nothing, rather than forwarding an empty header.
      if (run !== null) headers[RUN_HEADER] = run;
      try {
        headers.authorization = await authHeader(target);
      } catch (err) {
        // No token for the downstream target. Since end-point-blank-js 0.12.0
        // (sc-1469) the SDK throws TokenUnavailableError here instead of
        // falling back to Basic with this application's own credentials. That
        // fallback used to reach the downstream and come back as a refusal, so
        // this hop answered 502 naming itself; a bare 500 from `next(err)`
        // would instead be attributed by the hop above to itself. No call was
        // made, so there is no downstream status.
        if (err && err.name === 'TokenUnavailableError') {
          return failed(res, {
            app, hopsReceived, status: null, message: err.message, body: null,
          });
        }
        throw err;
      }

      let response;
      try {
        response = await call(target, {
          headers,
          body: JSON.stringify(payload === null ? {} : { payload }),
          connectTimeoutMs,
          requestTimeoutMs,
        });
      } catch (err) {
        // No status, and no body to inherit an origin from: the call never
        // landed, so this hop is necessarily the origin of the failure.
        return failed(res, {
          app, hopsReceived, status: null, message: err.message, body: null,
        });
      }

      if (response.status !== 200) {
        return failed(res, {
          app, hopsReceived, status: response.status,
          message: response.body, body: response.body,
        });
      }

      let downstream;
      try {
        downstream = JSON.parse(response.body);
      } catch {
        // A body that is not JSON cannot be carrying an `origin`, but it is
        // passed anyway rather than special-cased: one path through
        // `failureOrigin` is one fewer place for the non-overwrite rule to be
        // implemented differently.
        return failed(res, {
          app, hopsReceived, status: response.status,
          message: `downstream answered 200 with a body that is not JSON: ${response.body}`,
          body: response.body,
        });
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
 *
 * `downstream_status` and `downstream_error` keep their per-hop meaning
 * exactly: they describe the call *this* application made. `origin` is the
 * end-to-end companion to them, and the two answer different questions —
 * a 403 next door and a 403 four hops away must stay distinguishable.
 *
 * @param {import('express').Response} res
 * @param {object} failure
 * @param {string} failure.app this application's own name.
 * @param {number} failure.hopsReceived this hop's own parsed budget.
 * @param {number|null} failure.status the downstream HTTP status, or null when
 *   there was none: a connect error or a timeout.
 * @param {string} failure.message the per-hop reason, truncated into
 *   `downstream_error` at {@link MAX_ERROR_CHARS}.
 * @param {string|null} failure.body the raw downstream response body, which is
 *   where an `origin` set further down the chain arrives.
 */
function failed(res, { app, hopsReceived, status, message, body }) {
  const downstreamError = truncate(String(message ?? ''), MAX_ERROR_CHARS);
  const origin = failureOrigin({ app, hopsReceived, status, message, body });

  console.error(
    `[mesh] ${app} downstream call failed ` +
    `(status ${status === null ? 'none' : status}): ${downstreamError} ` +
    `[origin ${origin.app} status ${origin.status === null ? 'none' : origin.status}]`,
  );

  return res.status(502).json({
    app,
    hops_received: hopsReceived,
    error: 'downstream_failed',
    downstream_status: status,
    downstream_error: downstreamError,
    origin,
  });
}

/**
 * The `origin` object: **who refused**, recoverable at the entry point.
 *
 * `downstream_status` is per-hop, so the original status only rides up nested
 * inside `downstream_error` — and that nesting does not survive depth. Each hop
 * truncates the nested error to 500 characters against roughly 110 characters
 * of envelope per level, so the far side of a five-node ring is truncated away
 * by the time it reaches the entry point. Those are exactly the refusals sc-265
 * must count, so it counts them off this field and never off the nested walk.
 *
 * **Set once, by the hop whose own downstream call failed — the observer, not
 * the refuser.** The observer is the only participant that reliably knows both
 * the status it received and its own identity; the refuser may not even have
 * run any of our code.
 *
 * **Then forwarded verbatim by every hop above.** An `origin` already present
 * in a downstream failure body is returned unchanged, so the first failure
 * going up wins and that one is the deepest. Overwriting it is the mistake this
 * function exists to make impossible: it would not raise anything, it would
 * simply name the wrong application, and every hop above would repeat the lie
 * with total confidence.
 *
 * Two shape guards, both load-bearing in JavaScript:
 *
 *   * the body may be JSON that is not an object — `null`, a number, an array.
 *     `JSON.parse('null').origin` throws, and `['x'].origin` is quietly
 *     `undefined`, so the body's shape is checked before it is read at all.
 *   * `origin` itself may be present without being the contract's object. A
 *     string `origin` (a CORS-flavoured error body will have one) is not an
 *     origin to forward, and shipping it would hand sc-265 a field it cannot
 *     read. Only a plain object is inherited; anything else means this hop is
 *     the deepest that reported one, and it mints its own.
 *
 * @returns {{app: string, status: number|null, hops_received: number, error: string}}
 */
function failureOrigin({ app, hopsReceived, status, message, body }) {
  const parsed = parseJsonObject(body);

  const inherited = parsed === null ? null : parsed.origin;
  if (isPlainObject(inherited)) return inherited;

  // A JSON error body's own `error` is already the short reason this field
  // wants ("access_denied", "downstream_not_configured"); the raw body or the
  // transport error is the fallback when there is no such field.
  const reason = parsed !== null && typeof parsed.error === 'string' && parsed.error !== ''
    ? parsed.error
    : String(message ?? '');

  return {
    app,
    status,
    hops_received: hopsReceived,
    error: truncate(reason, MAX_ORIGIN_ERROR_CHARS),
  };
}

/**
 * The body parsed into a plain object, or null if it is neither.
 *
 * Anything that is not JSON, and any JSON that is not an object — `null`,
 * `true`, `4`, `"text"`, `[…]` — answers null rather than something a property
 * can be read off.
 *
 * @param {string|null} body
 * @returns {object|null}
 */
function parseJsonObject(body) {
  if (typeof body !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** True for a JSON object, false for null and for an array. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

module.exports = {
  createRelayHandler,
  DEFAULT_FORWARD_PATH,
  MAX_ERROR_CHARS,
  MAX_ORIGIN_ERROR_CHARS,
};
