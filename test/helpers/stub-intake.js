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
 * @param {object} [options]
 * @param {number} [options.status] status the stub answers `/api/authorize` with.
 *   201 grants; anything else is a refusal, exactly as intake's would be.
 * @param {string} [options.body] response body for that answer.
 */
async function startStubIntake({ status = 201, body = '{}' } = {}) {
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
        path: parsed?.path,
        action: parsed?.action,
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
