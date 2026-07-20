import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epochFromZonedWall } from '../schedules.js';

// AviationStack sends airport-LOCAL wall time with a fake +00:00 suffix.
test('epochFromZonedWall: Chicago summer wall time → correct UTC instant', () => {
  // 21:30 CDT (UTC-5) on 2026-07-20 = 02:30Z on 2026-07-21
  const t = epochFromZonedWall('2026-07-20T21:30:00+00:00', 'America/Chicago');
  assert.equal(new Date(t).toISOString(), '2026-07-21T02:30:00.000Z');
});

test('epochFromZonedWall: winter (CST, UTC-6) and no-tz fallback', () => {
  const t = epochFromZonedWall('2026-01-15T12:00:00+00:00', 'America/Chicago');
  assert.equal(new Date(t).toISOString(), '2026-01-15T18:00:00.000Z');
  // Missing tz → treated as UTC (best effort)
  const u = epochFromZonedWall('2026-07-20T21:30:00+00:00', null);
  assert.equal(new Date(u).toISOString(), '2026-07-20T21:30:00.000Z');
  assert.ok(Number.isNaN(epochFromZonedWall('garbage', 'America/Chicago')));
});

test('epochFromZonedWall: eastern-hemisphere zone (Tokyo, UTC+9)', () => {
  const t = epochFromZonedWall('2026-07-21T10:00:00+00:00', 'Asia/Tokyo');
  assert.equal(new Date(t).toISOString(), '2026-07-21T01:00:00.000Z');
});
