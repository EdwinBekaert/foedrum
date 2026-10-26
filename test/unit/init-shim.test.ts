// The `foedrum` command `foedrum init` writes (ADR 0210), through a fake file system, PATH, home
// and platform: the folders it offers and in which order, the shim on POSIX and on Windows, an
// existing shim or file, a no, a machine with no folder to offer, and the PATH lookup after it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { offerShim, type ShimPorts } from '../../src/cli/init-shim.ts';

interface Machine {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  entry: string;
  /** The folders that are there and writable. */
  writable: readonly string[];
  /** The files there, by path. */
  files?: Record<string, string>;
  /** What `foedrum` resolves to after the run; default the file written. */
  resolves?: string | null;
  /** Reading or writing a file throws this. */
  readFails?: string;
  writeFails?: string;
}

interface Run {
  questions: string[];
  lines: string[];
  written: { path: string; text: string; executable: boolean }[];
}

const ADA = '/home/ada';
const ENTRY = '/home/ada/code/foedrum/src/cli/main.ts';
const WIN_HOME = 'C:\\Users\\ada';
const WIN_ENTRY = 'C:\\Users\\ada\\code\\foedrum\\src\\cli\\main.ts';

const posix = (path: string, more: Partial<Machine> = {}): Machine => ({
  platform: 'linux',
  env: { PATH: path },
  home: ADA,
  entry: ENTRY,
  writable: path.split(':'),
  ...more,
});

const windows = (path: string, more: Partial<Machine> = {}): Machine => ({
  platform: 'win32',
  // Windows names it Path; PATHEXT is the default.
  env: { Path: path, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  home: WIN_HOME,
  entry: WIN_ENTRY,
  writable: path.split(';'),
  ...more,
});

/** Runs offerShim on `machine` with `answers` in order. */
const offer = async (machine: Machine, answers: readonly string[] = []): Promise<Run> => {
  const queue = [...answers];
  const files = new Map(Object.entries(machine.files ?? {}));
  const run: Run = { questions: [], lines: [], written: [] };
  const ports: ShimPorts = {
    platform: machine.platform,
    env: machine.env,
    home: machine.home,
    entry: machine.entry,
    writable: (folder) => machine.writable.includes(folder),
    read: (path) => {
      if (machine.readFails !== undefined) throw new Error(machine.readFails);
      return files.get(path);
    },
    write: (path, text, executable) => {
      if (machine.writeFails !== undefined) throw new Error(machine.writeFails);
      run.written.push({ path, text, executable });
      files.set(path, text);
    },
    resolve: (name) => {
      assert.equal(name, 'foedrum');
      if (machine.resolves !== undefined) return machine.resolves ?? undefined;
      return run.written.at(-1)?.path;
    },
  };
  await offerShim(ports, {
    answer: async (question) => {
      run.questions.push(question);
      return queue.shift() ?? assert.fail(`no answer to ${question}`);
    },
    say: (line) => {
      run.lines.push(line);
    },
  });
  return run;
};

/** offer, failing the test when offerShim throws instead of saying why. */
const settled = async (machine: Machine, answers: readonly string[] = []): Promise<Run> => {
  let run: Run | undefined;
  await assert.doesNotReject(async () => {
    run = await offer(machine, answers);
  });
  return run as Run;
};

const QUESTION = 'Write the foedrum command into which folder? [1, or n for none]: ';

describe('the foedrum command init writes (ADR 0210)', () => {
  it('offers the PATH folders inside the home, preferred ones first and tool folders last, and writes the first on an empty answer', async () => {
    const machine = posix(
      [
        '/usr/local/bin',
        '/home/ada/.cargo/bin',
        '/home/ada/.nvm/versions/node/v24.15.0/bin',
        '/home/ada/tools',
        '/opt/ada/bin',
        '/home/ada/.local/bin',
        '/home/ada/bin',
      ].join(':'),
    );
    const { questions, lines, written } = await offer(machine, ['']);
    assert.deepStrictEqual(questions, [QUESTION]);
    assert.deepStrictEqual(lines.slice(0, 6), [
      'Folders on the PATH for the foedrum command:',
      '  1. /home/ada/.local/bin',
      '  2. /home/ada/bin',
      '  3. /home/ada/tools',
      '  4. /home/ada/.cargo/bin',
      '  5. /home/ada/.nvm/versions/node/v24.15.0/bin',
    ]);
    assert.deepStrictEqual(written, [
      {
        path: '/home/ada/.local/bin/foedrum',
        text: written[0]?.text,
        executable: true,
      },
    ]);
    const text = written[0]?.text ?? '';
    assert.ok(text.startsWith('#!/bin/sh\n'), text);
    assert.ok(text.includes(`\nexec node '${ENTRY}' "$@"\n`), text);
    assert.ok(lines.includes('Wrote /home/ada/.local/bin/foedrum'), lines.join('\n'));
  });

  it('never offers a folder outside the home, one that is not there or not writable, or one twice', async () => {
    const machine = posix(
      '/usr/bin:/bin:/home/ada/gone:/home/ada/locked:/home/adam/bin:/home/ada/tools:/home/ada/tools',
      { writable: ['/usr/bin', '/bin', '/home/adam/bin', '/home/ada/tools'] },
    );
    const { lines } = await offer(machine, ['n']);
    assert.deepStrictEqual(lines.slice(0, 2), [
      'Folders on the PATH for the foedrum command:',
      '  1. /home/ada/tools',
    ]);
    assert.ok(!lines.some((line) => line.startsWith('  2. ')), lines.join('\n'));
  });

  it('writes into the folder a number picks, and asks again for an answer it cannot read', async () => {
    const machine = posix('/home/ada/.local/bin:/home/ada/tools');
    const { questions, lines, written } = await offer(machine, ['3', 'maybe', '2']);
    assert.deepStrictEqual(questions, [QUESTION, QUESTION, QUESTION]);
    assert.equal(lines.filter((line) => line === '  Answer a number from 1 to 2, or n').length, 2);
    assert.deepStrictEqual(
      written.map(({ path }) => path),
      ['/home/ada/tools/foedrum'],
    );
  });

  it('on Windows writes foedrum.cmd, never into WindowsApps, with npm and Python folders last', async () => {
    const machine = windows(
      [
        'C:\\Windows\\system32',
        'C:\\Users\\ada\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\',
        'C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps',
        'C:\\Users\\ada\\AppData\\Roaming\\npm',
        'C:\\Users\\ada\\Tools',
        'C:\\Users\\ada\\.local\\bin',
      ].join(';'),
    );
    const { lines, written } = await offer(machine, ['']);
    assert.deepStrictEqual(lines.slice(0, 5), [
      'Folders on the PATH for the foedrum command:',
      '  1. C:\\Users\\ada\\.local\\bin',
      '  2. C:\\Users\\ada\\Tools',
      '  3. C:\\Users\\ada\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\',
      '  4. C:\\Users\\ada\\AppData\\Roaming\\npm',
    ]);
    assert.ok(!lines.some((line) => line.includes('WindowsApps')), lines.join('\n'));
    assert.equal(written[0]?.path, 'C:\\Users\\ada\\.local\\bin\\foedrum.cmd');
    assert.equal(written[0]?.executable, false);
    const text = written[0]?.text ?? '';
    assert.ok(text.startsWith('@echo off\r\n'), text);
    assert.ok(text.includes(`\r\nnode "${WIN_ENTRY}" %*\r\n`), text);
    assert.ok(!/[^\r]\n/.test(text), 'CRLF line ends');
  });

  it('on Windows reads the home and the PATH whatever their case', async () => {
    const machine = windows('c:\\users\\ADA\\bin', { writable: ['c:\\users\\ADA\\bin'] });
    const { written } = await offer(machine, ['']);
    assert.equal(written[0]?.path, 'c:\\users\\ADA\\bin\\foedrum.cmd');
  });

  it('on Windows writes nothing, and says why, when PATHEXT has no .CMD', async () => {
    const machine = windows('C:\\Users\\ada\\bin', {
      env: { Path: 'C:\\Users\\ada\\bin', PATHEXT: '.COM;.EXE' },
    });
    const { questions, lines, written } = await offer(machine);
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
    assert.ok(
      lines.includes(
        'PATHEXT has no .CMD, so foedrum.cmd would not run as foedrum; the foedrum command is not written',
      ),
      lines.join('\n'),
    );
  });

  it('with no folder to offer, writes nothing and says which folder to add to the PATH, and how', async () => {
    const { questions, lines, written } = await offer(posix('/usr/bin:/bin'));
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(lines.slice(0, 3), [
      'No folder on the PATH is inside /home/ada to write the foedrum command into.',
      "Create /home/ada/.local/bin and add this line to your shell's profile (~/.profile, ~/.bashrc or ~/.zshrc):",
      '  export PATH="$HOME/.local/bin:$PATH"',
    ]);
    assert.ok(lines.includes('  #!/bin/sh'), lines.join('\n'));
  });

  it('on Windows with no folder to offer, names one in the user profile and the PowerShell line', async () => {
    const { written, lines } = await offer(windows('C:\\Windows\\system32'));
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(lines.slice(0, 3), [
      'No folder on the PATH is inside C:\\Users\\ada to write the foedrum command into.',
      'Create C:\\Users\\ada\\.local\\bin and add it to your PATH, in PowerShell:',
      `  New-Item -ItemType Directory -Force 'C:\\Users\\ada\\.local\\bin'; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\\Users\\ada\\.local\\bin', 'User')`,
    ]);
  });

  it('keeps a shim that runs this checkout, without a question', async () => {
    const machine = posix('/home/ada/.local/bin');
    const first = await offer(machine, ['']);
    const shim = first.written[0] ?? assert.fail('not written');
    const again = await offer({ ...machine, files: { [shim.path]: shim.text } });
    assert.deepStrictEqual(again.questions, []);
    assert.deepStrictEqual(again.written, []);
    assert.ok(
      again.lines.includes('/home/ada/.local/bin/foedrum runs this Foedrum already'),
      again.lines.join('\n'),
    );
  });

  it('names a shim that runs another checkout in the question, and keeps it on a no', async () => {
    const machine = posix('/home/ada/.local/bin');
    const other = await offer({ ...machine, entry: '/home/ada/old/foedrum/src/cli/main.ts' }, ['']);
    const shim = other.written[0] ?? assert.fail('not written');
    const files = { [shim.path]: shim.text };
    const question =
      '/home/ada/.local/bin/foedrum runs the Foedrum in /home/ada/old/foedrum. Point it at /home/ada/code/foedrum? [y/N]: ';
    const no = await offer({ ...machine, files }, ['']);
    assert.deepStrictEqual(no.questions, [question]);
    assert.deepStrictEqual(no.written, []);
    assert.ok(no.lines.includes('Kept /home/ada/.local/bin/foedrum'), no.lines.join('\n'));
    const yes = await offer({ ...machine, files }, ['y']);
    assert.deepStrictEqual(yes.questions, [question]);
    assert.equal(yes.written[0]?.path, '/home/ada/.local/bin/foedrum');
    assert.ok(yes.written[0]?.text.includes(`'${ENTRY}'`));
  });

  it('never writes over a foedrum that is not one of its shims', async () => {
    const machine = posix('/home/ada/.local/bin:/home/ada/tools', {
      files: { '/home/ada/tools/foedrum': '#!/bin/sh\necho mine\n' },
    });
    const { questions, lines, written } = await offer(machine);
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(lines, [
      '/home/ada/tools/foedrum is there and is not a foedrum command init wrote; it is left as it is',
    ]);
  });

  it('on a no, prints where the shim would go and what it would hold', async () => {
    const { lines, written } = await offer(posix('/home/ada/.local/bin'), ['n']);
    assert.deepStrictEqual(written, []);
    const at = lines.indexOf(
      'Not written. To write it by hand, put these lines in /home/ada/.local/bin/foedrum:',
    );
    assert.ok(at >= 0, lines.join('\n'));
    assert.equal(lines[at + 1], '  #!/bin/sh');
    assert.ok(lines.includes(`  exec node '${ENTRY}' "$@"`), lines.join('\n'));
    assert.equal(lines.at(-1), 'and run: chmod 755 /home/ada/.local/bin/foedrum');
  });

  it('quotes a checkout path with spaces, a quote or a percent sign as each shell reads it', async () => {
    const posixRun = await offer(
      posix('/home/ada/.local/bin', { entry: "/home/ada/my code/ada's foedrum/src/cli/main.ts" }),
      [''],
    );
    assert.ok(
      posixRun.written[0]?.text.includes(
        `exec node '/home/ada/my code/ada'\\''s foedrum/src/cli/main.ts' "$@"`,
      ),
      posixRun.written[0]?.text,
    );
    const windowsRun = await offer(
      windows('C:\\Users\\ada\\bin', {
        entry: 'C:\\Users\\ada\\my code\\100% foedrum\\src\\cli\\main.ts',
      }),
      [''],
    );
    assert.ok(
      windowsRun.written[0]?.text.includes(
        'node "C:\\Users\\ada\\my code\\100%% foedrum\\src\\cli\\main.ts" %*',
      ),
      windowsRun.written[0]?.text,
    );
  });

  it('knows again a shim it wrote for a checkout path with a quote or a percent sign', async () => {
    for (const machine of [
      posix('/home/ada/.local/bin', { entry: "/home/ada/ada's/src/cli/main.ts" }),
      windows('C:\\Users\\ada\\bin', { entry: 'C:\\Users\\ada\\100%\\src\\cli\\main.ts' }),
    ]) {
      const first = await offer(machine, ['']);
      const shim = first.written[0] ?? assert.fail('not written');
      const again = await offer({ ...machine, files: { [shim.path]: shim.text } });
      assert.deepStrictEqual(again.questions, [], machine.platform);
      assert.deepStrictEqual(again.written, [], machine.platform);
      assert.deepStrictEqual(again.lines, [`${shim.path} runs this Foedrum already`]);
    }
  });

  it('says whether foedrum runs the new shim in this terminal, or names the one that does', async () => {
    const machine = posix('/home/ada/.local/bin');
    const found = await offer(machine, ['']);
    assert.equal(found.lines.at(-1), 'foedrum runs it in this terminal');
    const shadowed = await offer({ ...machine, resolves: '/usr/local/bin/foedrum' }, ['']);
    assert.equal(
      shadowed.lines.at(-1),
      'foedrum runs /usr/local/bin/foedrum in this terminal, which is earlier on the PATH',
    );
    const unseen = await offer({ ...machine, resolves: null }, ['']);
    assert.equal(unseen.lines.at(-1), 'Open a new terminal to run foedrum');
  });

  it('puts each kind of folder a tool manages last, and a near miss among the others', async () => {
    const machine = posix(
      [
        '/home/ada/.npm-global/bin',
        '/home/ada/nvm/bin',
        '/home/ada/.pyenv/shims',
        '/home/ada/python3/bin',
        '/home/ada/tools/npm',
        '/home/ada/tools',
      ].join(':'),
    );
    const { lines } = await offer(machine, ['n']);
    assert.deepStrictEqual(lines.slice(1, 7), [
      '  1. /home/ada/tools/npm',
      '  2. /home/ada/tools',
      '  3. /home/ada/.npm-global/bin',
      '  4. /home/ada/nvm/bin',
      '  5. /home/ada/.pyenv/shims',
      '  6. /home/ada/python3/bin',
    ]);
    const windowsRun = await offer(
      windows(
        [
          'C:\\Users\\ada\\AppData\\Roaming\\nvm',
          'C:\\Users\\ada\\tools\\Scripts',
          'C:\\Users\\ada\\AppData\\Local\\npm',
          'C:\\Users\\ada\\tools',
        ].join(';'),
      ),
      ['n'],
    );
    assert.deepStrictEqual(windowsRun.lines.slice(1, 5), [
      '  1. C:\\Users\\ada\\AppData\\Local\\npm',
      '  2. C:\\Users\\ada\\tools',
      '  3. C:\\Users\\ada\\AppData\\Roaming\\nvm',
      '  4. C:\\Users\\ada\\tools\\Scripts',
    ]);
  });

  it('on Windows compares folders, a shim and the lookup whatever their case', async () => {
    const machine = windows(
      ['C:\\Users\\ada\\Tools', 'c:\\users\\ada\\tools', 'c:\\USERS\\ada\\.LOCAL\\bin'].join(';'),
    );
    const { lines, written } = await offer(
      { ...machine, resolves: 'C:\\USERS\\ADA\\.LOCAL\\BIN\\FOEDRUM.CMD' },
      [''],
    );
    assert.deepStrictEqual(lines.slice(0, 4), [
      'Folders on the PATH for the foedrum command:',
      '  1. c:\\USERS\\ada\\.LOCAL\\bin',
      '  2. C:\\Users\\ada\\Tools',
      `Wrote ${written[0]?.path}`,
    ]);
    assert.equal(lines.at(-1), 'foedrum runs it in this terminal');
    const shim = written[0] ?? assert.fail('not written');
    const again = await offer(
      { ...machine, entry: WIN_ENTRY.toUpperCase(), files: { [shim.path]: shim.text } },
      [],
    );
    assert.deepStrictEqual(again.lines, [`${shim.path} runs this Foedrum already`]);
  });

  it('never offers the home itself, or a folder on another drive', async () => {
    const posixRun = await offer(posix('/home/ada:/home/ada/tools'), ['n']);
    assert.deepStrictEqual(posixRun.lines.slice(1, 3), [
      '  1. /home/ada/tools',
      'Not written. To write it by hand, put these lines in /home/ada/tools/foedrum:',
    ]);
    const windowsRun = await offer(windows('C:\\Users\\ada;D:\\Users\\ada\\bin'));
    assert.equal(
      windowsRun.lines[0],
      'No folder on the PATH is inside C:\\Users\\ada to write the foedrum command into.',
    );
  });

  it("leaves a foedrum with a node line like init's but without its mark", async () => {
    const mine = `#!/bin/sh\nexec node '/home/ada/elsewhere/src/cli/main.ts' "$@"\n`;
    const { questions, lines, written } = await offer(
      posix('/home/ada/.local/bin', { files: { '/home/ada/.local/bin/foedrum': mine } }),
    );
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
    assert.deepStrictEqual(lines, [
      '/home/ada/.local/bin/foedrum is there and is not a foedrum command init wrote; it is left as it is',
    ]);
  });
});

describe('the foedrum command, on the edges of its machine (ADR 0210)', () => {
  it('on Windows keeps cmd from running a node in the working directory', async () => {
    const { written } = await offer(windows('C:\\Users\\ada\\bin'), ['']);
    const lines = (written[0]?.text ?? '').split('\r\n');
    const set = lines.indexOf('set "NoDefaultCurrentDirectoryInExePath=1"');
    assert.ok(lines.indexOf('setlocal') >= 0 && lines.indexOf('setlocal') < set, lines.join('\n'));
    assert.ok(set < lines.indexOf(`node "${WIN_ENTRY}" %*`), lines.join('\n'));
  });

  it('says a write it cannot make in one line, prints the shim and goes on', async () => {
    const { lines, written } = await settled(
      posix('/home/ada/.local/bin', { writeFails: 'EACCES: permission denied' }),
      [''],
    );
    assert.deepStrictEqual(written, []);
    assert.ok(
      lines.includes('Could not write /home/ada/.local/bin/foedrum: EACCES: permission denied'),
      lines.join('\n'),
    );
    assert.equal(lines.at(-1), 'and run: chmod 755 /home/ada/.local/bin/foedrum');
  });

  it('says a file it cannot read in one line, prints the shim and writes nothing', async () => {
    const { lines, questions, written } = await settled(
      posix('/home/ada/.local/bin', { readFails: 'EISDIR: illegal operation on a directory' }),
    );
    assert.deepStrictEqual(questions, []);
    assert.deepStrictEqual(written, []);
    assert.equal(
      lines[0],
      'Could not read /home/ada/.local/bin/foedrum: EISDIR: illegal operation on a directory',
    );
    assert.ok(lines.includes('  #!/bin/sh'), lines.join('\n'));
  });

  it('on POSIX reads a folder with a trailing slash as the same folder', async () => {
    const { lines } = await offer(
      posix('/home/ada/tools:/home/ada/.local/bin/:/home/ada/.local/bin'),
      ['n'],
    );
    assert.deepStrictEqual(lines.slice(1, 4), [
      '  1. /home/ada/.local/bin/',
      '  2. /home/ada/tools',
      'Not written. To write it by hand, put these lines in /home/ada/.local/bin/foedrum:',
    ]);
  });

  it('only says to create the folder when it is on the PATH already', async () => {
    const { lines } = await offer(posix('/usr/bin:/home/ada/.local/bin', { writable: [] }));
    assert.deepStrictEqual(lines.slice(0, 3), [
      'No folder on the PATH is inside /home/ada to write the foedrum command into.',
      'Create /home/ada/.local/bin: it is on the PATH already.',
      'Not written. To write it by hand, put these lines in /home/ada/.local/bin/foedrum:',
    ]);
  });

  it('quotes a user profile with an apostrophe in the PowerShell line', async () => {
    const { lines } = await offer(windows('C:\\Windows\\system32', { home: "C:\\Users\\o'brien" }));
    assert.equal(
      lines[2],
      `  New-Item -ItemType Directory -Force 'C:\\Users\\o''brien\\.local\\bin'; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\\Users\\o''brien\\.local\\bin', 'User')`,
    );
  });

  it('offers nothing when the home is a root folder, where every folder would be inside it', async () => {
    for (const machine of [
      posix('/usr/local/bin:/opt/bin', { home: '/' }),
      windows('C:\\Windows\\system32;C:\\tools', { home: 'C:\\' }),
    ]) {
      const { questions, written, lines } = await offer(machine);
      assert.deepStrictEqual(questions, [], machine.platform);
      assert.deepStrictEqual(written, [], machine.platform);
      assert.match(lines[0] ?? '', /^No folder on the PATH is inside /, machine.platform);
    }
  });

  it('offers a folder in the home whose name starts with two dots', async () => {
    const { lines } = await offer(posix('/home/ada/..tools'), ['n']);
    assert.equal(lines[1], '  1. /home/ada/..tools');
  });

  it("never offers the home's parent folder", async () => {
    const posixRun = await offer(posix('/home:/home/ada/tools'), ['n']);
    assert.deepStrictEqual(posixRun.lines.slice(1, 3), [
      '  1. /home/ada/tools',
      'Not written. To write it by hand, put these lines in /home/ada/tools/foedrum:',
    ]);
    const windowsRun = await offer(windows('C:\\Users;C:\\Users\\ada\\tools'), ['n']);
    assert.deepStrictEqual(windowsRun.lines.slice(1, 2), ['  1. C:\\Users\\ada\\tools']);
  });
});
