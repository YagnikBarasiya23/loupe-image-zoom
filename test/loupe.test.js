import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPan, insideTransform, lensTransform, pinch } from '../loupe.js';

test('the lens is centred on the pointer and shows that point magnified', () => {
  const { lens, inner } = lensTransform({ x: 200, y: 100 }, 3, 160);
  assert.deepEqual(lens, { x: 120, y: 20 });
  // Image point (200, 100) scaled by 3 lands at the lens centre (80, 80).
  assert.equal(200 * 3 + inner.x, 80);
  assert.equal(100 * 3 + inner.y, 80);
});

test('inside zoom keeps the pointed-at spot under the pointer', () => {
  const p = { x: 300, y: 120 };
  const t = insideTransform(p, 2.5);
  assert.equal(p.x * 2.5 + t.x, p.x);
  assert.equal(p.y * 2.5 + t.y, p.y);
  // Corners stay pinned: at the top-left corner nothing shifts.
  assert.equal(Math.abs(insideTransform({ x: 0, y: 0 }, 4).x), 0);
});

test('panning never reveals a gap at the edges', () => {
  const size = { width: 400, height: 300 };
  assert.deepEqual(clampPan(50, 50, 2, size), { x: 0, y: 0 });
  assert.deepEqual(clampPan(-900, -900, 2, size), { x: -400, y: -300 });
  assert.deepEqual(clampPan(-100, -80, 2, size), { x: -100, y: -80 });
});

test('pinching keeps the content under the fingers', () => {
  const start = { x: 0, y: 0, scale: 1 };
  const from = { mid: { x: 100, y: 100 }, distance: 100 };
  const to = { mid: { x: 100, y: 100 }, distance: 200 };
  const next = pinch(start, from, to);
  assert.equal(next.scale, 2);
  // The image point under the midpoint (100, 100) is still there.
  assert.equal(100 * next.scale + next.x, 100);
});

test('pinching and moving pans with the fingers', () => {
  const next = pinch({ x: -50, y: -20, scale: 2 }, { mid: { x: 100, y: 80 }, distance: 120 }, { mid: { x: 130, y: 60 }, distance: 120 });
  assert.equal(next.scale, 2);
  assert.deepEqual({ x: next.x, y: next.y }, { x: -20, y: -40 });
});

test('pinch scale is limited with a little overshoot allowed', () => {
  const huge = pinch({ x: 0, y: 0, scale: 1 }, { mid: { x: 0, y: 0 }, distance: 10 }, { mid: { x: 0, y: 0 }, distance: 1000 }, { min: 1, max: 4 });
  assert.equal(huge.scale, 4.6);
  const tiny = pinch({ x: 0, y: 0, scale: 1 }, { mid: { x: 0, y: 0 }, distance: 100 }, { mid: { x: 0, y: 0 }, distance: 10 }, { min: 1, max: 4 });
  assert.equal(tiny.scale, 0.8);
});
