/** Catalogue-backed selection. A missing observation never removes an available axis. */
const enumParameter = (values, required = true) => ({ required, type: 'enum', values: [...values] });
const textParameter = (required = true) => ({ required, type: 'text' });
const numberParameter = (required = true, min = undefined, integer = false) => ({ required, type: 'number', min, integer });

function catalogIndex(catalog) {
  if (!catalog || !Array.isArray(catalog.metrics)) throw new TypeError('採点カタログの形式が不正です。');
  const index = new Map();
  for (const metric of catalog.metrics) {
    if (!metric || !/^[A-Z]\d{2}$/.test(metric.id) || typeof metric.name !== 'string'
        || typeof metric.formula !== 'string' || index.has(metric.id)) {
      throw new TypeError('カタログの項目ID・名称・尺度が不正または重複しています。');
    }
    index.set(metric.id, metric);
  }
  if (catalog.basic_metric_count !== undefined && catalog.basic_metric_count !== index.size) {
    throw new RangeError('カタログの宣言項目数と実数が一致しません。');
  }
  return index;
}

function parseParameters(text) {
  if (typeof text !== 'string') throw new TypeError('パラメータは「名前=値」で指定してください。');
  if (!text.trim()) return {};
  const entries = text.split(',').map(part => {
    const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^,=\[\]\u0000-\u001f\u007f]+?)\s*$/.exec(part);
    if (!match) throw new TypeError('パラメータは「名前=値,名前=値」で指定してください。');
    const value = match[2].trim();
    if (!value || value.length > 200) throw new RangeError('パラメータの値が空または長すぎます。');
    return [match[1], value];
  });
  if (new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new RangeError('同じパラメータを二度指定できません。');
  }
  return Object.fromEntries(entries);
}

function parseKey(key) {
  if (typeof key !== 'string' || key.trim() !== key || key.length > 3000) {
    throw new TypeError('評価項目キーが不正です。');
  }
  const match = /^([A-Z]\d{2})(?:\[([^\[\]]+)\])?$/.exec(key);
  if (!match) throw new TypeError('評価項目キーは項目IDとパラメータで指定してください。');
  return { id: match[1], values: parseParameters(match[2] ?? ''), parameterized: match[2] !== undefined };
}

const serializedKey = (id, values) => {
  const entries = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return entries.length ? `${id}[${entries.map(([name, value]) => `${name}=${value}`).join(',')}]` : id;
};

/** Definitions come from the catalogue's named parameters, aliases, and dimension dictionary. */
function parameterDefinitions(catalog, metric) {
  const definitions = {};
  const aliasValues = (name) => [...new Set(Object.values(catalog.parameter_aliases ?? {})
    .filter(alias => alias.metric_id === metric.id && alias.parameters?.[name] != null)
    .map(alias => String(alias.parameters[name])))];
  const define = (name, definition) => { definitions[name] = definition; };
  const optional = (name) => define(name, textParameter(false));
  const enumFromAliases = (name) => define(name, enumParameter(aliasValues(name)));
  const id = metric.id;
  if (id === 'C44') enumFromAliases('tag');
  if (id === 'C45') enumFromAliases('class');
  if (id === 'P21') enumFromAliases('method');
  if (id === 'E07') enumFromAliases('field');
  if (['S05', 'S06'].includes(id)) define('odor', { ...textParameter(),
    values: ['sulfur', 'petroleum', 'oil', 'metal', 'earth', 'organic', 'chlorine', 'other'] });
  if (id === 'S01') define('color', enumParameter(['colorless', 'white', 'blue', 'green', 'yellow', 'red_brown', 'brown', 'black', 'gray']));
  if (id === 'S10') define('place', enumParameter(['surface', 'skin']));
  if (id === 'S18') define('taste', textParameter());
  if (id === 'P19') define('method', textParameter());
  if (id === 'P22') define('process', textParameter());
  if (['P13', 'P14'].includes(id)) optional('type');
  if (id === 'F05') define('analyte', textParameter());
  if (id === 'B03') define('band', textParameter());
  if (id === 'B09') {
    define('dimension', enumParameter(Object.keys(catalog.dimension_dictionary ?? {})));
    define('type', { required: true, type: 'enum', valuesBy: 'dimension',
      valuesByParameter: structuredClone(catalog.dimension_dictionary ?? {}) });
  }
  if (id === 'V10') define('dimension', enumParameter(catalog.metric_parameters?.V10?.dimension ?? Object.keys(catalog.dimension_dictionary ?? {})));
  if (id === 'B10') define('type', enumParameter(['foot', 'hand']));
  if (id === 'B16') define('material', textParameter());
  if (id === 'R01') define('tag_set', textParameter());
  if (id === 'R02') define('profile_id', textParameter());
  if (id === 'R03') define('feature_id', textParameter());
  if (['R01', 'R02', 'R03'].includes(id)) optional('comparison_id');
  if (['H15', 'H16'].includes(id)) define('type', textParameter());
  if (id === 'H18') { define('place', textParameter()); optional('time'); }
  if (metric.scope?.includes('活動タグ')) { define('tag', textParameter()); optional('project_id'); optional('event_type'); }
  if (id.startsWith('M')) define('project_id', textParameter());
  if (id === 'X01') define('mode', textParameter());
  if (id.startsWith('X')) { optional('origin'); optional('date'); optional('route'); optional('destination'); }
  if (['Z01', 'Z12', 'Z20'].includes(id)) define('equipment', textParameter());
  if (['Z02', 'Z16', 'Z23'].includes(id)) define('type', textParameter());
  if (id === 'Z09') define('method', textParameter());
  if (id === 'Z11') define('age', numberParameter(true, 0));
  if (id === 'Z13') define('condition', textParameter());
  if (id === 'Z18') define('place', textParameter());
  if (id === 'Z21') define('task', textParameter());
  if (id === 'Z22') define('direction', enumParameter(['down', 'up', 'download', 'upload']));
  if (id === 'Z24') { define('language', textParameter()); define('task', textParameter()); define('channel', textParameter()); }
  if (id === 'Y21') define('cancel_at', textParameter());
  if (id === 'Y22') define('stage', textParameter());
  if (['V13', 'V14'].includes(id)) { define('bath_preference_id', textParameter()); define('t', numberParameter(false, 0)); }

  // Explicit machine-readable definitions extend/override the known catalogue vocabulary.
  for (const [name, specification] of Object.entries(catalog.metric_parameters?.[id] ?? {})) {
    if (name.startsWith('k_by_')) continue;
    if (Array.isArray(specification)) define(name, enumParameter(specification));
    else if (specification && typeof specification === 'object' && specification.type) {
      define(name, { required: true, ...structuredClone(specification) });
    }
  }
  return definitions;
}

function validateParameters(catalog, metric, values, requireComplete) {
  const definitions = parameterDefinitions(catalog, metric);
  const normalized = {};
  for (const [name, value] of Object.entries(values)) {
    const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
    if (!definition) throw new RangeError(`${metric.id} にパラメータ「${name}」は定義されていません。`);
    const allowed = definition.valuesBy
      ? definition.valuesByParameter?.[values[definition.valuesBy]] : definition.values;
    if (definition.type === 'enum' && (!Array.isArray(allowed) || !allowed.map(String).includes(value))) {
      throw new RangeError(`${metric.id} の ${name} に未登録の値「${value}」が指定されています。`);
    }
    if (definition.type === 'number') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || (definition.integer && !Number.isInteger(numeric))
          || (definition.min !== undefined && numeric < definition.min)
          || (definition.max !== undefined && numeric > definition.max)) {
        throw new RangeError(`${metric.id} の ${name} は有効な数値で指定してください。`);
      }
      normalized[name] = String(numeric);
    } else normalized[name] = value;
    if (name === 'date' && !validDate(value)) throw new RangeError('date は実在する YYYY-MM-DD の日付で指定してください。');
  }
  if (requireComplete) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (definition.required && !Object.hasOwn(normalized, name)) {
        throw new RangeError(`${metric.id} の ${name} を指定してください。`);
      }
    }
  }
  return normalized;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function resolveKey(catalog, index, key, requireComplete) {
  let { id, values, parameterized } = parseKey(key);
  const alias = catalog.parameter_aliases?.[id];
  if (alias) {
    if (alias.series || alias.formula) throw new RangeError(`${id} は尺度または評価系列が異なる別名です。${alias.metric_id} と元の指定帯・尺度を明示してください。`);
    for (const [name, value] of Object.entries(alias.parameters ?? {})) {
      if (value == null) throw new RangeError(`${id} の ${name} を明示してください。`);
      if (Object.hasOwn(values, name) && values[name] !== String(value)) {
        throw new RangeError(`${id} の別名定義と ${name} が衝突しています。`);
      }
      values[name] = String(value);
    }
    id = alias.metric_id;
    parameterized = Object.keys(values).length > 0;
  }
  const redirect = catalog.parameter_redirects?.[serializedKey(id, values)];
  if (redirect) {
    id = redirect.metric_id;
    values = Object.fromEntries(Object.entries(redirect.parameters ?? {}).map(([name, value]) => [name, String(value)]));
    parameterized = Object.keys(values).length > 0;
  }
  const metric = index.get(id);
  if (!metric) throw new RangeError(`未登録の評価項目「${id}」です。`);
  values = validateParameters(catalog, metric, values, requireComplete || parameterized);
  return { metric, values, key: serializedKey(id, values) };
}

/** Return a stable canonical key. Bare IDs may denote parameter-entry templates. */
export function normalizeMetricKey(catalog, key) {
  return resolveKey(catalog, catalogIndex(catalog), key, false).key;
}

function inferUnit(metric) {
  if (['B', 'RARITY'].includes(metric.formula)) return '';
  if (['R', 'INTERSECTION'].includes(metric.formula)) return '割合（0〜1）';
  if (['INT', '100−INT'].includes(metric.formula)) return '強度';
  const unit = /mg\/kg|Bq\/kg|µS\/cm|mg\/L|L\/分|Mbps|m²|mV|ms|cm|km|℃|円|％|\bm\b/.exec(metric.raw ?? '');
  if (unit) return unit[0];
  if (/分|所要/.test(metric.raw ?? '')) return '分';
  if (/時間/.test(metric.raw ?? '')) return '時間';
  if (/日数/.test(metric.raw ?? '')) return '日';
  if (/年数/.test(metric.raw ?? '')) return '年';
  if (/人数/.test(metric.raw ?? '')) return '人';
  if (/件数|回数|企画数|施設数/.test(metric.raw ?? '')) return '件';
  return '';
}

function metadata(catalog, metric, values, key, published = {}) {
  const parameters = parameterDefinitions(catalog, metric);
  const template = Object.entries(parameters).some(([name, definition]) => definition.required && !Object.hasOwn(values, name));
  const suffix = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ');
  const k = catalog.metric_parameters?.[metric.id]?.k_by_dimension?.[values.dimension];
  return { ...published, key,
    name: published.name ?? `${metric.name}${suffix ? `（${suffix}）` : ''}`,
    positive: published.positive ?? 'この特徴を好む',
    negative: published.negative ?? '反対の特徴を好む',
    description: published.description ?? [metric.raw, metric.note].filter(Boolean).join('。'),
    group: metric.id[0], unit: published.unit ?? inferUnit(metric),
    formula: k === undefined ? metric.formula : `N(${k})`, parameters, template,
    metricId: metric.id, parameterValues: { ...values }, raw: metric.raw, scope: metric.scope };
}

/** Select any registered parameter combination, even when no plan has investigated it. */
export function parameterView(catalog, views, metricId, parameterText = '') {
  if (!Array.isArray(views)) throw new TypeError('評価ビューは配列で指定してください。');
  const index = catalogIndex(catalog);
  if (typeof metricId !== 'string') throw new TypeError('項目IDを指定してください。');
  if (metricId.includes('[') && parameterText.trim()) throw new RangeError('完全キーとパラメータの二重指定はできません。');
  const key = parameterText.trim() ? `${metricId}[${parameterText}]` : metricId;
  const resolved = resolveKey(catalog, index, key, true);
  const published = views.find(view => view.key === resolved.key && !view.template);
  return metadata(catalog, resolved.metric, resolved.values, resolved.key, published);
}

/** All basic templates plus published and observed complete parameter combinations. */
export function buildCatalogViews(catalog, publishedViews = [], plans = []) {
  const index = catalogIndex(catalog);
  if (!Array.isArray(publishedViews) || !Array.isArray(plans)) throw new TypeError('評価ビューとプランは配列で指定してください。');
  const result = new Map([...index.values()].map(metric => [metric.id, metadata(catalog, metric, {}, metric.id)]));
  const publishedKeys = new Set();
  for (const view of publishedViews) {
    if (!view || typeof view.key !== 'string') throw new TypeError('公開ビューのキーが不正です。');
    const resolved = resolveKey(catalog, index, view.key, false);
    if (publishedKeys.has(resolved.key)) throw new RangeError(`公開ビューが同じ正規項目「${resolved.key}」へ重複しています。`);
    publishedKeys.add(resolved.key);
    result.set(resolved.key, metadata(catalog, resolved.metric, resolved.values, resolved.key, view));
  }
  for (const plan of plans) {
    if (!plan || !plan.metrics || typeof plan.metrics !== 'object' || Array.isArray(plan.metrics)) throw new TypeError('プランの評価項目が不正です。');
    const planKeys = new Set();
    for (const key of Object.keys(plan.metrics)) {
      const resolved = resolveKey(catalog, index, key, false);
      if (planKeys.has(resolved.key)) throw new RangeError(`プラン内で同じ正規項目「${resolved.key}」が重複しています。`);
      planKeys.add(resolved.key);
      if (!result.has(resolved.key)) result.set(resolved.key, metadata(catalog, resolved.metric, resolved.values, resolved.key));
    }
  }
  return [...result.values()];
}
