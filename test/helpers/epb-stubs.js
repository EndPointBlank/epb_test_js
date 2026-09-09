'use strict';

/**
 * Test doubles for the EndPointBlank SDK.
 *
 * The mesh routes sit behind the SDK's real `authorized` middleware — that is
 * the point of the mesh, so the tests must not swap it for a pass-through.
 * What they do swap is the one thing inside it that talks to the network:
 * `EndpointAuthorize.authorize`. Replacing that method on the SDK's exported
 * object leaves every other line of `authorized` running for real (path
 * resolution, version detection, the non-201 branch, the UnauthorizedError it
 * raises) while the suite stays offline.
 *
 * Nothing here writes to the SDK's files. The stubs mutate the objects the
 * SDK exports into this process and restore them afterwards.
 */

const { EndpointAuthorize } = require('end-point-blank-js/src/commands/endpoint-authorize');
const { RequestWriter } = require('end-point-blank-js/src/writers/request-writer');
const { ResponseWriter } = require('end-point-blank-js/src/writers/response-writer');
const { ExceptionWriter } = require('end-point-blank-js/src/writers/exception-writer');

/**
 * Makes the SDK's authorize call answer locally.
 *
 * @param {object} [options]
 * @param {number} [options.status] status the fake authorize service returns.
 *   201 authorizes; anything else is a refusal, exactly as intake's would be.
 * @param {string} [options.body] response body, used by the refusal path.
 * @returns {{calls: object[], restore: Function}}
 */
function stubAuthorize({ status = 201, body = '{"error":"access_denied"}' } = {}) {
  const original = EndpointAuthorize.authorize;
  const calls = [];

  EndpointAuthorize.authorize = async (req, path, version) => {
    calls.push({ path, version, method: req.method });
    if (status === 201) return { status: 201, ok: true };
    return {
      status,
      ok: false,
      text: async () => body,
      clone() { return this; },
    };
  };

  return {
    calls,
    restore() { EndpointAuthorize.authorize = original; },
  };
}

/**
 * Silences the SDK's telemetry writers.
 *
 * They are fire-and-forget POSTs to intake. Left alone in a test run they
 * cannot fail the assertions, but they do hold the process open through three
 * retry attempts per request and fill the output with connection errors.
 *
 * @returns {{restore: Function}}
 */
function stubWriters() {
  const originals = [
    [RequestWriter, 'write'],
    [ResponseWriter, 'write'],
    [ExceptionWriter, 'write'],
  ].map(([target, name]) => [target, name, target[name]]);

  for (const [target, name] of originals) {
    target[name] = async () => {};
  }

  return {
    restore() {
      for (const [target, name, original] of originals) target[name] = original;
    },
  };
}

/**
 * Makes the SDK mint an access token without intake.
 *
 * The mesh's outbound call builds its Authorization header with the SDK's own
 * `Authorization.header(url)` — the seam the contract requires, so that
 * cross-organization authorization is genuinely exercised rather than
 * bypassed. That call ends in `AccessTokens.token(url)`, which is the single
 * point where the SDK would reach intake. Stubbing it keeps the whole of the
 * real seam in the test and takes the network out of it.
 *
 * @param {string|null} token the token to hand back, or null to force the
 *   Basic fallback.
 * @returns {{restore: Function}}
 */
function stubAccessTokens(token = 'mesh-test-token') {
  const { AccessTokens } = require('end-point-blank-js/src/tokens/access-tokens');
  const original = AccessTokens.token;
  AccessTokens.token = async () => token;
  return { restore() { AccessTokens.token = original; } };
}

module.exports = { stubAuthorize, stubWriters, stubAccessTokens };
