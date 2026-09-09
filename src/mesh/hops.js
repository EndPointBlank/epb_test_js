'use strict';

/**
 * Hop-budget header parsing.
 *
 * The contract lives in the deploy repository at
 * `docs/superpowers/specs/2026-09-08-hop-budget-contract.md`. Its parse table
 * is the specification; this module exists because none of the idiomatic
 * JavaScript one-liners implement it:
 *
 *   parseInt('1.5')  === 1      the contract says 0
 *   parseInt('0x4')  === 4      the contract says 0
 *   parseInt('4abc') === 4      the contract says 0
 *   Number('0x4')    === 4      the contract says 0
 *   Number('1e3')    === 1000   the contract says 0
 *   Number('+4')     === 4      the contract says 0
 *
 * So the value is matched against a base-10 digit pattern first, and only a
 * string that is entirely digits is converted at all. Everything else is 0,
 * and 0 means "answer and call nobody".
 *
 * A missing header must never mean "unlimited". That default is the whole
 * safety property: the applications are wired into a ring, and the one default
 * that can run away would run away on the box being measured.
 */

/** The most hops any request may carry. 12 laps of a five-node ring. */
const MAX_HOPS = 64;

const HOPS_HEADER = 'x-epb-test-hops';
const RUN_HEADER = 'x-epb-test-run';

/** Only these five, and the space. Deliberately not `\s`. */
const ASCII_WHITESPACE = new Set(['\t', '\n', '\v', '\f', '\r', ' ']);

const BASE_10_INTEGER = /^[0-9]+$/;

/**
 * Trims leading and trailing ASCII whitespace, and nothing else.
 *
 * `String.prototype.trim()` also strips U+00A0, U+2003, the BOM and the rest
 * of the Unicode whitespace class. The contract says ASCII, so a value like
 * `" 4"` is not a number with a space in front of it — it is junk, and
 * junk is 0.
 *
 * @param {string} value
 * @returns {string}
 */
function trimAscii(value) {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value[start])) start++;
  while (end > start && ASCII_WHITESPACE.has(value[end - 1])) end--;
  return value.slice(start, end);
}

/**
 * The first value of a possibly-repeated header.
 *
 * Node presents a repeated header as one comma-joined string (`"4, 2"`), and
 * some layers present it as an array. Both mean the header arrived more than
 * once, and the contract says the first value wins.
 *
 * @param {string|string[]|undefined|null} raw
 * @returns {string|null}
 */
function firstHeaderValue(raw) {
  const single = Array.isArray(raw) ? raw[0] : raw;
  if (typeof single !== 'string') return null;
  const [first] = single.split(',');
  return first;
}

/**
 * The hop budget carried by a request.
 *
 * @param {string|string[]|undefined|null} raw the raw header value, exactly as
 *   `req.headers['x-epb-test-hops']` gives it.
 * @returns {number} `0` for anything that is not a base-10 integer greater
 *   than zero; otherwise the value, clamped to {@link MAX_HOPS}.
 */
function parseHops(raw) {
  const first = firstHeaderValue(raw);
  if (first === null) return 0;

  const candidate = trimAscii(first);
  if (!BASE_10_INTEGER.test(candidate)) return 0;

  const value = Number(candidate);
  // A digit string long enough to overflow a double is still a budget that was
  // asked for, and the contract clamps a typo rather than rejecting it.
  // Falling through to 0 here would turn `X-EPB-Test-Hops: 999...9` into a
  // silent stop, which is the one outcome the clamp exists to avoid.
  if (!Number.isFinite(value)) return MAX_HOPS;
  if (value <= 0) return 0;

  return Math.min(value, MAX_HOPS);
}

/**
 * The opaque run identifier carried by a request.
 *
 * Forwarded verbatim, never modified, never generated — so unlike the hop
 * budget this is not trimmed, not validated, and not split on a comma. A run
 * identifier is sc-265's to define and may legitimately contain one. The array
 * form is the only case with a choice to make, and there the first value wins,
 * as it does for the budget.
 *
 * @param {string|string[]|undefined|null} raw
 * @returns {string|null} the identifier, or `null` when there is none to
 *   forward.
 */
function runIdentifier(raw) {
  const single = Array.isArray(raw) ? raw[0] : raw;
  if (typeof single !== 'string' || single === '') return null;
  return single;
}

module.exports = { parseHops, runIdentifier, MAX_HOPS, HOPS_HEADER, RUN_HEADER };
