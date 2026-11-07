// A virtual clock and timers for a brew whose calls take seconds: the shell's `clock` and `wait` over
// one counter that only the waits and `lag` move, so a test reads what the live line shows while a
// call is slow without a real second passing (ADR 0021).

export interface VirtualTimeline {
  /** The shell's clock. */
  clock: () => Date;
  /** The shell's wait: fires once the counter reaches it, or at once when `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * A promise that settles `ms` after now, for something outside the brew, such as an attempt that
   * ends: it moves no time itself, so it settles only while the brew waits or a call lags.
   */
  later: (ms: number) => Promise<void>;
  /**
   * A call that takes `ms`: the counter moves a second at a time, firing the timers that fall due,
   * with the event loop turning between the seconds so what a timer started can run. While it
   * lasts, no wait is cut short.
   */
  lag: (ms: number) => Promise<void>;
  /** Aborts once the counter is more than `runForMs` past the start. */
  controller: AbortController;
}

export const virtualTimeline = (start: Date, runForMs: number): VirtualTimeline => {
  const controller = new AbortController();
  let now = start.getTime();
  let lagging = 0;
  let queued = false;
  // `own` marks a wait on the brew's own signal: the wait between its ticks.
  const timers = new Set<{ at: number; done: () => void; own: boolean }>();
  const brewWaits = (): boolean => [...timers].some((timer) => timer.own);
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const fire = (): void => {
    if (now - start.getTime() > runForMs) controller.abort();
    for (const timer of [...timers]) {
      if (timer.at <= now) {
        timers.delete(timer);
        timer.done();
      }
    }
  };
  // While the brew itself waits between its ticks, and no call lags, the counter jumps to the next
  // timer two turns of the loop on: a loop that takes a turn before its next wait has set that
  // wait by then. While a tick runs it never moves, however many turns the tick takes, so the
  // waits beside a call (the live line's, the mark's) cannot run time ahead of it.
  const jump = (): void => {
    if (queued || lagging > 0 || !brewWaits()) return;
    queued = true;
    setImmediate(() => {
      setImmediate(() => {
        queued = false;
        if (lagging > 0 || !brewWaits()) return;
        now = Math.max(now, Math.min(...[...timers].map((timer) => timer.at)));
        fire();
        jump();
      });
    });
  };
  return {
    controller,
    clock: () => new Date(now),
    later: (ms) =>
      new Promise<void>((resolve) => {
        timers.add({ at: now + ms, done: resolve, own: false });
      }),
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const onAbort = (): void => {
          timers.delete(timer);
          resolve();
        };
        const timer = {
          at: now + ms,
          own: signal === controller.signal,
          done: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timers.add(timer);
        jump();
      }),
    lag: async (ms) => {
      lagging += 1;
      try {
        for (let spent = 0; spent < ms && !controller.signal.aborted; spent += 1000) {
          now += 1000;
          fire();
          await turn();
          await turn();
        }
      } finally {
        lagging -= 1;
        jump();
      }
    },
  };
};
