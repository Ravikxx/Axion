import assert from 'node:assert/strict'
import test from 'node:test'

import { computeNextRun } from '../src/index.js'

// Friday, March 15 2024, 10:30:00 UTC — a fixed reference point used across
// these tests so expected values can be hand-verified against a calendar
// rather than re-deriving them with the same logic under test.
const FROM = Date.UTC(2024, 2, 15, 10, 30, 0)

test('every-minute schedule fires on the next whole minute after "from"', () => {
  const next = computeNextRun('* * * * *', FROM)
  assert.equal(next, Date.UTC(2024, 2, 15, 10, 31, 0))
})

test('a step schedule (*/15) fires on the next matching quarter-hour boundary', () => {
  const next = computeNextRun('*/15 * * * *', FROM)
  assert.equal(next, Date.UTC(2024, 2, 15, 10, 45, 0))
})

test('a daily schedule whose time has already passed today rolls to tomorrow', () => {
  const next = computeNextRun('0 9 * * *', FROM)
  assert.equal(next, Date.UTC(2024, 2, 16, 9, 0, 0))
})

test('a daily schedule whose time has not yet happened today fires today', () => {
  const next = computeNextRun('0 12 * * *', FROM)
  assert.equal(next, Date.UTC(2024, 2, 15, 12, 0, 0))
})

test('a monthly schedule (1st of the month) rolls to next month when already past', () => {
  const next = computeNextRun('0 0 1 * *', FROM)
  assert.equal(next, Date.UTC(2024, 3, 1, 0, 0, 0))
})

test('a weekly schedule (every Monday) finds the next Monday', () => {
  const next = computeNextRun('0 9 * * 1', FROM)
  assert.equal(next, Date.UTC(2024, 2, 18, 9, 0, 0)) // March 18 2024 is a Monday
})

test('day-of-month and day-of-week restricted together are OR-ed, not AND-ed', () => {
  // "1st of the month OR any Monday" — the next Monday (Mar 18) comes before
  // the next 1st-of-month (Apr 1), so the OR semantics should pick Mar 18.
  const next = computeNextRun('0 0 1 * 1', FROM)
  assert.equal(next, Date.UTC(2024, 2, 18, 0, 0, 0))
})

test('an impossible schedule (Feb 30th) returns null instead of hanging', () => {
  assert.equal(computeNextRun('0 0 30 2 *', FROM), null)
})

test('a malformed field count returns null', () => {
  assert.equal(computeNextRun('* * *', FROM), null)
})

test('seconds on "from" do not affect which minute is treated as the start', () => {
  const withSeconds = computeNextRun('* * * * *', FROM + 45_000)
  assert.equal(withSeconds, Date.UTC(2024, 2, 15, 10, 31, 0))
})
