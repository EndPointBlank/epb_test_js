'use strict';

/**
 * The wire behaviour of POST /mesh/relay and POST /mesh/reports.
 *
 * Every downstream in this file is a local double, so a refusal, a 500, a
 * connection error and a hang are all reproducible without a mesh existing.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { stubAuthorize, stubAccessTokens } = require('./helpers/epb-stubs');
const {
  startNode,
  startDouble,
  meshReply,
  postMesh,
} = require('./helpers/mesh-node');

const APP = 'epb_test_js';

// The nodes below use the real SDK authorization seam for their outbound
// calls; this is the one point inside it that would reach intake.
const tokens = stubAccessTokens('mesh-test-token');
after(() => tokens.restore());

/** A node with no downstream configured. */
function unwired(t, options = {}) {
  return start(t, { appName: APP, downstreamUrl: null, ...options });
}

async function start(t, options) {
  const node = await startNode(options);
  t.after(() => node.close());
  return node;
}

// ---------------------------------------------------------------------------
// Authorization: the routes sit behind the SDK's middleware
// ---------------------------------------------------------------------------

test('both mesh routes go through the EndPointBlank authorization middleware', async (t) => {
  const auth = stubAuthorize({ status: 403, body: '{"error":"access_denied"}' });
  t.after(() => auth.restore());

  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  for (const path of ['/mesh/relay', '/mesh/reports']) {
    const response = await postMesh(`${node.url}${path}`, {
      headers: { 'x-epb-test-hops': '3' },
      body: '{}',
    });

    assert.equal(response.status, 403, `${path} must be refused`);
    assert.match(response.body.error, /Authorization failed/);
  }

  // A refused request never reaches the handler, so nothing was relayed.
  assert.equal(double.requests.length, 0);
  // And authorization was actually consulted for each, on the real path.
  assert.deepEqual(auth.calls.map(c => c.path), ['/mesh/relay', '/mesh/reports']);
});

// Everything below runs with authorization granted.
const granted = stubAuthorize();
after(() => granted.restore());

// ---------------------------------------------------------------------------
// Termination: n <= 0 answers and calls nobody
// ---------------------------------------------------------------------------

test('an absent hop header terminates without calling anybody', async (t) => {
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, { body: '{}' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    app: APP,
    hops_received: 0,
    hops_forwarded: null,
    terminated: true,
    run: null,
    payload: null,
    downstream: null,
  });
  assert.equal(double.requests.length, 0);
});

// Every zero row of the contract's table, over a real socket. Values that
// cannot legally appear in an HTTP header (a bare CR or LF) are covered in
// hops.test.js instead.
const ZERO_HEADERS = [
  '', 'abc', 'four', '1.5', '0.9', '0x4', '0b100', '1e3', '+4',
  '-1', '-100', '0', '00', ' ', '  ', '\t', '4abc', '4 4', 'NaN', 'Infinity',
];

for (const raw of ZERO_HEADERS) {
  test(`hop header ${JSON.stringify(raw)} terminates and calls nobody`, async (t) => {
    const double = await startDouble(meshReply());
    t.after(() => double.close());
    const node = await start(t, { appName: APP, downstreamUrl: double.url });

    const response = await postMesh(`${node.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': raw },
      body: '{}',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.terminated, true);
    assert.equal(response.body.hops_received, 0);
    assert.equal(response.body.hops_forwarded, null);
    assert.equal(response.body.downstream, null);
    assert.equal(double.requests.length, 0, 'must have called nobody');
  });
}

test('a terminated response still echoes the payload and the run', async (t) => {
  const node = await unwired(t);

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '0', 'x-epb-test-run': 'run-9' },
    body: JSON.stringify({ payload: 'hello' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.payload, 'hello');
  assert.equal(response.body.run, 'run-9');
  assert.equal(response.body.terminated, true);
});

test('an exhausted budget with no downstream configured is a normal 200', async (t) => {
  // The distinction the contract insists on: stopping because the budget ran
  // out is not the same event as stopping because nothing is wired.
  const node = await unwired(t);

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '0' },
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.terminated, true);
});

test('an empty body and no body at all are both accepted', async (t) => {
  const node = await unwired(t);

  for (const body of ['{}', null, '']) {
    const response = await postMesh(`${node.url}/mesh/relay`, { body });
    assert.equal(response.status, 200, `body ${JSON.stringify(body)}`);
    assert.equal(response.body.payload, null);
    assert.equal(response.body.terminated, true);
  }
});

// ---------------------------------------------------------------------------
// Misconfiguration is loud
// ---------------------------------------------------------------------------

test('a live budget with no downstream configured is a 500 naming the variable', async (t) => {
  const node = await unwired(t);

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'downstream_not_configured');
  assert.equal(response.body.missing_configuration, 'EPB_MESH_DOWNSTREAM_URL');
  assert.equal(response.body.app, APP);
  assert.equal(response.body.hops_received, 3);
  // Not a silent stop dressed up as a termination.
  assert.equal(response.body.terminated, undefined);
});

test('an empty downstream URL is missing, not a valid target', async (t) => {
  for (const configured of ['', '   ']) {
    const node = await start(t, { appName: APP, downstreamUrl: configured });
    const response = await postMesh(`${node.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': '1' },
      body: '{}',
    });
    assert.equal(response.status, 500, `downstream ${JSON.stringify(configured)}`);
    assert.equal(response.body.error, 'downstream_not_configured');
  }
});

test('/mesh/reports is loud about the same misconfiguration', async (t) => {
  const node = await unwired(t);

  const response = await postMesh(`${node.url}/mesh/reports`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'downstream_not_configured');
});

// ---------------------------------------------------------------------------
// The downstream call itself
// ---------------------------------------------------------------------------

test('a live budget makes exactly one downstream call, decremented', async (t) => {
  const double = await startDouble(meshReply('next_app'));
  t.after(() => double.close());
  const node = await start(t, {
    appName: APP,
    downstreamUrl: double.url,
    authHeader: async () => 'Bearer test-token',
  });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3', 'x-epb-test-run': 'run-1' },
    body: JSON.stringify({ payload: 'carried' }),
  });

  assert.equal(double.requests.length, 1);
  const sent = double.requests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/mesh/relay');
  assert.equal(sent.headers['x-epb-test-hops'], '2');
  assert.equal(sent.headers['x-epb-test-run'], 'run-1');
  assert.match(sent.headers['content-type'], /application\/json/);
  // The call goes out through the SDK's authorization seam, not raw.
  assert.equal(sent.headers.authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(sent.body), { payload: 'carried' });

  assert.equal(response.status, 200);
  assert.equal(response.body.terminated, false);
  assert.equal(response.body.hops_received, 3);
  assert.equal(response.body.hops_forwarded, 2);
  assert.equal(response.body.run, 'run-1');
  assert.equal(response.body.payload, 'carried');
  // Nested verbatim.
  assert.deepEqual(response.body.downstream, {
    app: 'next_app',
    hops_received: 0,
    hops_forwarded: null,
    terminated: true,
    run: null,
    payload: null,
    downstream: null,
  });
});

test('the outbound call is authorized through the SDK, not sent raw', async (t) => {
  // No authHeader override here: this exercises the default seam, which is
  // `Authorization.header(url)` from the SDK. With a token available it is a
  // Bearer for the downstream target, which is the whole reason the mesh
  // exists -- a raw HTTP client would bypass the authorization being measured.
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(double.requests[0].headers.authorization, 'Bearer mesh-test-token');
});

test('a trailing slash on the configured base URL does not double up', async (t) => {
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: `${double.url}///` });

  await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(double.requests[0].url, '/mesh/relay');
});

test('/mesh/reports relays to the downstream relay path', async (t) => {
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/reports`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.equal(double.requests.length, 1);
  assert.equal(double.requests[0].url, '/mesh/relay');
  assert.equal(double.requests[0].headers['x-epb-test-hops'], '1');
});

test('a clamped budget is forwarded clamped', async (t) => {
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1000000' },
    body: '{}',
  });

  assert.equal(response.body.hops_received, 64);
  assert.equal(response.body.hops_forwarded, 63);
  assert.equal(double.requests[0].headers['x-epb-test-hops'], '63');
});

test('no run header in means no run header out', async (t) => {
  const double = await startDouble(meshReply());
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal('x-epb-test-run' in double.requests[0].headers, false);
});

// ---------------------------------------------------------------------------
// Downstream failure: 502, with the status preserved
// ---------------------------------------------------------------------------

test('a downstream authorization refusal surfaces as 502 with its status', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authorization failed: access_denied' }));
  });
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  // Never swallowed into a 200: the negative control depends on this.
  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'downstream_failed');
  assert.equal(response.body.downstream_status, 403);
  assert.equal(response.body.app, APP);
  assert.equal(response.body.hops_received, 3);
  assert.match(response.body.downstream_error, /access_denied/);
});

for (const status of [401, 404, 422, 500, 502, 503]) {
  test(`a downstream ${status} surfaces as 502 preserving ${status}`, async (t) => {
    const double = await startDouble((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
    t.after(() => double.close());
    const node = await start(t, { appName: APP, downstreamUrl: double.url });

    const response = await postMesh(`${node.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': '2' },
      body: '{}',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.downstream_status, status);
  });
}

test('a downstream 201 is not a success either', async (t) => {
  // The contract says non-200 fails. A 2xx that is not 200 is still not the
  // response shape the chain is built out of.
  const double = await startDouble((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{}');
  });
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.downstream_status, 201);
});

test('a connection error surfaces as 502 with a null downstream status', async (t) => {
  // Bind a port and immediately release it: nothing is listening there.
  const dead = await startDouble(meshReply());
  const deadUrl = dead.url;
  await dead.close();

  const node = await start(t, { appName: APP, downstreamUrl: deadUrl });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error, 'downstream_failed');
  assert.equal(response.body.downstream_status, null);
  assert.match(response.body.downstream_error, /ECONNREFUSED|connect/i);
});

test('a downstream that never answers surfaces as 502 rather than hanging', async (t) => {
  const double = await startDouble(() => { /* accept, then say nothing */ });
  t.after(() => double.close());
  const node = await start(t, {
    appName: APP,
    downstreamUrl: double.url,
    requestTimeoutMs: 150,
    connectTimeoutMs: 150,
  });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.downstream_status, null);
  assert.match(response.body.downstream_error, /timed out/i);
});

test('a downstream 200 that is not JSON is a failure, not a nested string', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>a proxy error page</html>');
  });
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.downstream_status, 200);
  assert.match(response.body.downstream_error, /JSON/i);
});

test('the downstream error is truncated to 500 characters', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5000));
  });
  t.after(() => double.close());
  const node = await start(t, { appName: APP, downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.downstream_error.length, 500);
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('the application name comes from configuration', async (t) => {
  const node = await start(t, { appName: 'renamed_for_a_deployment', downstreamUrl: null });

  const response = await postMesh(`${node.url}/mesh/relay`, { body: '{}' });

  assert.equal(response.body.app, 'renamed_for_a_deployment');
});

test('only POST is routed', async (t) => {
  const node = await unwired(t);

  const response = await fetch(`${node.url}/mesh/relay`, { method: 'GET' });

  assert.equal(response.status, 404);
});
