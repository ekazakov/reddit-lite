// Spike test: from a baseline to 2 times PEAK in 10 seconds, then back.
// It shows if the site recovers after a sudden burst.
import { baseOptions, botIteration, thresholds } from './lib.js';

// The normal rate, in iterations per second.
const base = Number(__ENV.BASE_RATE || 20);
// The burst rate: twice the PEAK value. Set PEAK to the highest rate that the site handled in the staircase test.
const peak = 2 * Number(__ENV.PEAK || 200);

export const options = {
  ...baseOptions,
  scenarios: {
    spike: {
      // An open model: k6 keeps the rate even when the app is slow.
      executor: 'ramping-arrival-rate',
      startRate: base,
      timeUnit: '1s',
      // VUs that k6 creates before the start.
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      // The VU limit. A burst needs many VUs when responses are slow.
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages: [
        // A calm start, to get a baseline.
        { target: base, duration: '2m' },
        // The sudden burst.
        { target: peak, duration: '10s' },
        // Stay at the peak, to see how the site behaves under overload.
        { target: peak, duration: '1m' },
        // The sudden drop.
        { target: base, duration: '10s' },
        // A long calm end. Latency must return to the baseline here, or the site did not recover.
        { target: base, duration: '3m' },
      ],
    },
  },
  // The pass and fail limits from lib.js.
  thresholds,
};

export default function () {
  // One weighted bot action for each iteration.
  botIteration();
}
