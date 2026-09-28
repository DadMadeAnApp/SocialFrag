import { expect, test } from 'vitest';
import { duckCurve } from './duck';

const duck = { targets: [1], triggers: [2], amountDb: -12, thresholdDb: -40, releaseS: 0.4 };

test('dips while a trigger is above threshold and recovers after release', () => {
  const env = new Float32Array(1000); // 5 s
  env.fill(0.1, 200, 400); // −20 dB from 1 s to 2 s
  const c = duckCurve([env], duck, 1000);
  expect(c[100]).toBe(1);
  expect(c[395]).toBeCloseTo(10 ** (-12 / 20), 2); // fully ducked
  expect(c[400 + 80]).toBeGreaterThan(c[400]); // recovering 0.4 s later
  expect(c[999]).toBeGreaterThan(0.95);
});

test('quiet trigger never ducks; missing envelope samples count as silence', () => {
  const env = new Float32Array(10).fill(0.001); // −60 dB
  expect(Array.from(duckCurve([env], duck, 50)).every((v) => v === 1)).toBe(true);
});
