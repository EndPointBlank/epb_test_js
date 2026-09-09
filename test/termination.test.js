'use strict';

/**
 * Termination, proved rather than observed.
 *
 * A chain of real Express applications is started in-process, each one
 * mounting this repository's mesh router and pointed at the next. One entry
 * request with budget N must produce exactly N downstream calls and touch
 * exactly N+1 applications. The count is read off the nodes themselves, which
 * record every request they receive, so an extra call or a missing one is a
 * failed assertion and not something a human has to notice.
 *
 * Nothing here needs staging, AWS, intake, app_portal or a database.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { stubAuthorize, stubAccessTokens } = require('./helpers/epb-stubs');
const { startChain, postMesh, nestingDepth } = require('./helpers/mesh-node');

const auth = stubAuthorize();
const tokens = stubAccessTokens();
after(() => { auth.restore(); tokens.restore(); });

/** Total mesh requests received across every node in the chain. */
function totalMeshRequests(nodes) {
  return nodes.reduce((sum, node) => sum + node.meshRequests().length, 0);
}

for (const budget of [0, 1, 2, 4, 5]) {
  test(`budget ${budget} makes exactly ${budget} downstream calls`, async (t) => {
    // One more node than the budget needs, so running past the budget would be
    // possible if the implementation let it -- and would be counted.
    const chain = await startChain(budget + 3);
    t.after(() => chain.close());

    const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
      headers: { 'x-epb-test-hops': String(budget) },
      body: JSON.stringify({ payload: 'p' }),
    });

    assert.equal(response.status, 200);

    // The entry request itself is one of the mesh requests, so N downstream
    // calls means N+1 requests seen across the chain: N+1 applications touched.
    assert.equal(totalMeshRequests(chain.nodes), budget + 1,
      `expected ${budget} downstream calls (${budget + 1} applications touched)`);

    // Each node in the traversed prefix is hit exactly once; the rest never.
    chain.nodes.forEach((node, index) => {
      assert.equal(node.meshRequests().length, index <= budget ? 1 : 0,
        `node_${index} request count`);
    });

    // The chain describes itself: one nested `downstream` per hop.
    assert.equal(nestingDepth(response.body), budget);
  });
}

test('each hop decrements the budget by exactly one', async (t) => {
  const chain = await startChain(5);
  t.after(() => chain.close());

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3' },
    body: '{}',
  });

  assert.equal(response.status, 200);

  const received = [];
  let current = response.body;
  while (current) {
    received.push(current.hops_received);
    current = current.downstream;
  }
  assert.deepEqual(received, [3, 2, 1, 0]);

  // And on the wire, not just in the bodies the applications chose to report.
  const forwarded = chain.nodes
    .flatMap(node => node.meshRequests())
    .map(request => request.headers['x-epb-test-hops']);
  assert.deepEqual(forwarded, ['3', '2', '1', '0']);
});

test('the last application in the budget terminates and calls nobody', async (t) => {
  const chain = await startChain(4);
  t.after(() => chain.close());

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  const last = response.body.downstream.downstream;
  assert.equal(last.terminated, true);
  assert.equal(last.downstream, null);
  assert.equal(last.hops_forwarded, null);
  assert.equal(last.hops_received, 0);

  // The intermediate hops are not terminated.
  assert.equal(response.body.terminated, false);
  assert.equal(response.body.hops_forwarded, 1);
  assert.equal(response.body.downstream.terminated, false);
  assert.equal(response.body.downstream.hops_forwarded, 0);
});

test('the run identifier travels the whole chain unmodified', async (t) => {
  const chain = await startChain(5);
  t.after(() => chain.close());

  const runId = 'sc-265/run 1,2 %20+weird';
  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '3', 'x-epb-test-run': runId },
    body: '{}',
  });

  const seen = chain.nodes
    .flatMap(node => node.meshRequests())
    .map(request => request.headers['x-epb-test-run']);
  assert.deepEqual(seen, [runId, runId, runId, runId]);

  let current = response.body;
  while (current) {
    assert.equal(current.run, runId);
    current = current.downstream;
  }
});

test('no run identifier means none is generated or forwarded', async (t) => {
  const chain = await startChain(3);
  t.after(() => chain.close());

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '2' },
    body: '{}',
  });

  for (const node of chain.nodes) {
    for (const request of node.meshRequests()) {
      assert.equal('x-epb-test-run' in request.headers, false);
    }
  }
  assert.equal(response.body.run, null);
  assert.equal(response.body.downstream.run, null);
});

test('a budget over the clamp still terminates, at 64', async (t) => {
  // Three nodes wired into a ring: with no clamp this never returns.
  const chain = await startChain(3);
  t.after(() => chain.close());

  // Close the ring, so the only thing that can stop the traversal is the
  // budget.
  chain.nodes[2].setDownstream(chain.nodes[0].url);

  const response = await postMesh(`${chain.entry.url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '1000000' },
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.hops_received, 64);
  assert.equal(response.body.hops_forwarded, 63);
  assert.equal(totalMeshRequests(chain.nodes), 65);
  assert.equal(nestingDepth(response.body), 64);
});
