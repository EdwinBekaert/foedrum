// `foedrum stuck`: every Stuck batch with why, what it offers, and the questions it asks, numbered
// in the order `foedrum answer` takes their answers.

import { orderName } from '../engine/claim-orders.ts';
import type { State } from '../engine/fold.ts';
import { columns } from './columns.ts';
import { describeLane } from './status.ts';

/** What `foedrum stuck` prints: each Stuck batch, in the order they were ordered. */
export const formatStuck = (state: State): string => {
  const stuck = [...state.batches.values()].flatMap((batch) =>
    batch.lane.kind === 'stuck' ? [{ batch, lane: batch.lane }] : [],
  );
  if (stuck.length === 0) return 'No Stuck batches.\n';
  const heads = columns(
    stuck.map(({ batch }) => [batch.id, orderName(state, batch), describeLane(batch).detail]),
    '',
  );
  const lines = stuck.flatMap(({ lane }, i) => [
    heads[i] ?? '',
    `  options: ${lane.options.join(', ')}`,
    ...(lane.reason.kind === 'needs_input'
      ? lane.reason.questions.map(
          ({ q, options, recommended }, n) =>
            `  ${n + 1}. ${q} (${options.join(', ')}; recommended: ${recommended})`,
        )
      : []),
  ]);
  const count = `${stuck.length} Stuck ${stuck.length === 1 ? 'batch' : 'batches'}`;
  return `${[count, '', ...lines].join('\n')}\n`;
};
