import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type TastingMode,
  type TastingValues,
  tastingModeOf,
} from '../../scripts/tasting-compare/options.ts';
import { REAL_SETUPS } from '../../scripts/tasting-compare/real.ts';

const refusal = (message: string) => ({ kind: 'refused', message });

/** The mode `values` run, failing the test on a refusal. */
const modeOf = (values: TastingValues): TastingMode => {
  const mode = tastingModeOf(values);
  if (mode.kind === 'refused') assert.fail(mode.message);
  return mode;
};

const CELLARMAN = {
  real: true,
  brewer: 'cellarman',
  model: 'claude-sonnet-5-5',
  effort: 'moderate',
} as const;
const TASTER = {
  real: true,
  brewer: 'taster',
  model: 'strong',
  effort: 'moderate',
  lenses: 'apart',
  rules: 'reads',
} as const;

describe("tasting-compare's command line (#1094)", () => {
  it('--plan with --real is refused', () => {
    assert.deepEqual(
      tastingModeOf({ plan: true, real: true }),
      refusal('--plan and --real are two comparisons: give one of them'),
    );
  });

  it('--setups without --real is refused', () => {
    assert.deepEqual(
      tastingModeOf({ setups: 'opus' }),
      refusal('--setups chooses among the setups of --real: give --real too'),
    );
  });

  it('--setups with --real runs the real mode on the setups it names', () => {
    const mode = modeOf({ real: true, setups: 'opus,high' });
    assert.equal(mode.kind, 'real');
    assert.ok(mode.kind === 'real');
    assert.deepEqual(
      mode.setups,
      REAL_SETUPS.filter((setup) => setup.endsWith('-opus') || setup.endsWith('-high')),
    );
  });

  it("a brewer's settings that do not fit are refused with brewerSettingsOf's message", () => {
    assert.deepEqual(
      tastingModeOf({ map: true }),
      refusal('--map maps the code before a --brewer run: give --brewer too'),
    );
  });

  it("the seeded Tasters' settings that do not fit are refused with seededTasterOf's message", () => {
    assert.deepEqual(
      tastingModeOf({ model: 'strong' }),
      refusal('--model needs --effort <effort>'),
    );
  });

  it("--sub-orders that does not fit is refused with subOrdersRunOf's message", () => {
    assert.deepEqual(
      tastingModeOf({ 'sub-orders': true }),
      refusal('--sub-orders plans the orders of --real: give --real too'),
    );
  });

  it('--orders with none of --setups, --brewer and --sub-orders is refused', () => {
    assert.deepEqual(
      tastingModeOf({ real: true, orders: '867' }),
      refusal(
        '--orders chooses the orders of the setups --setups, the runs --brewer or the plans --sub-orders names: give one of them too',
      ),
    );
  });

  it('--orders with --setups runs those setups of those orders', () => {
    const mode = modeOf({ real: true, setups: 'opus', orders: '867' });
    assert.ok(mode.kind === 'real');
    assert.deepEqual(mode.setups, ['867-opus']);
  });

  it("--orders with --brewer runs that brewer on those orders' runs", () => {
    const mode = modeOf({ ...CELLARMAN, orders: '855,867' });
    assert.ok(mode.kind === 'brewer');
    assert.deepEqual(mode.setups, [
      '855-cellarman-claude-sonnet-5-5-moderate',
      '867-cellarman-claude-sonnet-5-5-moderate',
    ]);
  });

  it('--orders with --sub-orders plans those orders', () => {
    const mode = modeOf({ real: true, 'sub-orders': true, orders: '864' });
    assert.ok(mode.kind === 'planner');
    assert.deepEqual(mode.setups, ['864-brewmaster']);
  });

  it('a setup --setups does not know is refused', () => {
    assert.deepEqual(
      tastingModeOf({ real: true, setups: 'nobody' }),
      refusal(
        `--setups names no setup "nobody": it knows ${[...new Set(REAL_SETUPS.map((setup) => setup.replace(/^\d+-/, '')))].join(', ')}`,
      ),
    );
  });

  it('an unknown --orders with --setups is refused', () => {
    assert.deepEqual(
      tastingModeOf({ real: true, setups: 'opus', orders: '999' }),
      refusal('--orders names no order "999": it knows 855, 864, 867'),
    );
  });

  it('an unknown --orders with --brewer is refused like with --setups', () => {
    assert.deepEqual(
      tastingModeOf({ ...CELLARMAN, orders: '999' }),
      refusal('--orders names no order "999": it knows 855, 864, 867'),
    );
  });

  it('an unknown --orders with --brewer taster is refused like with --setups', () => {
    assert.deepEqual(
      tastingModeOf({ ...TASTER, orders: '999' }),
      refusal('--orders names no order "999": it knows 855, 864, 867'),
    );
  });

  it('an unknown --orders with --sub-orders is refused like with --setups', () => {
    assert.deepEqual(
      tastingModeOf({ real: true, 'sub-orders': true, orders: '999' }),
      refusal('--orders names no order "999": it knows 855, 864, 867'),
    );
  });

  it('--comparison without --real is refused', () => {
    assert.deepEqual(
      tastingModeOf({ comparison: 'c' }),
      refusal('--comparison names a comparison of --real: give --real too'),
    );
  });

  it("--comparison with --real keeps the real mode's records in the comparison's folders", () => {
    const mode = modeOf({ real: true, comparison: 'c' });
    assert.ok(mode.kind === 'real');
    assert.deepEqual(mode.folders, ['real', 'comparisons', 'c']);
  });

  it('a --comparison that is not one folder is refused', () => {
    assert.deepEqual(
      tastingModeOf({ real: true, comparison: 'Bad' }),
      refusal(
        '--comparison takes lower-case letters, digits and -, starting with a letter or a digit, as one folder\'s name and no Windows device\'s, not "Bad"',
      ),
    );
  });

  it('--runs that is not a number is refused', () => {
    assert.deepEqual(
      tastingModeOf({ runs: 'x' }),
      refusal('--runs must be a whole number of at least 1, not x'),
    );
  });

  it('--runs of 0 is refused', () => {
    assert.deepEqual(
      tastingModeOf({ runs: '0' }),
      refusal('--runs must be a whole number of at least 1, not 0'),
    );
  });

  it('--runs that is not whole is refused', () => {
    assert.deepEqual(
      tastingModeOf({ runs: '1.5' }),
      refusal('--runs must be a whole number of at least 1, not 1.5'),
    );
  });

  it('runs are 3 without --runs, and as many as --runs gives', () => {
    assert.equal(modeOf({}).runs, 3);
    assert.equal(modeOf({ runs: '1' }).runs, 1);
  });

  it('--dry-run runs the brewers scripted, and a run without it on the real claude', () => {
    assert.equal(modeOf({ 'dry-run': true }).dryRun, true);
    assert.equal(modeOf({}).dryRun, false);
  });

  it('of two refusals that apply, the one checked first is given', () => {
    assert.deepEqual(
      tastingModeOf({ plan: true, real: true, setups: 'nobody', runs: '0' }),
      refusal('--plan and --real are two comparisons: give one of them'),
    );
    assert.deepEqual(
      tastingModeOf({ setups: 'opus', comparison: 'c', runs: '0' }),
      refusal('--setups chooses among the setups of --real: give --real too'),
    );
  });

  it('--real --sub-orders runs the planning runs of every order in the real folder', () => {
    const mode = modeOf({ real: true, 'sub-orders': true });
    assert.deepEqual(mode, {
      kind: 'planner',
      setups: ['855-brewmaster', '864-brewmaster', '867-brewmaster'],
      folders: ['real'],
      runs: 3,
      dryRun: false,
    });
  });

  it('--real --brewer taster runs the Taster setup its settings build', () => {
    const mode = modeOf(TASTER);
    assert.deepEqual(mode, {
      kind: 'taster',
      settings: {
        brewer: 'taster',
        model: 'strong',
        effort: 'moderate',
        lenses: 'apart',
        rules: 'reads',
      },
      setups: [
        '855-taster-strong-moderate-apart-reads',
        '864-taster-strong-moderate-apart-reads',
        '867-taster-strong-moderate-apart-reads',
      ],
      folders: ['real'],
      runs: 3,
      dryRun: false,
    });
  });

  it('--real --brewer cellarman runs that brewer with its settings', () => {
    const mode = modeOf({ ...CELLARMAN, map: true, 'order-text': 'plan', orders: '867' });
    assert.deepEqual(mode, {
      kind: 'brewer',
      settings: {
        brewer: 'cellarman',
        model: 'claude-sonnet-5-5',
        effort: 'moderate',
        orderText: 'plan',
        map: true,
      },
      setups: ['867-cellarman-claude-sonnet-5-5-moderate-map-plan'],
      folders: ['real'],
      runs: 3,
      dryRun: false,
    });
  });

  it('--real alone runs every fixed setup of the real mode', () => {
    assert.deepEqual(modeOf({ real: true }), {
      kind: 'real',
      setups: REAL_SETUPS,
      folders: ['real'],
      runs: 3,
      dryRun: false,
    });
  });

  it('--plan runs the seeded plan', () => {
    assert.deepEqual(modeOf({ plan: true, runs: '2' }), { kind: 'plan', runs: 2, dryRun: false });
  });

  it('no option runs the seeded change with its Tasters as the setups give them', () => {
    assert.deepEqual(modeOf({}), { kind: 'seeded', runs: 3, dryRun: false });
  });

  it('--model and --effort alone run the seeded change with its Tasters on them', () => {
    assert.deepEqual(modeOf({ model: 'strong', effort: 'moderate', 'dry-run': true }), {
      kind: 'seeded',
      taster: { model: 'strong', effort: 'moderate' },
      runs: 3,
      dryRun: true,
    });
  });
});
