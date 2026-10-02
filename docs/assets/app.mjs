import { rankRegions } from './scoring.mjs';

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decimal = (value) => value.toFixed(1);
const levelWeights = [0, 0.3, 0.6, 1];
const levelNames = ['使わない', '少し重視', '重視', '特に重視'];
const stateNames = {K:'確認済み', C:'条件付き', Z:'不存在を確認', U:'情報未確認', X:'矛盾あり', F:'資料取得不能', E:'未調査', A:'対象外'};
const presets = {
  aroma: {'S06[odor=sulfur]':1, P17:0.6, B06:0.3, Y01:0.3},
  quiet: {'H18[place=bath]':1, B06:0.6, P17:0.3},
  value: {Y01:1, B06:0.3},
  mild: {'S06[odor=sulfur]':-1, 'H18[place=bath]':0.6, Y01:0.3},
};
let manifest, regions = [], plans = [], views = [], result, currentRows = [];
let state = {weights:{}, selected:[], directions:{}, outdoor:false, budgetEnabled:false, budget:1000, query:'', sort:'score', tab:'confirmed', preset:null};

async function fetchJson(path) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`データを読み込めませんでした（${response.status}）。`);
  return response.json();
}
function verifyRelease(data) {
  for (const key of ['schema_version', 'rubric_version', 'snapshot_id', 'dataset_kind']) {
    if (data[key] !== manifest[key]) throw new Error('異なる版のデータが混在しています。ページを再読み込みしてください。');
  }
}
function activeWeights() { return Object.fromEntries(Object.entries(state.weights).filter(([,w]) => w !== 0)); }
function scoringSettings() {
  const requirements = [];
  if (state.outdoor) requirements.push({metricKey:'B06', operator:'equals', value:1});
  if (state.budgetEnabled) requirements.push({metricKey:'Y01', operator:'atMost', value:state.budget});
  return {weights:activeWeights(), requirements, modality:'daytrip', regionQuery:state.query};
}
function validateConfig(config) {
  if (!config || config.version !== 1 || config.snapshot !== manifest.snapshot_id || config.rubric !== manifest.rubric_version) throw new Error('この共有リンクのデータ版・設定形式は、このデモでは読み込めません。最新版への置き換えは行いません。');
  const keys = new Set(views.map(v => v.key));
  if (!config.weights || typeof config.weights !== 'object' || Array.isArray(config.weights)) throw new Error('好み設定の形式が不正です。');
  for (const [key, value] of Object.entries(config.weights)) if (!keys.has(key) || !Number.isFinite(value) || Math.abs(value) > 1) throw new Error('好みの重みに不正な値があります。');
  if (!Array.isArray(config.selected) || config.selected.some(key => !keys.has(key)) || new Set(config.selected).size !== config.selected.length) throw new Error('選択項目の形式が不正です。');
  if (Object.keys(config.weights).some(key => !config.selected.includes(key))) throw new Error('好み設定と選択項目が一致しません。');
  if (config.directions != null && (typeof config.directions !== 'object' || Array.isArray(config.directions) || Object.entries(config.directions).some(([key,value]) => !keys.has(key) || ![1,-1].includes(value)))) throw new Error('好みの方向が不正です。');
  if (typeof config.outdoor !== 'boolean' || typeof config.budgetEnabled !== 'boolean' || !Number.isFinite(config.budget) || config.budget < 0 || config.budget > 100000) throw new Error('必須条件の値が不正です。');
  if (typeof config.query !== 'string' || config.query.length > 100 || !['score','name','coverage'].includes(config.sort)) throw new Error('表示条件の値が不正です。');
  return config;
}
function readSharedConfig() {
  const encoded = new URLSearchParams(location.hash.slice(1)).get('config');
  if (!encoded) return false;
  if (encoded.length > 12000) throw new Error('共有設定が長すぎます。');
  const config = validateConfig(JSON.parse(encoded));
  state = {...state, ...config, weights:{...config.weights}, selected:[...config.selected], directions:{...(config.directions ?? {})}, tab:'confirmed', preset:null};
  return true;
}
function viewFor(key) { return views.find(view => view.key === key); }
function labelForWeight(value) {
  const exact = levelWeights.indexOf(Math.abs(value));
  return exact >= 0 ? levelNames[exact] : `重み ${Math.abs(value).toFixed(2)}`;
}
function renderControls() {
  $('region-query').value = state.query;
  $('require-outdoor').checked = state.outdoor;
  $('require-budget').checked = state.budgetEnabled;
  $('budget-value').value = state.budget;
  $('budget-value').disabled = !state.budgetEnabled;
  $('sort-order').value = state.sort;
  $('metric-add').innerHTML = '<option value="">特徴を選ぶ</option>' + views.map(view => `<option value="${escapeHtml(view.key)}" ${state.selected.includes(view.key) ? 'disabled' : ''}>${escapeHtml(view.name)}</option>`).join('');
  $('metric-controls').innerHTML = state.selected.length ? state.selected.map(key => {
    const view = viewFor(key), weight = state.weights[key] ?? 0;
    const direction = weight < 0 ? -1 : weight > 0 ? 1 : state.directions[key] ?? 1;
    const nearest = levelWeights.reduce((best, value, index) => Math.abs(value-Math.abs(weight)) < Math.abs(levelWeights[best]-Math.abs(weight)) ? index : best, 0);
    return `<div class="metric-control" data-metric="${escapeHtml(key)}"><div class="metric-top"><label>${escapeHtml(view.name)}<select data-action="direction" aria-label="${escapeHtml(view.name)}の好みの方向"><option value="1" ${direction===1?'selected':''}>${escapeHtml(view.positive)}</option><option value="-1" ${direction===-1?'selected':''}>${escapeHtml(view.negative)}</option></select></label><button type="button" class="remove-metric" data-action="remove" aria-label="${escapeHtml(view.name)}を外す">×</button></div><div class="weight-row"><input type="range" min="0" max="3" step="1" value="${nearest}" data-action="weight" aria-label="${escapeHtml(view.name)}の重要度"><output>${escapeHtml(labelForWeight(weight))}</output></div><p class="metric-description">${escapeHtml(view.description)}</p></div>`;
  }).join('') : '<p class="field-note">選び方の例を使うか、気になる好みを追加してください。</p>';
  document.querySelectorAll('[data-preset]').forEach(button => { const selected = button.dataset.preset === state.preset; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
}
function uniqueExcluded(items, excludedRegionIds) {
  const map = new Map();
  for (const item of items) {
    if (excludedRegionIds.has(item.region.id)) continue;
    const existing = map.get(item.region.id);
    if (existing) existing.items.push(item); else map.set(item.region.id, {region:item.region, items:[item]});
  }
  return [...map.values()].sort((a,b) => a.region.kana.localeCompare(b.region.kana, 'ja'));
}
function requirementLabel(plan, key) {
  const metric = plan.metrics[key];
  const name = viewFor(key)?.name ?? key;
  if (!metric || ['U','E','F','A'].includes(metric.status) || metric.rawLower == null || metric.rawUpper == null) return `${name}：未確認`;
  if (key === 'B06') return `${name}：${metric.rawLower === metric.rawUpper ? metric.rawLower===1?'あり':'なし' : '未確認'}`;
  if (key === 'Y01') return `${name}：${metric.rawLower === metric.rawUpper ? metric.rawLower.toLocaleString('ja-JP') : `${metric.rawLower.toLocaleString('ja-JP')}〜${metric.rawUpper.toLocaleString('ja-JP')}`}円`;
  return `${name}：確認が必要`;
}
function chosenConditionDescription() {
  return [state.outdoor?'露天必須':null, state.budgetEnabled?`入浴料 ${state.budget.toLocaleString('ja-JP')}円以内`:null].filter(Boolean);
}
function renderResults() {
  if (!manifest) return;
  const settings = scoringSettings();
  result = rankRegions(regions, plans, settings);
  const confirmedIds = new Set(result.confirmed.map(row => row.id));
  const pending = uniqueExcluded(result.unknown, confirmedIds);
  const pendingIds = new Set(pending.map(row => row.region.id));
  const failed = uniqueExcluded(result.failed, new Set([...confirmedIds,...pendingIds]));
  const active = Object.entries(activeWeights()), hasScore = active.length > 0;
  $('sort-order').value = hasScore ? state.sort : 'name';
  for (const option of $('sort-order').options) option.disabled = !hasScore && option.value !== 'name';
  $('count-confirmed').textContent = result.confirmed.length;
  $('count-unknown').textContent = pending.length;
  $('count-failed').textContent = failed.length;
  $('result-title').textContent = hasScore ? 'あなたの温泉番付' : '温泉地一覧';
  $('result-subtitle').textContent = hasScore ? `${active.length}つの好みで、条件を満たす浴槽から比較します。` : '好みは未設定です。名前順の一覧から始めます。';
  const conditionChips = chosenConditionDescription();
  $('active-summary').innerHTML = [...conditionChips.map(value => `<span class="condition-chip">${escapeHtml(value)}</span>`), ...active.map(([key,w]) => `<span class="preference-chip">${escapeHtml(viewFor(key).name)} · ${escapeHtml(w<0?viewFor(key).negative:viewFor(key).positive)} · ${escapeHtml(labelForWeight(w))}</span>`)].join('');
  document.querySelectorAll('[data-tab]').forEach(button => { const selected = button.dataset.tab === state.tab; button.classList.toggle('active',selected); button.setAttribute('aria-pressed',String(selected)); });
  $('result-message').textContent = state.tab !== 'confirmed' ? 'この一覧は順位の対象外です。必須条件を確認できた浴槽がない温泉地と、その理由を名前順で表示します。' : hasScore && state.sort !== 'score' ? `${state.sort==='name'?'名前':'根拠取得率'}による表示順です。番付の順位は適合点順のままです。` : hasScore ? '順位は確認できた点の下限で決まります。点の範囲が重なる候補は順番が変わり得ます。' : '選び方の例を選ぶか、好みを追加すると番付を算出します。';
  if (state.tab === 'confirmed') {
    currentRows = [...result.confirmed];
    if (!hasScore || state.sort === 'name') currentRows.sort((a,b) => a.kana.localeCompare(b.kana,'ja'));
    else if (state.sort === 'coverage') currentRows.sort((a,b) => b.score.coverage-a.score.coverage || a.kana.localeCompare(b.kana,'ja'));
    $('ranking-list').innerHTML = currentRows.length ? currentRows.map(row => {
      const score = row.score, m = row.bestPlan.metrics.Y01;
      const price = !m || m.rawLower == null ? '入浴料 未確認' : `入浴料 ${m.rawLower.toLocaleString('ja-JP')}円`;
      const pendingAlternatives = result.unknown.filter(item => item.region.id === row.id).length;
      return `<article class="ranking-card"><div class="rank-number">${row.rank ?? '—'}${row.rank != null ? '<small>位</small>' : ''}</div><div class="region-main"><span class="landscape-tag">${escapeHtml(row.region.landscape)}</span><h3>${escapeHtml(row.name)}</h3><p class="pool-label">${hasScore?'選んだ浴槽':'比較候補の浴槽'} · ${escapeHtml(row.bestPlan.label)}</p><p class="price-label">${escapeHtml(price)}</p>${pendingAlternatives?'<small class="pending-alternative">未確認の別候補あり</small>':''}</div><div class="score-block"><span class="score-caption">${hasScore?'適合点の下限':'まだ未採点'}</span><strong class="score-number">${score?decimal(score.lower):'—'}${score?'<small>点</small>':''}</strong><span class="score-range">${score?`選んだ浴槽の幅 ${decimal(score.lower)}〜${decimal(score.upper)}`:'好みを選ぶと計算します'}</span>${score?`<div class="interval-track" aria-hidden="true"><span class="known-range" style="left:${score.lower}%;width:${Math.max(1,score.upper-score.lower)}%"></span><i style="width:${score.lower}%"></i></div>`:''}</div><div class="evidence-block"><span>根拠取得率</span><strong>${score?Math.round(score.coverage)+'%':'—'}</strong></div><button class="card-action" type="button" data-detail="${escapeHtml(row.id)}">${hasScore?'内訳を見る':'特徴を見る'} <span aria-hidden="true">↗</span></button></article>`;
    }).join('') : `<div class="empty-state"><h3>条件適合を確認できた候補はありません</h3><p>未確認 ${pending.length}温泉地、条件外 ${failed.length}温泉地。必須条件は自動で緩めません。</p></div>`;
  } else {
    const items = state.tab === 'unknown' ? pending : failed;
    currentRows = [];
    $('ranking-list').innerHTML = items.length ? items.map(row => `<article class="excluded-card"><span class="status-label">${state.tab==='unknown'?'必須条件が未確認':'必須条件に不適合'}</span><h3>${escapeHtml(row.region.name)}</h3><p>${row.items.map(item => `${escapeHtml(item.plan.label)}：${settings.requirements.map(req => escapeHtml(requirementLabel(item.plan, req.metricKey))).join(' / ')}`).join('<br>')}</p><small>順位の対象には含めません。</small></article>`).join('') : `<div class="empty-state"><h3>${state.tab==='unknown'?'未確認の候補':'条件外の候補'}はありません</h3><p>選んだ必須条件について、対象の温泉地を分類しています。</p></div>`;
  }
  $('ranking-note').textContent = hasScore ? '点の幅は根拠から拘束できる範囲で、確率ではありません。採用浴槽・同じ条件の値で計算し、未知も重みの分母に残します。' : '好みを選ぶまで順位と総合点は算出しません。料金・運用等はすべて架空のデモ用設定値です。';
}
function render() { renderControls(); renderResults(); }
function rawLabel(metric) {
  if (!metric || metric.rawLower == null || metric.rawUpper == null) return '未確認';
  const unit = metric.unit || '';
  return `${metric.rawLower===metric.rawUpper ? metric.rawLower : `${metric.rawLower}〜${metric.rawUpper}`} ${unit}`.trim();
}
function openDetail(id) {
  const row = currentRows.find(item => item.id === id);
  if (!row) return;
  $('detail-title').textContent = row.name;
  const contributions = row.contributions ?? [];
  const rows = contributions.length ? contributions.map(c => `<tr><th scope="row">${escapeHtml(viewFor(c.metricKey)?.name ?? c.metricKey)}<small>${escapeHtml(c.weight < 0 ? viewFor(c.metricKey)?.negative : viewFor(c.metricKey)?.positive)}</small></th><td>${escapeHtml(rawLabel(row.bestPlan.metrics[c.metricKey]))}</td><td>${escapeHtml(stateNames[c.status])}</td><td>${decimal(c.lower)}〜${decimal(c.upper)}</td><td>${decimal(c.weightedLower)}</td></tr>`).join('') : views.map(v => {const m=row.bestPlan.metrics[v.key]; return `<tr><th scope="row">${escapeHtml(v.name)}</th><td>${escapeHtml(rawLabel(m))}</td><td>${escapeHtml(stateNames[m?.status ?? 'E'])}</td><td>${m?decimal(m.lower)+'〜'+decimal(m.upper):'未確認'}</td><td>—</td></tr>`;}).join('');
  const alternatives = plans.filter(plan => plan.regionId === row.id).map(plan => plan.label).join('、');
  $('detail-content').innerHTML = `<p class="detail-note"><strong>${escapeHtml(row.bestPlan.label)}</strong><br>${escapeHtml(row.bestPlan.condition_label)}</p><p>${escapeHtml(row.region.summary)}</p><div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>選んだ特徴</th><th>生値</th><th>状態</th><th>適合点の幅</th><th>下限への寄与</th></tr></thead><tbody>${rows}</tbody></table></div><p class="detail-note">${row.score?`同じ浴槽での下限 ${decimal(row.score.lower)}点 / 上限 ${decimal(row.score.upper)}点。根拠取得率 ${decimal(row.score.coverage)}%。`:'好みが未設定のため、総合点はまだ算出していません。'}</p>${row.bestEnvelope&&row.score ? `<p class="field-note">条件適合の浴槽集合で最良を選ぶ場合の幅は ${decimal(row.bestEnvelope.lower)}〜${decimal(row.bestEnvelope.upper)}点。上限側では別の浴槽が候補になる場合があります。</p>` : ''}<p class="field-note">この温泉地の比較候補：${escapeHtml(alternatives)}</p><p class="demo-notice">${escapeHtml(row.bestPlan.evidence_note)}</p>`;
  $('detail-dialog').showModal();
}

$('metric-add').addEventListener('change', event => {
  const key=event.target.value;
  if (!key || state.selected.includes(key)) return;
  state.selected.push(key); state.weights[key]=0.6; state.directions[key]=1; state.preset=null; render();
});
$('metric-controls').addEventListener('change', event => {
  const control=event.target.closest('[data-metric]'); if (!control) return;
  const key=control.dataset.metric;
  if (event.target.dataset.action==='direction') { state.directions[key]=Number(event.target.value); state.weights[key]=Math.abs(state.weights[key]??0)*state.directions[key]; }
  if (event.target.dataset.action==='weight') state.weights[key]=levelWeights[Number(event.target.value)]*(state.directions[key]??1);
  const action = event.target.dataset.action;
  state.preset=null; render();
  const updated = [...$('metric-controls').querySelectorAll('[data-metric]')].find(item=>item.dataset.metric===key);
  updated?.querySelector(`[data-action="${action}"]`)?.focus({preventScroll:true});
});
$('metric-controls').addEventListener('click', event => {
  if (event.target.dataset.action !== 'remove') return;
  const key=event.target.closest('[data-metric]').dataset.metric;
  state.selected=state.selected.filter(item=>item!==key); delete state.weights[key]; delete state.directions[key]; state.preset=null; render();
});
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click',()=>{
  state.weights={...presets[button.dataset.preset]}; state.selected=Object.keys(state.weights); state.directions=Object.fromEntries(Object.entries(state.weights).map(([key,w])=>[key,Math.sign(w)])); state.preset=button.dataset.preset; render();
}));
$('region-query').addEventListener('input',event=>{state.query=event.target.value.slice(0,100); renderResults();});
$('require-outdoor').addEventListener('change',event=>{state.outdoor=event.target.checked; render();});
$('require-budget').addEventListener('change',event=>{state.budgetEnabled=event.target.checked; render();});
$('budget-value').addEventListener('change',event=>{
  const value=event.target.value.trim()==='' ? NaN : Number(event.target.value);
  if (!Number.isFinite(value)||value<0||value>100000) { event.target.setCustomValidity('0〜100,000円の数値を指定してください。'); event.target.reportValidity(); return; }
  event.target.setCustomValidity(''); state.budget=value; renderResults();
});
$('sort-order').addEventListener('change',event=>{state.sort=event.target.value; renderResults();});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.tab; renderResults();}));
$('reset-settings').addEventListener('click',()=>{state.weights={}; state.selected=[]; state.directions={}; state.preset=null; $('settings-message').textContent='好みをリセットしました。必須条件はそのままです。'; render();});
$('ranking-list').addEventListener('click',event=>{const button=event.target.closest('[data-detail]'); if(button)openDetail(button.dataset.detail);});
$('close-detail').addEventListener('click',()=>$('detail-dialog').close());
$('detail-dialog').addEventListener('click',event=>{if(event.target===$('detail-dialog'))$('detail-dialog').close();});
$('share-settings').addEventListener('click',async()=>{
  if (!manifest) return;
  const config={version:1,snapshot:manifest.snapshot_id,rubric:manifest.rubric_version,weights:activeWeights(),selected:state.selected,directions:state.directions,outdoor:state.outdoor,budgetEnabled:state.budgetEnabled,budget:state.budget,query:state.query,sort:state.sort};
  const url=new URL(location.href); url.hash=new URLSearchParams({config:JSON.stringify(config)}).toString();
  history.replaceState(null,'',url);
  try {await navigator.clipboard.writeText(url.toString()); $('share-link').hidden=true; $('settings-message').textContent='架空データ版と好みの設定を含むリンクをコピーしました。';}
  catch {$('share-link').value=url.toString(); $('share-link').hidden=false; $('share-link').select(); $('settings-message').textContent='このリンクを選択してコピーしてください。';}
});

async function start() {
  try {
    manifest=await fetchJson('./data/manifest.json');
    if(manifest.dataset_kind!=='synthetic_demo'||manifest.schema_version!=='1')throw new Error('この試作が扱えるデータ形式ではありません。');
    const [regionData,rankingData,viewData]=await Promise.all([fetchJson(manifest.regions_url),fetchJson(manifest.ranking_url),fetchJson(manifest.views_url)]);
    [regionData,rankingData,viewData].forEach(verifyRelease);
    regions=regionData.regions; plans=rankingData.plans; views=viewData.views;
    if(regions.length!==manifest.region_count||plans.length!==manifest.plan_count)throw new Error('索引と候補データの件数が一致しません。');
    $('snapshot-label').textContent=manifest.snapshot_id;
    if(readSharedConfig())$('settings-message').textContent='共有された好み・必須条件を復元しました。';
    if(matchMedia('(max-width: 860px)').matches)$('settings-panel').open=false;
    render();
  } catch(error) {
    manifest=null;
    $('result-subtitle').textContent='番付を計算できませんでした。';
    $('ranking-list').innerHTML=`<div class="empty-state"><h3>データ・設定の確認が必要です</h3><p>${escapeHtml(error.message)}</p><p>未読込の候補を未知の採点値に置き換えることはありません。</p><button type="button" class="share-button" id="reload-data">再読み込み</button></div>`;
    $('ranking-note').textContent='公開フォルダをHTTPで開いているか、指定データ版が存在するか確認してください。';
    $('reload-data').addEventListener('click',()=>location.reload());
    document.querySelectorAll('.settings-panel button,.settings-panel input,.settings-panel select').forEach(control=>control.disabled=true);
  }
}
start();
