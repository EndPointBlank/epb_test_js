'use strict';

const { Router } = require('express');
const { authorized } = require('end-point-blank-js/src/express/authorized');
const { versioned } = require('end-point-blank-js/src/express/versioned');
const { LogWriter } = require('end-point-blank-js/src/writers/log-writer');
const { projectorsByFacility } = require('../data');

const router = Router();

router.get('/', authorized, versioned(['1'], { state: 'Current' }), async (req, res, next) => {
  try {
    LogWriter.info('Fetching projectors list');
    res.json({ projectors: await projectorsByFacility() });
  } catch (err) { next(err); }
});

module.exports = router;
