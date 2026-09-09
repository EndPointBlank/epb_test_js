'use strict';

/**
 * The parse table from docs/superpowers/specs/2026-09-08-hop-budget-contract.md.
 *
 * Every row of that table is a case here. The table exists because the
 * idiomatic JavaScript one-liners all get it wrong in different ways:
 * `Number('')` is 0 (which happens to be right, for the wrong reason),
 * `Number('  ')` is also 0, `parseInt('1.5')` is 1, `parseInt('0x4')` is 4,
 * `Number('0x4')` is 4, `parseInt('4abc')` is 4 and `Number('1e3')` is 1000.
 * A parser that agrees with the table is the requirement; a parser that agrees
 * with `parseInt` is a bug that only shows up as an unterminated ring.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHops, runIdentifier, MAX_HOPS } = require('../src/mesh/hops');

test('the clamp is the contract\'s 64', () => {
  assert.equal(MAX_HOPS, 64);
});

test('absent means stop, never unlimited', () => {
  assert.equal(parseHops(undefined), 0);
  assert.equal(parseHops(null), 0);
});

test('empty is zero', () => {
  assert.equal(parseHops(''), 0);
});

test('non-numeric is zero', () => {
  for (const raw of ['abc', 'four', 'null', 'undefined', 'NaN', 'Infinity']) {
    assert.equal(parseHops(raw), 0, `${JSON.stringify(raw)} must parse to 0`);
  }
});

test('non-integer decimal is zero, not truncated', () => {
  // parseInt('1.5') is 1. The contract says 0.
  assert.equal(parseHops('1.5'), 0);
  assert.equal(parseHops('0.9'), 0);
  assert.equal(parseHops('4.0'), 0);
});

test('non base-10 notation is zero', () => {
  // Number('0x4') is 4 and parseInt('0x4') is 4. The contract says 0.
  assert.equal(parseHops('0x4'), 0);
  assert.equal(parseHops('0b100'), 0);
  assert.equal(parseHops('0o4'), 0);
  // Number('1e3') is 1000. The contract says base-10 integer, so: 0.
  assert.equal(parseHops('1e3'), 0);
});

test('a signed value is zero, even when positive', () => {
  // Number('+4') is 4. The contract lists '+4' as a zero case.
  assert.equal(parseHops('+4'), 0);
});

test('negative is zero', () => {
  assert.equal(parseHops('-1'), 0);
  assert.equal(parseHops('-100'), 0);
  assert.equal(parseHops('-0'), 0);
});

test('zero is zero', () => {
  assert.equal(parseHops('0'), 0);
  assert.equal(parseHops('00'), 0);
});

test('whitespace-only is zero', () => {
  // Number(' ') and Number('\t\n') are both 0 -- right answer, and the test
  // exists so a later rewrite to parseInt (NaN) or to a regex that treats a
  // blank string as a match does not change it.
  for (const raw of [' ', '   ', '\t', '\n', '\r\n', '\f', '\v', ' \t\r\n ']) {
    assert.equal(parseHops(raw), 0, `${JSON.stringify(raw)} must parse to 0`);
  }
});

test('trailing junk is zero', () => {
  // parseInt('4abc') is 4. The contract says the value is a base-10 integer
  // or it is nothing.
  assert.equal(parseHops('4abc'), 0);
  assert.equal(parseHops('4 4'), 0);
  // A comma is not junk: it is how Node joins a header that arrived twice, so
  // `'4,'` is a repeat whose first value is 4. See the first-wins test below.
  assert.equal(parseHops('4,'), 4);
});

test('surrounding ASCII whitespace is trimmed', () => {
  assert.equal(parseHops(' 4 '), 4);
  assert.equal(parseHops('\t4\r\n'), 4);
  assert.equal(parseHops('  0  '), 0);
});

test('non-ASCII whitespace is not trimmed', () => {
  // The contract says ASCII whitespace. String.prototype.trim() also strips
  // U+00A0 and friends, which would quietly accept a value the contract does
  // not.
  assert.equal(parseHops(' 4'), 0);
  assert.equal(parseHops('4 '), 0);
  assert.equal(parseHops('﻿4'), 0);
});

test('a positive base-10 integer is itself', () => {
  assert.equal(parseHops('1'), 1);
  assert.equal(parseHops('4'), 4);
  assert.equal(parseHops('63'), 63);
  assert.equal(parseHops('64'), 64);
});

test('leading zeros are still base 10', () => {
  assert.equal(parseHops('007'), 7);
});

test('the budget clamps to 64 rather than being rejected', () => {
  assert.equal(parseHops('65'), 64);
  assert.equal(parseHops('1000'), 64);
  assert.equal(parseHops('1000000'), 64);
  // Long enough that Number() overflows to Infinity. A typo must still clamp,
  // not fall through to 0 -- 0 would be a silent stop dressed as a budget.
  assert.equal(parseHops('9'.repeat(400)), 64);
});

test('the first value wins when the header repeats', () => {
  // Node joins repeated headers into one comma-separated string.
  assert.equal(parseHops('4, 2'), 4);
  assert.equal(parseHops('4,2'), 4);
  assert.equal(parseHops('0, 9'), 0);
  assert.equal(parseHops('abc, 9'), 0);
  // And the array form, for any layer that preserves it.
  assert.equal(parseHops(['4', '2']), 4);
  assert.equal(parseHops([]), 0);
});

test('a non-string header value is zero, not coerced', () => {
  assert.equal(parseHops(4), 0);
  assert.equal(parseHops({}), 0);
  assert.equal(parseHops(true), 0);
});

test('the run identifier is passed through verbatim', () => {
  assert.equal(runIdentifier('run-42'), 'run-42');
  // Never trimmed, never reformatted: it is opaque and belongs to sc-265.
  assert.equal(runIdentifier('  run-42  '), '  run-42  ');
  assert.equal(runIdentifier('a,b'), 'a,b');
  assert.equal(runIdentifier(['first', 'second']), 'first');
});

test('an absent run identifier is null', () => {
  assert.equal(runIdentifier(undefined), null);
  assert.equal(runIdentifier(null), null);
  assert.equal(runIdentifier(''), null);
  assert.equal(runIdentifier([]), null);
});
