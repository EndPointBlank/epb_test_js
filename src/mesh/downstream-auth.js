'use strict';

/**
 * The authorization seam for the mesh's outbound call.
 *
 * The contract requires the downstream call to go through this application's
 * own EndPointBlank SDK client path, so that cross-organization authorization
 * is genuinely exercised rather than bypassed by a raw HTTP client. That is
 * the entire reason the mesh exists.
 *
 * What the contract deliberately does not settle is the credential and grant
 * shape each call presents — that is sc-263's provisioning, and it is being
 * rewritten from a two-organization layout to a five-organization ring. So it
 * lives here, alone, in one function: when those grants land, adapting is an
 * edit to this file rather than a hunt through the handler.
 *
 * `Authorization.header(url)` asks the SDK for a Bearer token covering the
 * target and falls back to HTTP Basic with this application's own credentials
 * when none can be minted.
 */

const { Authorization } = require('end-point-blank-js/src/authorization');

/**
 * The `Authorization` header value for a call to *url*.
 *
 * @param {string} url the URL about to be called, with no query string or
 *   fragment — intake rejects both.
 * @returns {Promise<string>} `Bearer <token>` or `Basic <credentials>`.
 */
async function downstreamAuthHeader(url) {
  return Authorization.header(url);
}

module.exports = { downstreamAuthHeader };
