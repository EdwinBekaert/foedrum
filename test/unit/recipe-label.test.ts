// The recipe label (ADR 0232): `recipe:<name>` on the Brewery issue of a batch whose recipe a
// person chose by answering a step that chooses it, set once through the ledger, with a fake of the
// labels host. Pure: nothing reaches GitHub (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { recipeLabelEffects } from '../../src/engine/recipe-label.ts';
import type { Event } from '../../src/schemas/events.ts';

const brewery = 'alice/brewery';
const routeBy = '2026-10-28T12:00:00.000Z';
const by = { by: 'ann', via: 'terminal' } as const;
const key = { batchId: '12-1', effect: 'recipe-label' };

const ordered: Event = { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy };
const chose = (fields: Record<string, unknown> = { askedBy: 'innkeep' }): Event =>
  ({
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'nip',
    reason: 'the answer at innkeep: nip, as suggested',
    source: 'human',
    ...by,
    ...fields,
  }) as Event;

/** The labels of the Brewery and its issues, and the calls that changed them. */
const fakeHost = (shown: string[] = []) => {
  const calls: string[] = [];
  const onIssue = new Map<number, string[]>([
    [12, [...shown]],
    [40, []],
  ]);
  return {
    calls,
    onIssue,
    host: {
      labels: async (_repo: string, issue: number) => {
        calls.push(`labels #${issue}`);
        return [...(onIssue.get(issue) ?? [])];
      },
      createLabel: async (_repo: string, label: string) => {
        calls.push(`create ${label}`);
      },
      addLabel: async (_repo: string, issue: number, label: string) => {
        calls.push(`add ${label} #${issue}`);
        onIssue.get(issue)?.push(label);
      },
      removeLabel: async (_repo: string, issue: number, label: string) => {
        calls.push(`remove ${label} #${issue}`);
        const labels = onIssue.get(issue) ?? [];
        const at = labels.indexOf(label);
        assert.ok(at >= 0, `${label} is on #${issue} before it is removed`);
        labels.splice(at, 1);
      },
    },
  };
};

describe('recipeLabelEffects (ADR 0232)', () => {
  it('labels the Brewery issue with the recipe the answer chose, made in the Brewery first', async () => {
    const { host, calls, onIssue } = fakeHost();
    const effects = recipeLabelEffects({ brewery, host });
    assert.deepEqual(effects.due(fold([ordered, chose()]), '12-1'), [key]);
    const encoded = effectKey.encode(key);
    assert.equal(await effects.target.find(encoded), undefined);
    assert.deepEqual(await effects.target.apply(encoded), { label: 'recipe:nip' });
    assert.deepEqual(calls, [
      'labels #12',
      'labels #12',
      'create recipe:nip',
      'add recipe:nip #12',
    ]);
    assert.deepEqual(onIssue.get(12), ['recipe:nip']);
  });

  it('finds the label a kill left before its record, in any case, and adds nothing twice', async () => {
    const { host, calls } = fakeHost(['Recipe:NIP']);
    const effects = recipeLabelEffects({ brewery, host });
    assert.deepEqual(effects.due(fold([ordered, chose()]), '12-1'), [key]);
    assert.deepEqual(await effects.target.find(effectKey.encode(key)), {
      result: { label: 'recipe:nip' },
    });
    assert.deepEqual(calls, ['labels #12']);
  });

  it("takes the issue's other recipe labels off, in any case, so its next order has one to route by", async () => {
    // The labels the issue shows, and those it keeps: never one that only holds `recipe:`.
    for (const [shown, kept] of [
      [
        ['recipe:stuot', 'foedrum:stuck', 'old-recipe:x'],
        ['foedrum:stuck', 'old-recipe:x', 'recipe:nip'],
      ],
      [['Recipe:Stout', 'recipe:nip'], ['recipe:nip']],
    ] as [string[], string[]][]) {
      const { host, onIssue } = fakeHost(shown);
      const effects = recipeLabelEffects({ brewery, host });
      assert.deepEqual(effects.due(fold([ordered, chose()]), '12-1'), [key]);
      const encoded = effectKey.encode(key);
      // Not shown while another recipe label is there, even beside its own.
      assert.equal(await effects.target.find(encoded), undefined, shown.join(', '));
      assert.deepEqual(await effects.target.apply(encoded), { label: 'recipe:nip' });
      assert.deepEqual(onIssue.get(12), kept, shown.join(', '));
    }
  });

  it('labels nothing yet for a claimed batch whose Brewery issue is not recorded', () => {
    const effects = recipeLabelEffects({ brewery, host: fakeHost().host });
    const claimed: Event[] = [
      { type: 'batch.ordered', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' }, routeBy },
      { ...chose(), batchId: 'web-7' } as Event,
    ];
    assert.deepEqual(effects.due(fold(claimed), 'web-7'), []);
  });

  it('is due once: never again after its record', () => {
    const effects = recipeLabelEffects({ brewery, host: fakeHost().host });
    const applied: Event = {
      type: 'effect.applied',
      key: effectKey.encode(key),
      result: { label: 'recipe:nip' },
    };
    assert.deepEqual(effects.due(fold([ordered, chose(), applied]), '12-1'), []);
  });

  it('labels nothing for a choice no answer made: a label, or foedrum recipe', () => {
    const effects = recipeLabelEffects({ brewery, host: fakeHost().host });
    const label: Event = { ...chose({}), source: 'label' } as Event;
    for (const choice of [label, chose({})]) {
      assert.deepEqual(effects.due(fold([ordered, choice]), '12-1'), []);
    }
  });

  it("labels a claimed order's Brewery issue, never the target issue", async () => {
    const { host, onIssue } = fakeHost();
    const effects = recipeLabelEffects({ brewery, host });
    const claimed: Event[] = [
      { type: 'batch.ordered', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' }, routeBy },
      // The driver opened Brewery issue #40 as the claimed issue's order (ADR 0144).
      {
        type: 'effect.applied',
        key: effectKey.encode({ batchId: 'web-7', effect: 'order.issue' }),
        result: 40,
      },
      { ...chose(), batchId: 'web-7' } as Event,
    ];
    const [due] = effects.due(fold(claimed), 'web-7');
    assert.ok(due !== undefined);
    await effects.target.apply(effectKey.encode(due));
    assert.deepEqual(onIssue.get(40), ['recipe:nip']);
  });
});
