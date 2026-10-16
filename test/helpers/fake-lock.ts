// A driver lock for engine tests on an in-memory store: held until released, with no file (the
// real lock is tested in driver-lock.test.ts).

import type { DriverLock } from '../../src/engine/driver-lock.ts';

export const fakeLock = (owner = 'driver-1'): DriverLock => {
  let held = true;
  return {
    owner,
    path: 'fake.lock',
    get held() {
      return held;
    },
    release() {
      held = false;
    },
  };
};
