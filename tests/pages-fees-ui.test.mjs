import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startFeesPage, verifyFeeRelease, formatFeeInterval } from '../docs/assets/fees-app.mjs';

// Isolated fictional test fixtures; public figures are never replaced by these.
const envelope = { schema_version: '2', rubric_version: '1.2', snapshot_id: 'fee-ui-test', dataset_kind: 'evidence_pilot' };
const policy = { id: 'ordinary-adult-daytrip-v1', condition_key: 'ordinary-adult-daytrip-v1:time-unspecified' };
const regions = Array.from({ length: 10 }, (_, index) => ({
  id: `test-${index}`, name: `テスト温泉${index}`, kana: `てすと${index}`, prefecture: '検証用',
  report_url: `./reports/test-${index}.html`,
}));
const unit = (id, rawLower, rawUpper = rawLower, extra = {}) => ({
  id, rawLower, rawUpper, status: rawLower === rawUpper && rawLower !== null ? 'K' : 'C',
  evidence_ids: ['official-test-price'], plan_ids: ['test-plan-a', 'test-plan-b'],
  reason: 'テスト用の同じ一般入浴券で二つの浴槽を利用。', ...extra,
});
const included = (id, tariffs, extra = {}) => ({
  facility_id: id, name: `検証施設${id}`, membership: 'included', reason: '一般成人の入浴のみを確認。',
  evidence_ids: ['official-test-membership'], tariff_inventory_complete: true,
  tariff_inventory_evidence_ids: ['official-test-tariffs'], tariffs, ...extra,
});
const populations = regions.flatMap((region, index) => ['weekday', 'weekend'].map(day_type => ({
  id: `${region.id}-${day_type}`, regionId: region.id, day_type, policy_id: policy.id, condition_key: policy.condition_key,
  inventory_complete: false, inventory_reason: '公式施設全一覧と所属は未確認。',
  inventory_evidence_ids: [], condition_note: `架空テストの${day_type}条件。来訪の成立確認ではない。`,
  facilities: [
    included(`${region.id}-ordinary`, [unit(`${region.id}-admission`, index === 0 ? day_type === 'weekday' ? 500 : 1500 : 1200)]),
    ...(index === 0 ? [
      included('meal-only', [], { membership: 'excluded', reason: '食事必須の別系列で通常入浴のみなし。' }),
      included('membership-unknown', [], { membership: 'unknown', reason: '通常外来販売の所属未確認。', tariff_inventory_complete: false }),
    ] : []),
    ...(index === 1 ? [included('incomplete-units', [unit('partly-listed', 1000)], { tariff_inventory_complete: false })] : []),
  ],
})));
const manifest = {
  ...envelope, region_count: 10, published_at: '2026-10-03', fee_policy_id: policy.id,
  regions_url: './test-data/regions.json', fee_populations_url: './test-data/fee-populations.json',
};
const fixtures = {
  'data/manifest.json': manifest,
  'test-data/regions.json': { ...envelope, regions },
  'test-data/fee-populations.json': { ...envelope, policy, populations },
};
const readPage = () => readFile(new URL('../docs/fees.html', import.meta.url), 'utf8');
async function boot(data = fixtures) {
  const dom = new JSDOM(await readPage(), { url: 'https://example.test/onsen/fees.html', runScripts: 'outside-only' });
  const requested = [];
  const controller = await startFeesPage({
    document: dom.window.document,
    fetchImpl: async url => {
      requested.push(String(url));
      const key = new URL(String(url)).pathname.replace(/^\/onsen\//, '');
      return data[key] === undefined ? { ok: false, status: 404 }
        : { ok: true, json: async () => structuredClone(data[key]) };
    },
  });
  return { dom, controller, requested, document: dom.window.document, window: dom.window };
}
function change(window, id, value, event = 'input') {
  const input = window.document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new window.Event(event, { bubbles: true }));
}
const cell = (document, regionId, field) => document.querySelector(`#fee-results tr[data-region="${regionId}"] [data-field="${field}"]`).textContent;

test('the page shows ten condition-matched regions without inventing regional prices or ranks', async () => {
  const { dom, document, controller, requested } = await boot();
  assert.ok(controller);
  assert.equal(requested.length, 3);
  assert.ok(requested.every(url => url.startsWith('https://example.test/onsen/')));
  assert.equal(document.querySelectorAll('#fee-results tr[data-region]').length, 10);
  assert.equal(document.querySelector('#fee-budget').value, '1000');
  assert.match(document.querySelector('#fee-status').textContent, /10温泉地・平日・予算1,000円/);
  assert.match(document.querySelector('#fee-status').textContent, /料金の地域順位は作りません/);
  assert.equal(cell(document, 'test-0', 'regionalMinimum'), '未算出');
  assert.equal(cell(document, 'test-0', 'regionalMedian'), '未算出');
  assert.equal(cell(document, 'test-0', 'observedMinimum'), '500円');
  assert.equal(cell(document, 'test-0', 'observedMedian'), '500円');
  assert.match(cell(document, 'test-0', 'budgetCount'), /1施設以上.*上限未確認/);
  assert.equal(cell(document, 'test-0', 'budgetShare'), '未算出');
  assert.match(document.querySelector('#fee-release-meta').textContent, /2026-10-03.*1.2.*fee-ui-test/);
  assert.equal(document.querySelectorAll('.rank-number,[data-rank]').length, 0);
  assert.equal(document.querySelector('#fee-controls').disabled, false);
  dom.window.close();
});

test('weekday/weekend and the numeric budget recalculate the same facility population', async () => {
  const { dom, window, document } = await boot();
  change(window, 'fee-day-type', 'weekend', 'change');
  assert.equal(cell(document, 'test-0', 'observedMinimum'), '1,500円');
  assert.match(cell(document, 'test-0', 'budgetCount'), /0施設以上/);
  assert.match(document.querySelector('#fee-table-caption').textContent, /土日祝.*1,000円/);
  change(window, 'fee-budget', '1500');
  assert.match(cell(document, 'test-0', 'budgetCount'), /1施設以上/);
  assert.match(document.querySelector('#fee-budget-heading').textContent, /1,500円以内/);
  assert.equal(cell(document, 'test-0', 'budgetShare'), '未算出');
  change(window, 'fee-day-type', 'weekday', 'change');
  assert.equal(cell(document, 'test-0', 'observedMinimum'), '500円');
  dom.window.close();
});

test('facility details retain exclusion, unknown membership, evidence and one-facility weighting', async () => {
  const { dom, document } = await boot();
  const detail = document.querySelector('#fee-region-details details[data-region="test-0"]');
  const ordinary = detail.querySelector('[data-facility="test-0-ordinary"]');
  assert.match(ordinary.textContent, /地域集計：施設1件/);
  assert.match(ordinary.textContent, /test-plan-a.*test-plan-b/);
  assert.match(ordinary.textContent, /official-test-price/);
  assert.match(detail.querySelector('[data-facility="meal-only"]').textContent, /母集団から除外.*食事必須/s);
  assert.match(detail.querySelector('[data-facility="membership-unknown"]').textContent, /所属未確認.*通常外来販売の所属未確認/s);
  assert.match(detail.querySelector('[data-facility="membership-unknown"]').textContent, /未確認（上限未確定）/);
  assert.equal(detail.querySelector('a').href, 'https://example.test/onsen/reports/test-0.html');
  const partial = document.querySelector('[data-facility="incomplete-units"]');
  assert.match(partial.textContent, /通常料金単位の一覧：未網羅/);
  assert.match(partial.textContent, /施設最安とは確定しません/);
  assert.match(partial.querySelector('dl').textContent, /0〜1,000円.*1,000円/s);
  document.querySelector('[data-open-region="test-0"]').click();
  assert.equal(detail.open, true);
  change(dom.window, 'fee-budget', '2000');
  assert.equal(document.querySelector('#fee-region-details details[data-region="test-0"]').open, true);
  dom.window.close();
});

test('empty or negative budgets stop calculations instead of silently choosing zero', async () => {
  const { dom, window, document } = await boot();
  for (const value of ['', '-1']) {
    change(window, 'fee-budget', value);
    assert.equal(document.querySelector('#fee-error').hidden, false);
    assert.match(document.querySelector('#fee-error').textContent, /空欄は0円として計算しません/);
    assert.equal(document.querySelector('#fee-budget').getAttribute('aria-invalid'), 'true');
    assert.equal(document.querySelectorAll('#fee-results tr[data-region]').length, 0);
    assert.match(document.querySelector('#fee-results').textContent, /未算出/);
  }
  change(window, 'fee-budget', '0');
  assert.equal(document.querySelector('#fee-error').hidden, true);
  assert.equal(document.querySelector('#fee-budget').hasAttribute('aria-invalid'), false);
  assert.equal(document.querySelectorAll('#fee-results tr[data-region]').length, 10);
  assert.match(document.querySelector('#fee-status').textContent, /予算0円/);
  dom.window.close();
});

test('complete populations show true interval aggregates; a confirmed empty population is not free', async () => {
  const data = structuredClone(fixtures);
  const feeData = data['test-data/fee-populations.json'];
  for (const population of feeData.populations.filter(value => value.regionId === 'test-0')) {
    population.inventory_complete = true;
    population.facilities = [
      included('known', [unit('known-admission', 500)]),
      included('unpriced', [unit('unknown-admission', null, null, { status: 'U' })]),
    ];
  }
  for (const population of feeData.populations.filter(value => value.regionId === 'test-2')) {
    population.inventory_complete = true;
    population.facilities = [];
  }
  const { dom, document } = await boot(data);
  assert.equal(cell(document, 'test-0', 'regionalMedian'), '250円以上・上限未確定');
  assert.equal(cell(document, 'test-0', 'budgetCount'), '1〜2施設');
  assert.equal(cell(document, 'test-0', 'budgetShare'), '50〜100%');
  assert.equal(cell(document, 'test-2', 'regionalMinimum'), '対象外');
  assert.equal(cell(document, 'test-2', 'regionalMedian'), '対象外');
  assert.equal(cell(document, 'test-2', 'budgetCount'), '対象外');
  assert.equal(cell(document, 'test-2', 'budgetShare'), '対象外');
  assert.doesNotMatch(document.querySelector('#fee-results tr[data-region="test-2"]').textContent, /0円/);
  dom.window.close();
});

test('release envelope, policy, coverage and contradictory fee records are checked before rendering', () => {
  const valid = () => structuredClone(fixtures);
  for (const key of ['schema_version', 'rubric_version', 'snapshot_id', 'dataset_kind']) {
    const data = valid();
    data['test-data/fee-populations.json'][key] = 'different';
    assert.throws(() => verifyFeeRelease(data['data/manifest.json'], data['test-data/regions.json'], data['test-data/fee-populations.json']), /混在/);
  }
  const edits = [
    data => { data['test-data/regions.json'].regions.pop(); },
    data => { data['test-data/fee-populations.json'].populations.pop(); },
    data => { data['test-data/fee-populations.json'].populations.push(structuredClone(data['test-data/fee-populations.json'].populations[0])); },
    data => { data['test-data/fee-populations.json'].policy.id = 'other'; },
    data => { data['test-data/fee-populations.json'].populations[0].policy_id = 'other'; },
    data => { data['test-data/fee-populations.json'].populations[0].condition_key = 'fixed-at-night'; },
    data => { data['test-data/fee-populations.json'].populations[0].regionId = 'outside'; },
    data => { data['test-data/fee-populations.json'].populations[0].facilities[0].tariffs[0].rawLower = 9999; },
  ];
  for (const edit of edits) {
    const data = valid();
    edit(data);
    assert.throws(() => verifyFeeRelease(data['data/manifest.json'], data['test-data/regions.json'], data['test-data/fee-populations.json']));
  }
});

test('missing or mismatched publication data produce one read error and no partial fee table', async () => {
  for (const edit of [
    data => { delete data['data/manifest.json'].fee_populations_url; },
    data => { delete data['test-data/fee-populations.json']; },
    data => { data['test-data/regions.json'].snapshot_id = 'older-release'; },
  ]) {
    const data = structuredClone(fixtures);
    edit(data);
    const { dom, document, controller } = await boot(data);
    assert.equal(controller, null);
    assert.equal(document.querySelector('#fee-controls').disabled, true);
    assert.equal(document.querySelector('#fee-error').hidden, false);
    assert.equal(document.querySelectorAll('#fee-results tr[data-region]').length, 0);
    assert.equal(document.querySelectorAll('#fee-region-details details').length, 0);
    dom.window.close();
  }
});

test('only local published JSON is fetched, while document labels are escaped', async () => {
  const malicious = structuredClone(fixtures);
  malicious['data/manifest.json'].regions_url = 'https://outside.example/prices.json';
  const blocked = await boot(malicious);
  assert.equal(blocked.controller, null);
  assert.ok(blocked.requested.every(url => url.startsWith('https://example.test/onsen/')));
  assert.match(blocked.document.querySelector('#fee-error').textContent, /サイト内/);
  blocked.dom.window.close();
  const data = structuredClone(fixtures);
  data['test-data/regions.json'].regions[0].name = '<img src=x onerror=alert(1)>温泉';
  const rendered = await boot(data);
  assert.ok(rendered.controller);
  assert.equal(rendered.document.querySelectorAll('#fee-results img,#fee-region-details img').length, 0);
  assert.match(rendered.document.querySelector('#fee-results').textContent, /<img src=x onerror=alert\(1\)>温泉/);
  rendered.dom.window.close();
});

test('page controls, table captions, scroll regions and source links are accessible', async () => {
  const { dom, document } = await boot();
  for (const id of ['fee-day-type', 'fee-budget']) {
    assert.ok(document.querySelector(`label[for="${id}"]`));
  }
  assert.equal(document.querySelector('#fee-status').getAttribute('role'), 'status');
  assert.equal(document.querySelector('#fee-error').getAttribute('role'), 'alert');
  assert.ok(document.querySelector('.fees-summary-table caption').textContent.includes('一般成人1名'));
  assert.ok(document.querySelector('.fees-table-wrap[tabindex="0"][role="region"]'));
  assert.ok(document.querySelectorAll('.fees-summary-table th[scope="col"]').length >= 7);
  assert.match(document.querySelector('.fees-condition').textContent, /入浴時刻は指定せず/);
  assert.ok([...document.querySelectorAll('a')].some(link => link.getAttribute('href')?.startsWith('./criteria/scoring-1.2.md#')));
  assert.equal(formatFeeInterval({ lower: 0, upper: null }), '未確認（上限未確定）');
  dom.window.close();
});
