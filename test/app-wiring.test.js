'use strict';

/**
 * The mesh routes as the deployed application actually serves them.
 *
 * relay.test.js mounts the router on a bare Express app. That proves the
 * router; it does not prove that src/app.js mounts it, that it sits behind the
 * same middleware stack as the demo CRUD routes, or that a refusal comes back
 * as JSON rather than Express's HTML error page. This file loads the real
 * application module and drives it over a socket.
 *
 * Everything that would leave the machine is stubbed: the SDK's authorize call
 * and its three telemetry writers. Nothing here touches Postgres -- src/app.js
 * only connects to the database when it is run as the entry point.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { stubAuthorize, stubWriters } = require('./helpers/epb-stubs');
const { postMesh } = require('./helpers/mesh-node');

const writers = stubWriters();
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

test('requiring the application does not start a server or touch the database', () => {
  assert.equal(typeof app.listen, 'function');
});

test('POST /mesh/relay is mounted and terminates on an exhausted budget', async (t) => {
  const auth = stubAuthorize();
  t.after(() => auth.restore());
  const url = await serve(t);

  const response = await postMesh(`${url}/mesh/relay`, {
    headers: { 'x-epb-test-hops': '0' },
    body: JSON.stringify({ payload: 'p' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.terminated, true);
  assert.equal(response.body.payload, 'p');
  // The repository name, per the contract -- not the hyphenated EPB_APP_NAME.
  assert.equal(response.body.app, 'epb_test_js');
});

test('POST /mesh/reports is mounted', async (t) => {
  const auth = stubAuthorize();
  t.after(() => auth.restore());
  const url = await serve(t);

  const response = await postMesh(`${url}/mesh/reports`, { body: '{}' });

  assert.equal(response.status, 200);
  assert.equal(response.body.terminated, true);
});

test('a refusal from the authorization middleware is a JSON error, not the handler', async (t) => {
  const auth = stubAuthorize({ status: 403, body: '{"error":"access_denied"}' });
  t.after(() => auth.restore());
  const url = await serve(t);

  for (const path of ['/mesh/relay', '/mesh/reports']) {
    const response = await postMesh(`${url}${path}`, {
      headers: { 'x-epb-test-hops': '2' },
      body: '{}',
    });

    assert.equal(response.status, 403, path);
    assert.match(response.body.error, /Authorization failed/);
    assert.equal(response.body.terminated, undefined);
  }
});

test('the mesh routes are declared to the endpoint registrar like the demo routes', () => {
  const meshRouter = require('../src/routes/mesh');
  const layers = meshRouter.stack.filter(layer => layer.route);

  assert.deepEqual(layers.map(l => l.route.path).sort(), ['/relay', '/reports']);

  for (const layer of layers) {
    assert.deepEqual(Object.keys(layer.route.methods), ['post']);
    const handlers = layer.route.stack.map(s => s.handle);
    // `authorized` first, then the version metadata the registrar reads.
    assert.equal(handlers[0].name, 'authorized');
    assert.deepEqual(handlers[1]._epbVersions, ['1']);
  }
});
