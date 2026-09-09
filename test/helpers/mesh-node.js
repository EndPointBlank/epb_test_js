'use strict';

/**
 * In-process mesh nodes and a scriptable downstream double.
 *
 * A hop budget is a property of a chain, so the tests build a real chain:
 * several Express applications, each mounting this repository's own mesh
 * router, each listening on an ephemeral port, each pointed at the next. No
 * staging, no AWS, no intake, no app_portal — every socket in the test run
 * terminates on 127.0.0.1.
 */

const express = require('express');
const http = require('node:http');
const { once } = require('node:events');
const { createMeshRouter } = require('../../src/mesh/router');
const { UnauthorizedError } = require('end-point-blank-js/src/unauthorized-error');

/**
 * Starts one mesh node.
 *
 * @param {object} options
 * @param {string} options.appName reported as `app` in the response body.
 * @param {string|Function|null} [options.downstreamUrl] base URL of the next
 *   node, or null/undefined for a node with nothing configured.
 * @param {Function} [options.authHeader] the authorization seam.
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @returns {Promise<object>} the running node.
 */
async function startNode({ appName, downstreamUrl = null, ...options }) {
  const app = express();
  const inbound = [];
  // Read per request, so a test can close a ring after the nodes are up.
  let downstream = typeof downstreamUrl === 'function' ? downstreamUrl : () => downstreamUrl;

  app.use(express.json());
  app.use((req, res, next) => {
    inbound.push({ method: req.method, path: req.path, headers: { ...req.headers } });
    next();
  });
  app.use('/mesh', createMeshRouter({ appName, downstreamUrl: () => downstream(), ...options }));

  // Mirrors src/app.js's final handler, so a refusal from `authorized` comes
  // back as the status the SDK put on it rather than as Express's HTML 500.
  app.use((err, req, res, _next) => {
    if (err instanceof UnauthorizedError) {
      return res.status(err.statusCode || 401).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    appName,
    inbound,
    url: `http://127.0.0.1:${server.address().port}`,
    /** Requests this node received on a mesh path. */
    meshRequests: () => inbound.filter(r => r.path.startsWith('/mesh/')),
    /** Repoints this node, e.g. to close a chain into a ring. */
    setDownstream: (url) => { downstream = () => url; },
    close: () => closeServer(server),
  };
}

/**
 * Starts a chain of `count` nodes, each pointed at the next. The last has no
 * downstream configured — with a budget of `count - 1` it is never asked to
 * make one, which is precisely what the termination test proves.
 *
 * @param {number} count
 * @param {object} [options] passed to every node.
 * @returns {Promise<{nodes: object[], entry: object, close: Function}>}
 */
async function startChain(count, options = {}) {
  const nodes = [];
  // Built back to front: a node needs the URL of the one it calls.
  for (let i = count - 1; i >= 0; i--) {
    const downstream = nodes.length > 0 ? nodes[0].url : null;
    nodes.unshift(await startNode({
      appName: `node_${i}`,
      downstreamUrl: downstream,
      ...options,
    }));
  }

  return {
    nodes,
    entry: nodes[0],
    close: async () => { for (const node of nodes) await node.close(); },
  };
}

/**
 * A bare HTTP server standing in for a downstream application, so a test can
 * script a 403, a 500, a hang or a non-JSON body without an application on the
 * other end.
 *
 * @param {Function} handler `(req, res, body) => void`
 * @returns {Promise<object>}
 */
async function startDouble(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      handler(req, res, body);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => closeServer(server),
  };
}

/** Replies 200 with a mesh-shaped body, like a real next node would. */
function meshReply(name = 'downstream_app') {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      app: name,
      hops_received: 0,
      hops_forwarded: null,
      terminated: true,
      run: null,
      payload: null,
      downstream: null,
    }));
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * POSTs to a mesh path and returns `{ status, body }` with the body parsed
 * when it is JSON.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {object|null} [options.headers]
 * @param {string|null} [options.body] raw body; omit for no body at all.
 */
async function postMesh(url, { headers = {}, body = null } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === null ? headers : { 'content-type': 'application/json', ...headers },
    body: body === null ? undefined : body,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: response.status, body: parsed, text };
}

/** How many `downstream` objects are nested inside a relay response. */
function nestingDepth(body) {
  let depth = 0;
  let current = body;
  while (current && current.downstream) {
    depth++;
    current = current.downstream;
  }
  return depth;
}

module.exports = {
  startNode,
  startChain,
  startDouble,
  meshReply,
  postMesh,
  nestingDepth,
};
