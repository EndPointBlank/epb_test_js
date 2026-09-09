'use strict';

/**
 * epb_test_js — Express demo app using the EndPointBlank JS library.
 *
 * Endpoints
 * ---------
 * GET    /books          List all books.
 * POST   /books          Add a new book.
 * DELETE /books/:id      Remove a book by id.
 * GET    /errors         Intentionally throws to exercise EndPointBlank error tracking.
 * GET    /whoami         The one route behind `authenticated` rather than `authorized`.
 * POST   /mesh/relay     The sc-263 mesh call, bounded by the hop budget.
 * POST   /mesh/reports   The mesh negative control, deliberately not granted.
 *
 * Every route except `/whoami` is protected by the `authorized` middleware
 * (EndPointBlank authorization check: does a grant cover this endpoint?).
 * `/whoami` is protected by `authenticated` (is the credential itself good?),
 * which is a separate code path through the SDK -- see the note above the
 * route.  The reportInteraction / reportInteractionErrorHandler middleware
 * pair wraps every request/response and forwards data to the EndPointBlank
 * ingest service.
 */

const { execSync } = require('child_process');
const express = require('express');
const morgan = require('morgan');
const epb = require('end-point-blank-js');
const { setup: dbSetup } = require('./db');
const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/src/middleware/report-interaction');
const { UnauthorizedError } = require('end-point-blank-js/src/unauthorized-error');
const { registerExpressEndpoints } = require('end-point-blank-js/src/express/endpoint-registrar');
const { authenticated } = require('end-point-blank-js/src/express/authenticated');
// The mesh forwards to the path it was called on, so where the router is
// mounted is part of the wire contract rather than a local choice.
const { MESH_MOUNT } = require('./mesh/router');

// ---------------------------------------------------------------------------
// Configure EndPointBlank
// ---------------------------------------------------------------------------

const INTAKE_URL = process.env.INTAKE_API_URL || 'http://localhost:4001';

epb.configure({
  baseUrl: INTAKE_URL,
  appName: process.env.EPB_APP_NAME || 'epb-test-js',
  environment: process.env.NODE_ENV || 'development',
  clientId: process.env.EPB_CLIENT_ID || 'Sb3JsTeSd8EvPmQnLuTwFc4YjHgNvOq',
  clientSecret:
    process.env.EPB_CLIENT_SECRET ||
    'yK4pQmB7dN3sOkR2tF6bXeJiW0aFzGoBMaVnQkDpEyHwIlZcSxrUfOgtXu9P1J8',
  // Seconds. 0 disables caching entirely, which the e2e harness relies on so an
  // authorization decision can be observed changing without a restart. The SDK
  // reads this with `??`, so 0 is honoured rather than falling back to 300.
  cacheTtl: process.env.EPB_CACHE_TTL ? Number(process.env.EPB_CACHE_TTL) : undefined,
  applicationVersion: (() => {
    try { return execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); }
    catch { return process.env.GIT_COMMIT || '0'; }
  })(),
});

// logBaseUrl is not in configure()'s allowed list — set directly
epb.config.logBaseUrl = INTAKE_URL;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(morgan('combined'));
app.use(express.json());

// Health check — before EPB middleware so it isn't tracked
app.get('/status', (req, res) => res.status(200).send('ok'));

// EPB request/response tracking — must come before routes
app.use(reportInteraction);

// Routes
app.use('/books',      require('./routes/books'));
app.use('/computers',  require('./routes/computers'));
app.use('/projectors', require('./routes/projectors'));
app.use('/errors',     require('./routes/errors'));
app.use(MESH_MOUNT,    require('./routes/mesh'));

// The one route behind `authenticated` rather than `authorized`.
//
// These two guards are different code paths through the SDK: `authorized` asks
// intake whether a grant covers this endpoint, `authenticated` asks only
// whether the credential itself is good. Until now every route in every demo
// app used `authorized`, so nothing anywhere called the second one -- which is
// exactly how it dropped intake's refusal status for two releases without a
// test going red (sc-307). A pass/fail count over these apps cannot see a path
// nothing calls, so the fix is a route that calls it, not another assertion
// about the paths that were already covered.
//
// Mounted directly on `app` rather than as a router under `src/routes/`,
// deliberately, and this is load-bearing: `authenticated` resolves the endpoint
// path as `req.route?.path || req.path || req.url` and never prefixes
// `req.baseUrl`, while `authorized` goes through the SDK's shared
// `requestPath(req)`, which does. On a mounted router the two disagree --
// a router at `/whoami` with `router.get('/')` authenticates as `/` -- and per
// `request-path.js`'s own docstring, registration and authorization must
// produce byte-identical paths or every request fails `missing_target_endpoint`.
// At the top level `req.baseUrl` is empty, so both agree and the route works.
// That divergence is real and still unfixed on the SDK's master; it is the
// reason for the placement rather than an incidental style choice.
//
// No `versioned(...)` here: endpoint versions belong to the authorize path,
// which resolves a specific endpoint. Authentication judges the credential.
app.get('/whoami', authenticated, (req, res) =>
  res.status(200).json({ application: epb.config.appName, authenticated: true }));

// EPB error tracking — must come after routes
app.use(reportInteractionErrorHandler);

// Final error handler — sends JSON response for unhandled errors
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof UnauthorizedError) {
    return res.status(err.statusCode || 401).json({ error: err.message });
  }
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3003;

/**
 * Only when this file is the entry point. Requiring it — which the mesh tests
 * do, to drive the real middleware stack rather than a rebuilt one — must not
 * open a database connection or bind a port. `node src/app.js`, the Dockerfile
 * CMD and `./start` all still run this branch.
 */
function boot() {
  dbSetup()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`[epb-test-js] Listening on http://localhost:${PORT}`);
        registerExpressEndpoints(app);
      });
    })
    .catch(err => {
      console.error('Database setup failed:', err);
      process.exit(1);
    });
}

if (require.main === module) boot();

module.exports = app;
