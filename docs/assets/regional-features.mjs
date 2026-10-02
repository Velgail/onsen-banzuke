import { summarizeRegionalFees } from './pricing.mjs';

/** A missing public population is a broken release, not an uninvestigated row. */
export function validateFeePopulations(populations, regions, policy) {
  if (!Array.isArray(populations) || populations.length !== regions.length * 2) {
    throw new RangeError('日帰り料金の地域・曜日別データがそろっていません。');
  }
  const expected = new Set(regions.flatMap(region => ['weekday', 'weekend'].map(day => `${region.id}:${day}`)));
  for (const population of populations) {
    if (!expected.delete(`${population.regionId}:${population.day_type}`)) throw new RangeError('日帰り料金の地域・曜日が不正または重複しています。');
    if (population.policy_id !== policy.id || population.condition_key !== policy.condition_key) throw new RangeError('日帰り料金の集約条件が一致しません。');
    summarizeRegionalFees(population);
  }
}

/** Attach regional facts to condition-matched plans without replacing their Y01. */
export function attachRegionalFeeMetrics(plans, populations, metricKeys, {dayType = 'weekday'} = {}) {
  if (!['weekday', 'weekend'].includes(dayType)) throw new RangeError('日帰り料金の比較曜日が不正です。');
  const keys = [...new Set(['Y23', ...metricKeys.filter(key => /^Y2[45](?:\[|$)/.test(key))])];
  const definitions = keys.map(key => {
    if (key === 'Y23') return {key, metricId:key, budget:null};
    const match = /^(Y2[45])\[budget=([^\]]+)\]$/.exec(key);
    const budget = match ? Number(match[2]) : NaN;
    if (!Number.isFinite(budget) || budget < 0) throw new RangeError('予算内施設数・割合には0以上のbudgetを指定してください。');
    return {key, metricId:match[1], budget};
  });
  const lookup = new Map();
  for (const population of populations) {
    const key = `${population.regionId}:${population.day_type}`;
    if (lookup.has(key)) throw new RangeError('同じ地域・曜日の料金母集団が重複しています。');
    lookup.set(key, population);
  }
  const cache = new Map();
  const score = (id, value) => id === 'Y23'
    ? 100 * Math.max(0, Math.min(1, 1 - value / 2000))
    : id === 'Y24' ? 100 * Math.max(0, Math.min(1, value / 10))
      : 100 * Math.max(0, Math.min(1, value));
  return plans.map(plan => {
    const population = lookup.get(`${plan.regionId}:${dayType}`);
    const metrics = {...plan.metrics};
    for (const {key, metricId, budget} of definitions) {
      const cacheKey = `${plan.regionId}:${key}`;
      if (!cache.has(cacheKey)) {
        const summary = population ? summarizeRegionalFees(population, {budget}) : null;
        const interval = metricId === 'Y23' ? summary?.regionalMedian
          : metricId === 'Y24' ? summary?.budgetCount : summary?.budgetShare;
        const status = summary?.state === 'A' ? 'A' : !interval ? 'E'
          : interval.upper === interval.lower ? 'K' : 'C';
        const points = interval
          ? [score(metricId, interval.lower), score(metricId, interval.upper ?? Infinity)] : [0, status === 'A' ? 0 : 100];
        const evidence = population ? [...new Set([
          ...(population.inventory_evidence_ids ?? []),
          ...population.facilities.flatMap(facility => [
            ...(facility.evidence_ids ?? []), ...(facility.tariff_inventory_evidence_ids ?? []),
            ...facility.tariffs.flatMap(tariff => tariff.evidence_ids),
          ]),
        ])].sort() : [];
        cache.set(cacheKey, {
          metricKey:key, status, lower:Math.min(...points), upper:Math.max(...points),
          rawLower:interval?.lower ?? null, rawUpper:interval?.upper ?? null,
          unit:metricId === 'Y23' ? 'JPY' : metricId === 'Y24' ? '件' : '割合（0〜1）',
          formula:metricId === 'Y23' ? 'D(0,2000)' : metricId === 'Y24' ? 'N(10)' : 'R',
          entity_scope:'region', entity_id:plan.regionId, population_id:population?.id ?? null,
          evidence_ids:evidence,
          condition:population?.condition_note ?? '同じ地域・曜日の通常日帰り料金母集団が未収録。',
          reason:(summary?.note ?? '料金母集団の調査未完了。')
            + (budget === null ? '' : ` 指定予算 ${budget}円。`)
            + (metricId === 'Y24' && summary && !summary.complete ? ' 確認済み施設数の下限であり、総件数や地域全体の割合を示さない。' : ''),
        });
      }
      metrics[key] = {...cache.get(cacheKey), evidence_ids:[...cache.get(cacheKey).evidence_ids]};
    }
    return {...plan, metrics};
  });
}
