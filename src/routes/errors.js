'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');

const router = Router();

/**
 * GET /errors
 *
 * Intentionally throws an error to exercise EndPointBlank error tracking.
 * Equivalent to ErrorsController in epb_test_rails.
 */
router.get('/', authorized, versioned(['1']), (req, res) => {
  throw new Error('This is a test error for error tracking.');
});

module.exports = router;
