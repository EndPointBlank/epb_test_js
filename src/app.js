'use strict';

/**
 * epb_test_js — Express demo app using the EndPointBlank JS library.
 *
 * Endpoints
 * ---------
 * GET    /books      List all books.
 * POST   /books      Add a new book.
 * DELETE /books/:id  Remove a book by id.
 * GET    /errors     Intentionally throws to exercise EndPointBlank error tracking.
 *
 * All routes are protected by the `authorized` middleware (EndPointBlank
 * authorization check).  The reportInteraction / reportInteractionErrorHandler
 * middleware pair wraps every request/response and forwards data to the
 * EndPointBlank ingest service.
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

const INTAKE_URL = process.env.INTAKE_API_URL || 'http://localhost:4001';

epb.configure({
  baseUrl: INTAKE_URL,
  appName: 'epb-test-js',
  environment: process.env.NODE_ENV || 'development',
  clientId: 'Sb3JsTeSd8EvPmQnLuTwFc4YjHgNvOq',
  clientSecret: 'yK4pQmB7dN3sOkR2tF6bXeJiW0aFzGoBMaVnQkDpEyHwIlZcSxrUfOgtXu9P1J8',
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
