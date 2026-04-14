'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { projectorsByFacility } = require('../data');

const router = Router();

/**
 * GET /projectors
 *
 * Returns all projectors grouped by the facility they belong to.
 * Equivalent to the teachers endpoint in epb_test_rails.
 */
router.get('/', authorized, versioned(['1'], { state: 'Current' }), (req, res) => {
  LogWriter.info('Fetching projectors list');
  res.json({ projectors: projectorsByFacility() });
});

module.exports = router;
