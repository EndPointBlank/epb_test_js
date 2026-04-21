'use strict';

/**
 * epb_test_js — Express demo app using the EndPointBlank JS library.
 *
 * Endpoints
 * ---------
 * GET /computers   List all computers used across school facilities.
 * GET /projectors  List all projectors grouped by facility.
 * GET /errors      Intentionally throws to exercise EndPointBlank error tracking.
 *
 * All routes are protected by the `authorized` middleware (EndPointBlank
 * authorization check).  The reportInteraction / reportInteractionErrorHandler
 * middleware pair wraps every request/response and forwards data to the
 * EndPointBlank ingest service.
 *
 * Equivalent to epb_test_rails in structure and purpose.
 */

const { execSync } = require('child_process');
const express = require('express');
const epb = require('end-point-blank-js');
const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/src/middleware/report-interaction');
const { UnauthorizedError } = require('end-point-blank-js/src/unauthorized-error');
const { registerExpressEndpoints } = require('end-point-blank-js/src/express/endpoint-registrar');

// ---------------------------------------------------------------------------
// Configure EndPointBlank
// ---------------------------------------------------------------------------

epb.configure({
  baseUrl: 'http://localhost:4001',
  appName: 'epb-test-js',
  environment: 'development',
  clientId: 'kiKhVaXGr1oz4Ig8F2kGrTuDvd9RMwLE',
  clientSecret: 'lr+CFT3JoqnHalXZwR1Be5oaOsRBfYOQKpBNi+uaRyqopv1dp6gCuVzR9y4RdBI5',
  applicationVersion: (() => {
    try { return execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); }
    catch { return process.env.GIT_COMMIT || '0'; }
  })(),
});

// logBaseUrl is not in configure()'s allowed list — set directly
epb.config.logBaseUrl = 'http://localhost:4001';

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// EPB request/response tracking — must come before routes
app.use(reportInteraction);

// Routes
app.use('/computers', require('./routes/computers'));
app.use('/projectors', require('./routes/projectors'));
app.use('/errors',    require('./routes/errors'));

// EPB error tracking — must come after routes
app.use(reportInteractionErrorHandler);

// Final error handler — sends JSON response for unhandled errors
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof UnauthorizedError) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`[epb-test-js] Listening on http://localhost:${PORT}`);
  registerExpressEndpoints(app);
});

module.exports = app;
