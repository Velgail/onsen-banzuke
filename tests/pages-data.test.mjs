import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluatePlan, rankRegions } from '../docs/assets/scoring.mjs';

const docsRoot = new URL('../docs/', import.meta.url);
const json = async (url) => JSON.parse(await readFile(url, 'utf8'));
const manifest = await json(new URL('data/manifest.json', docsRoot));
const envelopeKeys = ['schema_version', 'rubric_version', 'snapshot_id', 'dataset_kind'];
const artifactNames = ['regions', 'ranking', 'views', 'rubric'];
const artifacts = Object.fromEntries(await Promise.all(artifactNames.map(async (name) => {
  const path = manifest[`${name}_url`];
  assert.equal(typeof path, 'string', `${name}_url must identify a published file`);
  const url = new URL(path, docsRoot);
  assert.ok(url.href.startsWith(docsRoot.href), `${name}_url must remain inside docs`);
  assert.ok(path.startsWith(`./data/releases/${manifest.snapshot_id}/`),
    `${name}_url must remain inside the selected snapshot`);
  return [name, await json(url)];
})));
const sourceCatalog = await json(new URL('../onsen_banzuke_metric_catalog_v1.json', import.meta.url));
const metricMap = new Map(sourceCatalog.metrics.map((metric) => [metric.id, metric]));
const regions = artifacts.regions.regions;
const plans = artifacts.ranking.plans;
const views = artifacts.views.views;

function unique(values, description) {
  for (const value of values) assert.ok(typeof value === 'string' && value.trim() === value && value,
    `${description} must contain nonempty identifiers`);
  assert.equal(new Set(values).size, values.length, `${description} must be unique`);
}

function canonicalView(key) {
  const match = /^([A-Z]\d{2})(?:\[([^\[\]\s]+)\])?$/.exec(key);
  assert.ok(match, `invalid canonical view: ${key}`);
  const [, id, parameters] = match;
  assert.ok(metricMap.has(id), `${key} must resolve to an active catalog metric`);
  assert.ok(!sourceCatalog.retired_metric_ids.includes(id), `${key} must not retain a retired ID`);
  if (!parameters) return id;
  const entries = parameters.split(',').map((entry) => {
    const parameter = /^([A-Za-z][A-Za-z0-9_]*)=([^=,]+)$/.exec(entry);
    assert.ok(parameter, `invalid parameter in ${key}`);
    return [parameter[1], parameter[2]];
  });
  unique(entries.map(([name]) => name), `parameters of ${key}`);
  const normalized = `${id}[${entries.sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, value]) => `${name}=${value}`).join(',')}]`;
  assert.equal(key, normalized, `${key} must use a canonical parameter order`);
  return id;
}

test('release datasets carry one envelope and the independent rubric uses its catalog version', () => {
  for (const key of envelopeKeys) assert.ok(typeof manifest[key] === 'string' && manifest[key],
    `manifest.${key} must be a nonempty string`);
  assert.equal(manifest.schema_version, '1');
  assert.equal(manifest.rubric_version, sourceCatalog.version);
  for (const name of ['regions', 'ranking', 'views']) {
    const artifact = artifacts[name];
    for (const key of envelopeKeys) assert.equal(artifact[key], manifest[key], `${name}.${key}`);
  }
  assert.equal(artifacts.rubric.version, manifest.rubric_version, 'rubric catalog version');
});

test('published scoring criteria and catalog preserve their authoritative sources', async () => {
  assert.deepEqual(artifacts.rubric, sourceCatalog,
    'the independent rubric must preserve the authoritative catalog without a release wrapper');
  const [publishedCriteria, sourceCriteria] = await Promise.all([
    readFile(new URL(`criteria/scoring-${manifest.rubric_version}.md`, docsRoot), 'utf8'),
    readFile(new URL('../onsen_banzuke_master_prompt_v1.md', import.meta.url), 'utf8'),
  ]);
  assert.equal(publishedCriteria, sourceCriteria, 'published criteria must match the current source');
});

test('release counts and entity references describe the complete published candidate set', () => {
  assert.ok(Array.isArray(regions) && Array.isArray(plans) && Array.isArray(views));
  assert.ok(Number.isInteger(manifest.region_count) && manifest.region_count > 0);
  assert.ok(Number.isInteger(manifest.plan_count) && manifest.plan_count > 0);
  assert.equal(regions.length, manifest.region_count);
  assert.equal(plans.length, manifest.plan_count);
  unique(regions.map((region) => region.id), 'region IDs');
  unique(plans.map((plan) => plan.id), 'plan IDs');
  const regionIds = new Set(regions.map((region) => region.id));
  for (const plan of plans) assert.ok(regionIds.has(plan.regionId), `${plan.id}: dangling regionId`);
  for (const region of regions) assert.ok(plans.some((plan) => plan.regionId === region.id),
    `${region.id}: index entry has no published plan`);
});

test('representative views are unique canonical catalog views and every plan uses that same set', () => {
  unique(views.map((view) => view.key), 'representative metric keys');
  views.forEach((view) => canonicalView(view.key));
  const expectedKeys = views.map((view) => view.key).sort();
  for (const plan of plans) {
    assert.deepEqual(Object.keys(plan.metrics).sort(), expectedKeys,
      `${plan.id}: missing or unadvertised representative metric`);
    Object.keys(plan.metrics).forEach(canonicalView);
  }
});

test('synthetic data flags survive every exported dataset and candidate', () => {
  assert.equal(manifest.dataset_kind, 'synthetic_demo');
  assert.ok(manifest.snapshot_id.startsWith('demo-'));
  for (const name of ['regions', 'ranking', 'views']) {
    const artifact = artifacts[name];
    assert.equal(artifact.dataset_kind, 'synthetic_demo', `${name}: missing demo marker`);
  }
  for (const region of regions) assert.ok(region.id.startsWith('demo-'), `${region.id}: demo namespace`);
  for (const plan of plans) {
    assert.ok(plan.condition_label.includes('架空'), `${plan.id}: conditions must identify synthetic data`);
    assert.ok(plan.evidence_note.includes('架空'), `${plan.id}: provenance must identify synthetic data`);
  }
});

const clip = (value) => Math.max(0, Math.min(1, value));
function expectedScore(metric, raw, unit) {
  const linear = /^([UD])\(([-\d.]+),([-\d.]+)\)$/.exec(metric.formula);
  if (linear) {
    const [, direction, first, second] = linear;
    const a = Number(first), b = Number(second);
    return 100 * clip(direction === 'U' ? (raw - a) / (b - a) : (b - raw) / (b - a));
  }
  if (metric.formula === 'B') {
    assert.ok([0, 1].includes(raw), `${metric.id}: binary raw must be 0 or 1`);
    return raw * 100;
  }
  if (['INT', '100−INT'].includes(metric.formula)) {
    assert.ok([0, 25, 50, 75, 100].includes(raw), `${metric.id}: raw intensity must use the fixed dictionary`);
    return metric.formula === 'INT' ? raw : 100 - raw;
  }
  if (metric.formula === 'INTERSECTION') {
    assert.equal(unit, '%', 'the demo intersection uses explicitly labeled percentage values');
    assert.ok(raw >= 0 && raw <= 100);
    return 100 * (raw / 100);
  }
  assert.fail(`add a data-integrity conversion for representative formula ${metric.formula}`);
}

test('normalized representative scores agree with raw bounds, units, and the catalog scales', () => {
  for (const plan of plans) {
    for (const [key, row] of Object.entries(plan.metrics)) {
      assert.doesNotThrow(() => evaluatePlan({ ...plan, metrics: { [key]: row } }), `${plan.id}: ${key}`);
      if (['U', 'E', 'F'].includes(row.status)) {
        assert.deepEqual([row.lower, row.upper], [0, 100], `${plan.id}: unknown score envelope`);
        assert.equal(row.rawLower, null, `${plan.id}: unknown raw lower must not be zero`);
        assert.equal(row.rawUpper, null, `${plan.id}: unknown raw upper must not be zero`);
        assert.ok(row.raw == null, `${plan.id}: unknown raw value must not be zero`);
        continue;
      }
      if (row.status === 'A') {
        assert.equal(row.rawLower, null);
        assert.equal(row.rawUpper, null);
        continue;
      }
      assert.ok(Number.isFinite(row.rawLower) && Number.isFinite(row.rawUpper), `${plan.id}: raw bounds`);
      const metric = metricMap.get(canonicalView(key));
      const scores = [row.rawLower, row.rawUpper].map((raw) => expectedScore(metric, raw, row.unit));
      const expected = [Math.min(...scores), Math.max(...scores)];
      assert.ok(Math.abs(row.lower - expected[0]) < 1e-10, `${plan.id}: ${key} lower score disagrees with raw data`);
      assert.ok(Math.abs(row.upper - expected[1]) < 1e-10, `${plan.id}: ${key} upper score disagrees with raw data`);
    }
  }
});

test('the whole published release is accepted by the browser ranking core', () => {
  const weights = Object.fromEntries(views.map((view) => [view.key, 1]));
  const result = rankRegions(regions, plans, { weights, modality: 'daytrip' });
  assert.equal(result.confirmed.length, regions.length);
  assert.equal(result.unknown.length, 0);
  assert.equal(result.failed.length, 0);
});
