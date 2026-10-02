import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInterval, evaluateRequirement, evaluatePlan, rankRegions } from '../docs/assets/scoring.mjs';

const row = (lower, upper = lower, extras = {}) => ({ status: 'K', lower, upper, ...extras });
const region = (id, kana = id) => ({ id, name: id, kana });
const plan = (id, regionId, metrics, extras = {}) => ({ id, regionId, label: id, modality: 'daytrip', metrics, ...extras });

test('a constrained interval reverses its endpoints; missing states gain no conservative points', () => {
  assert.deepEqual(scoreInterval(row(40, 75), -1), { lower: 25, upper: 60 });
  for (const status of ['U', 'E', 'F']) {
    for (const weight of [-1, 1]) {
      assert.deepEqual(scoreInterval(row(0, 0, { status }), weight), { lower: 0, upper: 100 });
    }
  }
  assert.deepEqual(scoreInterval(row(0, 100, { status: 'A' }), -1), { lower: 0, upper: 0 });
  assert.deepEqual(scoreInterval(row(0, 0, { status: 'Z' }), -1), { lower: 100, upper: 100 });
});

test('empty preferences are uncomputed, and adding a zero-weight axis changes nothing', () => {
  const candidate = plan('p', 'r', { P17: row(80) });
  assert.equal(evaluatePlan(candidate, {}).score, null);
  assert.equal(evaluatePlan(candidate, { weights: { P17: 0 } }).score, null);
  assert.deepEqual(evaluatePlan(candidate, { weights: { P17: 1 } }).score,
    evaluatePlan(candidate, { weights: { P17: 1, B06: 0 } }).score);
});

test('missing weighted metrics stay in the denominator and coverage uses the same weights', () => {
  const result = evaluatePlan(plan('p', 'r', { P17: row(100) }), { weights: { P17: 1, B06: 1 } });
  assert.deepEqual(result.score, { lower: 50, upper: 100, coverage: 50 });
  assert.equal(result.contributions[1].status, 'E');
  assert.equal(result.contributions[1].coefficient, 0.5);
  const weighted = evaluatePlan(plan('p', 'r', { P17: row(100), B06: row(0, 100, { status: 'X' }) }),
    { weights: { P17: 1, B06: 0.25 } });
  assert.deepEqual(weighted.score, { lower: 80, upper: 100, coverage: 80 });
});

test('hard temperature bands require the whole raw interval, independent of the score', () => {
  const requirement = { metricKey: 'B01', operator: 'within', min: 38, max: 41 };
  assert.equal(evaluateRequirement(row(100, 100, { rawLower: 39, rawUpper: 42 }), requirement), 'unknown');
  assert.equal(evaluateRequirement(row(0, 0, { rawLower: 39, rawUpper: 40 }), requirement), 'pass');
  assert.equal(evaluateRequirement(row(100, 100, { raw: 42 }), requirement), 'fail');
  assert.equal(evaluateRequirement(row(100, 100, { status: 'U', raw: 40 }), requirement), 'unknown');
});

test('one-sided cost bounds can prove budget failure, but cannot prove a complete budget', () => {
  const requirement = { metricKey: 'Y20', operator: 'atMost', value: 10000 };
  assert.equal(evaluateRequirement(row(0, 0, { rawLower: 11000 }), requirement), 'fail');
  assert.equal(evaluateRequirement(row(0, 100, { rawLower: 6000 }), requirement), 'unknown');
  assert.equal(evaluateRequirement(row(100, 100, { rawUpper: 8000 }), requirement), 'pass');
});

test('equals supports confirmed categories and exact numbers; a contradicting single raw is unknown', () => {
  assert.equal(evaluateRequirement(row(100, 100, { raw: true }),
    { metricKey: 'B06', operator: 'equals', value: true }), 'pass');
  assert.equal(evaluateRequirement(row(0, 0, { raw: 'not_allowed' }),
    { metricKey: 'Z23', operator: 'equals', value: 'allowed' }), 'fail');
  assert.equal(evaluateRequirement(row(50, 50, { rawLower: 2, rawUpper: 3 }),
    { metricKey: 'X03', operator: 'equals', value: 2 }), 'unknown');
  assert.equal(evaluateRequirement(row(50, 100, { status: 'X', raw: 2 }),
    { metricKey: 'X03', operator: 'equals', value: 2 }), 'unknown');
  assert.equal(evaluateRequirement(row(0, 100, { status: 'X', rawLower: 2, rawUpper: 3 }),
    { metricKey: 'X03', operator: 'atLeast', value: 2 }), 'pass');
});

test('hard constraints cannot be compensated by preferences and failure dominates unknown', () => {
  const candidate = plan('p', 'r', { P17: row(100), B06: row(0, 0, { raw: false }) });
  const result = evaluatePlan(candidate, { weights: { P17: 1 }, requirements: [
    { metricKey: 'B06', operator: 'equals', value: true },
    { metricKey: 'Z10', operator: 'equals', value: true },
  ] });
  assert.equal(result.eligibility, 'fail');
  assert.equal(result.reasons.length, 2);
  assert.equal(result.score, null);
  assert.equal(result.contributions[0].weightedLower, 100);
});

test('the regional maximum is computed after combining metrics within a real plan', () => {
  const result = rankRegions([region('r')], [
    plan('sulfur', 'r', { 'S06[odor=sulfur]': row(100), P17: row(0) }),
    plan('unprocessed', 'r', { 'S06[odor=sulfur]': row(0), P17: row(100) }),
  ], { weights: { 'S06[odor=sulfur]': 1, P17: 1 } });
  assert.equal(result.confirmed[0].score.lower, 50);
  assert.deepEqual(result.confirmed[0].bestEnvelope, { lower: 50, upper: 50 });
});

test('the selected plan interval is separate from the envelope of the best feasible plan', () => {
  const result = rankRegions([region('r')], [
    plan('known', 'r', { P17: row(70) }),
    plan('uncertain', 'r', { P17: row(60, 100, { status: 'C' }) }),
  ], { weights: { P17: 1 } });
  assert.equal(result.confirmed[0].bestPlan.id, 'known');
  assert.deepEqual(result.confirmed[0].score, { lower: 70, upper: 70, coverage: 100 });
  assert.deepEqual(result.confirmed[0].bestEnvelope, { lower: 70, upper: 100 });
});

test('only feasible candidates rank; unknown and failed plans remain separate', () => {
  const result = rankRegions([region('good'), region('unknown'), region('bad')], [
    plan('a', 'good', { B06: row(100, 100, { raw: true }) }),
    plan('b', 'unknown', { B06: row(0, 100, { status: 'U' }) }),
    plan('c', 'bad', { B06: row(0, 0, { raw: false }) }),
  ], { weights: { B06: 1 }, requirements: [{ metricKey: 'B06', operator: 'equals', value: true }] });
  assert.deepEqual(result.confirmed.map(item => item.id), ['good']);
  assert.equal(result.unknown[0].plan.id, 'b');
  assert.equal(result.failed[0].plan.id, 'c');
});

test('ties use competition ranks and name ordering; no preferences gives kana ordering and null ranks', () => {
  const regions = [region('c', 'う'), region('b', 'い'), region('a', 'あ')];
  const plans = [plan('c1', 'c', { P17: row(60) }), plan('b1', 'b', { P17: row(80) }), plan('a1', 'a', { P17: row(80) })];
  const scored = rankRegions(regions, plans, { weights: { P17: 1 } }).confirmed;
  assert.deepEqual(scored.map(item => [item.id, item.rank]), [['a', 1], ['b', 1], ['c', 3]]);
  const unscored = rankRegions(regions, plans, {}).confirmed;
  assert.deepEqual(unscored.map(item => [item.id, item.rank, item.score]), [['a', null, null], ['b', null, null], ['c', null, null]]);
});

test('modality and region query constrain the candidate population', () => {
  const result = rankRegions([region('a', 'あ'), region('b', 'い')], [
    plan('day', 'a', {}), plan('hotel', 'a', {}, { modality: 'stay' }), plan('other', 'b', {}),
  ], { modality: 'stay', regionQuery: 'あ' });
  assert.deepEqual(result.confirmed.map(item => item.bestPlan.id), ['hotel']);
  assert.deepEqual(result.failed.map(item => item.plan.id), ['day']);
});

test('confirmed free pricing differs from unavailable pricing', () => {
  const free = evaluatePlan(plan('free', 'r', { Y01: row(100, 100, { raw: 0 }) }), { weights: { Y01: 1 } });
  const absent = evaluatePlan(plan('absent', 'r', { Y01: row(0, 0, { status: 'A', raw: null }) }), { weights: { Y01: -1 } });
  assert.equal(free.score.lower, 100);
  assert.deepEqual(absent.score, { lower: 0, upper: 0, coverage: 0 });
});

test('invalid input is rejected even for unknown or zero-weight rows', () => {
  for (const invalid of [row(NaN), row(0, Infinity), row(-1), row(60, 40), row(0, 100, { status: '?' })]) {
    assert.throws(() => scoreInterval(invalid, 0));
  }
  for (const weight of [NaN, Infinity, 2, -2, '1']) assert.throws(() => scoreInterval(row(100), weight));
  assert.throws(() => evaluatePlan(plan('p', 'r', { P17: row(100, 100, { raw: Infinity }) })));
  assert.throws(() => evaluatePlan(plan('p', 'r', { P17: row(100, 100, { rawLower: 2, rawUpper: 1 }) })));
  assert.throws(() => evaluatePlan(plan('p', 'r', {}), { weights: { 'P17 ': 1 } }));
  assert.throws(() => evaluatePlan(plan('p', 'r', {}), { requirements: [{ metricKey: 'P17', operator: 'within', min: 2, max: 1 }] }));
});

test('duplicate identifiers, dangling regions, and mismatched metric keys are rejected', () => {
  assert.throws(() => rankRegions([region('r')], [plan('same', 'r', {}), plan('same', 'r', {})]), /duplicate plan/);
  assert.throws(() => rankRegions([region('r'), region('r')], []), /duplicate region/);
  assert.throws(() => rankRegions([region('r')], [plan('p', 'missing', {})]), /unknown regionId/);
  assert.throws(() => evaluatePlan(plan('p', 'r', { P17: row(100, 100, { metricKey: 'B06' }) })), /map key/);
});
