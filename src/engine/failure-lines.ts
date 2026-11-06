// What a driver said of the batches that threw in its passes (ADR 0328): one line per batch and pass
// until its message changes or a pass goes over it clean, and which recovered. This only decides
// what is printed, so it stays in the driver's memory, as the flush watch does (ADR 0027): a restart
// says each failure once more.

export interface FailureLines {
  /** Notes that `batchId` threw `message` in `pass`; whether that is new to say. */
  failed(pass: string, batchId: string, message: string): boolean;
  /** Ends a run of `pass` to its end: the batches it said failed and that did not fail in this run. */
  passed(pass: string): string[];
}

/** A message without what changes each pass, a time or a count in it (ADR 0335). */
const steadyText = (message: string): string => message.replace(/[0-9]+/g, '#');

export const createFailureLines = (): FailureLines => {
  const byPass = new Map<string, Map<string, { message: string; again: boolean }>>();
  return {
    failed: (pass, batchId, message) => {
      const said = byPass.get(pass) ?? new Map<string, { message: string; again: boolean }>();
      byPass.set(pass, said);
      const earlier = said.get(batchId)?.message;
      const steady = steadyText(message);
      said.set(batchId, { message: steady, again: true });
      return earlier !== steady;
    },
    passed: (pass) => {
      const recovered: string[] = [];
      for (const [batchId, line] of byPass.get(pass) ?? []) {
        if (line.again) line.again = false;
        else recovered.push(batchId);
      }
      for (const batchId of recovered) byPass.get(pass)?.delete(batchId);
      return recovered;
    },
  };
};
