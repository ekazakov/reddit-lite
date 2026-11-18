// Soak test: a constant rate for a long time, to find memory and connection leaks.
// Use about 70% of the breaking rate from the staircase test.
import { baseOptions, botIteration, thresholds } from './lib.js';

export const options = {
  ...baseOptions,
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '1h',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 100),
      maxVUs: Number(__ENV.MAX_VUS || 1000),
    },
  },
  thresholds,
};

export default function () {
  botIteration();
}
