import { summarizeRegionalFees } from './pricing.mjs';

const ENVELOPE_KEYS = ['schema_version', 'rubric_version', 'snapshot_id', 'dataset_kind'];
const DAY_LABELS = { weekday: '平日', weekend: '土日祝' };
const MEMBERSHIP_LABELS = { included: '通常日帰りの対象', excluded: '母集団から除外', unknown: '所属未確認' };
const STATE_LABELS = { K: '確認済み', C: '条件付き・区間', U: '情報未確認', E: '未調査', F: '資料取得不能', X: '矛盾あり' };
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const number = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(value);

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}の形式が不正です。`);
  return value;
}

/** Refuse mixed releases or missing weekday populations before calculating. */
export function verifyFeeRelease(manifest, regionData, feeData) {
  plainRecord(manifest, 'manifest');
  if (!['1', '2'].includes(manifest.schema_version) || manifest.dataset_kind !== 'evidence_pilot') {
    throw new Error('このページで扱える独立検証の公開データ形式ではありません。');
  }
  for (const key of ENVELOPE_KEYS) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) throw new Error('公開データ版の指定が不完全です。');
  }
  for (const data of [regionData, feeData]) {
    plainRecord(data, '公開データ');
    for (const key of ENVELOPE_KEYS) {
      if (data[key] !== manifest[key]) throw new Error('異なる版の公開データが混在しています。');
    }
  }
  if (!Array.isArray(regionData.regions) || !Array.isArray(feeData.populations)
      || !Number.isSafeInteger(manifest.region_count) || manifest.region_count < 0
      || regionData.regions.length !== manifest.region_count) {
    throw new Error('対象地域一覧・件数の整合を確認できません。');
  }
  if (!manifest.fee_policy_id || feeData.policy?.id !== manifest.fee_policy_id) {
    throw new Error('通常日帰り料金の母集団定義が一致しません。');
  }
  const regionIds = new Set();
  for (const region of regionData.regions) {
    plainRecord(region, '地域');
    if (typeof region.id !== 'string' || !region.id || regionIds.has(region.id)
        || typeof region.name !== 'string' || !region.name) {
      throw new Error('地域IDまたは名称に不正・重複があります。');
    }
    regionIds.add(region.id);
  }
  const populationKeys = new Set();
  const populationIds = new Set();
  for (const population of feeData.populations) {
    plainRecord(population, '料金母集団');
    if (!regionIds.has(population.regionId) || population.policy_id !== manifest.fee_policy_id
        || (feeData.policy.condition_key !== undefined
          && population.condition_key !== feeData.policy.condition_key)) {
      throw new Error('料金母集団の対象地域または定義が一致しません。');
    }
    if (typeof population.id !== 'string' || !population.id || populationIds.has(population.id)) {
      throw new Error('料金母集団IDに不正・重複があります。');
    }
    populationIds.add(population.id);
    const key = JSON.stringify([population.regionId, population.day_type]);
    if (populationKeys.has(key)) throw new Error('同一地域・曜日の料金母集団が重複しています。');
    populationKeys.add(key);
    // Validate fee intervals, statuses, tariff IDs and condition compatibility.
    summarizeRegionalFees(population);
  }
  for (const regionId of regionIds) {
    for (const dayType of Object.keys(DAY_LABELS)) {
      const matches = feeData.populations.filter(population => population.regionId === regionId
        && [dayType, 'all'].includes(population.day_type));
      if (matches.length !== 1) throw new Error('各地域の平日・土日祝の母集団が一意に収録されていません。');
    }
  }
  return true;
}

export function formatFeeInterval(interval) {
  if (interval === null) return '未算出';
  if (interval.upper === null) {
    return interval.lower === 0 ? '未確認（上限未確定）' : `${number(interval.lower)}円以上・上限未確定`;
  }
  if (interval.lower === interval.upper) return `${number(interval.lower)}円`;
  return `${number(interval.lower)}〜${number(interval.upper)}円`;
}

function rawTariffFee(tariff) {
  if (tariff.rawLower === null && tariff.rawUpper === null) return '料金未確認';
  if (tariff.rawLower === null) return `上限${number(tariff.rawUpper)}円・下限未確認`;
  if (tariff.rawUpper === null) return `${number(tariff.rawLower)}円以上・上限未確認`;
  return formatFeeInterval({ lower: tariff.rawLower, upper: tariff.rawUpper });
}

function facilityCount(interval) {
  if (interval.upper === null) return `${number(interval.lower)}施設以上・上限未確認`;
  return interval.lower === interval.upper ? `${number(interval.lower)}施設`
    : `${number(interval.lower)}〜${number(interval.upper)}施設`;
}

function budgetCount(interval) {
  if (interval === null) return '対象外';
  if (interval.upper === null) return `${number(interval.lower)}施設以上（確認済み下限）／上限未確認`;
  return facilityCount(interval);
}

function budgetShare(interval) {
  if (interval === null) return '未算出';
  const percent = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value * 100);
  return interval.lower === interval.upper ? `${percent(interval.lower)}%`
    : `${percent(interval.lower)}〜${percent(interval.upper)}%`;
}

function localUrl(path, document) {
  if (typeof path !== 'string' || !path) throw new Error('公開ファイルの参照先が未設定です。');
  const base = new URL('./', document.baseURI);
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin
      || !url.pathname.startsWith(base.pathname)) {
    throw new Error('サイト内の公開ファイル以外は読み込みません。');
  }
  return url;
}

function regionReport(region, document) {
  return localUrl(region.report_url ?? `./reports/${encodeURIComponent(region.id)}.html`, document).href;
}

function referenceIds(ids, fallback = '確認根拠の登録なし') {
  return ids?.length ? ids.map(id => `<code>${html(id)}</code>`).join(' / ') : html(fallback);
}

function summaryRow(region, summary) {
  const empty = summary.state === 'A';
  const regionalFee = interval => empty ? '対象外' : formatFeeInterval(interval);
  const membership = `${summary.includedCount}対象／${summary.unknownMembershipCount}所属未確認／${summary.excludedCount}除外`;
  const tableValue = (field, text) => `<td data-field="${field}"><span class="fee-value${text === '未算出' ? ' fee-uncomputed' : ''}">${html(text)}</span></td>`;
  return `<tr data-region="${html(region.id)}"><th scope="row">${html(region.name)}<small>${html(region.prefecture ?? '')}</small><small>${html(membership)}</small><small>母集団：${html(facilityCount(summary.populationCount))}</small><span class="fee-incomplete-tag">${empty ? '対象0施設を確認' : summary.complete ? '施設母集団確定' : '施設母集団未確定'}</span><br><a class="fee-region-link" href="#fee-detail-${html(encodeURIComponent(region.id))}" data-open-region="${html(region.id)}">施設・料金の内訳を見る</a></th>
    ${tableValue('regionalMinimum', regionalFee(summary.regionalMinimum))}
    ${tableValue('regionalMedian', regionalFee(summary.regionalMedian))}
    ${tableValue('observedMinimum', formatFeeInterval(summary.observedMinimum))}
    ${tableValue('observedMedian', formatFeeInterval(summary.observedMedian))}
    ${tableValue('budgetCount', budgetCount(summary.budgetCount))}
    ${tableValue('budgetShare', empty ? '対象外' : budgetShare(summary.budgetShare))}</tr>`;
}

function facilityDetail(source, summary) {
  const excluded = summary.membership === 'excluded';
  const membership = MEMBERSHIP_LABELS[summary.membership];
  const result = { pass: '予算内を確認', fail: '予算超過を確認', unknown: '予算内か未確認' }[summary.budgetResult]
    ?? '母集団から除外';
  const tariffs = summary.tariffs.map(tariff => {
    const metadata = source.tariffs.find(value => value.id === tariff.id);
    return `<tr><td><code>${html(tariff.id)}</code><br>${html(metadata?.reason ?? '')}</td><td>${html(rawTariffFee(tariff))}<br><small>${html(STATE_LABELS[tariff.status])}</small></td><td>${referenceIds(tariff.plan_ids, 'プランIDの登録なし')}</td><td>${referenceIds(tariff.evidence_ids)}</td></tr>`;
  }).join('');
  return `<article class="fee-facility" data-facility="${html(summary.facility_id)}"><h4>${html(source.name ?? summary.facility_id)}<span class="fee-membership" data-membership="${html(summary.membership)}">${html(membership)}</span></h4><p>${html(source.reason ?? '所属判定の説明未登録。地域台帳を確認してください。')}</p><p class="fee-evidence">施設ID：<code>${html(summary.facility_id)}</code> ／ 所属根拠：${referenceIds(source.evidence_ids)}</p>
    <dl class="fee-facility-dl"><div><dt>施設代表料金の外包</dt><dd>${html(excluded ? '対象外' : formatFeeInterval(summary.representativeFee))}</dd></div><div><dt>取得した料金単位内の参考</dt><dd>${html(excluded ? '対象外' : formatFeeInterval(summary.observedFee))}</dd></div><div><dt>予算との関係</dt><dd>${html(result)}</dd></div></dl>
    <p>通常料金単位の一覧：<strong>${summary.tariffInventoryComplete ? '網羅確認' : '未網羅'}</strong> ／ 取得料金単位：${summary.tariffCount}件 ／ 地域集計：${summary.membership === 'included' ? '施設1件' : '確定母集団の件数へ加算しない'}</p>
    ${!summary.tariffInventoryComplete && !excluded ? '<p>未取得の通常料金単位があり得るため、取得した価格を施設最安とは確定しません。</p>' : ''}
    ${source.tariff_inventory_evidence_ids?.length ? `<p class="fee-evidence">料金単位一覧の根拠：${referenceIds(source.tariff_inventory_evidence_ids)}</p>` : ''}
    ${tariffs ? `<div class="report-table-wrap" role="region" aria-label="${html(source.name ?? summary.facility_id)}の料金単位表（横にスクロールできます）" tabindex="0"><table class="fee-tariff-table"><caption>取得した通常日帰り料金単位</caption><thead><tr><th scope="col">料金ID・適用条件</th><th scope="col">公表総費用の原値</th><th scope="col">同じ料金単位を利用するプラン</th><th scope="col">出典ID</th></tr></thead><tbody>${tariffs}</tbody></table></div>` : '<p>この曜日の通常料金単位は未収録です。施設が未確認の場合は、料金0円や対象外を意味しません。</p>'}</article>`;
}

function regionDetail(region, population, summary, document) {
  const report = regionReport(region, document);
  return `<details class="fee-region-details" id="fee-detail-${html(encodeURIComponent(region.id))}" data-region="${html(region.id)}"><summary><span>${html(region.name)}の施設と根拠</span><small>${summary.includedCount}対象・${summary.unknownMembershipCount}所属未確認・${summary.excludedCount}除外</small></summary><div class="fee-region-body"><p>${html(population.condition_note ?? '')}</p><p><strong>施設母集団：${summary.complete ? '確定' : '未確定'}</strong><br>${html(population.inventory_reason ?? summary.note)}</p><p class="fee-evidence">母集団ID：<code>${html(population.id)}</code> ／ 全施設一覧の根拠：${referenceIds(population.inventory_evidence_ids)}</p><p>${html(summary.observedNote)} 取得料金のある所属確認済み施設：${summary.observedCount}施設。</p><p><a href="${html(report)}">${html(region.name)}の独立検証・根拠一覧</a></p>${summary.facilities.map(facility => facilityDetail(population.facilities.find(value => value.facility_id === facility.facility_id), facility)).join('') || '<p>施設の収録がありません。母集団の確認状態を参照してください。</p>'}</div></details>`;
}

/** Start an accessible, read-only view of the current published fee release. */
export async function startFeesPage({ document = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const get = id => document.getElementById(id);
  const clearResults = message => {
    get('fee-results').innerHTML = `<tr><td colspan="7">${html(message)}</td></tr>`;
    get('fee-region-details').replaceChildren();
  };
  const error = (message, loadFailure = false) => {
    get('fee-error').textContent = message;
    get('fee-error').hidden = false;
    get('fee-status').textContent = loadFailure ? '公開データを確認できないため、料金集計を表示していません。' : '入力を確認してください。料金集計は未算出です。';
    clearResults('料金集計は未算出です。');
  };
  try {
    const fetchJson = async path => {
      const response = await fetchImpl(localUrl(path, document));
      if (!response.ok) throw new Error(`公開データを読み込めませんでした（${response.status}）。`);
      return response.json();
    };
    const manifest = await fetchJson('./data/manifest.json');
    if (!manifest.fee_populations_url) throw new Error('この公開版には日帰り料金の母集団台帳がまだ収録されていません。');
    const [regionData, feeData] = await Promise.all([
      fetchJson(manifest.regions_url), fetchJson(manifest.fee_populations_url),
    ]);
    verifyFeeRelease(manifest, regionData, feeData);
    // Validate report URLs before displaying any portion of this release.
    regionData.regions.forEach(region => regionReport(region, document));
    const regions = [...regionData.regions].sort((a, b) => (a.kana ?? a.name).localeCompare(b.kana ?? b.name, 'ja')
      || a.id.localeCompare(b.id));
    get('fee-release-meta').textContent = `資料の公開日：${manifest.published_at ?? '未登録'} ／ 採点基準${manifest.rubric_version} ／ データ版：${manifest.snapshot_id}。資料ごとの確認日は地域台帳に記録。`;
    get('fee-controls').disabled = false;
    const render = () => {
      const dayType = get('fee-day-type').value;
      const text = get('fee-budget').value.trim();
      const budget = text === '' ? NaN : Number(text);
      if (!DAY_LABELS[dayType] || !Number.isFinite(budget) || budget < 0) {
        get('fee-budget').setAttribute('aria-invalid', String(!Number.isFinite(budget) || budget < 0));
        error('曜日を選び、予算を0円以上の有限の数値で入力してください。空欄は0円として計算しません。');
        return;
      }
      get('fee-budget').removeAttribute('aria-invalid');
      get('fee-error').hidden = true;
      get('fee-error').textContent = '';
      const entries = regions.map(region => {
        const population = feeData.populations.find(value => value.regionId === region.id && [dayType, 'all'].includes(value.day_type));
        return { region, population, summary: summarizeRegionalFees(population, { budget }) };
      });
      const incomplete = entries.filter(entry => !entry.summary.complete).length;
      get('fee-status').textContent = `${regions.length}温泉地・${DAY_LABELS[dayType]}・予算${number(budget)}円。施設母集団未確定${incomplete}地域。名称順に表示し、料金の地域順位は作りません。`;
      get('fee-table-caption').textContent = `${DAY_LABELS[dayType]}／通常の一般成人1名／予算${number(budget)}円／データ版 ${manifest.snapshot_id}`;
      get('fee-budget-heading').innerHTML = `予算${html(number(budget))}円以内<br><small>施設数 · Y24</small>`;
      const openedRegions = new Set([...get('fee-region-details').querySelectorAll('details[open][data-region]')]
        .map(details => details.dataset.region));
      get('fee-results').innerHTML = entries.map(entry => summaryRow(entry.region, entry.summary)).join('');
      get('fee-region-details').innerHTML = entries.map(entry => regionDetail(entry.region, entry.population, entry.summary, document)).join('');
      get('fee-region-details').querySelectorAll('details[data-region]').forEach(details => {
        details.open = openedRegions.has(details.dataset.region);
      });
    };
    get('fee-form').addEventListener('submit', event => { event.preventDefault(); render(); });
    get('fee-day-type').addEventListener('change', render);
    get('fee-budget').addEventListener('input', render);
    get('fee-results').addEventListener('click', event => {
      const link = event.target.closest('[data-open-region]');
      if (!link) return;
      const details = [...get('fee-region-details').querySelectorAll('details[data-region]')]
        .find(value => value.dataset.region === link.dataset.openRegion);
      if (details) details.open = true;
    });
    render();
    return { manifest, render };
  } catch (failure) {
    get('fee-controls').disabled = true;
    error(failure.message, true);
    return null;
  }
}

if (typeof document !== 'undefined' && document.getElementById('fees-app')) startFeesPage();
