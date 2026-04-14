'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { COMPUTERS } = require('../data');

const router = Router();

/**
 * GET /computers
 *
 * Returns all computers used across school facilities.
 * Equivalent to the students endpoint in epb_test_rails.
 */
router.get('/', authorized, versioned(['1'], { state: 'Current' }), (req, res) => {
  LogWriter.info('Fetching computers list');
  res.json({ computers: COMPUTERS });
});

module.exports = router;
