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
const morgan = require('morgan');
const epb = require('end-point-blank-js');
const { setup: dbSetup } = require('./db');
const { reportInteraction, reportInteractionErrorHandler } = require('end-point-blank-js/src/middleware/report-interaction');
const { UnauthorizedError } = require('end-point-blank-js/src/unauthorized-error');
const { registerExpressEndpoints } = require('end-point-blank-js/src/express/endpoint-registrar');

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

module.exports = app;
