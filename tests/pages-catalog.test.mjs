import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCatalogViews, parameterView, normalizeMetricKey } from '../docs/assets/catalog.mjs';

const catalog = JSON.parse(await readFile(new URL('../onsen_banzuke_metric_catalog_v1.json', import.meta.url), 'utf8'));
const observed = [{ id: 'p', metrics: { 'S06[odor=sulfur]': { status: 'K', lower: 75, upper: 75 } } }];
const published = [{ key: 'S06[odor=sulfur]', name: '硫黄の香り', positive: '強い', negative: '弱い', unit: '強度' }];

test('all declared basic items stay selectable independently of investigated observations', () => {
  const views = buildCatalogViews(catalog, published, observed);
  assert.equal(catalog.basic_metric_count, catalog.metrics.length);
  for (const metric of catalog.metrics) assert.ok(views.some(view => view.key === metric.id), metric.id);
  assert.equal(views.length, catalog.basic_metric_count + 1);
  assert.equal(views.find(view => view.key === 'S06').template, true);
  assert.equal(views.find(view => view.key === 'C11').template, false);
  assert.equal(views.find(view => view.key === 'S06[odor=sulfur]').name, '硫黄の香り');
  const uninvestigated = parameterView(catalog, views, 'C44', 'tag=iodide');
  assert.equal(uninvestigated.key, 'C44[tag=iodide]');
  assert.equal(uninvestigated.template, false);
  assert.equal(uninvestigated.formula, 'B');
  assert.ok(!observed.some(plan => Object.hasOwn(plan.metrics, uninvestigated.key)));
});

test('registered parameters and dictionaries preserve each independent preference', () => {
  const views = buildCatalogViews(catalog);
  assert.equal(parameterView(catalog, views, 'B09', 'type=natural_mud, dimension=medium').key,
    'B09[dimension=medium,type=natural_mud]');
  assert.equal(parameterView(catalog, views, 'V10', 'dimension=privacy').formula, 'N(3)');
  assert.equal(parameterView(catalog, views, 'V10', 'dimension=medium').formula, 'N(4)');
  assert.equal(parameterView(catalog, views, 'Z24', 'task=reservation, language=en, channel=human').key,
    'Z24[channel=human,language=en,task=reservation]');
  assert.equal(parameterView(catalog, views, 'C01').unit, '');
  assert.equal(parameterView(catalog, views, 'C11').unit, 'mg/kg');
  assert.equal(parameterView(catalog, views, 'B01').unit, '℃');
  assert.equal(parameterView(catalog, views, 'Y01').unit, '円');
  assert.equal(parameterView(catalog, views, 'P17').unit, '割合（0〜1）');
  assert.equal(parameterView(catalog, views, 'P01').unit, '割合（0〜1）');
  assert.equal(buildCatalogViews(catalog, [{ key: 'P17', unit: '%' }])
    .find(view => view.key === 'P17').unit, '%');
});

test('odor suggestions do not restrict registered observations unless the catalogue defines an explicit enum', () => {
  const oilPlans = [{ metrics: { 'S05[odor=oil]': {}, 'S06[odor=oil]': {} } }];
  const views = buildCatalogViews(catalog, [{ key: 'S05[odor=oil]' }], oilPlans);
  assert.ok(views.some(view => view.key === 'S05[odor=oil]'));
  assert.ok(views.some(view => view.key === 'S06[odor=oil]'));
  assert.equal(parameterView(catalog, views, 'S06', 'odor=新しく確認した臭い').key,
    'S06[odor=新しく確認した臭い]');
  assert.equal(views.find(view => view.key === 'S06').parameters.odor.type, 'text');
  assert.ok(views.find(view => view.key === 'S06').parameters.odor.values.includes('sulfur'));
  const restricted = structuredClone(catalog);
  restricted.metric_parameters.S06 = { odor: ['sulfur', 'petroleum'] };
  const restrictedViews = buildCatalogViews(restricted);
  assert.throws(() => parameterView(restricted, restrictedViews, 'S06', 'odor=oil'), /未登録/);
  assert.equal(parameterView(restricted, restrictedViews, 'S06', 'odor=petroleum').key,
    'S06[odor=petroleum]');
  assert.throws(() => parameterView(catalog, views, 'S06', 'unknown_odor=oil'), /定義/);
});

test('missing or invalid parameter choices fail rather than inventing defaults', () => {
  const views = buildCatalogViews(catalog);
  for (const [id, parameters] of [
    ['C44', ''], ['C44', 'tag=not_registered'], ['C44', 'tag=sulfur,tag=chloride'],
    ['B09', 'dimension=medium,type=lying'], ['B09', 'dimension=unknown,type=water'],
    ['B09', 'dimension=medium'], ['V10', 'dimension=unknown'], ['C11', 'arbitrary=value'],
    ['Z24', 'language=en,task=reservation'], ['Z11', 'age=-1'], ['Z11', 'age=Infinity'],
    ['C11', 'toString=value'], ['C11', 'constructor=value'], ['C11', '__proto__=value'],
    ['X01', 'mode=car,date=2026-02-30'], ['S06', 'odor=sulfur,'],
  ]) assert.throws(() => parameterView(catalog, views, id, parameters), `${id}: ${parameters}`);
  assert.throws(() => parameterView(catalog, views, 'S06[odor=sulfur]', 'odor=petroleum'));
});

test('normalization resolves equivalent aliases while rejecting conflicting or changed scales', () => {
  assert.equal(normalizeMetricKey(catalog, 'C37'), 'C44[tag=sulfur]');
  assert.equal(normalizeMetricKey(catalog, 'P09'), 'P21[method=chlorine]');
  assert.equal(normalizeMetricKey(catalog, 'X10'), 'X01[mode=car]');
  assert.equal(normalizeMetricKey(catalog, 'P18'), 'I21');
  assert.equal(normalizeMetricKey(catalog, 'B09[type=outdoor,dimension=setting]'), 'B06');
  assert.equal(normalizeMetricKey(catalog, 'Z02[type=natural_steam]'), 'B09[dimension=medium,type=natural_steam]');
  assert.equal(normalizeMetricKey(catalog, 'C44'), 'C44');
  assert.throws(() => normalizeMetricKey(catalog, 'C37[tag=chloride]'), /衝突/);
  for (const id of ['C03', 'C07', 'B02', 'M06', 'Z17']) {
    assert.throws(() => normalizeMetricKey(catalog, id), /尺度|評価系列/);
  }
  for (const key of ['Unknown', ' C11', 'C11[]', 'C44[tag=sulfur,tag=chloride]', 'Q99', 'C44[tag=sulfur,foo=bar]']) {
    assert.throws(() => normalizeMetricKey(catalog, key));
  }
});

test('duplicate canonical views and duplicate aliases inside one plan are configuration errors', () => {
  assert.throws(() => buildCatalogViews(catalog, [{ key: 'C37' }, { key: 'C44[tag=sulfur]' }]), /重複/);
  assert.throws(() => buildCatalogViews(catalog, [], [{ metrics: { C37: {}, 'C44[tag=sulfur]': {} } }]), /重複/);
  assert.throws(() => buildCatalogViews({ ...catalog, metrics: [...catalog.metrics, catalog.metrics[0]] }), /重複/);
  assert.throws(() => buildCatalogViews({ ...catalog, basic_metric_count: 1 }), /項目数/);
});

test('published bare axes with missing required parameters remain entry templates, not usable scoring axes', () => {
  const views = buildCatalogViews(catalog, [{ key: 'Z18', name: '禁煙条件' }], [{ metrics: { Z18: {} } }]);
  assert.equal(views.find(view => view.key === 'Z18').template, true);
  assert.equal(views.find(view => view.key === 'Z18').name, '禁煙条件');
  assert.throws(() => parameterView(catalog, views, 'Z18'), /place/);
  assert.equal(parameterView(catalog, views, 'Z18', 'place=guestroom').key, 'Z18[place=guestroom]');
  assert.throws(() => buildCatalogViews(catalog, [{ key: 'Q99' }]));
  assert.throws(() => buildCatalogViews(catalog, [{ key: 'C44[tag=unregistered]' }]));
});

test('view construction is pure and includes parameterized observations absent from published choices', () => {
  const initial = JSON.stringify({ catalog, published, observed });
  const extraPlans = [...observed, { metrics: { 'E07[field=flow]': {} } }];
  const views = buildCatalogViews(catalog, published, extraPlans);
  assert.ok(views.some(view => view.key === 'E07[field=flow]' && !view.template));
  assert.equal(JSON.stringify({ catalog, published, observed }), initial);
  const custom = structuredClone(catalog);
  custom.metric_parameters.C11 = { location: { type: 'enum', values: ['source', 'bath'], required: true } };
  const customViews = buildCatalogViews(custom);
  assert.equal(customViews.find(view => view.key === 'C11').template, true);
  assert.equal(parameterView(custom, customViews, 'C11', 'location=bath').key, 'C11[location=bath]');
  assert.throws(() => parameterView(custom, customViews, 'C11', 'location=unknown'));
});
