// Staircase test: the request rate goes up in steps and holds each step.
// At the end the rate drops to 10 req/s, to show how the site recovers.
// STEPS sets the rates in iterations per second, for example STEPS=25,50,100.
import { baseOptions, botIteration, thresholds } from './lib.js';

const steps = (__ENV.STEPS || '25,50,100,200,400,800').split(',').map(Number);
const ramp = __ENV.RAMP || '30s';
const hold = __ENV.HOLD || '4m';

const stages = steps.flatMap((target) => [
  { target, duration: ramp },
  { target, duration: hold },
]);
stages.push({ target: 10, duration: '1m' }, { target: 10, duration: '3m' });

export const options = {
  ...baseOptions,
  scenarios: {
    stairs: {
      // An open model: k6 starts iterations at the set rate, also when the app is slow.
      executor: 'ramping-arrival-rate',
      startRate: Math.min(10, steps[0]),
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages,
    },
  },
  thresholds,
};

export default function () {
  botIteration();
}
