/** Select the same day type and modality before computing a regional maximum. */
export function comparisonPlans(plans, {modality='daytrip', dayType='weekday'}={}) {
  if (!['all','daytrip','stay'].includes(modality) || !['weekday','weekend'].includes(dayType)) throw new RangeError('利用区分・比較曜日が不正です。');
  return plans.filter(plan => (modality==='all' || plan.modality===modality)
    && ((plan.day_type??'all')==='all' || plan.day_type===dayType));
}
