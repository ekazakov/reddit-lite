// Smoke test: 1 logged-in bot runs each action in turn for 1 minute.
// Run it first. Each check must pass before you run a larger test.
// Pause helper.
import { sleep } from 'k6';
// Test state, for the iteration counter.
import exec from 'k6/execution';
// The shared actions, options, and login.
import { actions, baseOptions, login } from './lib.js';

export const options = {
  ...baseOptions,
  scenarios: {
    // One VU with a fixed duration. DURATION overrides the default of 1 minute.
    smoke: { executor: 'constant-vus', vus: 1, duration: __ENV.DURATION || '1m' },
  },
  // Zero tolerance: every check must pass and no request may fail. One error proves a bug.
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
};

// The action names in a fixed order.
const order = Object.keys(actions);

export default function () {
  // VU 1 is a logged-in bot (see isAnonymous in lib.js).
  login();
  // Run the actions in turn, so each one runs the same number of times.
  actions[order[exec.vu.iterationInScenario % order.length]]();
  // A short pause, so the smoke test stays gentle.
  sleep(0.5);
}
