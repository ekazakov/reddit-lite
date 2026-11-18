// Soak test: a constant rate for a long time, to find memory and connection leaks.
// Use about 70% of the breaking rate from the staircase test.
import { baseOptions, botIteration, thresholds } from './lib.js';

export const options = {
  ...baseOptions,
  scenarios: {
    soak: {
      // A fixed rate that does not change. k6 starts iterations at this rate even if the app is slow.
      executor: 'constant-arrival-rate',
      // Iterations per time unit. A rate below the breaking point lets only slow leaks show.
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      // A long run, because leaks need time to grow.
      duration: __ENV.DURATION || '1h',
      // VUs that k6 creates before the start.
      preAllocatedVUs: Number(__ENV.PRE_VUS || 100),
      // The VU limit, in case the app slows down.
      maxVUs: Number(__ENV.MAX_VUS || 1000),
    },
  },
  // The pass and fail limits from lib.js.
  thresholds,
};

export default function () {
  // One weighted bot action for each iteration.
  botIteration();
}
