// What a driver said of the batches that threw in its passes (ADR 0328): one line per batch and pass
// until its message changes or a pass goes over it clean, and which recovered. This only decides
// what is printed, so it stays in the driver's memory, as the flush watch does (ADR 0027): a restart
// says each failure once more.

export interface FailureLines<Pass> {
  /** Notes that `batchId` threw `message` in `pass`; whether that is new to say. */
  failed(pass: Pass, batchId: string, message: string): boolean;
  /** Ends a run of `pass` to its end: the batches it said failed and that did not fail in this run. */
  passed(pass: Pass): string[];
}

export const createFailureLines = <Pass>(): FailureLines<Pass> => {
  const byPass = new Map<Pass, Map<string, { message: string; again: boolean }>>();
  return {
    failed: (pass, batchId, message) => {
      const said = byPass.get(pass) ?? new Map<string, { message: string; again: boolean }>();
      byPass.set(pass, said);
      const earlier = said.get(batchId)?.message;
      said.set(batchId, { message, again: true });
      return earlier !== message;
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
