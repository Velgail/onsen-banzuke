import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRegionalFees } from '../docs/assets/pricing.mjs';

const tariff = (id, lower, upper = lower, extra = {}) => ({
  id,
  rawLower: lower,
  rawUpper: upper,
  status: lower === upper && lower !== null ? 'K' : lower === null && upper === null ? 'E' : 'C',
  evidence_ids: ['official-price'],
  plan_ids: [`${id}-plan`],
  ...extra,
});

const facility = (id, tariffs, extra = {}) => ({
  facility_id: id,
  membership: 'included',
  tariff_inventory_complete: true,
  tariffs,
  ...extra,
});

const population = (facilities, extra = {}) => ({
  regionId: 'sample-region',
  day_type: 'weekday',
  inventory_complete: true,
  facilities,
  ...extra,
});

test('one cheap facility among ten differs from ten cheap facilities', () => {
  const oneCheap = population(Array.from({ length: 10 }, (_, index) => facility(
    `facility-${index}`, [tariff(`unit-${index}`, index === 0 ? 100 : 1000)],
  )));
  const allCheap = population(Array.from({ length: 10 }, (_, index) => facility(
    `facility-${index}`, [tariff(`unit-${index}`, 100)],
  )));
  const one = summarizeRegionalFees(oneCheap, { budget: 500 });
  const all = summarizeRegionalFees(allCheap, { budget: 500 });
  assert.deepEqual(one.regionalMinimum, { lower: 100, upper: 100 });
  assert.deepEqual(all.regionalMinimum, one.regionalMinimum);
  assert.deepEqual(one.regionalMedian, { lower: 1000, upper: 1000 });
  assert.deepEqual(all.regionalMedian, { lower: 100, upper: 100 });
  assert.deepEqual(one.budgetCount, { lower: 1, upper: 1 });
  assert.deepEqual(one.budgetShare, { lower: 0.1, upper: 0.1 });
  assert.deepEqual(all.budgetCount, { lower: 10, upper: 10 });
  assert.deepEqual(all.budgetShare, { lower: 1, upper: 1 });
  assert.equal(one.state, 'K');
  assert.equal(one.complete, true);
});

test('facility cheapest unit, not baths or repeated tariff citations, determines its one vote', () => {
  const shared = tariff('admission', 700, 700, { plan_ids: ['bath-A'], evidence_ids: ['price-A'] });
  const withDuplicateBaths = population([
    facility('public-bath', [
      shared,
      tariff('admission', 700, 700, { plan_ids: ['bath-B'], evidence_ids: ['price-B'] }),
      shared,
      tariff('premium', 1200),
    ]),
    facility('other-bath', [tariff('admission', 1300)]),
  ]);
  const result = summarizeRegionalFees(withDuplicateBaths, { budget: 800 });
  assert.equal(result.includedCount, 2);
  assert.deepEqual(result.populationCount, { lower: 2, upper: 2 });
  assert.equal(result.facilities[0].tariffCount, 2);
  assert.deepEqual(result.facilities[0].tariffs[0].plan_ids, ['bath-A', 'bath-B']);
  assert.deepEqual(result.facilities[0].tariffs[0].evidence_ids, ['price-A', 'price-B']);
  assert.deepEqual(result.regionalMedian, { lower: 1000, upper: 1000 });
  assert.deepEqual(result.budgetCount, { lower: 1, upper: 1 });
  assert.deepEqual(result.budgetShare, { lower: 0.5, upper: 0.5 });
});

test('same tariff id with conflicting bounds or status rejects within its facility', () => {
  for (const conflicting of [tariff('same', 701), tariff('same', 700, 700, { status: 'C' })]) {
    assert.throws(() => summarizeRegionalFees(population([
      facility('one', [tariff('same', 700), conflicting]),
    ])), /conflicting tariff.id/);
  }
  // A tariff id is facility-local, so distinct facilities may use the same id.
  assert.equal(summarizeRegionalFees(population([
    facility('one', [tariff('same', 700)]), facility('two', [tariff('same', 701)]),
  ])).includedCount, 2);
});

test('unknown fee of an included facility widens the median without confirming free admission', () => {
  const result = summarizeRegionalFees(population([
    facility('known-low', [tariff('one', 500)]),
    facility('known-high', [tariff('two', 1000)]),
    facility('unpriced', [tariff('three', null, null)]),
  ]), { budget: 700 });
  assert.equal(result.complete, true);
  assert.equal(result.state, 'C');
  assert.deepEqual(result.regionalMinimum, { lower: 0, upper: 500 });
  assert.deepEqual(result.regionalMedian, { lower: 500, upper: 1000 });
  assert.deepEqual(result.facilities[2].representativeFee, { lower: 0, upper: null });
  assert.equal(result.facilities[2].budgetResult, 'unknown');
  assert.deepEqual(result.budgetCount, { lower: 1, upper: 2 });
  assert.deepEqual(result.budgetShare, { lower: 1 / 3, upper: 2 / 3 });
});

test('an unknown majority leaves the median ceiling unbounded and is JSON safe', () => {
  const result = summarizeRegionalFees(population([
    facility('known', [tariff('one', 500)]),
    facility('unknown-U', [tariff('two', null, null, { status: 'U' })]),
    facility('unknown-F', [tariff('three', null, null, { status: 'F' })]),
  ]), { budget: 500 });
  assert.deepEqual(result.regionalMedian, { lower: 0, upper: null });
  assert.deepEqual(result.budgetCount, { lower: 1, upper: 3 });
  assert.deepEqual(result.budgetShare, { lower: 1 / 3, upper: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('incomplete tariff inventory expands facility minimum but not acquired-set reference', () => {
  const result = summarizeRegionalFees(population([
    facility('partly-listed', [tariff('observed', 1000)], { tariff_inventory_complete: false }),
  ]), { budget: 600 });
  assert.equal(result.complete, true);
  assert.equal(result.tariffInventoriesComplete, false);
  assert.deepEqual(result.regionalMinimum, { lower: 0, upper: 1000 });
  assert.deepEqual(result.regionalMedian, { lower: 0, upper: 1000 });
  assert.deepEqual(result.observedMinimum, { lower: 1000, upper: 1000 });
  assert.deepEqual(result.observedMedian, { lower: 1000, upper: 1000 });
  assert.deepEqual(result.facilities[0].observedFee, result.observedMinimum);
  assert.equal(result.facilities[0].budgetResult, 'unknown');
  assert.deepEqual(result.budgetCount, { lower: 0, upper: 1 });
});

test('incomplete facility inventory exposes references and a confirmed count lower bound only', () => {
  const result = summarizeRegionalFees(population([
    facility('cheap', [tariff('one', 500)]),
    facility('expensive', [tariff('two', 1200)]),
  ], { inventory_complete: false }), { budget: 500 });
  assert.equal(result.state, 'E');
  assert.equal(result.complete, false);
  assert.deepEqual(result.populationCount, { lower: 2, upper: null });
  assert.equal(result.regionalMinimum, null);
  assert.equal(result.regionalMedian, null);
  assert.equal(result.budgetShare, null);
  assert.deepEqual(result.budgetCount, { lower: 1, upper: null });
  assert.deepEqual(result.observedMinimum, { lower: 500, upper: 500 });
  assert.deepEqual(result.observedMedian, { lower: 850, upper: 850 });
  assert.equal(result.observedCount, 2);
});

test('unknown membership remains outside the definite observed reference and complete statistics', () => {
  const result = summarizeRegionalFees(population([
    facility('included', [tariff('one', 500)]),
    facility('maybe', [tariff('two', 0)], { membership: 'unknown' }),
    facility('resident-discount-only', [tariff('three', 0)], { membership: 'excluded' }),
  ]), { budget: 500 });
  assert.equal(result.state, 'E');
  assert.equal(result.complete, false);
  assert.equal(result.includedCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.unknownMembershipCount, 1);
  assert.deepEqual(result.populationCount, { lower: 1, upper: 2 });
  assert.deepEqual(result.facilities[1].representativeFee, { lower: 0, upper: null });
  assert.equal(result.facilities[1].budgetResult, 'unknown');
  assert.equal(result.facilities[1].observedFee, null);
  assert.equal(result.facilities[2].representativeFee, null);
  assert.deepEqual(result.observedMinimum, { lower: 500, upper: 500 });
  assert.equal(result.observedCount, 1);
  assert.equal(result.regionalMinimum, null);
  assert.equal(result.regionalMedian, null);
  assert.equal(result.budgetShare, null);
  assert.deepEqual(result.budgetCount, { lower: 1, upper: null });
});

test('one-sided prices and budget equality use conservative pass/fail/unknown bounds', () => {
  const result = summarizeRegionalFees(population([
    facility('upper-only', [tariff('upper', null, 600)]),
    facility('lower-only', [tariff('lower', 601, null)]),
    facility('straddles', [tariff('range', 590, 610)]),
    facility('equals', [tariff('exact', 600)]),
  ]), { budget: 600 });
  assert.deepEqual(result.facilities.map(value => value.budgetResult), ['pass', 'fail', 'unknown', 'pass']);
  assert.deepEqual(result.budgetCount, { lower: 2, upper: 3 });
  assert.deepEqual(result.budgetShare, { lower: 0.5, upper: 0.75 });
  assert.deepEqual(result.regionalMedian, { lower: 595, upper: 605 });
  assert.deepEqual(result.budgetBreakdown, {
    confirmedWithin: 2, confirmedOver: 1, feeUnconfirmed: 1, membershipUnconfirmed: 0,
  });
});

test('even-number medians average the two central endpoints independently', () => {
  const result = summarizeRegionalFees(population([
    facility('a', [tariff('a', 100, 600)]),
    facility('b', [tariff('b', 300, 400)]),
    facility('c', [tariff('c', 500, 700)]),
    facility('d', [tariff('d', 900, 1000)]),
  ]));
  assert.deepEqual(result.regionalMedian, { lower: 400, upper: 650 });
  assert.deepEqual(result.regionalMinimum, { lower: 100, upper: 400 });
});

test('complete population with zero included facilities is A, not zero yen', () => {
  for (const facilities of [[], [facility('outside', [], { membership: 'excluded' })]]) {
    const result = summarizeRegionalFees(population(facilities), { budget: 0 });
    assert.equal(result.state, 'A');
    assert.equal(result.complete, true);
    assert.deepEqual(result.populationCount, { lower: 0, upper: 0 });
    for (const field of ['regionalMinimum', 'regionalMedian', 'observedMinimum', 'observedMedian', 'budgetCount', 'budgetShare']) {
      assert.equal(result[field], null);
    }
  }
});

test('empty incomplete populations and unpriced facilities retain uncertainty', () => {
  const empty = summarizeRegionalFees(population([], { inventory_complete: false }), { budget: 0 });
  assert.equal(empty.state, 'E');
  assert.deepEqual(empty.populationCount, { lower: 0, upper: null });
  assert.deepEqual(empty.budgetCount, { lower: 0, upper: null });
  const unpriced = summarizeRegionalFees(population([
    facility('unpriced', [], { tariff_inventory_complete: false }),
  ]), { budget: 0 });
  assert.deepEqual(unpriced.regionalMedian, { lower: 0, upper: null });
  assert.equal(unpriced.observedMedian, null);
  assert.deepEqual(unpriced.budgetCount, { lower: 0, upper: 1 });
  assert.equal(unpriced.facilities[0].budgetResult, 'unknown');
});

test('confirmed free admission is distinct from an unknown fee, including at zero budget', () => {
  const result = summarizeRegionalFees(population([
    facility('free', [tariff('zero', 0)], { tariff_inventory_complete: false }),
    facility('unknown', [tariff('missing', null, null)]),
  ]), { budget: 0 });
  assert.deepEqual(result.facilities[0].representativeFee, { lower: 0, upper: 0 });
  assert.equal(result.facilities[0].budgetResult, 'pass');
  assert.equal(result.facilities[1].budgetResult, 'unknown');
  assert.deepEqual(result.budgetCount, { lower: 1, upper: 2 });
});

test('without a budget fee statistics remain available and budget fields are null', () => {
  const result = summarizeRegionalFees(population([facility('one', [tariff('one', 700)])]));
  assert.deepEqual(result.regionalMedian, { lower: 700, upper: 700 });
  assert.equal(result.budget, null);
  assert.equal(result.budgetCount, null);
  assert.equal(result.budgetShare, null);
  assert.equal(result.budgetBreakdown, null);
  assert.equal(result.facilities[0].budgetResult, null);
});

test('input objects, arrays, and reference sets remain unchanged and outputs do not alias inputs', () => {
  const input = population([
    facility('one', [tariff('one', 500, 500, { evidence_ids: ['z', 'a', 'z'], plan_ids: ['b', 'a'] })]),
  ]);
  const before = structuredClone(input);
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(input);
  const result = summarizeRegionalFees(input, { budget: 1000 });
  assert.deepEqual(input, before);
  result.facilities[0].tariffs[0].evidence_ids.push('new');
  assert.deepEqual(input, before);
});

test('facility and tariff order do not change regional summaries', () => {
  const input = population([
    facility('one', [tariff('one-high', 900), tariff('one-low', 400)]),
    facility('two', [tariff('two', 1200)]),
    facility('three', [tariff('three', 500, 800)]),
  ]);
  const reversed = structuredClone(input);
  reversed.facilities.reverse().forEach(value => value.tariffs.reverse());
  const a = summarizeRegionalFees(input, { budget: 700 });
  const b = summarizeRegionalFees(reversed, { budget: 700 });
  for (const field of ['regionalMinimum', 'regionalMedian', 'observedMinimum', 'observedMedian', 'populationCount', 'budgetCount', 'budgetShare', 'state']) {
    assert.deepEqual(a[field], b[field]);
  }
});

test('condition mismatches reject while an all-days tariff can serve a weekday population', () => {
  const input = population([facility('one', [tariff('one', 500, 500, { day_type: 'all' })])]);
  assert.equal(summarizeRegionalFees(input).state, 'K');
  for (const extra of [
    { day_type: 'weekend' },
    { day_type: 'mixed' },
    { regionId: 'other-region' },
    { modality: 'stay' },
    { currency: 'USD' },
  ]) {
    assert.throws(() => summarizeRegionalFees(population([
      facility('one', [tariff('one', 500, 500, extra)]),
    ])));
  }
  assert.throws(() => summarizeRegionalFees(population([
    facility('one', [tariff('one', 500, 500, { day_type: 'weekday' })]),
  ], { day_type: 'all' })), /different day condition/);
  assert.throws(() => summarizeRegionalFees(population([
    facility('one', [tariff('one', 500, 500, { condition_key: 'adult-ordinary' })]),
    facility('two', [tariff('two', 400, 400, { condition_key: 'resident-discount' })]),
  ])), /mixed fee conditions/);
});

test('invalid bounds, statuses, collections, duplicate facility ids, and budgets reject', () => {
  const valid = () => population([facility('one', [tariff('one', 500)])]);
  const changes = [
    value => { value.regionId = ''; },
    value => { value.day_type = 'mixed'; },
    value => { value.inventory_complete = 1; },
    value => { value.facilities = null; },
    value => { value.facilities.push(structuredClone(value.facilities[0])); },
    value => { value.facilities[0].membership = 'maybe'; },
    value => { value.facilities[0].tariff_inventory_complete = 'yes'; },
    value => { value.facilities[0].tariffs = null; },
    value => { value.facilities[0].tariffs = []; },
    value => { value.facilities[0].tariffs[0].id = ' bad '; },
    value => { value.facilities[0].tariffs[0].rawLower = NaN; },
    value => { value.facilities[0].tariffs[0].rawUpper = Infinity; },
    value => { value.facilities[0].tariffs[0].rawLower = -1; },
    value => { value.facilities[0].tariffs[0].rawLower = 501; },
    value => { value.facilities[0].tariffs[0].rawLower = undefined; },
    value => { value.facilities[0].tariffs[0].status = 'A'; },
    value => { value.facilities[0].tariffs[0].evidence_ids = null; },
    value => { value.facilities[0].tariffs[0].plan_ids = ['']; },
  ];
  for (const change of changes) {
    const input = valid();
    change(input);
    assert.throws(() => summarizeRegionalFees(input));
  }
  for (const budget of [NaN, Infinity, -1, '500']) {
    assert.throws(() => summarizeRegionalFees(valid(), { budget }));
  }
});


test('missing-data status cannot turn numeric prices into confirmed regional affordability',()=>{
  for(const status of ['U','E','F'])assert.throws(()=>summarizeRegionalFees(population([facility('one',[tariff('bad',500,500,{status})])]),{budget:1000}),/unknown tariff status/);
  assert.throws(()=>summarizeRegionalFees(population([facility('one',[tariff('bad',null,500,{status:'K'})])])),/both monetary bounds/);
  assert.throws(()=>summarizeRegionalFees(population([facility('one',[tariff('bad',null,null,{status:'C'})])])),/monetary bound/);
  assert.throws(()=>summarizeRegionalFees(population([facility('one',[tariff('bad',500,500,{evidence_ids:[]})])])),/source evidence/);
});
