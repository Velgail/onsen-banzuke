import { normalizeMetricKey, parameterView } from './catalog.mjs';

/** Fresh, independent settings for the ranking UI. */
export function createSettings() {
  return {
    weights: {}, selected: [], targetFits: {},
    requirements: { operator: 'and', conditions: [] },
    modality: 'daytrip', query: '', sort: 'score', groupBudgets: null,
    tab: 'confirmed', preset: null,
  };
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label}の形式が不正です。`);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label}には有限の数値を指定してください。`);
  }
  return value;
}

function canonicalKey(key, catalog, views) {
  if (typeof key !== 'string' || !key || key.trim() !== key) {
    throw new TypeError('項目のキーが不正です。');
  }
  const canonical = normalizeMetricKey(catalog, key);
  const match = /^([A-Z]\d{2})(?:\[([\s\S]*)\])?$/.exec(canonical);
  if (!match) throw new RangeError('項目のキーが不正です。');
  // A catalogue template is not a completed view: parameterView also rejects
  // omitted required parameters when the key has no bracketed parameters.
  const view = parameterView(catalog, views, match[1], match[2] ?? '');
  if (view.key !== canonical) throw new RangeError('項目のパラメータが一致しません。');
  return canonical;
}

function metricRecord(value, label, catalog, views, validateValue) {
  const normalized = {};
  for (const [key, item] of Object.entries(record(value, label))) {
    const canonical = canonicalKey(key, catalog, views);
    if (Object.hasOwn(normalized, canonical)) {
      throw new RangeError(`${label}に同じ項目の別名が重複しています。`);
    }
    normalized[canonical] = validateValue(item, canonical);
  }
  return normalized;
}

function normalizeWeights(weights, catalog, views) {
  return metricRecord(weights, '好みの重み', catalog, views, weight => {
    finite(weight, '好みの重み');
    if (weight < -1 || weight > 1) throw new RangeError('好みの重みは−1〜1で指定してください。');
    return weight;
  });
}

function normalizeSelected(selected, catalog, views) {
  if (!Array.isArray(selected)) throw new TypeError('選択項目の形式が不正です。');
  const normalized = selected.map(key => canonicalKey(key, catalog, views));
  if (new Set(normalized).size !== normalized.length) {
    throw new RangeError('選択項目に同じ項目の別名が重複しています。');
  }
  return normalized;
}

function normalizeTargets(targetFits, selected, catalog, views) {
  return metricRecord(targetFits, '目標範囲', catalog, views, (fit, key) => {
    record(fit, '目標範囲');
    if (!selected.has(key)) throw new RangeError('目標範囲と選択項目が一致しません。');
    const metric = catalog.metrics.find(item => item.id === key.split('[')[0]);
    if (metric.formula === 'B') throw new RangeError('有無の項目には目標範囲を指定できません。');
    const min = finite(fit.min, '目標範囲の下限');
    const max = finite(fit.max, '目標範囲の上限');
    const decay = finite(fit.decay, '目標範囲外の減衰幅');
    if (min > max || decay <= 0) throw new RangeError('目標範囲は下限≤上限、減衰幅>0で指定してください。');
    return { min, max, decay };
  });
}

function normalizeRequirements(requirements, catalog, views) {
  const ancestors = new Set();
  function visit(node, depth = 0) {
    record(node, '必須条件');
    if (ancestors.has(node)) throw new TypeError('必須条件が循環しています。');
    ancestors.add(node);
    try {
      if (['and', 'or', 'not'].includes(node.operator)) {
        if (Object.hasOwn(node, 'metricKey') || ['value', 'min', 'max'].some(key => Object.hasOwn(node, key))) {
          throw new TypeError('条件の組み合わせと個別の条件が混在しています。');
        }
        if (!Array.isArray(node.conditions)) throw new TypeError('条件の組み合わせには条件の配列を指定してください。');
        if (node.operator === 'not' && node.conditions.length !== 1) {
          throw new RangeError('NOTには条件を1つ指定してください。');
        }
        if (node.operator === 'or' && node.conditions.length === 0) {
          throw new RangeError('ORには条件を1つ以上指定してください。');
        }
        if (depth > 0 && node.conditions.length === 0) {
          throw new RangeError('入れ子の条件グループには条件を1つ以上指定してください。');
        }
        return { operator: node.operator, conditions: node.conditions.map(condition => visit(condition, depth + 1)) };
      }
      if (Object.hasOwn(node, 'conditions')) throw new TypeError('個別の条件に条件の配列は指定できません。');
      const metricKey = canonicalKey(node.metricKey, catalog, views);
      switch (node.operator) {
        case 'atLeast':
        case 'atMost':
          return { metricKey, operator: node.operator, value: finite(node.value, '必須条件の値') };
        case 'within': {
          const min = finite(node.min, '必須条件の下限');
          const max = finite(node.max, '必須条件の上限');
          if (min > max) throw new RangeError('必須条件の下限が上限を超えています。');
          return { metricKey, operator: node.operator, min, max };
        }
        case 'equals':
          if (!['number', 'string', 'boolean'].includes(typeof node.value)) {
            throw new TypeError('一致条件には数値・文字列・真偽値を指定してください。');
          }
          if (typeof node.value === 'number') finite(node.value, '必須条件の値');
          return { metricKey, operator: node.operator, value: node.value };
        default:
          throw new RangeError('必須条件の比較方法が不正です。');
      }
    } finally {
      ancestors.delete(node);
    }
  }
  return Array.isArray(requirements)
    ? { operator: 'and', conditions: requirements.map(condition => visit(condition, 1)) }
    : visit(requirements);
}

function normalizeGroupBudgets(groupBudgets, catalog) {
  if (groupBudgets === null) return null;
  const groups = new Set(catalog.metrics.map(metric => metric.group));
  const normalized = {};
  for (const [group, budget] of Object.entries(record(groupBudgets, '群ごとの重み'))) {
    if (!groups.has(group)) throw new RangeError('群ごとの重みに未知の群があります。');
    finite(budget, '群ごとの重み');
    if (budget < 0) throw new RangeError('群ごとの重みは0以上で指定してください。');
    normalized[group] = budget;
  }
  return normalized;
}

function migrateLegacy(config, catalog, views) {
  if (config.directions != null) {
    metricRecord(config.directions, '好みの方向', catalog, views, direction => {
      if (![1, -1].includes(direction)) throw new RangeError('好みの方向が不正です。');
      return direction;
    });
  }
  if (typeof config.outdoor !== 'boolean' || typeof config.budgetEnabled !== 'boolean') {
    throw new TypeError('必須条件の形式が不正です。');
  }
  finite(config.budget, '予算');
  if (config.budget < 0) throw new RangeError('予算は0以上で指定してください。');
  const conditions = [];
  if (config.outdoor) conditions.push({ metricKey: 'B06', operator: 'equals', value: 1 });
  if (config.budgetEnabled) conditions.push({ metricKey: 'Y01', operator: 'atMost', value: config.budget });
  return {
    ...config, version: 2, targetFits: {},
    requirements: { operator: 'and', conditions },
    modality: 'daytrip', groupBudgets: null,
  };
}

/** Validate a versioned shared configuration without mutating it or the catalogue. */
export function validateConfig(config, manifest, catalog, views) {
  record(config, '共有設定');
  if (![1, 2].includes(config.version) || config.snapshot !== manifest.snapshot_id
      || config.rubric !== manifest.rubric_version) {
    throw new RangeError('この共有リンクのデータ版・設定形式は読み込めません。指定版を自動で置き換えることはありません。');
  }
  const source = config.version === 1 ? migrateLegacy(config, catalog, views) : config;
  const normalized = createSettings();
  normalized.weights = normalizeWeights(source.weights, catalog, views);
  normalized.selected = normalizeSelected(source.selected, catalog, views);
  const selected = new Set(normalized.selected);
  if (Object.keys(normalized.weights).some(key => !selected.has(key))) {
    throw new RangeError('好みの重みと選択項目が一致しません。');
  }
  normalized.targetFits = normalizeTargets(source.targetFits === undefined ? {} : source.targetFits, selected, catalog, views);
  normalized.requirements = normalizeRequirements(source.requirements === undefined ? normalized.requirements : source.requirements, catalog, views);
  normalized.modality = source.modality === undefined ? normalized.modality : source.modality;
  if (!['all', 'daytrip', 'stay'].includes(normalized.modality)) throw new RangeError('利用モードが不正です。');
  normalized.query = source.query === undefined ? normalized.query : source.query;
  normalized.sort = source.sort === undefined ? normalized.sort : source.sort;
  if (typeof normalized.query !== 'string' || normalized.query.length > 100
      || !['score', 'name', 'coverage'].includes(normalized.sort)) {
    throw new RangeError('表示条件の値が不正です。');
  }
  normalized.groupBudgets = normalizeGroupBudgets(source.groupBudgets ?? null, catalog);
  return normalized;
}
