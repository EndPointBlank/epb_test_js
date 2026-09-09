'use strict';

/**
 * `origin`: who refused, recoverable at the entry point (sc-290).
 *
 * `downstream_status` is per-hop, so the status that was actually refused only
 * rides up nested inside `downstream_error`, and that nesting is truncated to
 * 500 characters at every hop. Past about three hops the original status is
 * gone — in a five-node ring with budget 4, the refusals lost are exactly the
 * far-side ones. sc-265 counts refusals off `origin` instead, so `origin` has
 * to be right at any depth.
 *
 * The rule that carries all the weight is the non-overwrite rule: a hop that
 * receives an `origin` forwards it untouched. Getting it wrong raises nothing
 * and produces no error — it just names the wrong application, confidently, all
 * the way up. So it is tested here directly, from both sides.
 *
 * Every downstream is a local double or an in-process node. No staging, no AWS,
 * no intake, no mesh.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { stubAuthorize, stubAccessTokens } = require('./helpers/epb-stubs');
const {
  startNode,
  startChain,
  startDouble,
  meshReply,
  postMesh,
} = require('./helpers/mesh-node');

const APP = 'epb_test_js';

const auth = stubAuthorize();
const tokens = stubAccessTokens();
after(() => { auth.restore(); tokens.restore(); });

async function start(t, options) {
  const node = await startNode({ appName: APP, ...options });
  t.after(() => node.close());
  return node;
}

/** A double answering `status` with `body`, and the node in front of it. */
async function nodeInFrontOf(t, status, body, options = {}) {
  const double = await startDouble((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  t.after(() => double.close());
  const node = await start(t, { downstreamUrl: double.url, ...options });
  return { node, double };
}

/** A 502 body shaped exactly as a deeper hop of this implementation emits one. */
function deepFailureBody(origin) {
  return JSON.stringify({
    app: 'node_below',
    hops_received: 2,
    error: 'downstream_failed',
    downstream_status: 403,
    downstream_error: '{"error":"Authorization failed: access_denied"}',
    origin,
  });
}

// ---------------------------------------------------------------------------
// Set once, by the observer
// ---------------------------------------------------------------------------

test('the hop whose own downstream call fails sets origin naming itself', async (t) => {
  const { node } = await nodeInFrontOf(
    t, 403, '{"error":"Authorization failed: access_denied"}',
  );

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body.origin, {
    app: APP,
    status: 403,
    hops_received: 2,
    error: 'Authorization failed: access_denied',
  });
});

test('origin.hops_received is this hop own budget, parsed and clamped', async (t) => {
  const { node } = await nodeInFrontOf(t, 403, '{"error":"access_denied"}');

  // 1000000 clamps to 64, and origin must report the clamped value for the
  // same reason `hops_received` does: the entry point derives depth by
  // subtracting it, and the raw header would make that arithmetic nonsense.
  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1000000' },
    body: '{}',
  });

  assert.equal(response.body.hops_received, 64);
  assert.equal(response.body.origin.hops_received, 64);
});

test('adding origin leaves downstream_status and downstream_error per-hop', async (t) => {
  const { node } = await nodeInFrontOf(t, 418, '{"error":"short and stout"}');

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.app, APP);
  assert.equal(response.body.hops_received, 3);
  assert.equal(response.body.error, 'downstream_failed');
  assert.equal(response.body.downstream_status, 418);
  assert.equal(response.body.downstream_error, '{"error":"short and stout"}');
});

// ---------------------------------------------------------------------------
// Forwarded verbatim: the rule most likely to be got wrong
// ---------------------------------------------------------------------------

test('a hop that receives an origin forwards it unchanged', async (t) => {
  const received = {
    app: 'epb_test_py',
    status: 403,
    hops_received: 1,
    error: 'access_denied',
  };
  const { node } = await nodeInFrontOf(t, 502, deepFailureBody(received));

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '4' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  // Byte for byte what arrived: not this application's name, not this
  // application's budget, not the 502 it actually saw.
  assert.deepEqual(response.body.origin, received);
  assert.notEqual(response.body.origin.app, APP);
  assert.notEqual(response.body.origin.hops_received, 4);
  // And its own per-hop fields are untouched by the inheritance.
  assert.equal(response.body.app, APP);
  assert.equal(response.body.hops_received, 4);
  assert.equal(response.body.downstream_status, 502);
});

test('an inherited origin keeps fields this application does not know about', async (t) => {
  // Another language's hop may carry more than the four contract fields. This
  // one forwards, it does not re-serialize from a schema of its own.
  const received = {
    app: 'epb_test_rails',
    status: null,
    hops_received: 7,
    error: 'connect timed out',
    observed_at: '2026-09-09T00:00:00Z',
  };
  const { node } = await nodeInFrontOf(t, 502, deepFailureBody(received));

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.deepEqual(response.body.origin, received);
});

test('an inherited origin wins over the one this hop would have minted', async (t) => {
  // The two disagree on every field, so a substitution cannot pass by
  // coincidence: this hop saw a 500, the origin says 403.
  const received = { app: 'epb_test_java', status: 403, hops_received: 1, error: 'access_denied' };
  const { node } = await nodeInFrontOf(t, 500, JSON.stringify({
    app: 'node_below',
    error: 'downstream_failed',
    downstream_status: 500,
    origin: received,
  }));

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '5' },
    body: '{}',
  });

  assert.equal(response.body.downstream_status, 500);
  assert.deepEqual(response.body.origin, received);
});

// ---------------------------------------------------------------------------
// The whole point: attribution that survives depth
// ---------------------------------------------------------------------------

test('in a chain, the entry origin names the deepest hop, not an intermediate', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":"Authorization failed: access_denied"}');
  });
  t.after(() => double.close());

  const chain = await startChain(4);
  t.after(() => chain.close());
  // node_3 is the deepest application; the refusal happens on the edge out of
  // it, so node_3 is the observer and the origin must name node_3.
  chain.nodes[3].setDownstream(double.url);

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '4' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.app, 'node_0');
  // Per-hop: the entry called node_1, and node_1 answered 502.
  assert.equal(response.body.downstream_status, 502);
  // End-to-end: the refusal was three hops away, at node_3, and it was a 403.
  assert.deepEqual(response.body.origin, {
    app: 'node_3',
    status: 403,
    hops_received: 1,
    error: 'Authorization failed: access_denied',
  });
  // The depth derivation the contract promises the entry point, with no hop
  // having to know the entry budget: 4 - 1 = three hops down.
  assert.equal(4 - response.body.origin.hops_received, 3);

  assert.equal(double.requests.length, 1);
  for (const node of chain.nodes) assert.equal(node.meshRequests().length, 1);
});

test('the origin survives the depth at which the nested walk is truncated away', async (t) => {
  // This is the failure `origin` exists for. The refusal reason is long enough
  // that each hop's 500-character `downstream_error` is filled before the next
  // level's fields can fit, so walking the nesting from the entry point cannot
  // reach the 403 any more.
  const double = await startDouble((req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `access_denied ${'detail '.repeat(60)}` }));
  });
  t.after(() => double.close());

  const chain = await startChain(5);
  t.after(() => chain.close());
  chain.nodes[4].setDownstream(double.url);

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '5' },
    body: '{}',
  });

  assert.equal(response.status, 502);

  // The nested walk: everything the entry point could recover the old way.
  assert.equal(response.body.downstream_error.length, 500);
  assert.equal(response.body.downstream_error.includes('"downstream_status":403'), false,
    'the 403 should have been truncated out of the nested error');
  assert.equal(response.body.downstream_error.includes('access_denied'), false,
    'the refusal reason should have been truncated out of the nested error');

  // `origin` is unaffected by any of that, because it is never nested.
  assert.equal(response.body.origin.app, 'node_4');
  assert.equal(response.body.origin.status, 403);
  assert.equal(response.body.origin.hops_received, 1);
  assert.equal(response.body.origin.error.length, 200);
});

test('a refusal next door and a refusal far away stay distinguishable', async (t) => {
  // The reason the origin status was not simply propagated in
  // `downstream_status`: these two must not look the same to sc-265.
  const refuse = (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"error":"access_denied"}');
  };

  const nextDoor = await startDouble(refuse);
  t.after(() => nextDoor.close());
  const near = await start(t, { downstreamUrl: nextDoor.url });

  const farDouble = await startDouble(refuse);
  t.after(() => farDouble.close());
  const chain = await startChain(3);
  t.after(() => chain.close());
  chain.nodes[2].setDownstream(farDouble.url);

  const nearResponse = await postMesh(`${near.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });
  const farResponse = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  // Locality, from `downstream_status`: 403 was next door, 502 was relayed.
  assert.equal(nearResponse.body.downstream_status, 403);
  assert.equal(farResponse.body.downstream_status, 502);
  // Attribution, from `origin`: both were a 403, at different distances.
  assert.equal(nearResponse.body.origin.status, 403);
  assert.equal(farResponse.body.origin.status, 403);
  assert.equal(nearResponse.body.origin.hops_received, 3);
  assert.equal(farResponse.body.origin.hops_received, 1);
});

// ---------------------------------------------------------------------------
// Bounded, and never nested
// ---------------------------------------------------------------------------

test('origin.error is capped at 200 characters', async (t) => {
  const { node } = await nodeInFrontOf(
    t, 500, JSON.stringify({ error: 'x'.repeat(5000) }),
  );

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.body.origin.error.length, 200);
  assert.equal(response.body.origin.error, 'x'.repeat(200));
  // The per-hop field keeps its own, larger ceiling.
  assert.equal(response.body.downstream_error.length, 500);
});

test('origin.error is capped when the reason is a body rather than a field', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('y'.repeat(5000));
  });
  t.after(() => double.close());
  const node = await start(t, { downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.body.origin.error.length, 200);
});

test('a short reason is not padded or truncated', async (t) => {
  const { node } = await nodeInFrontOf(t, 403, '{"error":"access_denied"}');

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.body.origin.error, 'access_denied');
});

// ---------------------------------------------------------------------------
// Failures that are not an HTTP status
// ---------------------------------------------------------------------------

test('origin.status is null for a transport failure', async (t) => {
  // Bind a port and release it: nothing is listening, so nothing was refused.
  const dead = await startDouble(meshReply());
  const deadUrl = dead.url;
  await dead.close();

  const node = await start(t, { downstreamUrl: deadUrl });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.downstream_status, null);
  assert.equal(response.body.origin.status, null);
  assert.equal(response.body.origin.app, APP);
  assert.equal(response.body.origin.hops_received, 2);
  assert.match(response.body.origin.error, /ECONNREFUSED|connect/i);
});

test('origin.status is null for a timeout', async (t) => {
  const double = await startDouble(() => { /* accept, then say nothing */ });
  t.after(() => double.close());
  const node = await start(t, {
    downstreamUrl: double.url,
    requestTimeoutMs: 150,
    connectTimeoutMs: 150,
  });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.body.origin.status, null);
  assert.match(response.body.origin.error, /timed out/i);
});

test('a transport failure in a chain still attributes to the deepest hop', async (t) => {
  const dead = await startDouble(meshReply());
  const deadUrl = dead.url;
  await dead.close();

  const chain = await startChain(3);
  t.after(() => chain.close());
  chain.nodes[2].setDownstream(deadUrl);

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  assert.equal(response.body.downstream_status, 502);
  assert.equal(response.body.origin.app, 'node_2');
  assert.equal(response.body.origin.status, null);
  assert.equal(response.body.origin.hops_received, 1);
});

test('a downstream 200 that is not JSON has origin status 200', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>a proxy error page</html>');
  });
  t.after(() => double.close());
  const node = await start(t, { downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1' },
    body: '{}',
  });

  assert.equal(response.body.downstream_status, 200);
  assert.equal(response.body.origin.app, APP);
  assert.equal(response.body.origin.status, 200);
  assert.match(response.body.origin.error, /JSON/i);
});

// ---------------------------------------------------------------------------
// Shape guards: JSON that is not an object, and an origin that is not one
// ---------------------------------------------------------------------------

// A body that parses but is not an object. `JSON.parse('null').origin` throws
// and `[].origin` is silently undefined, so the shape is checked before it is
// read at all.
const NON_OBJECT_BODIES = [
  'null',
  '4',
  'true',
  '"just a string"',
  '[]',
  '[{"origin":{"app":"smuggled_in_an_array"}}]',
];

for (const body of NON_OBJECT_BODIES) {
  test(`a failure body of ${body} mints an origin rather than reading one`, async (t) => {
    const { node } = await nodeInFrontOf(t, 502, body);

    const response = await postMesh(`${node.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': '2' },
      body: '{}',
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.origin.app, APP);
    assert.equal(response.body.origin.status, 502);
    assert.equal(response.body.origin.hops_received, 2);
    assert.equal(response.body.origin.error, body);
  });
}

// An `origin` key that is present without being the contract's object. A
// string one in particular is what a CORS-flavoured error body carries, and
// forwarding it would hand sc-265 a field it cannot read.
const NON_OBJECT_ORIGINS = [
  '"https://example.test"',
  'null',
  '["epb_test_py"]',
  '403',
  'true',
];

for (const origin of NON_OBJECT_ORIGINS) {
  test(`an origin of ${origin} is not inherited`, async (t) => {
    const { node } = await nodeInFrontOf(
      t, 403, `{"error":"denied","origin":${origin}}`,
    );

    const response = await postMesh(`${node.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': '2' },
      body: '{}',
    });

    assert.deepEqual(response.body.origin, {
      app: APP,
      status: 403,
      hops_received: 2,
      error: 'denied',
    });
  });
}

test('a failure body that is not JSON at all mints an origin', async (t) => {
  const double = await startDouble((req, res) => {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<html>502 Bad Gateway</html>');
  });
  t.after(() => double.close());
  const node = await start(t, { downstreamUrl: double.url });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.body.origin.app, APP);
  assert.equal(response.body.origin.status, 503);
  assert.equal(response.body.origin.error, '<html>502 Bad Gateway</html>');
});

// ---------------------------------------------------------------------------
// This adds a field and removes nothing
// ---------------------------------------------------------------------------

test('a successful chain carries no origin at any level', async (t) => {
  const chain = await startChain(5);
  t.after(() => chain.close());

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  assert.equal(response.status, 200);

  let current = response.body;
  let levels = 0;
  while (current) {
    assert.equal('origin' in current, false, `level ${levels} must carry no origin`);
    current = current.downstream;
    levels++;
  }
  assert.equal(levels, 4);
});

test('a terminated response carries no origin', async (t) => {
  const node = await start(t, { downstreamUrl: null });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '0' },
    body: '{}',
  });

  assert.equal(response.body.terminated, true);
  assert.equal('origin' in response.body, false);
});

test('the unconfigured 500 carries no origin and still no terminated', async (t) => {
  // This hop made no downstream call, so it observed no refusal to originate.
  // The hop above will mint one naming itself and status 500, which is the
  // correct attribution: an unconfigured node is a fact about the edge into it.
  const node = await start(t, { downstreamUrl: null });

  const response = await postMesh(`${node.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'downstream_not_configured');
  assert.equal('origin' in response.body, false);
  assert.equal('terminated' in response.body, false);
});

test('the hop above an unconfigured node originates the failure itself', async (t) => {
  const chain = await startChain(3);
  t.after(() => chain.close());

  // node_2 has no downstream, so a budget that reaches it live is a 500 there
  // and a 502 above it.
  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '4' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.deepEqual(response.body.origin, {
    app: 'node_1',
    status: 500,
    hops_received: 3,
    error: 'downstream_not_configured',
  });
});

test('/mesh/reports carries an origin too', async (t) => {
  const { node, double } = await nodeInFrontOf(t, 403, '{"error":"access_denied"}');

  const response = await postMesh(`${node.url}/mesh/reports`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  assert.equal(response.status, 502);
  assert.equal(double.requests[0].url, '/mesh/reports');
  assert.deepEqual(response.body.origin, {
    app: APP,
    status: 403,
    hops_received: 2,
    error: 'access_denied',
  });
});
