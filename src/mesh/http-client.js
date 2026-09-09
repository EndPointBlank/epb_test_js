'use strict';

/**
 * The mesh's outbound HTTP call.
 *
 * Written on `node:http` rather than `fetch` for one reason: the contract
 * specifies two deadlines — 10 seconds for the request and 3 seconds for the
 * connect — and native `fetch` has only one knob. An `AbortSignal` bounds the
 * whole exchange and cannot distinguish "the next application is not
 * reachable" from "the next application is slow". The SDK's own `_http.js`
 * says the same thing and settles for a single total deadline; a load harness
 * measuring hop latency is exactly the case where that distinction is the
 * measurement, so this one does not.
 *
 * Nothing here knows what a hop is. It POSTs a body and reports what came
 * back, including a non-2xx, which is a result and not an error.
 */

const http = require('node:http');
const https = require('node:https');

/** No response was obtained at all: refused, reset, unresolvable, timed out. */
class MeshTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MeshTransportError';
  }
}

/**
 * POSTs a JSON body and resolves with the response.
 *
 * @param {string} url absolute URL to POST to.
 * @param {object} options
 * @param {object} [options.headers] extra request headers.
 * @param {string} [options.body] the request body, already serialized.
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs] total budget for the exchange.
 * @returns {Promise<{status: number, body: string}>}
 * @throws {MeshTransportError} when no response was obtained.
 */
function postJson(url, {
  headers = {},
  body = '{}',
  connectTimeoutMs = 3_000,
  requestTimeoutMs = 10_000,
} = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new MeshTransportError(`downstream URL is not a valid URL: ${url}`));
      return;
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new MeshTransportError(`downstream URL has an unsupported scheme: ${target.protocol}`));
      return;
    }

    const payload = Buffer.from(body, 'utf8');
    const transport = target.protocol === 'https:' ? https : http;

    const request = transport.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
    });

    let settled = false;
    const timers = [];
    const clearTimers = () => { for (const timer of timers) clearTimeout(timer); };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      request.destroy();
      reject(error);
    };

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    timers.push(setTimeout(
      () => fail(new MeshTransportError(`downstream request timed out after ${requestTimeoutMs}ms`)),
      requestTimeoutMs,
    ));

    request.on('socket', (socket) => {
      // A pooled socket is already connected, so there is no connect phase to
      // bound. Only a fresh one gets the connect deadline.
      if (!socket.connecting) return;
      const connectTimer = setTimeout(
        () => fail(new MeshTransportError(`downstream connect timed out after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
      timers.push(connectTimer);
      socket.once('connect', () => clearTimeout(connectTimer));
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });

    request.on('error', err => fail(new MeshTransportError(err.message)));

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', err => fail(new MeshTransportError(err.message)));
      response.on('end', () => succeed({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });

    request.end(payload);
  });
}

module.exports = { postJson, MeshTransportError };
