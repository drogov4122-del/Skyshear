import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLonToWorldPx, WORLD_SIZE } from '../radar.js';

const close = (a, b, eps = 1.5) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test('latLonToWorldPx: equator/prime meridian is world center', () => {
  const p = latLonToWorldPx(0, 0);
  close(p.x, WORLD_SIZE / 2);
  close(p.y, WORLD_SIZE / 2);
});

test('latLonToWorldPx: edges and clamps', () => {
  close(latLonToWorldPx(0, -180).x, 0);
  close(latLonToWorldPx(0, 180).x, WORLD_SIZE - 1);
  close(latLonToWorldPx(85.05, 0).y, 0, 3);              // mercator top
  close(latLonToWorldPx(-85.05, 0).y, WORLD_SIZE - 1, 3); // mercator bottom
  // polar clamp: beyond mercator range stays in-bounds
  const n = latLonToWorldPx(89, 10);
  assert.ok(n.y >= 0 && n.y < WORLD_SIZE);
});

test('latLonToWorldPx: northern hemisphere maps above center, monotonic in lon', () => {
  assert.ok(latLonToWorldPx(45, 0).y < WORLD_SIZE / 2);
  assert.ok(latLonToWorldPx(-45, 0).y > WORLD_SIZE / 2);
  assert.ok(latLonToWorldPx(0, -87).x < latLonToWorldPx(0, -74).x);
});
