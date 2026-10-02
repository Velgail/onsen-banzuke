/**
 * Specification 1.2 scoring for already-normalized, condition-matched plans.
 * Target-band preferences are recalculated from raw facts, before weighting.
 * This module does not parse the metric catalogue, resolve aliases, or search
 * for plans. Missing weighted metrics remain in the denominator as E.
 */
const STATES = new Set(['K', 'C', 'Z', 'X', 'U', 'E', 'F', 'A']);
const UNKNOWN_STATES = new Set(['U', 'E', 'F']);
const EVIDENCE_STATES = new Set(['K', 'C', 'Z']);
const UNKNOWN_ROW = Object.freeze({ status: 'E', lower: 0, upper: 100 });

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new TypeError(`${label} must be a nonempty identifier without surrounding whitespace`);
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function weightValue(weight) {
  finite(weight, 'weight');
  if (weight < -1 || weight > 1) throw new RangeError('weight must be in [-1, 1]');
  return weight;
}

function validateRow(row) {
  record(row, 'metric row');
  if (!STATES.has(row.status)) throw new RangeError('unknown metric status');
  finite(row.lower, 'score lower');
  finite(row.upper, 'score upper');
  if (row.lower < 0 || row.upper > 100 || row.lower > row.upper) {
    throw new RangeError('score interval must satisfy 0 <= lower <= upper <= 100');
  }
  for (const field of ['rawLower', 'rawUpper']) {
    if (row[field] !== undefined && row[field] !== null) finite(row[field], field);
  }
  const low = row.rawLower ?? undefined;
  const high = row.rawUpper ?? undefined;
  if (low !== undefined && high !== undefined && low > high) {
    throw new RangeError('raw interval is reversed');
  }
  if (row.raw !== undefined && row.raw !== null) {
    if (!['number', 'string', 'boolean'].includes(typeof row.raw)) {
      throw new TypeError('raw must be a finite number, string, boolean, or null');
    }
    if (typeof row.raw === 'number') {
      finite(row.raw, 'raw');
      if ((low !== undefined && row.raw < low) || (high !== undefined && row.raw > high)) {
        throw new RangeError('raw lies outside its raw interval');
      }
    } else if (low !== undefined || high !== undefined) {
      throw new TypeError('categorical raw cannot have numerical raw bounds');
    }
  }
  return row;
}

/** Return the contribution interval, before multiplying by |weight|. */
export function scoreInterval(row, weight) {
  validateRow(row);
  weightValue(weight);
  if (weight === 0 || row.status === 'A') return { lower: 0, upper: 0 };
  if (UNKNOWN_STATES.has(row.status)) return { lower: 0, upper: 100 };
  return weight > 0
    ? { lower: row.lower, upper: row.upper }
    : { lower: 100 - row.upper, upper: 100 - row.lower };
}

function validateTargetFit(targetFit) {
  record(targetFit, 'target fit');
  finite(targetFit.min, 'target fit min');
  finite(targetFit.max, 'target fit max');
  finite(targetFit.decay, 'target fit decay');
  if (targetFit.min > targetFit.max) throw new RangeError('target fit range is reversed');
  if (targetFit.decay <= 0) throw new RangeError('target fit decay must be positive');
  return targetFit;
}

/** T(a,b,d) over the entire raw interval, including its interior plateau. */
export function targetFitInterval(row, targetFit) {
  validateRow(row);
  validateTargetFit(targetFit);
  if (row.status === 'A') return { lower: 0, upper: 0 };
  if (UNKNOWN_STATES.has(row.status)) return { lower: 0, upper: 100 };
  const hasBounds = row.rawLower != null || row.rawUpper != null;
  if ((row.status === 'X' && !hasBounds)
      || (row.raw != null && typeof row.raw !== 'number')) return { lower: 0, upper: 100 };
  const raw = typeof row.raw === 'number' ? row.raw : undefined;
  if (!hasBounds && raw === undefined) return { lower: 0, upper: 100 };
  const lower = row.rawLower ?? raw ?? -Infinity;
  const upper = row.rawUpper ?? raw ?? Infinity;
  const at = value => {
    if (value >= targetFit.min && value <= targetFit.max) return 100;
    const distance = value < targetFit.min ? targetFit.min - value : value - targetFit.max;
    return 100 * Math.max(0, 1 - distance / targetFit.decay);
  };
  const endpoints = [at(lower), at(upper)];
  return {
    lower: Math.min(...endpoints),
    upper: lower <= targetFit.max && upper >= targetFit.min ? 100 : Math.max(...endpoints),
  };
}

function validateRequirement(requirement, ancestors = new Set()) {
  record(requirement, 'requirement');
  if (ancestors.has(requirement)) throw new RangeError('cyclic requirement expression');
  if (['and', 'or', 'not'].includes(requirement.operator)) {
    if (!Array.isArray(requirement.conditions)) {
      throw new TypeError('logical requirement conditions must be an array');
    }
    if (requirement.operator === 'or' && requirement.conditions.length === 0) {
      throw new TypeError('or requires nonempty conditions');
    }
    if (requirement.operator === 'not' && requirement.conditions.length !== 1) {
      throw new RangeError('not requires exactly one condition');
    }
    if (requirement.metricKey !== undefined) throw new TypeError('logical requirement cannot specify a metricKey');
    const next = new Set(ancestors).add(requirement);
    requirement.conditions.forEach(condition => validateRequirement(condition, next));
    return requirement;
  }
  identifier(requirement.metricKey, 'requirement metricKey');
  if (requirement.conditions !== undefined) throw new TypeError('atomic requirement cannot specify conditions');
  switch (requirement.operator) {
    case 'atLeast':
    case 'atMost':
      finite(requirement.value, 'requirement value');
      break;
    case 'within':
      finite(requirement.min, 'requirement min');
      finite(requirement.max, 'requirement max');
      if (requirement.min > requirement.max) throw new RangeError('requirement range is reversed');
      break;
    case 'equals':
      if (!['number', 'string', 'boolean'].includes(typeof requirement.value)) {
        throw new TypeError('equals requires a number, string, or boolean');
      }
      if (typeof requirement.value === 'number') finite(requirement.value, 'requirement value');
      break;
    default:
      throw new RangeError('unknown requirement operator');
  }
  return requirement;
}

/** Three-state hard constraints use raw facts, never rounded/scaled scores. */
export function evaluateRequirement(row, requirement) {
  validateRequirement(requirement);
  if (['and', 'or', 'not'].includes(requirement.operator)) {
    throw new TypeError('evaluateRequirement expects an atomic condition; use evaluateRequirements for expressions');
  }
  if (row === undefined) return 'unknown';
  validateRow(row);
  if (UNKNOWN_STATES.has(row.status) || row.status === 'A') return 'unknown';

  const hasBounds = row.rawLower != null || row.rawUpper != null;
  if (row.status === 'X' && !hasBounds) return 'unknown';
  const raw = row.raw;
  if (requirement.operator === 'equals' && typeof requirement.value !== 'number') {
    return raw == null || hasBounds ? 'unknown' : raw === requirement.value ? 'pass' : 'fail';
  }
  if (raw != null && typeof raw !== 'number') return 'unknown';
  const lower = row.rawLower ?? (typeof raw === 'number' ? raw : undefined);
  const upper = row.rawUpper ?? (typeof raw === 'number' ? raw : undefined);
  if (lower === undefined && upper === undefined) return 'unknown';
  switch (requirement.operator) {
    case 'atLeast':
      if (lower !== undefined && lower >= requirement.value) return 'pass';
      if (upper !== undefined && upper < requirement.value) return 'fail';
      return 'unknown';
    case 'atMost':
      if (upper !== undefined && upper <= requirement.value) return 'pass';
      if (lower !== undefined && lower > requirement.value) return 'fail';
      return 'unknown';
    case 'within':
      if (lower !== undefined && upper !== undefined
          && lower >= requirement.min && upper <= requirement.max) return 'pass';
      if ((upper !== undefined && upper < requirement.min)
          || (lower !== undefined && lower > requirement.max)) return 'fail';
      return 'unknown';
    case 'equals':
      if (lower === requirement.value && upper === requirement.value) return 'pass';
      if ((upper !== undefined && upper < requirement.value)
          || (lower !== undefined && lower > requirement.value)) return 'fail';
      return 'unknown';
  }
}

function evaluateValidatedRequirements(metrics, requirement) {
  if (Array.isArray(requirement)) {
    const decisions = requirement.map(condition => evaluateValidatedRequirements(metrics, condition));
    return decisions.includes('fail') ? 'fail' : decisions.includes('unknown') ? 'unknown' : 'pass';
  }
  if (['and', 'or', 'not'].includes(requirement.operator)) {
    const decisions = requirement.conditions.map(condition => evaluateValidatedRequirements(metrics, condition));
    if (requirement.operator === 'not') {
      return decisions[0] === 'pass' ? 'fail' : decisions[0] === 'fail' ? 'pass' : 'unknown';
    }
    if (requirement.operator === 'or') {
      return decisions.includes('pass') ? 'pass' : decisions.includes('unknown') ? 'unknown' : 'fail';
    }
    return decisions.includes('fail') ? 'fail' : decisions.includes('unknown') ? 'unknown' : 'pass';
  }
  const row = Object.hasOwn(metrics, requirement.metricKey) ? metrics[requirement.metricKey] : undefined;
  return evaluateRequirement(row, requirement);
}

function validateRequirements(requirements) {
  if (Array.isArray(requirements)) requirements.forEach(requirement => validateRequirement(requirement));
  else validateRequirement(requirements);
  return requirements;
}

/** Legacy arrays mean AND; expressions support recursively nested AND/OR/NOT. */
export function evaluateRequirements(metrics, requirements = []) {
  record(metrics, 'plan metrics');
  validateRequirements(requirements);
  return evaluateValidatedRequirements(metrics, requirements);
}

function effectiveWeights(weights, groupBudgets, groupAssignments) {
  const active = Object.entries(weights).filter(([, weight]) => weight !== 0);
  if (groupBudgets === undefined) {
    const denominator = active.reduce((sum, [, weight]) => sum + Math.abs(weight), 0);
    return active.map(([metricKey, weight]) => ({ metricKey, weight, coefficient: Math.abs(weight) / denominator }));
  }
  const groupTotals = new Map();
  const groupFor = key => Object.hasOwn(groupAssignments, key) ? groupAssignments[key] : key[0];
  for (const [key, weight] of active) {
    const group = groupFor(key);
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + Math.abs(weight));
  }
  for (const [group, budget] of Object.entries(groupBudgets)) {
    if (budget > 0 && !groupTotals.has(group)) {
      throw new RangeError(`positive group budget requires active preferences: ${group}`);
    }
  }
  // Scale before summing so finite budgets near Number.MAX_VALUE stay finite.
  const scale = Object.values(groupBudgets).reduce((maximum, budget) => Math.max(maximum, budget), 0);
  if (!scale) return [];
  const total = Object.values(groupBudgets).reduce((sum, budget) => sum + budget / scale, 0);
  return active.map(([metricKey, weight]) => {
    const group = groupFor(metricKey);
    const budget = Object.hasOwn(groupBudgets, group) ? groupBudgets[group] : 0;
    return { metricKey, weight, group,
      coefficient: (budget / scale / total) * (Math.abs(weight) / groupTotals.get(group)) };
  });
}

function normalizedSettings(settings) {
  record(settings, 'settings');
  const weights = record(settings.weights ?? {}, 'weights');
  for (const [key, weight] of Object.entries(weights)) {
    identifier(key, 'metricKey');
    weightValue(weight);
  }
  const requirements = settings.requirements === undefined ? [] : settings.requirements;
  validateRequirements(requirements);
  const targetFits = record(settings.targetFits === undefined ? {} : settings.targetFits, 'target fits');
  for (const [key, targetFit] of Object.entries(targetFits)) {
    identifier(key, 'target fit metricKey');
    validateTargetFit(targetFit);
  }
  const groupAssignments = record(settings.groupAssignments === undefined ? {} : settings.groupAssignments, 'group assignments');
  for (const [key, group] of Object.entries(groupAssignments)) {
    identifier(key, 'group assignment metricKey');
    identifier(group, 'group assignment');
  }
  const groupBudgets = settings.groupBudgets == null ? undefined : record(settings.groupBudgets, 'group budgets');
  if (groupBudgets !== undefined) {
    for (const [group, budget] of Object.entries(groupBudgets)) {
      identifier(group, 'group');
      finite(budget, 'group budget');
      if (budget < 0) throw new RangeError('group budget must be nonnegative');
    }
  }
  const modality = settings.modality ?? 'all';
  if (!['all', 'daytrip', 'stay'].includes(modality)) throw new RangeError('unknown modality');
  const regionQuery = settings.regionQuery ?? '';
  if (typeof regionQuery !== 'string') throw new TypeError('regionQuery must be text');
  return { weights, requirements, targetFits, modality, regionQuery,
    coefficients: effectiveWeights(weights, groupBudgets, groupAssignments) };
}

function validatePlan(plan) {
  record(plan, 'plan');
  identifier(plan.id, 'plan id');
  identifier(plan.regionId, 'regionId');
  identifier(plan.label, 'plan label');
  if (!['daytrip', 'stay'].includes(plan.modality)) throw new RangeError('unknown plan modality');
  record(plan.metrics, 'plan metrics');
  for (const [key, row] of Object.entries(plan.metrics)) {
    identifier(key, 'metricKey');
    validateRow(row);
    if (row.metricKey !== undefined && row.metricKey !== key) {
      throw new RangeError('row metricKey disagrees with its unique map key');
    }
  }
}

function evaluateValidatedPlan(plan, settings) {
  const reasons = [];
  const decisions = [];
  if (settings.modality !== 'all' && settings.modality !== plan.modality) {
    decisions.push('fail');
    reasons.push(`利用モード不適合: ${plan.modality}`);
  }
  const requirementDecision = evaluateValidatedRequirements(plan.metrics, settings.requirements);
  decisions.push(requirementDecision);
  if (requirementDecision !== 'pass') {
    if (Array.isArray(settings.requirements)) {
      for (const requirement of settings.requirements) {
        const decision = evaluateValidatedRequirements(plan.metrics, requirement);
        if (decision !== 'pass') reasons.push(`${requirement.metricKey ?? '条件式'}: 必須条件${decision === 'fail' ? '不適合' : '未確認'}`);
      }
    } else reasons.push(`必須条件式${requirementDecision === 'fail' ? '不適合' : '未確認'}`);
  }
  const eligibility = decisions.includes('fail') ? 'fail'
    : decisions.includes('unknown') ? 'unknown' : 'pass';
  if (!settings.coefficients.length) return { eligibility, reasons, score: null, contributions: [] };

  const contributions = settings.coefficients.map(({ metricKey, weight, coefficient, group }) => {
    const row = Object.hasOwn(plan.metrics, metricKey) ? plan.metrics[metricKey] : UNKNOWN_ROW;
    const targetFit = Object.hasOwn(settings.targetFits, metricKey) ? settings.targetFits[metricKey] : undefined;
    const scoredRow = targetFit ? { ...row, ...targetFitInterval(row, targetFit) } : row;
    const interval = scoreInterval(scoredRow, weight);
    const coverage = EVIDENCE_STATES.has(row.status) ? 100 : 0;
    const certainty = row.status === 'A' || UNKNOWN_STATES.has(row.status) ? 0 : 100 - interval.upper + interval.lower;
    return { metricKey, weight, status: row.status, coefficient, ...(group ? { group } : {}),
      ...(targetFit ? { targetFit: { ...targetFit } } : {}),
      lower: interval.lower, upper: interval.upper,
      weightedLower: coefficient * interval.lower,
      weightedUpper: coefficient * interval.upper, coverage, certainty };
  });
  const score = contributions.reduce((sum, row) => ({
    lower: sum.lower + row.weightedLower,
    upper: sum.upper + row.weightedUpper,
    coverage: sum.coverage + row.coefficient * row.coverage,
    certainty: sum.certainty + row.coefficient * row.certainty,
  }), { lower: 0, upper: 0, coverage: 0, certainty: 0 });
  return { eligibility, reasons, score: eligibility === 'pass' ? score : null, contributions };
}

export function evaluatePlan(plan, settings = {}) {
  validatePlan(plan);
  return evaluateValidatedPlan(plan, normalizedSettings(settings));
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const planOrder = (a, b) => collator.compare(a.plan.label, b.plan.label)
  || collator.compare(a.plan.id, b.plan.id);
const regionOrder = (a, b) => collator.compare(a.kana || a.name, b.kana || b.name)
  || collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
const queryText = value => value.normalize('NFKC').toLocaleLowerCase('ja');

/**
 * Rank only confirmed feasible plans. `score` belongs to bestPlan itself;
 * bestEnvelope is [max(plan lower), max(plan upper)] across feasible plans.
 * coverage is the specification's weighted evidence-acquisition percentage.
 * With no preferences, bestPlan is a label-ordered representative, rank is null.
 */
export function rankRegions(regions, plans, settings = {}) {
  if (!Array.isArray(regions) || !Array.isArray(plans)) {
    throw new TypeError('regions and plans must be arrays');
  }
  const config = normalizedSettings(settings);
  const regionMap = new Map();
  for (const region of regions) {
    record(region, 'region');
    identifier(region.id, 'region id');
    identifier(region.name, 'region name');
    if (region.kana !== undefined && typeof region.kana !== 'string') {
      throw new TypeError('region kana must be text');
    }
    if (regionMap.has(region.id)) throw new RangeError(`duplicate region id: ${region.id}`);
    regionMap.set(region.id, region);
  }
  const planIds = new Set();
  for (const plan of plans) {
    validatePlan(plan);
    if (planIds.has(plan.id)) throw new RangeError(`duplicate plan id: ${plan.id}`);
    planIds.add(plan.id);
    if (!regionMap.has(plan.regionId)) throw new RangeError(`unknown regionId: ${plan.regionId}`);
  }

  const query = queryText(config.regionQuery.trim());
  const selected = new Set(regions.filter(region => !query || [region.name, region.kana ?? '', region.id]
    .some(value => queryText(value).includes(query))).map(region => region.id));
  const feasible = new Map();
  const unknown = [];
  const failed = [];
  for (const plan of plans) {
    if (!selected.has(plan.regionId)) continue;
    const evaluation = evaluateValidatedPlan(plan, config);
    const item = { region: regionMap.get(plan.regionId), plan, ...evaluation };
    if (evaluation.eligibility === 'unknown') unknown.push(item);
    else if (evaluation.eligibility === 'fail') failed.push(item);
    else {
      if (!feasible.has(plan.regionId)) feasible.set(plan.regionId, []);
      feasible.get(plan.regionId).push(item);
    }
  }
  const hasPreferences = config.coefficients.length > 0;
  const confirmed = [...feasible].map(([id, items]) => {
    items.sort((a, b) => (hasPreferences ? b.score.lower - a.score.lower : 0) || planOrder(a, b));
    const best = items[0];
    const region = regionMap.get(id);
    return { ...region, region, bestPlan: best.plan, score: best.score,
      bestEnvelope: hasPreferences ? {
        lower: Math.max(...items.map(item => item.score.lower)),
        upper: Math.max(...items.map(item => item.score.upper)),
      } : null,
      contributions: best.contributions, rank: null, eligiblePlanCount: items.length };
  });
  confirmed.sort((a, b) => (hasPreferences ? b.score.lower - a.score.lower : 0) || regionOrder(a, b));
  if (hasPreferences) {
    for (let index = 0; index < confirmed.length; index += 1) {
      confirmed[index].rank = index > 0 && confirmed[index].score.lower === confirmed[index - 1].score.lower
        ? confirmed[index - 1].rank : index + 1;
    }
  }
  const rejectedOrder = (a, b) => regionOrder(a.region, b.region) || planOrder(a, b);
  unknown.sort(rejectedOrder);
  failed.sort(rejectedOrder);
  return { confirmed, unknown, failed };
}
