'use strict';

/**
 * Pins the stub intake's granted answer to the body intake really sends.
 *
 * A double written from the same misunderstanding as the code hides that
 * misunderstanding completely. The JS SDK read only `deprecation` from intake's
 * 201 and never the caller's source environment (sc-473), and this stub
 * answered a granted authorize with `{}` -- a 201 intake has never sent -- so
 * nothing in this suite could have told the difference (sc-483).
 *
 * The shape is intake's `AuthorizationJSON.show/1`
 * (`lib/intake_web/controllers/authorization_json.ex`), pinned by its
 * `authorization_controller_test.exs` ("POST /api/authorize — authorized"): the
 * grant sits under `data`, one entry with exactly four keys, and `deprecation`
 * is added only when the called version is deprecated.
 *
 * This asks the stub over a socket rather than going through the app, so the
 * assertion is about the bytes the SDK receives, not about what one SDK version
 * makes of them. The SDK this app pins reads only `deprecation`, so an
 * assertion through the app could not see this yet.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const epb = require('end-point-blank-js');
const { startStubIntake } = require('./helpers/stub-intake');

const GRANT_KEYS = [
  'id',
  'inserted_at',
  'source_application_environment_id',
  'target_application_environment_id',
];

test("a default answer is intake's granted body, with the grant under data", async (t) => {
  const intake = await startStubIntake();
  t.after(() => intake.stop());

  const response = await fetch(`${epb.config.baseUrl}/api/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(body).sort(), ['authorized', 'data'],
    'a current version gets no deprecation key at all, and nothing else rides along');
  assert.equal(body.authorized, true);

  assert.ok(Array.isArray(body.data), 'intake renders the grant list under `data`');
  assert.equal(body.data.length, 1);
  const [grant] = body.data;
  assert.deepEqual(Object.keys(grant).sort(), GRANT_KEYS);
  assert.equal(typeof grant.source_application_environment_id, 'string');
  assert.notEqual(grant.source_application_environment_id, '',
    'the key the SDK reads to name the caller on every row it writes');
  assert.ok(!Number.isNaN(Date.parse(grant.inserted_at)), 'inserted_at is an ISO 8601 timestamp');
});
