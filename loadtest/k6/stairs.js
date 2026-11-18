// Staircase test: the request rate goes up in steps and holds each step.
// At the end the rate drops to 10 req/s, to show how the site recovers.
// STEPS sets the rates in iterations per second, for example STEPS=25,50,100.
import { baseOptions, botIteration, thresholds } from './lib.js';

// The rates to test. The defaults double each step, so the breaking point shows up fast.
const steps = (__ENV.STEPS || '25,50,70,90,100,110,80,50').split(',').map(Number);
// The time to move from one rate to the next.
const ramp = __ENV.RAMP || '15s';
// The time to stay on each rate. A long hold lets the system settle, so the numbers are stable.
const hold = __ENV.HOLD || '1m';

// For each rate, make two stages: a ramp up, then a hold.
const stages = steps.flatMap((target) => [
  { target, duration: ramp },
  { target, duration: hold },
]);
// Drop to a low rate and stay there. This shows if the site recovers after the overload.
stages.push({ target: 10, duration: '1m' });

export const options = {
  ...baseOptions,
  scenarios: {
    stairs: {
      // An open model: k6 starts iterations at the set rate, also when the app is slow.
      executor: 'ramping-arrival-rate',
      // Start low, but never above the first step.
      startRate: Math.min(10, steps[0]),
      // The rates above are per second.
      timeUnit: '1s',
      // VUs that k6 creates before the start, so the first requests do not wait for setup.
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      // The VU limit. If the app is slow, k6 adds VUs up to this number. Past it, k6 drops iterations.
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages,
    },
  },
  // The pass and fail limits from lib.js.
  thresholds,
};

export default function () {
  // One weighted bot action for each iteration.
  botIteration();
}
