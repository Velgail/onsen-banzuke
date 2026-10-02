import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInterval, targetFitInterval, evaluateRequirement, evaluateRequirements, evaluatePlan, rankRegions } from '../docs/assets/scoring.mjs';

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
  assert.deepEqual(result.score, { lower: 50, upper: 100, coverage: 50, certainty: 50 });
  assert.equal(result.contributions[1].status, 'E');
  assert.equal(result.contributions[1].coefficient, 0.5);
  const weighted = evaluatePlan(plan('p', 'r', { P17: row(100), B06: row(0, 100, { status: 'X' }) }),
    { weights: { P17: 1, B06: 0.25 } });
  assert.deepEqual(weighted.score, { lower: 80, upper: 100, coverage: 80, certainty: 80 });
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
  assert.deepEqual(result.confirmed[0].score, { lower: 70, upper: 70, coverage: 100, certainty: 100 });
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
  assert.deepEqual(absent.score, { lower: 0, upper: 0, coverage: 0, certainty: 0 });
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

test('a target band recalculates suitability from raw facts and reverses the ranking', () => {
  const regions = [region('hot'), region('mild')];
  const plans = [plan('hot-pool', 'hot', { B01: row(100, 100, { raw: 50 }) }),
    plan('mild-pool', 'mild', { B01: row(80, 80, { raw: 40 }) })];
  assert.deepEqual(rankRegions(regions, plans, { weights: { B01: 1 } }).confirmed.map(item => item.id), ['hot', 'mild']);
  const targetFit = { min: 38, max: 41, decay: 5 };
  const ranked = rankRegions(regions, plans, { weights: { B01: 1 }, targetFits: { B01: targetFit } }).confirmed;
  assert.deepEqual(ranked.map(item => item.id), ['mild', 'hot']);
  assert.equal(ranked[0].score.lower, 100);
  assert.equal(ranked[1].score.lower, 0);
  assert.equal(ranked[0].contributions.length, 1, 'the target view replaces, rather than duplicates, the axis');
  assert.deepEqual(ranked[0].contributions[0].targetFit, targetFit);
});

test('target intervals include the interior plateau and use the configured decay', () => {
  const source = row(10, 20, { rawLower: 37, rawUpper: 43 });
  assert.deepEqual(targetFitInterval(source, { min: 39, max: 41, decay: 5 }), { lower: 60, upper: 100 });
  assert.deepEqual(targetFitInterval(source, { min: 39, max: 41, decay: 2 }), { lower: 0, upper: 100 });
  assert.deepEqual(targetFitInterval(row(100, 100, { raw: 39 }), { min: 40, max: 40, decay: 2 }), { lower: 50, upper: 50 });
  const inverse = evaluatePlan(plan('p', 'r', { B01: source }), {
    weights: { B01: -0.47 }, targetFits: { B01: { min: 39, max: 41, decay: 5 } },
  });
  assert.deepEqual(inverse.score, { lower: 0, upper: 40, coverage: 100, certainty: 60 });
});

test('one-sided target raw bounds preserve uncertainty beyond the known bound', () => {
  const targetFit = { min: 500, max: 1000, decay: 500 };
  assert.deepEqual(targetFitInterval(row(0, 100, { status: 'C', rawLower: 1100 }), targetFit), { lower: 0, upper: 80 });
  assert.deepEqual(targetFitInterval(row(0, 100, { status: 'C', rawUpper: 400 }), targetFit), { lower: 0, upper: 80 });
  assert.deepEqual(targetFitInterval(row(0, 100, { status: 'C', rawLower: 750 }), targetFit), { lower: 0, upper: 100 });
  assert.deepEqual(targetFitInterval(row(0, 100, { status: 'X', raw: 750 }), targetFit), { lower: 0, upper: 100 });
});

test('target preferences never reward unavailable or unknown numerical facts', () => {
  const targetFit = { min: 38, max: 41, decay: 5 };
  for (const status of ['U', 'E', 'F']) {
    const result = evaluatePlan(plan('p', 'r', { B01: row(0, 0, { status }) }), {
      weights: { B01: -1 }, targetFits: { B01: targetFit },
    });
    assert.deepEqual(result.score, { lower: 0, upper: 100, coverage: 0, certainty: 0 });
  }
  assert.deepEqual(targetFitInterval(row(0, 0, { status: 'A' }), targetFit), { lower: 0, upper: 0 });
  assert.deepEqual(targetFitInterval(row(100), targetFit), { lower: 0, upper: 100 });
  assert.deepEqual(targetFitInterval(row(100, 100, { raw: true }), targetFit), { lower: 0, upper: 100 });
});

test('invalid or incomplete target settings stop ranking, even for a zero-weight axis', () => {
  for (const targetFit of [null, {}, { min: 40, max: 39, decay: 5 },
    { min: 38, max: 41, decay: 0 }, { min: 38, max: 41, decay: -1 },
    { min: NaN, max: 41, decay: 5 }, { min: 38, max: Infinity, decay: 5 }]) {
    assert.throws(() => rankRegions([region('r')], [plan('p', 'r', {})], {
      weights: { B01: 0 }, targetFits: { B01: targetFit },
    }));
  }
});

test('AND, OR, and NOT preserve all three hard-condition outcomes', () => {
  const metrics = { pass: row(100, 100, { raw: true }), fail: row(0, 0, { raw: false }), unknown: row(0, 100, { status: 'U' }) };
  const leaf = metricKey => ({ metricKey, operator: 'equals', value: true });
  const states = ['pass', 'fail', 'unknown'];
  for (const first of states) {
    for (const second of states) {
      const decisions = [first, second];
      const expectedAnd = decisions.includes('fail') ? 'fail' : decisions.includes('unknown') ? 'unknown' : 'pass';
      const expectedOr = decisions.includes('pass') ? 'pass' : decisions.includes('unknown') ? 'unknown' : 'fail';
      assert.equal(evaluateRequirements(metrics, { operator: 'and', conditions: [leaf(first), leaf(second)] }), expectedAnd);
      assert.equal(evaluateRequirements(metrics, { operator: 'or', conditions: [leaf(first), leaf(second)] }), expectedOr);
      assert.equal(evaluateRequirements(metrics, [leaf(first), leaf(second)]), expectedAnd);
    }
    assert.equal(evaluateRequirements(metrics, { operator: 'not', conditions: [leaf(first)] }),
      first === 'pass' ? 'fail' : first === 'fail' ? 'pass' : 'unknown');
  }
  assert.equal(evaluateRequirements(metrics, { operator: 'and', conditions: [] }), 'pass');
});

test('nested alternatives apply to one real plan before choosing the region winner', () => {
  const requirement = { operator: 'and', conditions: [
    { operator: 'or', conditions: [
      { metricKey: 'B06', operator: 'equals', value: 1 },
      { metricKey: 'B07', operator: 'equals', value: 1 },
    ] },
    { operator: 'not', conditions: [{ metricKey: 'Y01', operator: 'atLeast', value: 1000 }] },
  ] };
  const outdoorOnly = plan('outdoor-expensive', 'r', { B06: row(100, 100, { raw: 1 }), Y01: row(0, 0, { raw: 2000 }) });
  const cheapOnly = plan('cheap-indoor', 'r', { B06: row(0, 0, { raw: 0 }), B07: row(0, 0, { raw: 0 }), Y01: row(100, 100, { raw: 500 }) });
  const combined = plan('private-cheap', 'r', { B06: row(0, 0, { raw: 0 }), B07: row(100, 100, { raw: 1 }), Y01: row(100, 100, { raw: 500 }) });
  const separate = rankRegions([region('r')], [outdoorOnly, cheapOnly], { requirements: requirement });
  assert.equal(separate.confirmed.length, 0, 'facts from different plans cannot satisfy one expression');
  const valid = rankRegions([region('r')], [outdoorOnly, cheapOnly, combined], { weights: { Y01: 0.47 }, requirements: requirement });
  assert.equal(valid.confirmed[0].bestPlan.id, 'private-cheap');
  assert.equal(valid.confirmed[0].score.lower, 100);
  assert.deepEqual(valid.confirmed[0].score.certainty, 100);
});

test('malformed logical conditions do not silently become an unconstrained search', () => {
  const metrics = {};
  for (const requirements of [null, { operator: 'or', conditions: [] },
    { operator: 'not', conditions: [] }, { operator: 'not', conditions: [{ metricKey: 'B06', operator: 'equals', value: 1 }, { metricKey: 'B07', operator: 'equals', value: 1 }] },
    { operator: 'and', conditions: {} }, { operator: 'and', metricKey: 'B06', conditions: [] },
    { metricKey: 'B06', operator: 'equals', value: 1, conditions: [] }]) {
    assert.throws(() => evaluateRequirements(metrics, requirements));
  }
  const cyclic = { operator: 'and', conditions: [] };
  cyclic.conditions.push(cyclic);
  assert.throws(() => evaluateRequirements(metrics, cyclic), /cyclic/);
});

test('numeric certainty distinguishes bounded contradictions, evidence, and unavailable facts', () => {
  const result = evaluatePlan(plan('p', 'r', {
    C01: row(50, 100, { status: 'X' }),
    C02: row(0, 100, { status: 'C' }),
    P17: row(0, 0, { status: 'A' }),
    B06: row(100),
  }), { weights: { C01: 0.25, C02: 0.25, P17: 0.25, B06: 0.25 } });
  assert.deepEqual(result.score, { lower: 37.5, upper: 75, coverage: 50, certainty: 37.5 });
  assert.equal(result.contributions[0].coverage, 0);
  assert.equal(result.contributions[0].certainty, 50);
  assert.equal(result.contributions[1].coverage, 100);
  assert.equal(result.contributions[1].certainty, 0);
});

test('arbitrary finite weights use their exact ratios without preset-level rounding', () => {
  const result = evaluatePlan(plan('p', 'r', { P17: row(100), B06: row(0) }), { weights: { P17: 0.47, B06: 0.53 } });
  assert.deepEqual(result.score, { lower: 47, upper: 47, coverage: 100, certainty: 100 });
  assert.equal(result.contributions[0].coefficient, 0.47);
});

test('group budgets normalize within a field before combining fields', () => {
  const candidate = plan('p', 'r', { C01: row(100), C02: row(100), C06: row(100), S06: row(0) });
  const result = evaluatePlan(candidate, { weights: { C01: 1, C02: 1, C06: 1, S06: 1 }, groupBudgets: { C: 1, S: 1 } });
  assert.ok(Math.abs(result.score.lower - 50) < 1e-10, 'three chemistry axes together receive half the total budget');
  assert.equal(result.contributions[0].coefficient, 1 / 6);
  assert.equal(result.contributions[3].coefficient, 1 / 2);
  assert.equal(result.contributions[0].group, 'C');
  const custom = evaluatePlan(candidate, { weights: { C01: 1, S06: 1 }, groupAssignments: { C01: 'chemistry', S06: 'experience' }, groupBudgets: { chemistry: 3, experience: 1 } });
  assert.deepEqual(custom.score, { lower: 75, upper: 75, coverage: 100, certainty: 100 });
});

test('group budgets never activate preferences or redistribute an omitted field budget', () => {
  const candidate = plan('p', 'r', { C01: row(100), S06: row(0) });
  assert.throws(() => evaluatePlan(candidate, { weights: { C01: 1, S06: 0 }, groupBudgets: { C: 1, S: 1 } }), /active preferences/);
  const chemistryOnly = evaluatePlan(candidate, { weights: { C01: 1, S06: 1 }, groupBudgets: { C: 1 } });
  assert.equal(chemistryOnly.score.lower, 100);
  assert.equal(chemistryOnly.contributions.find(item => item.metricKey === 'S06').coefficient, 0);
  const empty = rankRegions([region('r')], [candidate], { weights: { C01: 1 }, groupBudgets: { C: 0 } });
  assert.equal(empty.confirmed[0].score, null);
  assert.equal(empty.confirmed[0].rank, null);
  const flat = evaluatePlan(candidate, { weights: { C01: 1, S06: 1 }, groupBudgets: null });
  assert.equal(flat.score.lower, 50);
});

test('group coefficients also govern missing metrics, coverage, and certainty', () => {
  const result = evaluatePlan(plan('p', 'r', { C01: row(100), S06: row(25, 75, { status: 'C' }) }), {
    weights: { C01: 1, C02: 1, S06: 1 }, groupBudgets: { C: 3, S: 1 },
  });
  assert.deepEqual(result.score, { lower: 43.75, upper: 93.75, coverage: 62.5, certainty: 50 });
  assert.deepEqual(result.contributions.map(item => item.coefficient), [0.375, 0.375, 0.25]);
});

test('group budget inputs remain finite and valid before ranking', () => {
  for (const groupBudgets of [{ C: -1 }, { C: Infinity }, { C: NaN }, { C: '1' }, { ' C': 1 }, []]) {
    assert.throws(() => evaluatePlan(plan('p', 'r', {}), { weights: { C01: 1 }, groupBudgets }));
  }
  assert.throws(() => evaluatePlan(plan('p', 'r', {}), { weights: { C01: 1 }, groupAssignments: { C01: '' } }));
  const huge = evaluatePlan(plan('p', 'r', { C01: row(100), S06: row(0) }), {
    weights: { C01: 1, S06: 1 }, groupBudgets: { C: 1e308, S: 1e308 },
  });
  assert.equal(huge.score.lower, 50);
});
