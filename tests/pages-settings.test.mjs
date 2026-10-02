import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSettings, validateConfig } from '../docs/assets/settings.mjs';
import { evaluatePlan } from '../docs/assets/scoring.mjs';

const catalog = JSON.parse(await readFile(new URL('../onsen_banzuke_metric_catalog_v1.json', import.meta.url), 'utf8'));
const manifest = { snapshot_id: 'settings-test', rubric_version: catalog.version };
const views = catalog.metrics.map(metric => ({
  key: metric.id, name: metric.name, formula: metric.formula, group: metric.group,
  description: metric.note, positive: '多い', negative: '少ない',
}));
const config = (extras = {}) => ({
  version: 2, snapshot: manifest.snapshot_id, rubric: manifest.rubric_version,
  ...createSettings(), ...extras,
});
const validate = value => validateConfig(value, manifest, catalog, views);
const leaf = (metricKey = 'Y01', operator = 'atMost', value = 2000) => ({ metricKey, operator, value });

test('the initial ranking settings have no implicit weights or conditions, and are independent', () => {
  const initial = createSettings();
  assert.deepEqual(validate(config()), initial);
  initial.weights.B06 = 1;
  initial.selected.push('B06');
  initial.targetFits.B01 = { min: 38, max: 41, decay: 5 };
  initial.requirements.conditions.push(leaf());
  assert.deepEqual(createSettings(), {
    weights: {}, selected: [], targetFits: {}, requirements: { operator: 'and', conditions: [] },
    modality: 'daytrip', query: '', sort: 'score', groupBudgets: null, tab: 'confirmed', preset: null,
  });
});

test('shared settings retain exact signed weights, raw target ranges, and arbitrary complete parameter views', () => {
  const input = config({
    weights: { B01: 0.47, 'S06[odor = sulfur ]': -0.82, 'C44[tag=chloride]': 0 },
    selected: ['B01', 'S06[odor=sulfur]', 'C30'],
    targetFits: { B01: { min: 38.5, max: 41, decay: 2.5 } },
    modality: 'all', query: '草津', sort: 'coverage', groupBudgets: { B: 2, S: 1, C: 0 },
  });
  const original = structuredClone(input);
  const catalogBefore = structuredClone(catalog);
  const viewsBefore = structuredClone(views);
  const normalized = validate(input);
  assert.deepEqual(input, original);
  assert.deepEqual(catalog, catalogBefore);
  assert.deepEqual(views, viewsBefore);
  assert.deepEqual(normalized.weights, { B01: 0.47, 'S06[odor=sulfur]': -0.82, 'C44[tag=chloride]': 0 });
  assert.deepEqual(normalized.selected, ['B01', 'S06[odor=sulfur]', 'C44[tag=chloride]']);
  assert.deepEqual(normalized.targetFits, { B01: { min: 38.5, max: 41, decay: 2.5 } });
  assert.equal(normalized.modality, 'all');
  assert.equal(normalized.query, '草津');
  assert.equal(normalized.sort, 'coverage');
  assert.deepEqual(normalized.groupBudgets, { B: 2, S: 1, C: 0 });
  normalized.weights.B01 = 1;
  normalized.targetFits.B01.min = 40;
  normalized.groupBudgets.B = 10;
  assert.deepEqual(input, original);
});

test('aliases and parameter redirects normalize before checking duplicate selections and weights', () => {
  const normalized = validate(config({
    selected: ['P18', 'B09[type=outdoor,dimension=setting]'], weights: { I21: 1, B06: -1 },
  }));
  assert.deepEqual(normalized.selected, ['I21', 'B06']);
  assert.throws(() => validate(config({ selected: ['P18', 'I21'] })), /重複/);
  assert.throws(() => validate(config({ weights: { P18: 1, I21: 0.5 }, selected: ['I21'] })), /重複/);
  assert.throws(() => validate(config({ selected: ['B06', 'B09[dimension=setting,type=outdoor]'] })), /重複/);
  assert.throws(() => validate(config({ weights: { B06: 1 }, selected: [] })), /一致/);
});

test('dynamic views need valid, complete parameters and may not invent catalogue metrics', () => {
  for (const key of ['C44', 'S06', 'C44[tag=sulfur,tag=acid]', 'C44[unknown=sulfur]', 'J99', 'B06[anything=1]']) {
    assert.throws(() => validate(config({ selected: [key] })), key);
  }
  for (const key of ['C03', 'C07', 'B02', 'M06', 'Z17']) {
    assert.throws(() => validate(config({ selected: [key] })), `${key} must not silently change scales`);
  }
  assert.doesNotThrow(() => validate(config({ selected: ['S06[odor=petroleum]', 'H18[place=bath]'] })));
});

test('numeric weights and target ranges reject incomplete, nonfinite, and binary settings', () => {
  for (const weight of [NaN, Infinity, -Infinity, 1.01, -1.01, '1', null]) {
    assert.throws(() => validate(config({ weights: { B01: weight }, selected: ['B01'] })));
  }
  const target = (fit, key = 'B01') => config({ selected: [key], targetFits: { [key]: fit } });
  for (const fit of [null, [], { min: 42, max: 38, decay: 5 }, { min: 38, max: 41, decay: 0 },
    { min: 38, max: 41, decay: -1 }, { min: NaN, max: 41, decay: 5 }, { min: 38, max: Infinity, decay: 5 },
    { min: 38, max: 41, decay: Infinity }, { min: null, max: 41, decay: 5 }]) {
    assert.throws(() => validate(target(fit)));
  }
  assert.throws(() => validate(target({ min: 0, max: 1, decay: 1 }, 'B06')), /有無/);
  assert.throws(() => validate(config({ targetFits: { B01: { min: 38, max: 41, decay: 5 } } })), /一致/);
  assert.throws(() => validate(config({ targetFits: null })));
  assert.doesNotThrow(() => validate(target({ min: 40, max: 40, decay: 5 })));
});

test('AND, OR, and NOT retain their recursive structure and raw-valued leaves', () => {
  const tree = {
    operator: 'and', conditions: [
      { operator: 'or', conditions: [leaf('B06', 'equals', true), leaf('C37', 'equals', 1)] },
      { operator: 'not', conditions: [leaf('Y01', 'atLeast', 2500)] },
      { metricKey: 'B01', operator: 'within', min: 38, max: 41 },
      leaf('B06', 'equals', 'allowed'),
    ],
  };
  const input = config({ requirements: tree });
  const normalized = validate(input);
  assert.deepEqual(normalized.requirements, {
    ...tree, conditions: [{ operator: 'or', conditions: [leaf('B06', 'equals', true), leaf('C44[tag=sulfur]', 'equals', 1)] }, ...tree.conditions.slice(1)],
  });
  normalized.requirements.conditions[0].conditions[0].value = false;
  assert.equal(input.requirements.conditions[0].conditions[0].value, true);
  assert.deepEqual(validate(config({ requirements: [leaf()] })).requirements, { operator: 'and', conditions: [leaf()] });
});

test('malformed or incomplete condition trees fail instead of dropping a user condition', () => {
  const cyclic = { operator: 'and', conditions: [] };
  cyclic.conditions.push(cyclic);
  for (const requirements of [null, {}, cyclic, [null], { operator: 'or', conditions: [] },
    { operator: 'not', conditions: [] }, { operator: 'not', conditions: [leaf(), leaf()] },
    { operator: 'and', conditions: 'all' }, { operator: 'and', metricKey: 'Y01', conditions: [] },
    { ...leaf(), conditions: [] }, { ...leaf(), value: null }, { ...leaf(), value: Infinity },
    { ...leaf('B06', 'equals'), value: {} }, { ...leaf('B06', 'equals'), value: NaN },
    { metricKey: 'B01', operator: 'within', min: 41, max: 38 },
    { metricKey: 'B01', operator: 'within', min: 38 }, { metricKey: 'unknown', operator: 'equals', value: 1 },
    { ...leaf(), operator: 'search' }]) {
    assert.throws(() => validate(config({ requirements })));
  }
});

test('only the root AND may be empty, so an unfinished nested group cannot relax requirements', () => {
  const emptyAnd = { operator: 'and', conditions: [] };
  assert.deepEqual(validate(config({ requirements: emptyAnd })).requirements, emptyAnd);
  assert.deepEqual(validate(config({ requirements: [] })).requirements, emptyAnd);
  for (const requirements of [
    { operator: 'or', conditions: [leaf(), emptyAnd] },
    { operator: 'and', conditions: [emptyAnd] },
    { operator: 'not', conditions: [emptyAnd] },
    { operator: 'and', conditions: [{ operator: 'or', conditions: [leaf(), emptyAnd] }] },
    [emptyAnd],
  ]) {
    assert.throws(() => validate(config({ requirements })), /入れ子/);
  }
});

test('all raw equality types stay intact, and thresholds do not accept numeric-looking strings', () => {
  for (const value of [0, 1, false, true, '0', 'allowed']) {
    assert.equal(validate(config({ requirements: [leaf('B06', 'equals', value)] })).requirements.conditions[0].value, value);
  }
  assert.throws(() => validate(config({ requirements: [leaf('Y01', 'atMost', '1000')] })));
});

test('group budgets accept zero and any nonnegative finite size, and reject unknown groups', () => {
  assert.deepEqual(validate(config({ groupBudgets: { I: 0, C: 2, Y: 1000000 } })).groupBudgets, { I: 0, C: 2, Y: 1000000 });
  for (const groupBudgets of [[], { C: -1 }, { C: NaN }, { C: Infinity }, { C: '1' }, { Q: 1 }]) {
    assert.throws(() => validate(config({ groupBudgets })));
  }
});

test('shared links preserve their requested dataset and rubric instead of replacing them', () => {
  for (const change of [{ version: 3 }, { version: '2' }, { snapshot: 'another-release' }, { rubric: '1.0' }]) {
    assert.throws(() => validate(config(change)), /指定版/);
  }
  assert.throws(() => validate(null));
});

test('display and modality validation is explicit and shared links reset ephemeral UI state', () => {
  for (const change of [{ modality: 'bath' }, { modality: null }, { query: 'a'.repeat(101) },
    { query: null }, { query: 1 }, { sort: null }, { sort: 'random' }, { weights: [] }, { selected: {} }]) {
    assert.throws(() => validate(config(change)));
  }
  assert.equal(validate(config({ query: 'a'.repeat(100), modality: 'stay', sort: 'name' })).query.length, 100);
  const restored = validate(config({ tab: 'failed', preset: 'unknown' }));
  assert.equal(restored.tab, 'confirmed');
  assert.equal(restored.preset, null);
});

test('legacy shared links migrate outdoor and budget checks into raw AND requirements', () => {
  const legacy = {
    version: 1, snapshot: manifest.snapshot_id, rubric: manifest.rubric_version,
    weights: { B06: -0.3, Y01: 0.8 }, selected: ['B06', 'Y01'], directions: { B06: 1, Y01: -1 },
    outdoor: true, budgetEnabled: true, budget: 2300.5, query: '湯', sort: 'score',
  };
  const original = structuredClone(legacy);
  const normalized = validate(legacy);
  assert.deepEqual(normalized.weights, legacy.weights);
  assert.deepEqual(normalized.requirements, { operator: 'and', conditions: [
    { metricKey: 'B06', operator: 'equals', value: 1 }, { metricKey: 'Y01', operator: 'atMost', value: 2300.5 },
  ] });
  assert.equal(normalized.modality, 'daytrip');
  assert.deepEqual(normalized.targetFits, {});
  assert.equal(normalized.groupBudgets, null);
  assert.equal(Object.hasOwn(normalized, 'directions'), false);
  assert.equal(Object.hasOwn(normalized, 'outdoor'), false);
  assert.deepEqual(legacy, original);
  assert.deepEqual(validate({ ...legacy, outdoor: false, budgetEnabled: false }).requirements,
    { operator: 'and', conditions: [] });
  for (const change of [{ outdoor: 1 }, { budgetEnabled: null }, { budget: -1 }, { budget: NaN }, { directions: { B06: 0 } }]) {
    assert.throws(() => validate({ ...legacy, ...change }));
  }
});

test('restored target ranges, logical conditions, modality, and group budgets reach the scoring core intact', () => {
  const restored = validate(config({
    weights: { B01: 0.47, P17: 0.82 }, selected: ['B01', 'P17'],
    targetFits: { B01: { min: 38, max: 40, decay: 5 } }, modality: 'stay', groupBudgets: { B: 1, P: 1 },
    requirements: { operator: 'and', conditions: [
      { operator: 'or', conditions: [leaf('B06', 'equals', 1), { metricKey: 'B01', operator: 'within', min: 38, max: 40 }] },
      { operator: 'not', conditions: [leaf('Y01', 'atLeast', 4000)] },
    ] },
  }));
  const result = evaluatePlan({
    id: 'p', regionId: 'r', label: '宿泊候補', modality: 'stay', metrics: {
      B01: { status: 'K', raw: 39, lower: 35, upper: 35 },
      P17: { status: 'K', raw: 1, lower: 100, upper: 100 },
      B06: { status: 'U', lower: 0, upper: 100 },
      Y01: { status: 'K', raw: 2500, lower: 50, upper: 50 },
    },
  }, restored);
  assert.equal(result.eligibility, 'pass');
  assert.equal(result.score.lower, 100);
  assert.equal(result.score.upper, 100);
});
