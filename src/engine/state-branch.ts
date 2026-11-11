// The state branch's pure core (ADR 0011, ADR 0024): which file an event belongs to, how log
// files are read, merged and extended, what a step boundary is, and whether the engine may start.
// No I/O: the shell (state-branch-git.ts) gathers the facts and carries out the decisions.

import { isDeepStrictEqual } from 'node:util';
import { parseJson } from '../formats/json.ts';
import { findSecrets } from '../formats/secrets.ts';
import { Event } from '../schemas/events.ts';
import { PathSafeId } from '../schemas/ids.ts';
import {
  BranchLogLine,
  CommitSha,
  type KeptOutDoc,
  noCommitSha,
  type PushedThrough,
} from '../schemas/store.ts';
import { z } from '../schemas/zod.ts';
import { effectKey } from './effect-key.ts';
import type { LoggedEvent, StoredEvent } from './event-store.ts';
import type { State } from './fold.ts';

/** The engine must stop: the state branch and this engine's store disagree (ADR 0024). */
export class StateBranchStopError extends Error {
  override readonly name = 'StateBranchStopError';
}

/** A file on the state branch, by its path with forward slashes, and its text. */
export interface BranchFile {
  path: string;
  text: string;
}

const TOP_LEVEL_LOG = 'events.jsonl';
const NEVER_REWRITTEN =
  'Foedrum never merges or rewrites state history: keep the remote history by moving the local ' +
  'database aside (the next start rebuilds it from the branch), or stop the other engine first.';

/** The batch an event belongs to; `undefined` for events without one. */
export const batchOf = (event: Event): string | undefined => {
  switch (event.type) {
    case 'effect.applied':
      return effectKey.decode(event.key).batchId;
    case 'bottle.opened':
    case 'release.observed':
    case 'system.mapped':
    case 'order.paused':
    case 'order.continued':
    case 'order.ranked':
    // The usage window holds every batch's brewers (ADR 0206).
    case 'usage.window_closed':
    case 'usage.window_opened':
      return undefined;
    case 'batch.approved':
    case 'batch.ordered':
    case 'batch.recipe_chosen':
    case 'step.scheduled':
    case 'step.skipped':
    case 'step.started':
    case 'step.finished':
    case 'input.received':
    case 'batch.stuck':
    case 'batch.resumed':
    case 'order.decomposed':
    case 'batch.waiting':
    case 'batch.rewound':
    case 'batch.on_tap':
    case 'batch.cancelled':
    case 'batch.taken_over':
    case 'batch.failing':
    case 'batch.recovered':
    case 'pull_request.ended':
    case 'pull_request.base_checked':
    case 'pull_request.pair_checked':
    case 'pull_request.checks_pending':
    case 'pull_request.checks_finished':
    case 'pull_request.reviews_read':
    case 'step.rescheduled':
    case 'order.approved':
      return event.batchId;
    // Its batch's own log moves to archive/ with it (ADR 0380).
    case 'batch.archived':
      return undefined;
    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
};

// The schema already refuses such ids; this is the one check where a path is built (ADR 0024).
const segment = (id: string, what: string): string => {
  if (!PathSafeId.safeParse(id).success) {
    throw new Error(`Invalid ${what} ${JSON.stringify(id)}: it is not a safe path segment`);
  }
  return id;
};

/** A batch's folder in `batches/`, and where its archive moves it (ADR 0380). */
export const batchFolder = (batchId: string): string => `batches/${segment(batchId, 'batch id')}`;
export const archiveFolder = (batchId: string): string => `archive/${segment(batchId, 'batch id')}`;

const batchLog = (batchId: string): string => `${batchFolder(batchId)}/events.jsonl`;

/** An archive's batch, read from a logged event that merging the logs checked already. */
const ArchivedRef = z.object({ type: z.literal('batch.archived'), batchId: PathSafeId });

/** The batches that `events` archive, whose folders a flush of them moves to `archive/` (ADR 0380). */
export const archivedIn = (events: readonly { event: unknown }[]): string[] =>
  events.flatMap(({ event }) => {
    const archived = ArchivedRef.safeParse(event);
    return archived.success ? [archived.data.batchId] : [];
  });

/** The log file an event belongs to: its batch's `events.jsonl`, or the top-level one. */
export const logPathOf = (event: Event): string => {
  const batchId = batchOf(event);
  return batchId === undefined ? TOP_LEVEL_LOG : batchLog(batchId);
};

/**
 * The out doc of an attempt within `batches/`, as `7-1/plan-2.md`: a batch id and a step id, both
 * path-safe, and the attempt.
 */
export const outDocPlace = ({
  batchId,
  stepId,
  attempt,
}: {
  batchId: string;
  stepId: string;
  attempt: number;
}): string => {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`Invalid attempt ${attempt}: it must be a positive integer`);
  }
  return `${segment(batchId, 'batch id')}/${segment(stepId, 'step id')}-${attempt}.md`;
};

/** Where the out doc of an attempt goes: next to its batch's `events.jsonl`. */
export const outDocPath = (ref: { batchId: string; stepId: string; attempt: number }): string =>
  `batches/${outDocPlace(ref)}`;

/**
 * The out doc of an attempt on `stateBranchUrl`, the branch's address on the code host: as GitHub
 * renders it when its body reads (`readable`, a plan's since ADR 0275), else opened as written
 * (`?plain=1`), since the rendered view does not show its JSON frontmatter readably. The branch,
 * not a commit: an attempt's path is its own, and a flush writes it with the same text. The
 * driver applies its effects after the tick's flush, so a link a comment shows for a
 * `step.finished` just recorded works from the next tick's push (ADR 0266).
 */
export const outDocLink = (
  stateBranchUrl: string,
  ref: { batchId: string; stepId: string; attempt: number },
  readable = false,
): string => `${stateBranchUrl}/${outDocPath(ref)}${readable ? '' : '?plain=1'}`;

/**
 * The most bytes of an out doc's text the state branch keeps (ADR 0103); past it, a fixed line
 * takes the text's place.
 */
export const MAX_BRANCH_OUT_DOC_BYTES = 256 * 1024;

/** Whether `path` is a log file: `events.jsonl` or `batches/<batchId>/events.jsonl`. */
export const isLogPath = (path: string): boolean => {
  if (path === TOP_LEVEL_LOG) return true;
  const batchId = /^batches\/([^/]+)\/events\.jsonl$/.exec(path)?.[1];
  return batchId !== undefined && PathSafeId.safeParse(batchId).success;
};

const formatLine = ({ id, event }: { id: number; event: unknown }): string =>
  `${JSON.stringify({ id, event })}\n`;

interface Line extends LoggedEvent {
  /** 1-based, for messages. */
  line: number;
}

const stop = (reason: string): StateBranchStopError => new StateBranchStopError(reason);

const parseLines = ({ path, text }: BranchFile): Line[] => {
  const lines: Line[] = [];
  let previous = 0;
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((content, i) => {
      if (content.trim() === '') return;
      const where = `${path}:${i + 1}`;
      const read = BranchLogLine.safeParse(parseJson(content));
      if (!read.success) {
        throw stop(`${where}: not a stored event {"id":<positive integer>,"event":{…}}`);
      }
      const { id, event } = read.data;
      if (id <= previous) {
        throw stop(`${where}: ids must grow, but ${id} follows ${previous}`);
      }
      previous = id;
      lines.push({ id, event, line: i + 1 });
    });
  return lines;
};

/** Reads one log file; throws `StateBranchStopError` naming the file and line of a bad line. */
export const parseLog = (file: BranchFile): LoggedEvent[] =>
  parseLines(file).map(({ id, event }) => ({ id, event }));

/**
 * Merges every log file by id. Throws `StateBranchStopError` for a bad line, a repeated id, or
 * an event in a file it does not belong to.
 */
export const mergeLogs = (files: readonly BranchFile[]): LoggedEvent[] => {
  const found = new Map<number, { path: string; event: Event }>();
  for (const file of files) {
    for (const { id, event, line } of parseLines(file)) {
      const where = `${file.path}:${line}`;
      const parsed = Event.safeParse(event);
      if (!parsed.success) throw stop(`${where}: event ${id} is invalid: ${parsed.error.message}`);
      const belongs = logPathOf(parsed.data);
      if (belongs !== file.path) {
        throw stop(`${where}: event ${id} (${parsed.data.type}) belongs in ${belongs}`);
      }
      const other = found.get(id);
      if (other !== undefined) throw stop(`event id ${id} is in both ${other.path} and ${where}`);
      found.set(id, { path: file.path, event: parsed.data });
    }
  }
  return [...found].sort(([a], [b]) => a - b).map(([id, { event }]) => ({ id, event }));
};

/**
 * A full commit hash in an out doc: out docs name the commits they made and read, and a hash is no
 * key a brewer can choose (ADR 0378). `findSecrets` asks this only of a 40-character hexadecimal word.
 */
const namedCommit = (): boolean => true;

// A private key's block, PEM's or PGP's: its body lines need not look like a secret one by one
// (ADR 0378).
const KEY_BEGINS = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_ENDS = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * `text` with each line that looks like a secret replaced where it stood by a fixed line naming
 * the attempt, its line end kept: never the line, nor `findSecrets`' excerpt of it. Every line of
 * a private key's block goes, through its end line or, without one, to the end (ADR 0378).
 */
const withoutSecretLines = (text: string, stepId: string, attempt: number): string => {
  let inKey = false;
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const end = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
      const content = line.slice(0, line.length - end.length);
      const keyLine = inKey || KEY_BEGINS.test(content);
      inKey = keyLine && !KEY_ENDS.test(content);
      if (!keyLine && findSecrets(content, namedCommit).length === 0) return line;
      return `[left out: a line of ${stepId}#${attempt} that looks like a secret]${end}`;
    })
    .join('');
};

/**
 * A kept out doc as a file on the branch: model output, never read back as a log or an order (ADR
 * 0103), stored as it is but for its lines that look like a secret (ADR 0378). Past
 * `MAX_BRANCH_OUT_DOC_BYTES` a fixed line takes its place.
 */
const outDocFile = (doc: KeptOutDoc): BranchFile => {
  const path = outDocPath(doc);
  const bytes = Buffer.byteLength(doc.text, 'utf8');
  if (bytes <= MAX_BRANCH_OUT_DOC_BYTES) {
    return { path, text: withoutSecretLines(doc.text, doc.stepId, doc.attempt) };
  }
  const text = `[left out: the out doc of ${doc.stepId}#${doc.attempt} is ${bytes} bytes, more than the ${MAX_BRANCH_OUT_DOC_BYTES} the state branch keeps]\n`;
  return { path, text };
};

/** Whether a logged `event` is `ours` as the store reads it: the schema drops an old receipt's cost (ADR 0181). */
const sameAsRead = (event: unknown, ours: Event): boolean => {
  const read = Event.safeParse(event);
  return read.success && isDeepStrictEqual(read.data, ours);
};

/**
 * The new text of every log file the pending events go to, then every out doc in `outDocs` at its
 * `outDocPath`, so each goes into the commit of the step.finished that records it (ADR 0103).
 * `current` holds the files to check, as they are in the worktree (missing when absent): at least
 * those the pending events go to. Lines after `pushedThrough` that a crashed flush left behind are
 * replaced; one that differs from the pending event with its id, also as the store reads it, means
 * another engine wrote it, and throws `StateBranchStopError`. Without pending events only the out
 * docs are planned: those kept after their step.finished was pushed, such as an attempt's that
 * Stuck abandoned.
 */
export const planFlush = (
  current: ReadonlyMap<string, string | undefined>,
  pending: readonly StoredEvent[],
  pushedThrough: number,
  outDocs: readonly KeptOutDoc[] = [],
): BranchFile[] => {
  const byPath = new Map<string, StoredEvent[]>();
  // Each pending line by id, with the file it goes to.
  const byId = new Map<number, { path: string; text: string; event: Event }>();
  let previous = pushedThrough;
  for (const stored of pending) {
    if (stored.id <= previous) {
      throw new Error(`Pending events must grow and come after ${pushedThrough}`);
    }
    previous = stored.id;
    const path = logPathOf(stored.event);
    byPath.set(path, [...(byPath.get(path) ?? []), stored]);
    byId.set(stored.id, { path, text: formatLine(stored), event: stored.event });
  }
  const kept = new Map<string, string>();
  for (const path of new Set([...current.keys(), ...byPath.keys()])) {
    let text = '';
    for (const line of parseLines({ path, text: current.get(path) ?? '' })) {
      const formatted = formatLine(line);
      if (line.id <= pushedThrough) {
        text += formatted;
        continue;
      }
      const ours = byId.get(line.id);
      if (ours === undefined) {
        throw stop(`${path} has event ${line.id}, which this engine does not have`);
      }
      if (ours.path !== path || (ours.text !== formatted && !sameAsRead(line.event, ours.event))) {
        throw stop(
          `${path} has an event ${line.id} that differs from this engine's event ${line.id}`,
        );
      }
    }
    kept.set(path, text);
  }
  return [
    ...[...byPath].map(([path, events]) => ({
      path,
      text: (kept.get(path) ?? '') + events.map(formatLine).join(''),
    })),
    ...outDocs.map(outDocFile),
  ];
};

const range = (from: number, to: number): string =>
  from === to ? `event ${from}` : `events ${from}–${to}`;

/** The commit message of a flush. */
export const commitMessage = (pending: readonly StoredEvent[]): string => {
  const first = pending[0];
  const last = pending.at(-1);
  if (first === undefined || last === undefined) return 'Record state';
  return `Record ${range(first.id, last.id)}`;
};

/**
 * The branch's events after the local ones, once every local event is checked to be on the
 * branch with the same id and content; throws `StateBranchStopError` when one is not.
 */
export const planCatchUp = (
  branch: readonly LoggedEvent[],
  local: readonly StoredEvent[],
): LoggedEvent[] => {
  const onBranch = new Map(branch.map((logged) => [logged.id, logged.event]));
  // The events of a batch the branch archived left batches/ with its folder (ADR 0380).
  const archived = new Set(archivedIn(branch));
  for (const { id, event } of local) {
    const batchId = batchOf(event);
    if (batchId !== undefined && archived.has(batchId) && !onBranch.has(id)) continue;
    if (!onBranch.has(id)) throw stop(`local event ${id} is not on the state branch`);
    if (!isDeepStrictEqual(onBranch.get(id), event)) {
      throw stop(`event ${id} on the state branch differs from local event ${id}`);
    }
  }
  const last = local.at(-1)?.id ?? 0;
  const localIds = new Set(local.map((stored) => stored.id));
  const missing = branch.find((logged) => logged.id <= last && !localIds.has(logged.id));
  if (missing !== undefined) {
    throw stop(`the state branch has event ${missing.id}, which the local store lacks`);
  }
  return branch.filter((logged) => logged.id > last);
};

/**
 * Whether appending `event` (which took the state from `before` to `after`) ends a step: it is
 * `step.finished`, or it changes a batch's lane kind (ADR 0024).
 */
export const isStepBoundary = (event: Event, before: State, after: State): boolean => {
  if (event.type === 'step.finished') return true;
  const batchId = batchOf(event);
  if (batchId === undefined) return false;
  return before.batches.get(batchId)?.lane.kind !== after.batches.get(batchId)?.lane.kind;
};

/** What the engine knows at start-up. */
export interface StartFacts {
  /** The remote branch, for messages, such as `origin/foedrum/state`. */
  branch: string;
  lastEventId: number;
  pushed: PushedThrough | undefined;
  /** The state worktree's commit; undefined before its first commit. */
  localHead: string | undefined;
  /** The remote branch's commit; undefined when the branch does not exist. */
  remoteHead: string | undefined;
  /** Whether the marker's commit is the remote head or one of its ancestors. */
  pushedReachesRemote: boolean;
}

export type StartDecision =
  | { kind: 'ready' }
  /** Push what is not on the branch yet. */
  | { kind: 'flush' }
  /** Append the branch's events after the local ones (the database is missing or behind). */
  | { kind: 'restore' }
  | { kind: 'stop'; reason: string };

/** The start-up table of ADR 0024. */
export const decideStart = (facts: StartFacts): StartDecision => {
  const { branch, lastEventId, pushed, localHead, remoteHead } = facts;
  const pushedId = pushed?.eventId ?? 0;
  const unpushed = lastEventId > pushedId;
  if (remoteHead === undefined) {
    if (pushed !== undefined) {
      return {
        kind: 'stop',
        reason: `${branch} is gone, but this engine pushed events up to ${pushedId} in ${pushed.commit}. ${NEVER_REWRITTEN}`,
      };
    }
    return { kind: unpushed ? 'flush' : 'ready' };
  }
  if (pushed?.commit === remoteHead) return { kind: unpushed ? 'flush' : 'ready' };
  if (pushed !== undefined && !facts.pushedReachesRemote) {
    return {
      kind: 'stop',
      reason: `${branch} was rewritten: the last commit this engine pushed, ${pushed.commit}, is not in its history at ${remoteHead}. ${NEVER_REWRITTEN}`,
    };
  }
  if (!unpushed) return { kind: 'restore' };
  // A push whose marker was not written; the flush checks that the files hold our events.
  if (localHead === remoteHead) return { kind: 'flush' };
  const since = pushed === undefined ? 'never pushed' : `not pushed after ${pushed.commit}`;
  return {
    kind: 'stop',
    reason:
      `The state branch diverged: this engine has ${range(pushedId + 1, lastEventId)} ${since} ` +
      `(local head ${localHead ?? 'none'}), and ${branch} is at ${remoteHead}. ${NEVER_REWRITTEN}`,
  };
};

/**
 * The paths in `git ls-tree -r -z` output that are not plain files: symbolic links and
 * submodules, which could lead reads and writes outside the state worktree (ADR 0024).
 */
export const unsafeEntries = (lsTree: string): string[] =>
  lsTree
    .split('\0')
    .filter((entry) => /^(?:120000|160000) /.test(entry))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));

/**
 * The commit of exactly `ref` in `git ls-remote` output, or undefined when it is not there.
 * ls-remote matches patterns against the end of a ref, so `refs/heads/x/refs/heads/<branch>`
 * also matches; only the exact ref counts. Throws when its object name is not a full sha.
 */
export const remoteCommitOf = (lsRemote: string, ref: string): string | undefined => {
  for (const line of lsRemote.split(/\r?\n/)) {
    const [commit = '', name] = line.split('\t');
    if (name !== ref) continue;
    if (!CommitSha.safeParse(commit).success) {
      throw new Error(
        noCommitSha(
          commit,
          `git ls-remote names ${ref} with ${JSON.stringify(commit)}, not a commit sha`,
        ),
      );
    }
    return commit;
  }
  return undefined;
};

export type PushOutcome = 'pushed' | 'rejected' | 'secret' | 'failed';

// What GitHub's push protection prints on stderr when it refuses a push (ADR 0378): its heading,
// its rule, and the older message.
const PUSH_PROTECTION = /push protection|push cannot contain secrets|secrets detected/i;

/**
 * Reads `git push --porcelain`: rejected means the remote moved (non-fast-forward); secret, that
 * the remote refused it and its stderr names push protection (ADR 0378).
 */
export const classifyPush = ({
  code,
  stdout,
  stderr = '',
}: {
  code: number | null;
  stdout: string;
  stderr?: string;
}): PushOutcome => {
  if (code === 0) return 'pushed';
  const refused = stdout.split(/\r?\n/).filter((line) => line.startsWith('!'));
  if (refused.some((line) => line.includes('\t[rejected]'))) return 'rejected';
  const remote = refused.some((line) => line.includes('\t[remote rejected]'));
  return remote && PUSH_PROTECTION.test(stderr) ? 'secret' : 'failed';
};

// The page where the account that pushed allows a secret push protection found, as GitHub prints it.
const UNBLOCK_URL =
  /https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/security\/secret-scanning\/unblock-secret\/[A-Za-z0-9]+/g;

/**
 * Why the engine stops when push protection refused `commit` (ADR 0378): the commit and the events
 * it holds (`from` to `through`; none when `through` is below `from`), each unblock page `stderr`
 * names, and the way on without one. Never the secret, nor any other line of `stderr`.
 */
export const secretRefusal = ({
  commit,
  from,
  through,
  stderr,
}: {
  commit: string;
  from: number;
  through: number;
  stderr: string;
}): string => {
  const what = through >= from ? `with ${range(from, through)}` : 'with out docs only';
  const urls = [...new Set(stderr.match(UNBLOCK_URL) ?? [])];
  const page = urls.length === 0 ? 'the page GitHub printed for this push' : urls.join(' and ');
  return (
    `GitHub push protection refused the state branch: commit ${commit} ${what} holds a text it reads as a secret, ` +
    'and every later commit carries it. The engine stops; Foedrum never rewrites state history. ' +
    `To go on, if the secret is real, revoke or rotate it first, since the branch keeps it for good; then open ${page} as the account that pushed, allow the secret, and start again within three hours ` +
    '(without that right, ask an admin of the repository for a bypass). ' +
    'Else start again after moving the database aside, which rebuilds it from the branch and loses what is not on it.'
  );
};
