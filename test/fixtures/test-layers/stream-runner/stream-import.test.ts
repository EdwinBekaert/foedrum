import { type StreamOptions, streamProcess } from '../../../../src/platform/processes.ts';

export const run = (options: StreamOptions) => streamProcess('claude', [], options);
