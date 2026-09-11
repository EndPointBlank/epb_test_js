'use strict';

/**
 * A real intake, on loopback, for the length of one test.
 *
 * `epb-stubs.js` doubles intake by replacing the SDK's command objects. That is
 * the right tool for the mesh suite -- it keeps the whole of `authorized`
 * running while taking the network out -- but it cannot answer the question
 * sc-307 turned on, which is what the *client* receives when intake refuses.
 * Replacing `EndpointAuthorize.authorize` or `BasicAuthenticate.authenticate`
 * stubs out the very layer that reads intake's status, so a bug that loses the
 * status between the socket and the caller is invisible to it. That is not
 * hypothetical: it is precisely the bug that survived two releases here.
 *
 * So this helper stubs nothing. It stands up an HTTP server on 127.0.0.1 and
 * points `epb.config.baseUrl` at it, exactly as `MeshAuthorizationTest` does on
 * the Java side. Every line of the SDK runs for real -- `_http.post`, the
 * retry loop, `Authorization.header()`, `BasicAuthenticate`, `EndpointAuthorize`,
 * the guards, `refusalFrom` -- and only the far end of the socket is ours.
 *
 * Both guards POST to `${baseUrl}/api/authorize`, so one stub serves both and
 * the two paths can be compared against a single answer.
 */

const http = require('node:http');
const { once } = require('node:events');
const epb = require('end-point-blank-js');

/**
 * What intake answers a granted `POST /api/authorize` with.
 *
 * The field names are intake's, from `AuthorizationJSON.show/1` (intake
 * `lib/intake_web/controllers/authorization_json.ex`), pinned by its
 * `authorization_controller_test.exs` ("POST /api/authorize — authorized"): the
 * grant sits under `data`, one entry with exactly these four keys. A
 * `deprecation` block is added only when the called version is deprecated, so
 * the default leaves it out. The values are stand-ins.
 *
 * This used to be `{}`. The SDK this app pins reads only `deprecation` from a
 * 201, so nothing broke -- but once it reads
 * `data[0].source_application_environment_id` and logs an error on a grant that
 * names no caller (sc-473), every authorized request here would have logged
 * that error, and nothing in this suite pinned intake's real key (sc-483).
 * `test/stub-intake.test.js` pins it now.
 */
const GRANTED_BODY = JSON.stringify({
  authorized: true,
  data: [
    {
      id: '5f0c6b1e-0000-4000-8000-000000000001',
      source_application_environment_id: '5f0c6b1e-0000-4000-8000-000000000002',
      target_application_environment_id: '5f0c6b1e-0000-4000-8000-000000000003',
      inserted_at: '2026-01-01T00:00:00Z',
    },
  ],
});

/**
 * @param {object} [options]
 * @param {number} [options.status] status the stub answers `/api/authorize` with.
 *   201 grants; anything else is a refusal, exactly as intake's would be.
 * @param {string} [options.body] response body for that answer. Defaults to
 *   intake's granted body for a 201, and to `{}` for anything else.
 */
async function startStubIntake({ status = 201, body = status === 201 ? GRANTED_BODY : '{}' } = {}) {
  const calls = [];
  let answer = { status, body };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      calls.push({
        url: req.url,
        method: req.method,
        // What the SDK told intake about the request it is judging. `path` is
        // the assertion that catches a guard resolving the endpoint wrongly.
        //
        // `http_method`, not `action`: intake's `AuthorizeAccess.authorize/1`
        // pattern-matches on `http_method` and ignores every other key, so the
        // name is the wire contract rather than a label. The authenticate
        // command used to send `action` and was corrected (sc-320); reading
        // `action` here would silently record `undefined` for both guards and
        // assert nothing.
        path: parsed?.path,
        httpMethod: parsed?.http_method,
        clientAuth: parsed?.client_auth,
      });

      if (req.url !== '/api/authorize') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"stub intake serves only /api/authorize"}');
        return;
      }

      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const previousBaseUrl = epb.config.baseUrl;
  epb.config.baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    calls,
    /** Change the answer mid-test. */
    answerWith(next) { answer = { ...answer, ...next }; },
    async stop() {
      epb.config.baseUrl = previousBaseUrl;
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * Point the SDK at a port with nothing behind it.
 *
 * Bind a port, read it back, then close it: the OS will not hand the same port
 * out again while this process holds the socket's TIME_WAIT, so the connection
 * is refused rather than answered by whatever happens to be listening. This is
 * the "intake did not answer at all" case -- the one where nothing judged the
 * caller, and 401 would blame a credential that was never looked at.
 */
async function pointAtUnreachableIntake() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');

  const previousBaseUrl = epb.config.baseUrl;
  epb.config.baseUrl = `http://127.0.0.1:${port}`;

  return {
    async stop() { epb.config.baseUrl = previousBaseUrl; },
  };
}

module.exports = { startStubIntake, pointAtUnreachableIntake };
