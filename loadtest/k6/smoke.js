// Smoke test: 1 logged-in bot runs each action in turn for 1 minute.
// Run it first. Each check must pass before you run a larger test.
import { sleep } from 'k6';
import exec from 'k6/execution';
import { actions, baseOptions, login } from './lib.js';

export const options = {
  ...baseOptions,
  scenarios: {
    smoke: { executor: 'constant-vus', vus: 1, duration: __ENV.DURATION || '1m' },
  },
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
};

const order = Object.keys(actions);

export default function () {
  // VU 1 is a logged-in bot (see isAnonymous in lib.js).
  login();
  actions[order[exec.vu.iterationInScenario % order.length]]();
  sleep(0.5);
}
