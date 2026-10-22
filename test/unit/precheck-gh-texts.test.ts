// The gate reads what gh would post (ADR 0132): titles, bodies and comments of gh pr and gh issue,
// and the title and body fields and input of gh api, against the personal denylist. The list and
// the files are injected, with fixture words only: no test reads the real list or the home folder.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GH_FILE_MAX_BYTES, ghFileReader, textRefusal } from '../../scripts/denylist.ts';
import {
  type CheckResult,
  type DeniedTexts,
  forbiddenReason,
  precheck,
} from '../../scripts/precheck.ts';
import type { DenylistState } from '../../src/platform/denylist.ts';

const PATH = '/lists/denylist.txt';
const WORD = /example.?corp/i;
const set = (text: string): DenylistState => ({ kind: 'set', path: PATH, text });
const CWD = '/work/tree';

// Files by their path parts as the gate resolves them from CWD, and every read made.
const fakeFiles = (files: Record<string, string> = {}) => {
  const reads: string[][] = [];
  const readAt = (cwd: string, path: readonly string[]): string => {
    assert.equal(cwd, CWD);
    reads.push([...path]);
    const text = files[path.join('/')];
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${path.join('/')}'`);
    return text;
  };
  return { reads, readAt };
};

const scan = (files: Record<string, string> = {}, list = set('# fixture words\nExampleCorp\n')) => {
  const fake = fakeFiles(files);
  return { ...fake, deniedTexts: textRefusal(() => list, fake.readAt) };
};

// The refusal for a command, and that it never names the word.
const refusal = (command: string, files: Record<string, string> = {}): string => {
  const reason = forbiddenReason(command, scan(files).deniedTexts, CWD) ?? '';
  assert.doesNotMatch(reason, WORD);
  return reason;
};

const hit = (what: string, place: string): RegExp =>
  new RegExp(
    `^${literal(what)} is blocked: it would send a word on your denylist \\(ADR 0114\\), at ${literal(place)}\\. `,
  );
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('forbiddenReason on what gh pr and gh issue would post', () => {
  const inline: [string, string, string][] = [
    [
      'gh pr create --draft -t "Add ExampleCorp support" -b plain',
      'gh pr create',
      '--title line 1',
    ],
    ['gh pr create --title="example-corp" --body plain', 'gh pr create', '--title line 1'],
    ['gh pr create -tExampleCorp -b plain', 'gh pr create', '--title line 1'],
    ['gh pr create -dt examplecorp -b plain', 'gh pr create', '--title line 1'],
    ['gh pr create -t=ExampleCorp -b plain', 'gh pr create', '--title line 1'],
    ['gh pr new -a me -t plain -b "one\nfor ExampleCorp"', 'gh pr new', '--body line 2'],
    ['gh pr edit 5 --body "ok\nexample_corp"', 'gh pr edit', '--body line 2'],
    ['gh pr edit 5 -t "Rename exampleCorpClient"', 'gh pr edit', '--title line 1'],
    ['gh pr comment 5 -b "Thanks, ExampleCorp"', 'gh pr comment', '--body line 1'],
    ['gh pr comment 5 --body=examplecorp', 'gh pr comment', '--body line 1'],
    ['gh issue create -t plain -b "for ExampleCorp"', 'gh issue create', '--body line 1'],
    ['gh issue create --title ExampleCorp --body plain', 'gh issue create', '--title line 1'],
    ['gh issue new -l bug -b examplecorp', 'gh issue new', '--body line 1'],
    ['gh issue edit 3 -t ExampleCorp', 'gh issue edit', '--title line 1'],
    ['gh issue comment 3 --body "example corp"', 'gh issue comment', '--body line 1'],
    ['gh -R o/r issue comment 3 -b examplecorp', 'gh issue comment', '--body line 1'],
  ];
  for (const [command, what, place] of inline) {
    it(`blocks a word given inline, naming the field: ${command}`, () => {
      assert.match(refusal(command), hit(what, `${what} ${place}`));
    });
  }

  it('lets a clean title and body through, reading a body file', () => {
    for (const command of [
      'gh pr create --draft -t "Add a plan" -b "plain text"',
      'gh issue comment 3 -b "Corporate example"',
      'gh pr comment 5 --body-file body.md',
    ]) {
      const { deniedTexts, reads } = scan({ 'body.md': 'clean\n' });
      assert.equal(forbiddenReason(command, deniedTexts, CWD), undefined);
      assert.deepEqual(reads, command.includes('body.md') ? [['body.md']] : []);
    }
  });

  const fromFiles: [string, string[], string][] = [
    [
      'gh pr comment 5 --body-file .foedrum/tmp/345/body.md',
      ['.foedrum/tmp/345/body.md'],
      'gh pr comment --body-file .foedrum/tmp/345/body.md:2',
    ],
    ['gh pr create --draft -t plain -F body.md', ['body.md'], 'gh pr create --body-file body.md:2'],
    ['gh pr edit 5 --body-file=body.md', ['body.md'], 'gh pr edit --body-file body.md:2'],
    ['gh issue create -t plain -Fbody.md', ['body.md'], 'gh issue create --body-file body.md:2'],
    ['gh issue edit 3 -F body.md', ['body.md'], 'gh issue edit --body-file body.md:2'],
    [
      'cd sub && gh issue comment 3 -F body.md',
      ['sub', 'body.md'],
      'gh issue comment --body-file body.md:2',
    ],
  ];
  for (const [command, path, place] of fromFiles) {
    it(`reads a body from a file where gh runs, naming the file and line: ${command}`, () => {
      const { deniedTexts, reads } = scan({ [path.join('/')]: 'clean\nfor ExampleCorp\n' });
      const reason = forbiddenReason(command, deniedTexts, CWD) ?? '';
      assert.match(reason, hit(place.split(' --')[0] ?? '', place));
      assert.deepEqual(reads, [path]);
    });
  }

  it('names a body file whose path holds the word without the path', () => {
    const reason = refusal('gh pr comment 5 -F notes/examplecorp.md', {
      'notes/examplecorp.md': 'ExampleCorp\n',
    });
    assert.match(
      reason,
      hit(
        'gh pr comment',
        'gh pr comment --body-file a file whose path holds a denied word, line 1',
      ),
    );
  });

  it('blocks a body file it cannot read, saying so', () => {
    const reason = refusal('gh pr comment 5 --body-file missing.md');
    assert.match(reason, /^gh pr comment is blocked: could not read its --body-file missing\.md /);
    assert.match(reason, /ENOENT/);
    assert.match(reason, /\(ADR 0132\)/);
  });

  it('blocks a body file it cannot read whose path holds the word, without the path', () => {
    const reason = refusal('gh pr comment 5 -F notes/examplecorp.md');
    assert.match(
      reason,
      /^gh pr comment is blocked: could not read its --body-file from a file whose path holds a denied word, /,
    );
    assert.doesNotMatch(reason, /ENOENT/);
  });

  // A value of another option is never read as a title or body, nor anything after --.
  it('skips the values of the other options, and what comes after --', () => {
    for (const command of [
      'gh issue edit 3 --add-label -tExampleCorp',
      'gh pr create -B -bExampleCorp -t plain',
      'gh pr comment 5 -- -b ExampleCorp',
      'gh api repos/o/r/issues -H -ftitle=ExampleCorp',
      'gh api repos/o/r/issues --jq -Fbody=ExampleCorp',
    ]) {
      assert.equal(forbiddenReason(command, scan().deniedTexts, CWD), undefined, command);
    }
  });

  // The error names the path as resolved, from the hook's working directory or the home folder.
  it('never quotes a read error that holds the word', () => {
    const readAt = () => {
      throw new Error(`ENOENT: no such file, open '/home/examplecorp/site/missing.md'`);
    };
    const deniedTexts = textRefusal(() => set('ExampleCorp\n'), readAt);
    const reason = forbiddenReason('gh pr comment 5 -F missing.md', deniedTexts, CWD) ?? '';
    assert.match(reason, /^gh pr comment is blocked: could not read its --body-file missing\.md /);
    assert.doesNotMatch(reason, WORD);
  });
});

describe('ghFileReader', () => {
  // A file system of regular files and others, by resolved path, and every call made.
  const fakeFileSystem = (entries: Record<string, { text?: string; size?: number }>) => {
    const calls: string[] = [];
    const entry = (path: string) => {
      const found = entries[path];
      if (found === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`);
      return found;
    };
    return {
      calls,
      files: {
        resolve: (cwd: string, path: readonly string[]) => [cwd, ...path].join('/'),
        stat: (path: string) => {
          calls.push(`stat ${path}`);
          const { text, size } = entry(path);
          return { isFile: () => text !== undefined, size: size ?? text?.length ?? 0 };
        },
        read: (path: string) => {
          calls.push(`read ${path}`);
          return entry(path).text ?? '';
        },
      },
    };
  };
  const failure = (read: () => string): string => {
    try {
      read();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return 'read';
  };

  it('reads a regular file at the path resolved from where the hook runs', () => {
    const { files, calls } = fakeFileSystem({ '/work/tree/body.md': { text: 'plain' } });
    assert.equal(ghFileReader(files, 'linux')('/work/tree', ['body.md']), 'plain');
    assert.deepEqual(calls, ['stat /work/tree/body.md', 'read /work/tree/body.md']);
  });

  it('never reads what is not a regular file, such as /dev/stdin or a FIFO', () => {
    const { files, calls } = fakeFileSystem({ '/work/tree//dev/stdin': {} });
    assert.match(
      failure(() => ghFileReader(files, 'linux')('/work/tree', ['/dev/stdin'])),
      /not a regular file/,
    );
    assert.deepEqual(calls, ['stat /work/tree//dev/stdin']);
  });

  it(`never reads a file over ${GH_FILE_MAX_BYTES} bytes`, () => {
    const { files, calls } = fakeFileSystem({
      '/work/tree/big.json': { text: '{}', size: GH_FILE_MAX_BYTES + 1 },
    });
    assert.match(
      failure(() => ghFileReader(files, 'linux')('/work/tree', ['big.json'])),
      /over/,
    );
    assert.deepEqual(calls, ['stat /work/tree/big.json']);
  });

  it(`reads a file of exactly ${GH_FILE_MAX_BYTES} bytes`, () => {
    const { files } = fakeFileSystem({
      '/work/tree/full.json': { text: '{}', size: GH_FILE_MAX_BYTES },
    });
    assert.equal(ghFileReader(files, 'linux')('/work/tree', ['full.json']), '{}');
  });

  it('reads a relative path inside a folder on Windows, and a full drive path', () => {
    const { files } = fakeFileSystem({
      'C:\\work/sub/body.md': { text: 'plain' },
      'C:\\work/C:\\notes\\body.md': { text: 'full' },
    });
    const reader = ghFileReader(files, 'win32');
    assert.equal(reader('C:\\work', ['sub', 'body.md']), 'plain');
    assert.equal(reader('C:\\work', ['C:\\notes\\body.md']), 'full');
  });

  it('never touches a network or drive-less path on Windows', () => {
    for (const path of ['\\\\attacker.example\\s\\x.md', '//attacker.example/s/x.md']) {
      const { files, calls } = fakeFileSystem({});
      const windows = {
        ...files,
        resolve: (_cwd: string, parts: readonly string[]) => parts.join(''),
      };
      assert.match(
        failure(() => ghFileReader(windows, 'win32')('C:\\work', [path])),
        /network/,
      );
      assert.deepEqual(calls, []);
    }
  });

  // Git Bash maps /tmp/… for gh to another folder than the gate would resolve, PowerShell passes
  // /c/… to gh as a folder of the current drive, and a drive's own current folder (D:notes.md)
  // is gh's to know: the gate refuses each part as written, before it resolves it.
  it('refuses a rooted or drive-relative path on Windows, as written, touching nothing', () => {
    for (const part of ['/tmp/body.md', '/c/notes/body.md', '\\notes\\body.md', 'D:notes.md']) {
      const { files, calls } = fakeFileSystem({ [`C:\\work/${part}`]: { text: 'plain' } });
      const reader = ghFileReader(files, 'win32');
      assert.match(
        failure(() => reader('C:\\work', [part])),
        /Windows or relative path/,
        part,
      );
      assert.deepEqual(calls, [], part);
    }
  });

  // bash leaves ~ after @ and in quotes as it is, and PowerShell never expands it for gh.
  it('refuses a ~ path on every platform, which gh may read as a folder named ~', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { files, calls } = fakeFileSystem({});
      assert.match(
        failure(() => ghFileReader(files, platform)('/work/tree', ['~/draft.md'])),
        /without ~/,
      );
      assert.deepEqual(calls, []);
    }
  });

  it('blocks gh pr comment -F /dev/stdin, which reads standard input', () => {
    const { files } = fakeFileSystem({ '/work/tree//dev/stdin': {} });
    const deniedTexts = textRefusal(() => set('ExampleCorp\n'), ghFileReader(files, 'linux'));
    const reason = forbiddenReason('gh pr comment 5 -F /dev/stdin', deniedTexts, CWD) ?? '';
    assert.match(
      reason,
      /^gh pr comment is blocked: could not read its --body-file \/dev\/stdin \(not a regular file/,
    );
  });
});

describe('forbiddenReason on what gh api would post', () => {
  const ISSUES = 'gh api repos/{owner}/{repo}/issues';
  const inline: [string, string][] = [
    [`${ISSUES} -f title=ExampleCorp -f body=plain`, 'field title line 1'],
    [`${ISSUES} -f title=plain -F body=examplecorp`, 'field body line 1'],
    [`${ISSUES} --field "body=ok\nfor ExampleCorp"`, 'field body line 2'],
    [`${ISSUES} --raw-field title=example-corp`, 'field title line 1'],
    [`${ISSUES} --raw-field=title=example-corp`, 'field title line 1'],
    [`${ISSUES} --field=body=ExampleCorp`, 'field body line 1'],
    [`${ISSUES} -Fbody=ExampleCorp`, 'field body line 1'],
    [`${ISSUES} -ftitle=ExampleCorp`, 'field title line 1'],
    [`${ISSUES} -X POST -f body=@ExampleCorp`, 'field body line 1'],
    ['gh api -X PATCH repos/o/r/issues/3 -f title=ExampleCorp', 'field title line 1'],
    [`${ISSUES} -if title=ExampleCorp`, 'field title line 1'],
    [`${ISSUES} -iF body=ExampleCorp`, 'field body line 1'],
    [`${ISSUES} -iFbody=ExampleCorp`, 'field body line 1'],
  ];
  for (const [command, place] of inline) {
    it(`blocks a word in a title or body field: ${command}`, () => {
      assert.match(refusal(command), hit('gh api', `gh api ${place}`));
    });
  }

  it('reads a body field from @file, naming the file and line', () => {
    const { deniedTexts, reads } = scan({ 'body.md': 'clean\nExampleCorp\n' });
    const reason = forbiddenReason(`${ISSUES} -f title=plain -F body=@body.md`, deniedTexts, CWD);
    assert.match(reason ?? '', hit('gh api', 'gh api field body body.md:2'));
    assert.deepEqual(reads, [['body.md']]);
  });

  it('reads --input from a file, a JSON body by its fields', () => {
    // JSON escapes the word's line break and first letter; gh sends the fields decoded.
    const draft = '{"title":"plain","body":"clean\\nfor \\u0045xampleCorp"}';
    const { deniedTexts, reads } = scan({ 'draft.json': draft, 'raw.txt': 'a\nExampleCorp' });
    assert.match(
      forbiddenReason(`${ISSUES} --input draft.json`, deniedTexts, CWD) ?? '',
      hit('gh api', 'gh api --input draft.json, body line 2'),
    );
    assert.match(
      forbiddenReason(`${ISSUES} --input=raw.txt`, deniedTexts, CWD) ?? '',
      hit('gh api', 'gh api --input raw.txt:2'),
    );
    assert.deepEqual(reads, [['draft.json'], ['raw.txt']]);
  });

  const BOM = String.fromCodePoint(0xfeff);
  const inputs: [string, string][] = [
    ['{"labels":{"ExampleCorp":1}}', 'gh api --input d.json, labels line 1'],
    ['{"labels":["plain","for ExampleCorp"]}', 'gh api --input d.json, labels line 1'],
    ['{"ExampleCorp":"plain"}', 'gh api --input d.json, a field whose name holds a denied word'],
    ['["plain",\n"ExampleCorp"]', 'gh api --input d.json:2'],
    [`${BOM}{"body":"ExampleCorp"}`, 'gh api --input d.json, body line 1'],
  ];
  for (const [json, place] of inputs) {
    it(`reads the keys and nested strings of a JSON --input, and an array by its lines: ${place}`, () => {
      const reason = refusal(`${ISSUES} --input d.json`, { 'd.json': json });
      assert.match(reason, hit('gh api', place));
    });
  }

  it('lets the review skill file a clean draft with --input (ADR 0094)', () => {
    const draft = JSON.stringify({ title: 'A plain title', body: 'A plain body.' });
    const { deniedTexts, reads } = scan({ 'bundle/pre-existing/1.json': draft });
    const command = `${ISSUES} --input "bundle/pre-existing/1.json"`;
    assert.equal(forbiddenReason(command, deniedTexts, CWD), undefined);
    assert.deepEqual(reads, [['bundle/pre-existing/1.json']]);
  });
});

describe('forbiddenReason on a gh text it cannot read, while a list is set', () => {
  const unreadable: [string, string][] = [
    [
      'gh api repos/o/r/issues --input -',
      'gh api is blocked: its --input is read from standard input',
    ],
    [
      'gh api repos/o/r/issues --input "$draft"',
      'gh api is blocked: its --input is computed at run time',
    ],
    [
      'gh api repos/o/r/issues -F body=@-',
      'gh api is blocked: its field body is read from standard input',
    ],
    [
      'gh api repos/o/r/issues -F "body=$text"',
      'gh api is blocked: its field body is computed at run time',
    ],
    [
      'gh api repos/o/r/issues -F "body=@$file"',
      'gh api is blocked: its field body is computed at run time',
    ],
    ['gh api repos/o/r/issues -f "$pair"', 'gh api is blocked: its field is computed at run time'],
    ['gh pr comment 5 -b "$body"', 'gh pr comment is blocked: its --body is computed at run time'],
    [
      'gh pr create -t "$(cat t)" -b x',
      'gh pr create is blocked: its --title is computed at run time',
    ],
    ['gh pr create -F -', 'gh pr create is blocked: its --body-file is read from standard input'],
    [
      'gh issue comment 3 --body-file "$f"',
      'gh issue comment is blocked: its --body-file is computed at run time',
    ],
    [
      'cd "$d" && gh issue comment 3 -F body.md',
      'gh issue comment is blocked: its --body-file is in a directory computed at run time',
    ],
  ];
  for (const [command, start] of unreadable) {
    it(`blocks it, saying why: ${command}`, () => {
      const reason = refusal(command);
      assert.ok(reason.startsWith(start), reason);
      assert.match(reason, /cannot check it against your denylist \(ADR 0132\)/);
    });
  }
});

describe('forbiddenReason on gh texts inside other shells', () => {
  const nested: [string, string, string][] = [
    ['bash -c \'gh pr comment 5 -b "for ExampleCorp"\'', 'gh pr comment', '--body line 1'],
    ['pwsh -Command "gh pr comment 5 -b \'for ExampleCorp\'"', 'gh pr comment', '--body line 1'],
    ["bash -c 'gh issue create -t ExampleCorp -b x'", 'gh issue create', '--title line 1'],
    [
      'pwsh -Command "gh api repos/o/r/issues -f title=ExampleCorp"',
      'gh api',
      'field title line 1',
    ],
    ["bash -c 'gh issue comment 3 -F body.md'", 'gh issue comment', '--body-file body.md:1'],
    ['pwsh -c "gh api repos/o/r/issues -F body=@body.md"', 'gh api', 'field body body.md:1'],
  ];
  for (const [command, what, place] of nested) {
    it(`blocks a word sent from a nested command: ${command}`, () => {
      assert.match(refusal(command, { 'body.md': 'ExampleCorp' }), hit(what, `${what} ${place}`));
    });
  }

  // A nested command is read in both shells' ways, and finds the same file each time.
  it('reads a body file of a nested command once', () => {
    const { deniedTexts, reads } = scan({ 'body.md': 'ExampleCorp' });
    forbiddenReason("bash -c 'gh issue comment 3 -F body.md'", deniedTexts, CWD);
    assert.deepEqual(reads, [['body.md']]);
  });

  for (const command of [
    "bash -c 'gh api repos/o/r/issues --input -'",
    'pwsh -Command "gh pr comment 5 -b $body"',
  ]) {
    it(`blocks a nested text it cannot read: ${command}`, () => {
      assert.match(refusal(command), /cannot check it against your denylist \(ADR 0132\)/);
    });
  }
});

describe('textRefusal', () => {
  const texts = [
    { kind: 'text', command: 'gh pr comment', field: '--body', text: 'ExampleCorp' },
    { kind: 'file', command: 'gh pr comment', field: '--body-file', path: ['body.md'] },
    { kind: 'unreadable', command: 'gh api', field: '--input', why: 'read from standard input' },
  ] as const;

  it('reads nothing and blocks nothing without a list, or with a list of only comments', () => {
    for (const list of [{ kind: 'none', path: PATH } as const, set('# none yet\n\n')]) {
      const { deniedTexts, reads } = scan({ 'body.md': 'ExampleCorp' }, list);
      assert.equal(deniedTexts(texts, CWD), undefined);
      assert.deepEqual(reads, []);
    }
  });

  it('blocks every gh text when the list cannot be read, naming its path', () => {
    const list = { kind: 'unreadable', path: PATH, why: 'EACCES: permission denied' } as const;
    const { deniedTexts, reads } = scan({}, list);
    const reason = deniedTexts([texts[0]], CWD) ?? '';
    assert.match(
      reason,
      /^gh pr comment is blocked: the denylist at \/lists\/denylist\.txt cannot be read \(EACCES/,
    );
    assert.deepEqual(reads, []);
  });

  it('names up to ten places and counts the rest, never the word', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      kind: 'text' as const,
      command: 'gh pr comment',
      field: '--body',
      text: `${'plain\n'.repeat(i)}ExampleCorp`,
    }));
    const reason = scan().deniedTexts(many, CWD) ?? '';
    assert.match(reason, /at gh pr comment --body line 1; .*line 10; and 2 more\. /);
    assert.doesNotMatch(reason, WORD);
  });
});

describe('precheck reads gh texts against the denylist', () => {
  const fakeCheck = () => {
    const calls: string[] = [];
    const runCheck = async (cwd: string): Promise<CheckResult> => {
      calls.push(cwd);
      return { ok: true, output: '' };
    };
    return { calls, runCheck };
  };
  const hookInput = (command: string, tool: string): string =>
    JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: CWD });
  const gate = (command: string, deniedTexts: DeniedTexts, tool = 'Bash') => {
    const loads: number[] = [];
    const check = fakeCheck();
    const result = precheck(
      hookInput(command, tool),
      check.runCheck,
      async () => undefined,
      async () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        loads.push(1);
        return deniedTexts;
      },
    );
    return { result, loads, checks: check.calls };
  };

  it('blocks gh pr create with a word before the check runs', async () => {
    const { result, checks } = gate('gh pr create --draft -t ExampleCorp -b x', scan().deniedTexts);
    const { exitCode, stderr } = await result;
    assert.equal(exitCode, 2);
    assert.match(stderr, hit('gh pr create', 'gh pr create --title line 1'));
    assert.doesNotMatch(stderr, WORD);
    assert.deepEqual(checks, []);
  });

  it('reads body files where the hook runs, and loads the scan only for gh texts', async () => {
    const { deniedTexts, reads } = scan({ 'body.md': 'ExampleCorp' });
    const comment = gate('gh pr comment 5 -F body.md', deniedTexts);
    assert.equal((await comment.result).exitCode, 2);
    assert.deepEqual(reads, [['body.md']]);
    assert.deepEqual(comment.loads, [1]);
    const status = gate('git status && gh pr view 5', deniedTexts);
    assert.deepEqual(await status.result, { exitCode: 0, stderr: '' });
    assert.deepEqual(status.loads, []);
  });

  // PowerShell turns `n, `t, `u{…} and the like into other characters, which the gate does not
  // decode, so a word after one would read as part of another.
  for (const command of [
    'gh pr comment 5 -b "Done.`nexamplecorp asked"',
    'gh pr comment 5 -b "`u{45}xampleCorp"',
    'gh issue create -t plain -b Done.`texamplecorp',
  ]) {
    it(`blocks a PowerShell escape in a gh text it cannot decode: ${command}`, async () => {
      const { exitCode, stderr } = await gate(command, scan().deniedTexts, 'PowerShell').result;
      assert.equal(exitCode, 2);
      assert.match(
        stderr,
        /--body is a text with a PowerShell escape, so the gate cannot check it/,
      );
    });
  }

  it('reads an escaped character with no special meaning in PowerShell as it is', async () => {
    const { exitCode } = await gate(
      'gh pr comment 5 -b "It`s done"',
      scan().deniedTexts,
      'PowerShell',
    ).result;
    assert.equal(exitCode, 0);
  });

  // Before anything else the gate runs (ADR 0132): the push scan, here.
  it('blocks a gh text with a word before the push scan of the same command', async () => {
    const pushes: string[] = [];
    const result = await precheck(
      hookInput('git push && gh pr comment 5 -b ExampleCorp', 'Bash'),
      fakeCheck().runCheck,
      async () => undefined,
      async () => false,
      undefined,
      undefined,
      undefined,
      async (dir) => {
        pushes.push(dir);
        return undefined;
      },
      async () => scan().deniedTexts,
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, hit('gh pr comment', 'gh pr comment --body line 1'));
    assert.deepEqual(pushes, []);
  });

  // GitHub shows a literal \n, so a word after it is posted as it is.
  it('reads a literal backslash escape as a break between words', async () => {
    const { exitCode, stderr } = await gate(
      "gh pr comment 5 -b 'Summary\\nexamplecorp'",
      scan().deniedTexts,
    ).result;
    assert.equal(exitCode, 2);
    assert.match(stderr, hit('gh pr comment', 'gh pr comment --body line 1'));
  });

  it('blocks when the scan throws, saying so', async () => {
    const { result } = gate('gh pr comment 5 -b x', () => {
      throw new Error('broken');
    });
    const { exitCode, stderr } = await result;
    assert.equal(exitCode, 2);
    assert.match(
      stderr,
      /^gh is blocked: could not check what it sends against your denylist \(broken\) \(ADR 0132\)/,
    );
  });
});
