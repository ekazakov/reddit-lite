// Spike test: from a baseline to 2 times PEAK in 10 seconds, then back.
// It shows if the site recovers after a sudden burst.
import { baseOptions, botIteration, thresholds } from './lib.js';

const base = Number(__ENV.BASE_RATE || 20);
const peak = 2 * Number(__ENV.PEAK || 200);

export const options = {
  ...baseOptions,
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: base,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages: [
        { target: base, duration: '2m' },
        { target: peak, duration: '10s' },
        { target: peak, duration: '1m' },
        { target: base, duration: '10s' },
        { target: base, duration: '3m' },
      ],
    },
  },
  thresholds,
};

export default function () {
  botIteration();
}
