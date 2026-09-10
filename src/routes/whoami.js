'use strict';

/**
 * The one route behind `authenticated` rather than `authorized`.
 *
 * These two guards are different code paths through the SDK: `authorized` asks
 * intake whether a grant covers this endpoint, `authenticated` asks only
 * whether the credential itself is good. Until sc-307 every route in every one
 * of the five epb_test_* applications used `authorized`, so nothing anywhere
 * called the second one -- which is exactly how it dropped intake's refusal
 * status for two releases without a test going red. A pass/fail count over
 * these apps cannot see a code path nothing calls, so the fix was a route that
 * calls it, not another assertion about the paths already covered.
 *
 * This lived at the top level of `app.js` until the SDK's two guards agreed on
 * how to resolve an endpoint path. `authenticated` used to build the path
 * itself and never prefixed `req.baseUrl`, so on a mounted router it named an
 * endpoint intake had never been told about and every request through it would
 * have failed `missing_target_endpoint`. Both guards now go through the shared
 * `requestPath(req)`, so a router is safe -- and being a router is what makes
 * `test/authenticate-status.test.js`'s path assertion mean something, since at
 * the top level `req.baseUrl` is empty and a broken guard would agree by
 * accident.
 *
 * No `versioned(...)` here: endpoint versions belong to the authorize path,
 * which resolves a specific endpoint. Authentication judges the credential.
 */

const { Router } = require('express');
const epb = require('end-point-blank-js');
const { authenticated } = require('end-point-blank-js/src/express/authenticated');

const router = Router();

router.get('/', authenticated, (req, res) =>
  res.status(200).json({ application: epb.config.appName, authenticated: true }));

module.exports = router;
