/**
 * Regional fees for one ordinary adult, own towel, bathing only, in JPY.
 * The caller must supply one condition-matched population (including day type),
 * without resident/member discounts, private baths, or required meal packages.
 * This pure module aggregates raw fee bounds; it does not produce ranking points
 * or establish that a published tariff is currently bookable.
 *
 * Output intervals use {lower, upper}; upper:null means no established ceiling,
 * never a zero fee. `complete` describes the facility population, not whether
 * every tariff or monetary amount is known. Observed values describe only the
 * acquired tariff sets of definitely included facilities, not regional extremes.
 * Optional nested regionId/day_type/modality/currency/condition_key tags are
 * checked for compatibility; descriptions cannot establish condition matching.
 */

const STATUSES = new Set(['K', 'C', 'U', 'E', 'F', 'X']);
const MEMBERSHIPS = new Set(['included', 'excluded', 'unknown']);
const DAY_TYPES = new Set(['weekday', 'weekend', 'all']);
const CONDITION_FIELDS = ['regionId', 'day_type', 'modality', 'currency', 'condition_key'];

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new TypeError(`${label} must be a nonempty identifier without surrounding whitespace`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function money(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  if (value < 0) throw new RangeError(`${label} must be nonnegative`);
  return value;
}

function references(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map(value => identifier(value, label)))].sort();
}

function compatibleConditions(value, population, conditionKey, label) {
  if (value.regionId !== undefined && value.regionId !== population.regionId) {
    throw new RangeError(`${label} belongs to a different region`);
  }
  if (value.day_type !== undefined && (!DAY_TYPES.has(value.day_type)
      || (value.day_type !== 'all' && value.day_type !== population.day_type))) {
    throw new RangeError(`${label} has a different day condition`);
  }
  if (value.modality !== undefined && value.modality !== 'daytrip') {
    throw new RangeError(`${label} must be a daytrip tariff population`);
  }
  if (value.currency !== undefined && value.currency !== 'JPY') {
    throw new RangeError(`${label} must use JPY`);
  }
  if (value.condition_key !== undefined) {
    identifier(value.condition_key, `${label}.condition_key`);
    if (conditionKey !== undefined && value.condition_key !== conditionKey) {
      throw new RangeError(`${label} has a different fee condition`);
    }
  }
}

function encode(interval) {
  return interval === null ? null : {
    lower: interval.lower,
    upper: Number.isFinite(interval.upper) ? interval.upper : null,
  };
}

function minimum(intervals) {
  if (intervals.length === 0) return null;
  return {
    lower: Math.min(...intervals.map(interval => interval.lower)),
    upper: Math.min(...intervals.map(interval => interval.upper)),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : sorted[middle - 1] / 2 + sorted[middle] / 2;
}

function medianInterval(intervals) {
  if (intervals.length === 0) return null;
  return {
    lower: median(intervals.map(interval => interval.lower)),
    upper: median(intervals.map(interval => interval.upper)),
  };
}

function budgetResult(interval, budget) {
  if (budget === null) return null;
  if (interval.upper <= budget) return 'pass';
  if (interval.lower > budget) return 'fail';
  return 'unknown';
}

function sameTariffUnit(a, b) {
  return ['rawLower', 'rawUpper', 'status', ...CONDITION_FIELDS]
    .every(field => a[field] === b[field]);
}

function normalizeTariffs(facility, population, conditionKey) {
  if (!Array.isArray(facility.tariffs)) throw new TypeError('facility.tariffs must be an array');
  const units = new Map();
  for (const value of facility.tariffs) {
    record(value, 'tariff');
    identifier(value.id, 'tariff.id');
    if (!STATUSES.has(value.status)) throw new RangeError(`unknown tariff status: ${value.status}`);
    for (const field of ['rawLower', 'rawUpper']) {
      if (value[field] !== null) money(value[field], `tariff.${field}`);
    }
    if (value.rawLower !== null && value.rawUpper !== null && value.rawLower > value.rawUpper) {
      throw new RangeError('tariff raw interval is reversed');
    }
    if (['U', 'E', 'F'].includes(value.status) && (value.rawLower !== null || value.rawUpper !== null)) {
      throw new RangeError('unknown tariff status cannot carry monetary bounds');
    }
    if (value.status === 'K' && (value.rawLower === null || value.rawUpper === null)) {
      throw new RangeError('confirmed tariff needs both monetary bounds');
    }
    if (value.status === 'C' && value.rawLower === null && value.rawUpper === null) {
      throw new RangeError('conditional tariff needs a monetary bound');
    }
    if (['K', 'C', 'X'].includes(value.status) && references(value.evidence_ids, 'tariff.evidence_ids').length === 0) {
      throw new RangeError('bounded tariff needs source evidence');
    }
    compatibleConditions(value, population, conditionKey, 'tariff');
    const tariff = {
      id: value.id,
      rawLower: value.rawLower,
      rawUpper: value.rawUpper,
      status: value.status,
      evidence_ids: references(value.evidence_ids, 'tariff.evidence_ids'),
      plan_ids: references(value.plan_ids, 'tariff.plan_ids'),
    };
    for (const field of CONDITION_FIELDS) {
      if (value[field] !== undefined) tariff[field] = value[field];
    }
    const previous = units.get(tariff.id);
    if (previous) {
      if (!sameTariffUnit(previous, tariff)) {
        throw new RangeError(`conflicting tariff.id within facility ${facility.facility_id}: ${tariff.id}`);
      }
      // Multiple baths/plans may cite the same charge; references are not units.
      previous.evidence_ids = references([...previous.evidence_ids, ...tariff.evidence_ids], 'evidence_ids');
      previous.plan_ids = references([...previous.plan_ids, ...tariff.plan_ids], 'plan_ids');
    } else {
      units.set(tariff.id, tariff);
    }
  }
  return [...units.values()];
}

/**
 * Summarize facility-level representative fees for one regional population.
 * Bounds remain source constraints. Unknown states cannot carry numeric fees;
 * bounded states require evidence rather than acquiring certainty from labels.
 * Empty or missing fee bounds are [0,∞], including an unpriced tariff unit.
 * A complete empty tariff set cannot describe an included facility.
 */
export function summarizeRegionalFees(population, { budget = null } = {}) {
  record(population, 'population');
  identifier(population.regionId, 'population.regionId');
  if (!DAY_TYPES.has(population.day_type)) throw new RangeError('population.day_type is invalid');
  boolean(population.inventory_complete, 'population.inventory_complete');
  if (!Array.isArray(population.facilities)) throw new TypeError('population.facilities must be an array');
  if (budget !== null) money(budget, 'budget');

  // An optional machine condition tag must agree everywhere it is supplied.
  const conditionKeys = [population.condition_key];
  for (const facility of population.facilities) {
    record(facility, 'facility');
    conditionKeys.push(facility.condition_key);
    if (Array.isArray(facility.tariffs)) {
      for (const tariff of facility.tariffs) {
        record(tariff, 'tariff');
        conditionKeys.push(tariff.condition_key);
      }
    }
  }
  const suppliedKeys = conditionKeys.filter(value => value !== undefined);
  suppliedKeys.forEach(value => identifier(value, 'condition_key'));
  if (new Set(suppliedKeys).size > 1) throw new RangeError('mixed fee conditions in population');
  const conditionKey = suppliedKeys[0];
  compatibleConditions(population, population, conditionKey, 'population');

  const facilityIds = new Set();
  const includedIntervals = [];
  const observedIntervals = [];
  let includedCount = 0;
  let excludedCount = 0;
  let unknownMembershipCount = 0;
  let pass = 0;
  let fail = 0;
  let unknown = 0;

  const facilities = population.facilities.map(facility => {
    identifier(facility.facility_id, 'facility.facility_id');
    if (facilityIds.has(facility.facility_id)) throw new RangeError('duplicate facility_id');
    facilityIds.add(facility.facility_id);
    if (!MEMBERSHIPS.has(facility.membership)) throw new RangeError('unknown facility membership');
    boolean(facility.tariff_inventory_complete, 'facility.tariff_inventory_complete');
    compatibleConditions(facility, population, conditionKey, 'facility');
    const tariffs = normalizeTariffs(facility, population, conditionKey);
    let representative = null;
    let observed = null;
    let result = null;
    if (facility.membership === 'included') {
      includedCount += 1;
      if (facility.tariff_inventory_complete && tariffs.length === 0) {
        throw new RangeError('included facility cannot have a complete empty tariff inventory');
      }
      observed = minimum(tariffs.map(tariff => ({
        lower: tariff.rawLower ?? 0,
        upper: tariff.rawUpper ?? Infinity,
      })));
      representative = {
        lower: facility.tariff_inventory_complete ? observed.lower : 0,
        upper: observed?.upper ?? Infinity,
      };
      includedIntervals.push(representative);
      if (observed !== null) observedIntervals.push(observed);
      result = budgetResult(representative, budget);
      if (result === 'pass') pass += 1;
      else if (result === 'fail') fail += 1;
      else if (result === 'unknown') unknown += 1;
    } else if (facility.membership === 'unknown') {
      unknownMembershipCount += 1;
      representative = { lower: 0, upper: Infinity };
      result = budget === null ? null : 'unknown';
    } else {
      excludedCount += 1;
    }
    return {
      facility_id: facility.facility_id,
      membership: facility.membership,
      tariffInventoryComplete: facility.tariff_inventory_complete,
      tariffCount: tariffs.length,
      tariffs,
      representativeFee: encode(representative),
      observedFee: encode(observed),
      budgetResult: result,
    };
  });

  const complete = population.inventory_complete && unknownMembershipCount === 0;
  const empty = complete && includedCount === 0;
  const calculable = complete && !empty;
  const exactFees = includedIntervals.every(interval => Number.isFinite(interval.upper)
    && interval.lower === interval.upper);
  const state = empty ? 'A' : complete ? exactFees ? 'K' : 'C' : 'E';
  const note = empty
    ? '通常の一般成人1名・自前タオル・入浴のみの母集団に該当施設がないことを確認。'
    : !complete
      ? '施設母集団または所属が未確定。地域最低料金・中央値・予算内割合は未算出。取得範囲の参考値と確認済み予算内施設数の下限を表示。'
      : exactFees
        ? '施設母集団と所属が確定。各施設の同条件の最安通常料金を施設1件として集計。'
        : '施設母集団と所属が確定。未確認料金単位・片側料金を含む外包区間で集計し、未知料金を無料とは確定しない。';

  return {
    regionId: population.regionId,
    day_type: population.day_type,
    currency: 'JPY',
    budget,
    ...(conditionKey === undefined ? {} : { condition_key: conditionKey }),
    complete,
    state,
    note,
    inventoryComplete: population.inventory_complete,
    tariffInventoriesComplete: facilities.filter(facility => facility.membership === 'included')
      .every(facility => facility.tariffInventoryComplete),
    includedCount,
    excludedCount,
    unknownMembershipCount,
    populationCount: {
      lower: includedCount,
      upper: population.inventory_complete ? includedCount + unknownMembershipCount : null,
    },
    facilities,
    regionalMinimum: calculable ? encode(minimum(includedIntervals)) : null,
    regionalMedian: calculable ? encode(medianInterval(includedIntervals)) : null,
    observedMinimum: encode(minimum(observedIntervals)),
    observedMedian: encode(medianInterval(observedIntervals)),
    observedCount: observedIntervals.length,
    observedNote: '所属が確認された施設の取得済み料金単位集合内の参考値。未取得の料金単位や所属未確認施設を補わず、地域全体の最安・中央値とは扱わない。',
    budgetCount: budget === null || empty ? null : {
      lower: pass,
      upper: complete ? includedCount - fail : null,
    },
    budgetShare: budget === null || !calculable ? null : {
      lower: pass / includedCount,
      upper: (includedCount - fail) / includedCount,
    },
    budgetBreakdown: budget === null || empty ? null : {
      confirmedWithin: pass,
      confirmedOver: fail,
      feeUnconfirmed: unknown,
      membershipUnconfirmed: unknownMembershipCount,
    },
  };
}
