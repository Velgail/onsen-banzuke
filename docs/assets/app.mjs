import { rankRegions, evaluateRequirement } from './scoring.mjs';
import { buildCatalogViews, parameterView } from './catalog.mjs';
import { createSettings, validateConfig } from './settings.mjs';
import { comparisonPlans } from './comparison.mjs';
import { attachRegionalFeeMetrics, validateFeePopulations } from './regional-features.mjs';

const $ = id => document.getElementById(id);
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Evidence-ledger rendering shares the escaping function used by the controls.
const escapeHtml = html;
const ledgerCache = new Map();
const decimal = value => value.toFixed(1);
const numberValue = input => input.value.trim() === '' ? null : Number(input.value);
const groups = {I:'公開情報',C:'成分・液性',O:'湧出・供給',P:'湯の加工',F:'新湯・鮮度',S:'湯の知覚',B:'入浴温度・形態',V:'温泉地の幅',R:'希少性',H:'街・過ごし方',A:'地域活動',M:'地域IP',X:'アクセス',Y:'料金・滞在',Z:'設備・利用条件',E:'資源・環境'};
const stateNames = {K:'確認済み',C:'条件付き',Z:'不存在を確認',U:'情報未確認',X:'矛盾あり',F:'資料取得不能',E:'未調査',A:'対象外'};
const entityNames = {region:'地域',facility:'施設',facility_scope:'施設範囲・個別浴槽未特定',bath:'浴槽',bath_group:'浴槽群・共通条件',plan:'利用プラン',analysis_sample:'分析試料',source:'源泉',supply:'供給系統'};
const operators = {atLeast:'以上',atMost:'以下',within:'範囲内',equals:'一致'};
const presets = {
  aroma:{'S06[odor=sulfur]':1,P17:0.6,B06:0.3,Y01:0.3},
  quiet:{'H18[place=bath]':1,B06:0.6,P17:0.3},
  value:{Y01:1,B06:0.3},
  mild:{'S06[odor=sulfur]':-1,'H18[place=bath]':0.6,Y01:0.3},
};
let manifest, catalog, regions = [], plans = [], views = [], feePopulations = [], currentRows = [];
let state = createSettings();
let comparisonDayType = 'weekday';
let pickerQuery = '', pickerGroup = '';
const viewFor = key => views.find(view => view.key === key);
const nameFor = key => viewFor(key)?.name ?? key;
const activeWeights = () => Object.fromEntries(Object.entries(state.weights).filter(([,w]) => w !== 0));
const configFor = () => ({version:2,snapshot:manifest.snapshot_id,rubric:manifest.rubric_version,
  weights:state.weights,selected:state.selected,targetFits:state.targetFits,requirements:state.requirements,
  modality:state.modality,dayType:comparisonDayType,query:state.query,sort:state.sort,groupBudgets:state.groupBudgets});
const settingsFor = () => ({weights:state.weights,targetFits:state.targetFits,requirements:state.requirements,
  modality:state.modality,regionQuery:state.query,groupBudgets:state.groupBudgets});
const preferenceLabel = key => state.targetFits[key]
  ? `${state.weights[key] < 0 ? '希望帯から離れる' : '希望帯に近い'} ${state.targetFits[key].min}〜${state.targetFits[key].max}（減衰幅 ${state.targetFits[key].decay}）`
  : state.weights[key] < 0 ? viewFor(key).negative : viewFor(key).positive;

async function fetchJson(path) {
  const response = await fetch(new URL(path, document.baseURI));
  if (!response.ok) throw new Error(`公開データを読み込めませんでした（${response.status}）：${path}`);
  return response.json();
}
function verifyRelease(data) {
  for (const key of ['schema_version','rubric_version','snapshot_id','dataset_kind'])
    if (data[key] !== manifest[key]) throw new Error('異なる版のデータが混在しています。');
}
function ensureView(key) {
  let view = viewFor(key);
  if (view && !view.template) return view;
  const match = /^([A-Z]\d{2})(?:\[(.*)\])?$/.exec(key);
  if (!match) throw new Error('項目IDの形式が不正です。');
  view = parameterView(catalog, views, match[1], match[2] ?? '');
  if (!viewFor(view.key)) views.push(view);
  return view;
}
function conditionLeaves(node) {
  return node.conditions ? node.conditions.flatMap(conditionLeaves) : [node];
}
function readSharedConfig() {
  const encoded = new URLSearchParams(location.hash.slice(1)).get('config');
  if (!encoded) return false;
  if (encoded.length > 200000) throw new Error('共有設定が長すぎます。');
  const shared = JSON.parse(encoded);
  comparisonDayType = shared.dayType ?? 'weekday';
  comparisonPlans([], {modality: shared.modality ?? 'daytrip', dayType: comparisonDayType});
  state = validateConfig(shared, manifest, catalog, views);
  [...state.selected,...conditionLeaves(state.requirements).map(node=>node.metricKey)].forEach(ensureView);
  return true;
}
function renderPicker() {
  const previous = $('metric-add').value;
  const query = pickerQuery.trim().toLocaleLowerCase('ja');
  const matches = views.filter(view => (!pickerGroup || view.group === pickerGroup)
    && (!query || [view.key,view.name,view.description].join(' ').toLocaleLowerCase('ja').includes(query)));
  $('metric-add').innerHTML = '<option value="">特徴を選ぶ</option>' + matches.map(view=>`<option value="${html(view.key)}">${html(view.key)} · ${html(view.name)}${view.template?'（パラメータ指定）':''}</option>`).join('');
  if (matches.some(view=>view.key===previous)) $('metric-add').value=previous;
  $('metric-picker-note').textContent = `${catalog.basic_metric_count}基本項目と条件別の項目から選べます。現在の候補 ${matches.length}件。未調査の項目も選択できます。`;
  renderParameterHelp();
}
function renderParameterHelp() {
  const view = viewFor($('metric-add').value);
  const budget = ['Y24','Y25'].includes(view?.metricId);
  $('metric-budget-field').hidden = !budget;
  $('metric-parameters-field').hidden = !view?.template || budget;
  const entries = Object.entries(view?.parameters ?? {});
  $('metric-parameters-help').textContent = entries.map(([key,definition])=>`${key}: ${typeof definition==='string'?definition:JSON.stringify(definition)}`).join(' / ');
  $('add-preference').disabled = $('add-requirement').disabled = !view;
}
function selectedView() {
  const view = viewFor($('metric-add').value);
  if (!view) throw new Error('追加する特徴を選んでください。');
  if (!view.template) return view;
  const parameterText = ['Y24','Y25'].includes(view.metricId) ? `budget=${$('metric-budget').value}` : $('metric-parameters').value;
  const created = parameterView(catalog,views,view.key,parameterText);
  if (!viewFor(created.key)) views.push(created);
  return created;
}
function restoreFocus(container, selector) {
  container.querySelector(selector)?.focus({preventScroll:true});
}
function renderPreferences() {
  $('metric-controls').innerHTML = state.selected.map(key => {
    const view = viewFor(key), weight = state.weights[key] ?? 0, fit = state.targetFits[key];
    return `<div class="metric-control" data-metric="${html(key)}"><div class="metric-top"><strong>${html(view.name)}<small>${html(key)}</small></strong><button type="button" data-action="remove" aria-label="${html(view.name)}を外す">×</button></div>
      <label class="filter-field">採点の方法<select data-action="mode" aria-label="${html(view.name)}の採点方法"><option value="standard" ${fit?'':'selected'}>特徴の方向で採点</option>${view.formula==='B'?'':`<option value="target" ${fit?'selected':''}>希望する数値帯への近さ</option>`}</select></label>
      <p class="metric-description">${html(view.description)}<br>生値の単位：${html(view.unit || view.raw || catalog.metrics.find(m=>m.id===key.slice(0,3))?.raw)}${fit?'':` / ＋：${html(view.positive)} / −：${html(view.negative)}`}</p>
      ${fit?`<div class="target-inputs"><label>帯の下限<input type="number" step="any" data-action="min" value="${fit.min??''}" aria-label="${html(view.name)}の希望帯下限"></label><label>帯の上限<input type="number" step="any" data-action="max" value="${fit.max??''}" aria-label="${html(view.name)}の希望帯上限"></label><label>減衰幅<input type="number" step="any" min="0" data-action="decay" value="${fit.decay??''}" aria-label="${html(view.name)}の減衰幅"></label></div><p class="field-note">帯の中は100点。帯から減衰幅だけ離れると0点。元の尺度を置き換えて計算します。</p>`:''}
      <div class="weight-row"><input type="range" min="-1" max="1" step="0.01" value="${weight}" data-action="weight-range" aria-label="${html(view.name)}の重みスライダー"><input type="number" min="-1" max="1" step="any" value="${weight}" data-action="weight" aria-label="${html(view.name)}の重み"></div><p class="field-note">重み −1〜1。0は採点に使いません。</p></div>`;
  }).join('') || '<p class="field-note">採点する特徴を追加し、重みを指定してください。</p>';
  $('weight-mode').value=state.groupBudgets===null?'flat':'groups';
  renderGroups();
}
function renderGroups() {
  $('group-controls').innerHTML = state.groupBudgets===null ? '' : `<p class="field-note">分野内で項目の重みを正規化し、分野予算で得点を配分します。未指定は0。正の予算には重みが0以外の項目が必要です。</p>`+Object.entries(groups).map(([id,name])=>`<label class="group-budget">${html(name)}<input type="number" min="0" step="any" data-group="${id}" value="${state.groupBudgets[id]??0}" aria-label="${html(name)}の分野予算"></label>`).join('');
}
const pathText = path => path.join('.');
function conditionAt(path) {
  return path === '' ? state.requirements : path.split('.').reduce((node,index)=>node.conditions[Number(index)],state.requirements);
}
function renderCondition(node, path=[]) {
  const address = pathText(path), root = !path.length;
  if (node.conditions) return `<fieldset class="condition-group" data-path="${address}"><legend>${root?'条件の組み合わせ':'条件グループ'}</legend><div class="condition-heading"><select data-action="logic" aria-label="${root?'全体':'グループ'}の条件の組み合わせ">${[['and','すべて満たす（AND）'],['or','いずれか満たす（OR）'],['not','満たさない（NOT）']].map(([op,label])=>`<option value="${op}" ${node.operator===op?'selected':''}>${label}</option>`).join('')}</select>${root?'':`<button type="button" data-action="remove-condition" aria-label="条件グループを削除">×</button>`}</div>${node.conditions.map((child,i)=>renderCondition(child,[...path,i])).join('')}<div class="condition-actions"><button type="button" data-action="add-leaf">選択中の特徴を追加</button><button type="button" data-action="add-group">グループを追加</button></div></fieldset>`;
  const type = node.valueType ?? (typeof node.value==='string'?'string':typeof node.value==='boolean'?'boolean':'number');
  return `<div class="condition-leaf" data-path="${address}"><div class="metric-top"><strong>${html(nameFor(node.metricKey))}<small>${html(node.metricKey)}</small></strong><button type="button" data-action="remove-condition" aria-label="${html(nameFor(node.metricKey))}の必須条件を削除">×</button></div><p class="field-note">生値：${html(viewFor(node.metricKey)?.unit || catalog.metrics.find(m=>m.id===node.metricKey.slice(0,3))?.raw)}</p><select data-action="operator" aria-label="${html(nameFor(node.metricKey))}の条件">${Object.entries(operators).map(([op,label])=>`<option value="${op}" ${node.operator===op?'selected':''}>${label}</option>`).join('')}</select>
    ${node.operator==='within'?`<div class="target-inputs"><label>下限<input type="number" step="any" data-action="condition-min" value="${node.min??''}"></label><label>上限<input type="number" step="any" data-action="condition-max" value="${node.max??''}"></label></div>`:`${node.operator==='equals'?`<select data-action="value-type" aria-label="条件値の種類"><option value="number" ${type==='number'?'selected':''}>数値</option><option value="string" ${type==='string'?'selected':''}>文字</option><option value="boolean" ${type==='boolean'?'selected':''}>真偽値</option></select>`:''}<label class="filter-field">条件値${type==='boolean'&&node.operator==='equals'?`<select data-action="condition-value"><option value="true" ${node.value===true?'selected':''}>true</option><option value="false" ${node.value===false?'selected':''}>false</option></select>`:`<input type="${type==='string'&&node.operator==='equals'?'text':'number'}" step="any" data-action="condition-value" value="${html(node.value??'')}">`}</label>`}</div>`;
}
function renderControls() {
  $('region-query').value=state.query; $('modality').value=state.modality; $('sort-order').value=state.sort;
  $('day-type').value=comparisonDayType;
  renderPreferences(); $('requirement-controls').innerHTML=renderCondition(state.requirements);
  document.querySelectorAll('[data-preset]').forEach(button=>{const active=button.dataset.preset===state.preset;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
}
function conditionDescription(node) {
  if (node.conditions) {
    if (!node.conditions.length) return '';
    if (node.operator==='not') return `NOT（${conditionDescription(node.conditions[0])}）`;
    return `（${node.conditions.map(conditionDescription).join(node.operator==='and'?' AND ':' OR ')}）`;
  }
  return `${nameFor(node.metricKey)} ${node.operator==='within'?`${node.min}〜${node.max}`:`${node.value} ${operators[node.operator]}`}`;
}
function uniqueExcluded(items, excludedIds) {
  const map=new Map();
  for(const item of items){if(excludedIds.has(item.region.id))continue;const row=map.get(item.region.id);if(row)row.items.push(item);else map.set(item.region.id,{region:item.region,items:[item]});}
  return [...map.values()].sort((a,b)=>a.region.kana.localeCompare(b.region.kana,'ja'));
}
function showCalculationError(error) {
  currentRows=[]; $('result-title').textContent='設定を確認してください';
  $('result-subtitle').textContent='入力がそろうまで得点と順位を計算しません。';
  $('ranking-list').innerHTML=`<div class="empty-state"><h3>条件・重みの設定が未完了です</h3><p>${html(error.message)}</p><p>希望帯は下限≦上限、減衰幅は0より大きい数値で指定してください。必須条件の数値と分野予算も確認してください。</p></div>`;
  ['count-confirmed','count-unknown','count-failed'].forEach(id=>$(id).textContent='—');
  $('result-message').textContent='不正な値を既定値に置き換えず、再計算を止めています。'; $('ranking-note').textContent=''; $('active-summary').innerHTML='';
}
function currentCandidates() {
  const source = manifest.dataset_kind === 'synthetic_demo'
    ? plans.map(plan => plan.day_type == null ? {...plan, day_type:'all'} : plan) : plans;
  const candidates = comparisonPlans(source, {modality:state.modality, dayType:comparisonDayType});
  return attachRegionalFeeMetrics(candidates, feePopulations,
    [...state.selected, ...conditionLeaves(state.requirements).map(node => node.metricKey)],
    {dayType:comparisonDayType});
}
function renderResults() {
  if (!manifest) return;
  try {
    validateConfig(configFor(),manifest,catalog,views);
    const candidates=currentCandidates();
    const result=rankRegions(regions,candidates,settingsFor());
    const pending=uniqueExcluded(result.unknown,new Set(result.confirmed.map(row=>row.id)));
    const candidateIds=new Set(candidates.map(plan=>plan.regionId));
    for (const region of regions) if (!candidateIds.has(region.id) && (!state.query || [region.name,region.kana,region.id].some(value=>value?.normalize('NFKC').includes(state.query.normalize('NFKC'))))) pending.push({region,items:[],missingPlan:true});
    pending.sort((a,b)=>a.region.kana.localeCompare(b.region.kana,'ja'));
    const failed=uniqueExcluded(result.failed,new Set([...result.confirmed.map(row=>row.id),...pending.map(row=>row.region.id)]));
    const active=Object.entries(activeWeights());
    const hasScore=active.length>0&&(state.groupBudgets===null||Object.values(state.groupBudgets).some(value=>value>0));
    const provisional=result.confirmed.some(row=>row.contributions.some(c=>c.status==='E'&&c.coefficient>0));
    $('sort-order').value=hasScore?state.sort:'name';for(const option of $('sort-order').options)option.disabled=!hasScore&&option.value!=='name';
    $('count-confirmed').textContent=result.confirmed.length; $('count-unknown').textContent=pending.length; $('count-failed').textContent=failed.length;
    $('result-title').textContent=hasScore?'あなたの温泉番付（暫定）':'温泉地一覧';
    $('result-subtitle').textContent=hasScore?`${active.length}項目の設定で、同じ浴槽・プランの得点を再計算しました。`:'採点する重みは未設定です。名前順で表示します。';
    const condition=conditionDescription(state.requirements);
    $('active-summary').innerHTML=(condition?`<span class="condition-chip">${html(condition)}</span>`:'')+active.map(([key,w])=>`<span class="preference-chip">${html(nameFor(key))} · ${html(preferenceLabel(key))} · 重み ${w}</span>`).join('');
    document.querySelectorAll('[data-tab]').forEach(button=>{const selected=button.dataset.tab===state.tab;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
    $('result-message').textContent=state.tab!=='confirmed'?'必須条件を満たすと確認できない候補と理由を表示します。':hasScore?(provisional?'採点に使う未調査項目があります。暫定の下限順です。':'確認できた点の下限順です。')+' 点の範囲が重なる候補は順番が変わり得ます。'+(state.sort!=='score'?`表示は${state.sort==='name'?'名前':'根拠取得率'}順です。`:''):'項目の重みを指定すると番付を計算します。';
    if(state.tab==='confirmed'){
      currentRows=[...result.confirmed];
      if(!hasScore||state.sort==='name')currentRows.sort((a,b)=>a.kana.localeCompare(b.kana,'ja'));
      else if(state.sort==='coverage')currentRows.sort((a,b)=>b.score.coverage-a.score.coverage||a.kana.localeCompare(b.kana,'ja'));
      $('ranking-list').innerHTML=currentRows.map(row=>{
        const score=row.score, priceKey=row.bestPlan.modality==='stay'?['Y03','Y04'].find(key=>row.bestPlan.metrics[key]):'Y01';
        const price=priceKey?row.bestPlan.metrics[priceKey]:undefined;
        const priceLabel=price?.rawLower!=null?`${row.bestPlan.modality==='daytrip'?'採用候補の入浴料':nameFor(priceKey)} ${rawLabel(price)}`:'料金 未確認';
        return `<article class="ranking-card"><div class="rank-number">${row.rank??'—'}${row.rank!=null?'<small>位</small>':''}</div><div class="region-main"><span class="landscape-tag">${html(row.region.landscape)}</span><h3>${html(row.name)}</h3><p class="pool-label">採用候補 · ${html(row.bestPlan.label)}${['facility_scope','bath_group'].includes(row.bestPlan.entity_scope)?'（'+html(entityNames[row.bestPlan.entity_scope])+'）':''}</p><p class="price-label">${html(priceLabel)}</p>${result.unknown.some(item=>item.region.id===row.id)?'<small class="pending-alternative">未確認の別候補あり</small>':''}</div><div class="score-block"><span class="score-caption">${score?'適合点の下限':'まだ未採点'}</span><strong class="score-number">${score?decimal(score.lower):'—'}${score?'<small>点</small>':''}</strong><span class="score-range">${score?`幅 ${decimal(score.lower)}〜${decimal(score.upper)}`:'重みを指定してください'}</span>${score?`<div class="interval-track" aria-hidden="true"><span class="known-range" style="left:${score.lower}%;width:${Math.max(1,score.upper-score.lower)}%"></span><i style="width:${score.lower}%"></i></div>`:''}</div><div class="evidence-block"><span>根拠取得率</span><strong>${score?Math.round(score.coverage)+'%':'—'}</strong>${score?`<small>数値確定度 ${Math.round(score.certainty)}%</small>`:''}</div><button class="card-action" type="button" data-detail="${html(row.id)}">内訳を見る <span aria-hidden="true">↗</span></button></article>`;
      }).join('')||`<div class="empty-state"><h3>条件適合を確認できた候補はありません</h3><p>未確認 ${pending.length}温泉地、条件外 ${failed.length}温泉地。条件は自動で緩めません。</p></div>`;
    }else{
      currentRows=[];const items=state.tab==='unknown'?pending:failed;
      $('ranking-list').innerHTML=items.map(row=>`<article class="excluded-card"><span class="status-label">${state.tab==='unknown'?row.missingPlan?'比較候補の調査未完了':'必須条件が未確認':'必須条件に不適合'}</span><h3>${html(row.region.name)}</h3><p>${row.items.map(item=>`${html(item.plan.label)}：${item.reasons.map(reason=>html(reason)).join(' / ')}<br>${conditionLeaves(state.requirements).map(condition=>`${html(conditionDescription(condition))}：${html(rawLabel(item.plan.metrics[condition.metricKey]))}（${{pass:'適合',fail:'不適合',unknown:'未確認'}[evaluateRequirement(item.plan.metrics[condition.metricKey],condition)]}）`).join(' / ')}`).join('<br>')}</p>${row.region.report_url?`<p><a href="${escapeHtml(row.region.report_url)}">調査台帳を読む ↗</a></p>`:""}<small>順位の対象には含めません。</small></article>`).join('')||'<div class="empty-state"><h3>該当する候補はありません</h3></div>';
    }
    $('ranking-note').textContent='点の幅は根拠から拘束できる範囲で、確率ではありません。未確認・未調査の項目も重みの分母に残します。採用候補の生値と指定した条件で計算しています。';
  }catch(error){showCalculationError(error);}
}
function render(){renderControls();renderResults();}
function rawLabel(metric){
  if(!metric)return'未調査';
  if(metric.rawLower==null&&metric.rawUpper==null)return metric.raw==null?'未確認':String(metric.raw);
  const lower=metric.rawLower??'下限未確認',upper=metric.rawUpper??'上限未確認';
  const unit=metric.unit==='JPY'?'円':metric.unit??'';
  return `${lower===upper?lower:`${lower}〜${upper}`} ${unit}`.trim();
}
async function openDetail(id) {
  const row = currentRows.find(item => item.id === id);
  if (!row) return;
  $('detail-title').textContent = row.name;
  $('detail-content').innerHTML = '<p>出典台帳を読み込んでいます。</p>';
  $('detail-dialog').showModal();
  try {
    let ledger = ledgerCache.get(id);
    if (!ledger && row.region.ledger_url) { ledger = await fetchJson(row.region.ledger_url); verifyRelease(ledger); ledgerCache.set(id,ledger); }
    ledger ??= {sources:[],coverage:null};
    if ($('detail-title').textContent !== row.name) return;
    const sourceMap = new Map(ledger.sources.map(source=>[source.id,source]));
    const contributions = row.contributions ?? [];
    const selected = contributions.length ? contributions.map(c=>({key:c.metricKey,c})) : Object.keys(row.bestPlan.metrics).map(key=>({key}));
    const rows = selected.map(({key,c})=>{
      const m = row.bestPlan.metrics[key];
      const sources = (m?.evidence_ids??[]).map(id=>sourceMap.get(id)).filter(Boolean);
      const refs = sources.map(source=>`<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.title)}</a>`).join(' / ');
      return `<tr><th scope="row">${escapeHtml(nameFor(key))}<small>${c?`${escapeHtml(preferenceLabel(key))}<br>重み ${c.weight} / 配分 ${decimal(c.coefficient*100)}%`:''}</small></th><td>${escapeHtml(rawLabel(m))}<small>${escapeHtml(entityNames[m?.entity_scope]??m?.entity_scope??'')} / ${escapeHtml(m?.entity_id??'')}</small></td><td>${escapeHtml(stateNames[m?.status??'E'])}</td><td>${c?decimal(c.lower)+'〜'+decimal(c.upper):m?decimal(m.lower)+'〜'+decimal(m.upper):'0〜100'}</td><td>${c?decimal(c.weightedLower):'—'}</td></tr><tr class="evidence-row"><td colspan="5">${escapeHtml(m?.reason??(m?'':'この条件の調査未完了。'))} ${escapeHtml(m?.condition??'')}<br>${refs}</td></tr>`;
    }).join('');
    const alternatives = plans.filter(plan=>plan.regionId===id).map(plan=>`${plan.label}（${plan.modality==='stay'?'宿泊':'日帰り'} / ${plan.day_type??'曜日未指定'}）`).join('、');
    $('detail-content').innerHTML = `<p class="detail-note"><strong>${escapeHtml(row.bestPlan.label)}</strong><br>${escapeHtml(row.bestPlan.condition_label)}</p><p>${escapeHtml(row.region.summary)}</p>${ledger.coverage?`<p class="demo-notice">初回部分調査：${ledger.coverage.basic_metrics_with_observations}/${catalog.basic_metric_count}基本項目に調査行あり。全浴槽・全条件の網羅ではありません。</p>`:""}${row.region.report_url?`<p><a href="${escapeHtml(row.region.report_url)}">全項目・分析試料・残課題・根拠一覧を読む ↗</a></p>`:""}<div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>選んだ特徴</th><th>生値・適用実体</th><th>状態</th><th>適合点の幅</th><th>下限への寄与</th></tr></thead><tbody>${rows}</tbody></table></div><p class="detail-note">${row.score?`採用プラン下限 ${decimal(row.score.lower)}点 / 上限 ${decimal(row.score.upper)}点。根拠取得率 ${decimal(row.score.coverage)}%、数値確定度 ${decimal(row.score.certainty)}%。`:'好みが未設定のため総合点は算出していません。'}</p>${row.bestEnvelope&&row.score?`<p class="field-note">同条件候補集合から最良を選ぶ幅：${decimal(row.bestEnvelope.lower)}〜${decimal(row.bestEnvelope.upper)}点。上限側は別の候補の場合があります。</p>`:''}<p class="field-note">収録候補：${escapeHtml(alternatives)}</p><p class="field-note">${escapeHtml(row.bestPlan.evidence_note)}</p>`;
  } catch(error) { $('detail-content').innerHTML=`<p>${escapeHtml(error.message)}</p><p><a href="${escapeHtml(row.region.report_url)}">調査台帳を読む</a></p>`; }
}

function reportSettingError(error){$('settings-message').textContent=error.message;}
function newLeaf(view){return {metricKey:view.key,operator:view.formula==='B'?'equals':'atLeast',value:view.formula==='B'?1:null};}
function addChild(group,child){
  if(group.operator==='not'&&group.conditions.length)group.conditions[0]={operator:'and',conditions:[group.conditions[0],child]};
  else group.conditions.push(child);
}
$('metric-search').addEventListener('input',event=>{pickerQuery=event.target.value;renderPicker();});
$('metric-group').addEventListener('change',event=>{pickerGroup=event.target.value;renderPicker();});
$('metric-add').addEventListener('change',()=>{$('metric-parameters').value='';$('metric-budget').value='';renderParameterHelp();});
$('add-preference').addEventListener('click',()=>{
  try{const view=selectedView();if(state.selected.includes(view.key))throw new Error('この特徴はすでに採点に追加されています。');state.selected.push(view.key);state.weights[view.key]=0;state.preset=null;$('settings-message').textContent='重みを指定して採点してください。';render();}catch(error){reportSettingError(error);}
});
$('add-requirement').addEventListener('click',()=>{try{addChild(state.requirements,newLeaf(selectedView()));render();}catch(error){reportSettingError(error);}});
$('metric-controls').addEventListener('click',event=>{
  if(event.target.dataset.action!=='remove')return;const key=event.target.closest('[data-metric]').dataset.metric;
  state.selected=state.selected.filter(item=>item!==key);delete state.weights[key];delete state.targetFits[key];state.preset=null;render();
});
function changePreference(event){
  const control=event.target.closest('[data-metric]');if(!control)return;
  const key=control.dataset.metric,action=event.target.dataset.action;
  if(action==='weight'||action==='weight-range'){
    state.weights[key]=numberValue(event.target);const other=control.querySelector(`[data-action="${action==='weight'?'weight-range':'weight'}"]`);if(other)other.value=state.weights[key]??'';
  }else if(['min','max','decay'].includes(action))state.targetFits[key][action]=numberValue(event.target);
  else if(action==='mode'){
    if(event.target.value==='target')state.targetFits[key]={min:null,max:null,decay:null};else delete state.targetFits[key];
    renderPreferences();restoreFocus($('metric-controls'),`[data-metric="${CSS.escape(key)}"] [data-action="mode"]`);
  }else return;
  state.preset=null;renderResults();
}
$('metric-controls').addEventListener('input',event=>{if(event.target.dataset.action!=='mode')changePreference(event);});
$('metric-controls').addEventListener('change',event=>{if(event.target.dataset.action==='mode')changePreference(event);});
$('weight-mode').addEventListener('change',event=>{state.groupBudgets=event.target.value==='flat'?null:{};state.preset=null;renderGroups();renderResults();});
$('group-controls').addEventListener('input',event=>{if(event.target.dataset.group){state.groupBudgets[event.target.dataset.group]=numberValue(event.target);renderResults();}});
$('requirement-controls').addEventListener('click',event=>{
  const action=event.target.dataset.action,control=event.target.closest('[data-path]');if(!control)return;
  const path=control.dataset.path,node=conditionAt(path);
  try{
    if(action==='remove-condition'){const indices=path.split('.');const index=Number(indices.pop());conditionAt(indices.join('.')).conditions.splice(index,1);}
    else if(action==='add-leaf')addChild(node,newLeaf(selectedView()));
    else if(action==='add-group')addChild(node,{operator:'and',conditions:[]});
    else return;
    render();
  }catch(error){reportSettingError(error);}
});
$('requirement-controls').addEventListener('change',event=>{
  const control=event.target.closest('[data-path]');if(!control)return;
  const node=conditionAt(control.dataset.path),action=event.target.dataset.action,value=event.target.value;
  if(action==='logic'){
    if(value==='not'&&node.conditions.length!==1)node.conditions=[{operator:node.operator,conditions:node.conditions}];
    node.operator=value;
  }else if(action==='operator'){
    node.operator=value;delete node.valueType;delete node.value;delete node.min;delete node.max;
    if(value==='within'){node.min=null;node.max=null;}else node.value=null;
  }else if(action==='value-type'){node.valueType=value;node.value=value==='string'?'':value==='boolean'?true:null;}
  else if(action==='condition-min')node.min=numberValue(event.target);
  else if(action==='condition-max')node.max=numberValue(event.target);
  else if(action==='condition-value'){
    const type=node.valueType??typeof node.value;
    node.value=type==='string'?value:type==='boolean'?value==='true':numberValue(event.target);
  }
  else return;
  if(['logic','operator','value-type'].includes(action)){$('requirement-controls').innerHTML=renderCondition(state.requirements);restoreFocus($('requirement-controls'),`[data-path="${control.dataset.path}"] [data-action="${action}"]`);}
  renderResults();
});
document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{
  try{Object.keys(presets[button.dataset.preset]).forEach(ensureView);state.weights=Object.fromEntries(Object.entries(presets[button.dataset.preset]).map(([key,w])=>[key==='Y01'&&state.modality==='stay'?'Y03':key,w]));state.selected=Object.keys(state.weights);state.targetFits={};state.groupBudgets=null;state.preset=button.dataset.preset;render();}catch(error){reportSettingError(error);}
}));
$('modality').addEventListener('change',event=>{state.modality=event.target.value; render();});
$('day-type').addEventListener('change',event=>{comparisonDayType=event.target.value;render();});
$('region-query').addEventListener('input',event=>{state.query=event.target.value.slice(0,100);renderResults();});
$('sort-order').addEventListener('change',event=>{state.sort=event.target.value;renderResults();});
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{state.tab=button.dataset.tab;renderResults();}));
$('reset-settings').addEventListener('click',()=>{state.weights={};state.selected=[];state.targetFits={};state.groupBudgets=null;state.preset=null;$('settings-message').textContent='採点設定をリセットしました。必須条件は保持しています。';render();});
$('ranking-list').addEventListener('click',event=>{const button=event.target.closest('[data-detail]');if(button)openDetail(button.dataset.detail);});
$('close-detail').addEventListener('click',()=>$('detail-dialog').close());
$('detail-dialog').addEventListener('click',event=>{if(event.target===$('detail-dialog'))$('detail-dialog').close();});
$('share-settings').addEventListener('click',async()=>{
  if(!manifest)return;
  try{
    const config=configFor();validateConfig(config,manifest,catalog,views);rankRegions(regions,currentCandidates(),settingsFor());
    const url=new URL(location.href);url.hash=new URLSearchParams({config:JSON.stringify(config)}).toString();history.replaceState(null,'',url);
    try{await navigator.clipboard.writeText(url.toString());$('share-link').hidden=true;$('settings-message').textContent='データ版・重み・希望帯・必須条件を含むリンクをコピーしました。';}
    catch{$('share-link').value=url.toString();$('share-link').hidden=false;$('share-link').select();$('settings-message').textContent='このリンクを選択してコピーしてください。';}
  }catch(error){reportSettingError(error);}
});
async function start(){
  try{
    manifest=await fetchJson('./data/manifest.json');
    if(!['1','2'].includes(manifest.schema_version)||!['synthetic_demo','evidence_pilot'].includes(manifest.dataset_kind))throw new Error('このページで扱える公開データ形式ではありません。');
    const [regionData,rankingData,viewData,rubric,feeData]=await Promise.all([fetchJson(manifest.regions_url),fetchJson(manifest.ranking_url),fetchJson(manifest.views_url),fetchJson(manifest.rubric_url),manifest.fee_populations_url?fetchJson(manifest.fee_populations_url):null]);
    [regionData,rankingData,viewData].forEach(verifyRelease);catalog=rubric;
    if(catalog.version!==manifest.rubric_version)throw new Error('採点カタログの版が一致しません。');
    if(feeData){verifyRelease(feeData);if(feeData.policy.id!==manifest.fee_policy_id||feeData.policy.id!==catalog.regional_daytrip_fee_policy.id)throw new Error('日帰り料金の集約基準が一致しません。');feePopulations=feeData.populations;validateFeePopulations(feePopulations,regionData.regions,catalog.regional_daytrip_fee_policy);}
    regions=regionData.regions;plans=rankingData.plans;views=buildCatalogViews(catalog,viewData.views,plans);
    if(regions.length!==manifest.region_count||plans.length!==manifest.plan_count)throw new Error('索引と候補データの件数が一致しません。');
    $('snapshot-label').textContent=manifest.snapshot_id;
    const demo=manifest.dataset_kind==='synthetic_demo';
    $('dataset-notice').innerHTML=`<strong>${demo?'架空データによる操作デモ':'公開根拠に基づく調査データ'}</strong><span>${regions.length}温泉地・${plans.length}候補。${demo?'実在する温泉地の評価ではありません。':html(manifest.scope_note??'')+' 未調査項目を含む番付は暫定です。'}</span>`;
    $('metric-group').innerHTML='<option value="">すべての分野</option>'+Object.entries(groups).map(([id,name])=>`<option value="${id}">${html(name)}</option>`).join('');
    if(readSharedConfig())$('settings-message').textContent='共有された採点設定・必須条件を復元しました。';
    if(matchMedia('(max-width: 860px)').matches)$('settings-panel').open=false;
    renderPicker();render();
  }catch(error){
    manifest=null;$('result-subtitle').textContent='番付を計算できませんでした。';
    $('ranking-list').innerHTML=`<div class="empty-state"><h3>公開データ・共有設定を確認してください</h3><p>${html(error.message)}</p><button type="button" id="reload-data">再読み込み</button></div>`;
    $('ranking-note').textContent='指定したデータ版の全候補を読み込んでから計算します。';$('reload-data').addEventListener('click',()=>location.reload());
    document.querySelectorAll('.settings-panel button,.settings-panel input,.settings-panel select').forEach(control=>control.disabled=true);
  }
}
start();
