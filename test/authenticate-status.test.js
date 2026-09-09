'use strict';

/**
 * What the caller is told when intake refuses an `authenticated` route.
 *
 * This file exists because of a hole rather than a feature. Every route in
 * every one of the five epb_test_* applications sat behind `authorized`, so
 * nothing anywhere called the SDK's `authenticated` guard. The two guards are
 * two transcriptions of one decision, and for two releases only one of them
 * carried intake's refusal status: `authorized` passed 403 through, while
 * `authenticated` handed every refusal to the caller as 401 (sc-307). No test
 * went red, because no test -- and no application -- called the second one.
 *
 * A conformance count over these apps could not have caught it either. A
 * pass/fail tally cannot see a code path nothing calls, so the test that was
 * missing is not another assertion about `authorized`; it is a route that
 * calls the other guard, and an assertion about what comes back out of it.
 *
 * Nothing in the SDK is stubbed here. `startStubIntake` puts a real server on
 * loopback and points the SDK at it, so the status travels the whole real
 * distance -- socket, `_http.post`, `BasicAuthenticate`, the guard,
 * `refusalFrom`, the app's error handler -- exactly as it would in production.
 * Doubling the SDK's command objects instead would stub out the very layer
 * that reads the status, which is how this bug stayed invisible.
 *
 * The contract, from the SDK's own `refusalFrom`:
 *
 *   intake answered 401        -> caller sees 401  (re-check the credential)
 *   intake answered 403        -> caller sees 403  (ask for a grant)
 *   intake answered any non-201-> caller sees that status, verbatim
 *   intake did not answer      -> caller sees 503  (nothing judged this caller)
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { stubWriters } = require('./helpers/epb-stubs');
const { startStubIntake, pointAtUnreachableIntake } = require('./helpers/stub-intake');

// Both before requiring the app: the writers so telemetry never leaves the
// machine, and the TTL because `EndpointAuthorize` caches a decision for five
// minutes by default, which would let one test's answer serve the next one's
// request. `authenticated` has no cache of its own -- `authentication-cache` is
// wired only into `endpoint-authorize` -- but the parity test drives both.
const writers = stubWriters();
process.env.EPB_CACHE_TTL = '0';
after(() => writers.restore());

const app = require('../src/app');

async function serve(t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A fresh credential per call, so no cached decision can answer for intake. */
let credential = 0;
async function call(url, path) {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Basic caller-${++credential}` },
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body, text };
}

// --------------------------------------------------------------------------
// The route exists and goes through the guard
// --------------------------------------------------------------------------

test('GET /whoami is served when intake accepts the credential', async (t) => {
  const intake = await startStubIntake({ status: 201, body: '{}' });
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  assert.equal(response.body.application, 'epb-test-js');
  assert.equal(intake.calls.length, 1, 'intake must actually be consulted');
});

test('GET /whoami really does go through the authenticate path', async (t) => {
  const intake = await startStubIntake({ status: 201, body: '{}' });
  t.after(() => intake.stop());
  const url = await serve(t);

  await call(url, '/whoami');

  // `BasicAuthenticate` forwards the caller's own Authorization header as
  // `client_auth`; `EndpointAuthorize` does too, but only this path is reached
  // by a route with no `authorized` on it. The route's presence in app.js is
  // what makes the guard reachable at all, so assert the wire, not the import.
  const [only] = intake.calls;
  assert.equal(only.url, '/api/authorize');
  assert.equal(only.action, 'GET');
  assert.match(only.clientAuth, /^Basic caller-/);
});

// --------------------------------------------------------------------------
// The contract: intake's own status, not a blanket 401
// --------------------------------------------------------------------------

test('a 403 from intake reaches the caller as 403, not 401', async (t) => {
  const intake = await startStubIntake({
    status: 403,
    body: '{"error":"access_denied"}',
  });
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 403,
    'the whole point of sc-307: 403 means ask for a grant, 401 means re-check ' +
    'the credential, and collapsing them sends integrators to debug the wrong thing');
  assert.match(response.body.error, /Authentication failed/);
  assert.match(response.body.error, /access_denied/,
    "intake's reason must survive too, not just its status");
});

test('a 401 from intake still reaches the caller as 401', async (t) => {
  const intake = await startStubIntake({
    status: 401,
    body: '{"error":"invalid_credentials"}',
  });
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 401);
  assert.match(response.body.error, /invalid_credentials/);
});

test('an unreachable intake reaches the caller as 503, not 401', async (t) => {
  const intake = await pointAtUnreachableIntake();
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 503,
    'nothing judged this caller, so 401 would blame a credential no one looked at');
  assert.match(response.body.error, /Authentication failed/);
});

test("any other status intake invents is passed through verbatim", async (t) => {
  const intake = await startStubIntake({ status: 429, body: '{"error":"slow down"}' });
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 429,
    'the guard forwards intake\'s verdict rather than classifying it');
});

test('a non-JSON refusal body still yields intake\'s status and its text', async (t) => {
  // A proxy in front of intake answers HTML, not JSON. The pre-sc-307 code read
  // the body twice -- json() then text() on one consumed stream -- so the second
  // read could only fail and the message degraded to a generic string.
  const intake = await startStubIntake({ status: 502, body: '<html>bad gateway</html>' });
  t.after(() => intake.stop());
  const url = await serve(t);

  const response = await call(url, '/whoami');

  assert.equal(response.status, 502);
  assert.match(response.text, /bad gateway/,
    'the raw body is the only diagnostic there is when it is not JSON');
});

// --------------------------------------------------------------------------
// Parity: the two guards must answer one refusal the same way
// --------------------------------------------------------------------------

test('both guards give the caller the same status for the same refusal', async (t) => {
  // The regression test for sc-307 proper. One intake, one answer, two routes:
  // /whoami goes through `authenticated`, /books through `authorized`. Before
  // the fix these returned 401 and 403 for one identical refusal.
  for (const status of [401, 403, 429]) {
    const intake = await startStubIntake({ status, body: '{"error":"access_denied"}' });
    // try/finally, not a trailing stop(): a failing assertion below would skip
    // the stop and leave the stub's socket open, which holds the whole run
    // alive long after the failure is known. Found the honest way -- by running
    // this file against the pre-fix SDK, where it does fail.
    try {
      const url = await serve(t);

      const viaAuthenticate = await call(url, '/whoami');
      const viaAuthorize = await call(url, '/books');

      assert.equal(viaAuthenticate.status, status, `authenticate lost intake's ${status}`);
      assert.equal(viaAuthorize.status, status, `authorize lost intake's ${status}`);
      assert.equal(viaAuthenticate.status, viaAuthorize.status,
        `the two guards disagree about a ${status} from intake`);
    } finally {
      await intake.stop();
    }
  }
});

test('both guards answer 503 when intake cannot be reached', async (t) => {
  const intake = await pointAtUnreachableIntake();
  t.after(() => intake.stop());
  const url = await serve(t);

  const viaAuthenticate = await call(url, '/whoami');
  const viaAuthorize = await call(url, '/books');

  assert.equal(viaAuthenticate.status, 503);
  assert.equal(viaAuthorize.status, 503);
});

// --------------------------------------------------------------------------
// The endpoint path the guard reports
// --------------------------------------------------------------------------

test('the path sent to intake for /whoami is /whoami', async (t) => {
  // Registration and authorization must produce byte-identical paths or intake
  // answers `missing_target_endpoint` for every request (see the SDK's
  // `request-path.js`). `authenticated` builds the path itself --
  // `req.route?.path || req.path || req.url` -- instead of using the shared
  // `requestPath(req)`, so it never prefixes `req.baseUrl`. That is fine here
  // only because the route is mounted on `app` rather than on a router, which
  // is why app.js mounts it that way. This asserts the property that placement
  // buys; it is not a claim that the guard would get a mounted route right.
  const intake = await startStubIntake({ status: 201, body: '{}' });
  t.after(() => intake.stop());
  const url = await serve(t);

  await call(url, '/whoami');

  assert.equal(intake.calls[0].path, '/whoami');
});
