import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import * as scoring from '../docs/assets/scoring.mjs';
const docsRoot=new URL('../docs/',import.meta.url);
const readAsset=path=>readFile(new URL(path,docsRoot),'utf8');
const catalog=JSON.parse(await readFile(new URL('../onsen_banzuke_metric_catalog_v1.json',import.meta.url),'utf8'));
// Isolated test facts exercise the UI without depending on a release under construction.
const envelope={schema_version:'1',rubric_version:catalog.version,snapshot_id:'ui-test',dataset_kind:'synthetic_demo'};
const regions=[{id:'test-a',name:'テスト温泉A',kana:'あ',landscape:'テスト',summary:'検証用'},
  {id:'test-b',name:'テスト温泉B',kana:'い',landscape:'テスト',summary:'検証用'}];
const known=(raw,score,unit='')=>({status:'K',rawLower:raw,rawUpper:raw,lower:score,upper:score,unit});
const unknown={status:'U',rawLower:null,rawUpper:null,lower:0,upper:100};
const plan=(id,regionId,label,pH,outdoor,price)=>({id,regionId,label,modality:'daytrip',condition_label:'テスト用架空条件',evidence_note:'架空のテスト値',metrics:{C01:known(pH,100*Math.max(0,Math.min(1,(7-pH)/6)),'pH'),B06:outdoor===null?unknown:known(outdoor,100*outdoor),Y01:known(price,100*Math.max(0,1-price/2000),'円')}});
const plans=[plan('test-a1','test-a','浴槽A1',2,0,500),plan('test-a2','test-a','浴槽A2',5,1,1200),plan('test-b1','test-b','浴槽B1',9,null,1800)];
const manifest={...envelope,region_count:regions.length,plan_count:plans.length,regions_url:'./test-data/regions.json',ranking_url:'./test-data/ranking.json',views_url:'./test-data/views.json',rubric_url:'./test-data/rubric.json'};
const datasets={'data/manifest.json':manifest,'test-data/regions.json':{...envelope,regions},'test-data/ranking.json':{...envelope,plans},'test-data/views.json':{...envelope,views:[]},'test-data/rubric.json':catalog};
async function boot(url='http://127.0.0.1:8877/docs/',data=datasets){
  const dom=new JSDOM(await readAsset('index.html'),{url,runScripts:'outside-only'});
  const w=dom.window;w.structuredClone=value=>w.JSON.parse(w.JSON.stringify(value));
  for(const [file,names] of [['scoring.mjs',['rankRegions','evaluateRequirement']],['catalog.mjs',['buildCatalogViews','parameterView','normalizeMetricKey']],['settings.mjs',['createSettings','validateConfig']],['comparison.mjs',['comparisonPlans']],['pricing.mjs',['summarizeRegionalFees']],['regional-features.mjs',['attachRegionalFeeMetrics','validateFeePopulations']]]){
    const module=(await readAsset('assets/'+file)).replace(/^import .*;\n/gm,'').replace(/export /g,'');
    Object.assign(w,w.eval('(()=>{'+module+';return {'+names.join(',')+'};})()'));
  }
  w.matchMedia=()=>({matches:false});w.CSS={escape:s=>s.replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c)};
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>{w.copied=value;}}});
  w.fetch=async url=>{const value=data[new URL(String(url)).pathname.replace(/^\/docs\//,'')];return value?{ok:true,json:async()=>w.structuredClone(value)}:{ok:false,status:404};};
  let source=await readAsset('assets/app.mjs');
  source=source.replace(/^import .*;\n/gm,'').replace(/start\(\);\s*$/,'window.ready=start();');
  w.eval(source);
  await w.ready;
  assert.doesNotMatch(w.document.querySelector('#result-subtitle').textContent,/計算できません|入力がそろうまで/,w.document.querySelector('#ranking-list').textContent);
  return dom;
}
const change=(w,selector,value,event='change')=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new w.Event(event,{bubbles:true}));};
const click=(w,selector)=>{const el=w.document.querySelector(selector);assert.ok(el,selector);el.click();};
const pick=(w,key)=>change(w,'#metric-add',key);
const preference=(key,action)=>`[data-metric="${key}"] [data-action="${action}"]`;
const readConfig=w=>JSON.parse(new w.URLSearchParams(w.location.hash.slice(1)).get('config'));
async function share(w){click(w,'#share-settings');await new Promise(resolve=>setTimeout(resolve,0));assert.ok(w.copied,w.document.querySelector('#settings-message').textContent);return readConfig(w);}

test('all catalogue axes, arbitrary weights, target scores and shared restoration work through the actual controls',async()=>{
  const dom=await boot(),w=dom.window,d=w.document;
  assert.ok(d.querySelector('#metric-add').options.length>catalog.basic_metric_count);
  change(w,'#metric-search','C01','input');assert.equal(d.querySelector('#metric-add').options.length,2);
  pick(w,'C01');click(w,'#add-preference');
  assert.equal(d.querySelector(preference('C01','weight')).value,'0');assert.equal(d.querySelector('#result-title').textContent,'温泉地一覧');
  change(w,preference('C01','weight'),'0.473','input');
  assert.equal(d.querySelector(preference('C01','weight')).value,'0.473');
  change(w,preference('C01','mode'),'target');assert.equal(d.querySelector('#result-title').textContent,'設定を確認してください');
  for(const [action,value] of [['min','4'],['max','6'],['decay','2']])change(w,preference('C01',action),value,'input');
  assert.match(d.querySelector('#result-title').textContent,/番付/);
  const config=await share(w);assert.equal(config.weights.C01,0.473);assert.deepEqual(config.targetFits.C01,{min:4,max:6,decay:2});
  const expected=scoring.rankRegions(regions,plans,{weights:config.weights,targetFits:config.targetFits,modality:'daytrip'}).confirmed;
  const shown=[...d.querySelectorAll('.ranking-card')].map(card=>({name:card.querySelector('h3').textContent,score:parseFloat(card.querySelector('.score-number').textContent)}));
  assert.deepEqual(shown,expected.map(row=>({name:row.name,score:Number(row.score.lower.toFixed(1))})));
  click(w,'[data-detail]');await new Promise(resolve=>setTimeout(resolve,0));assert.match(d.querySelector('#detail-content').textContent,/希望帯に近い 4〜6/);assert.match(d.querySelector('#detail-content').textContent,/重み 0.473/);
  const restored=await boot(w.location.href),rw=restored.window;
  assert.equal(rw.document.querySelector(preference('C01','weight')).value,'0.473');
  assert.equal(rw.document.querySelector(preference('C01','min')).value,'4');
  assert.deepEqual(await share(rw),config);
  dom.window.close();restored.window.close();
});

test('parameter views outside the published six axes remain selectable and unknown; group budgets do not silently activate weights',async()=>{
  const dom=await boot(),w=dom.window,d=w.document;
  pick(w,'S06');change(w,'#metric-parameters','odor=petroleum');click(w,'#add-preference');
  assert.ok(d.querySelector('[data-metric="S06[odor=petroleum]"]'));
  change(w,preference('S06[odor=petroleum]','weight'),'-0.82','input');
  assert.match(d.querySelector('#result-title').textContent,/暫定/);
  for(const card of d.querySelectorAll('.ranking-card'))assert.equal(parseFloat(card.querySelector('.score-number').textContent),0);
  change(w,'#weight-mode','groups');assert.equal(d.querySelector('#result-title').textContent,'温泉地一覧');
  change(w,'[data-group="C"]','1','input');assert.equal(d.querySelector('#result-title').textContent,'設定を確認してください');
  change(w,'[data-group="C"]','0','input');change(w,'[data-group="S"]','2','input');assert.match(d.querySelector('#result-title').textContent,/暫定/);
  const config=await share(w),restored=await boot(w.location.href);
  assert.equal(config.groupBudgets.S,2);assert.equal(restored.window.document.querySelector('[data-group="S"]').value,'2');
  dom.window.close();restored.window.close();
});

test('arbitrary raw requirements, nested OR/NOT, incomplete groups and shared scalar edits use the real handlers',async()=>{
  const dom=await boot(),w=dom.window,d=w.document;
  pick(w,'C01');click(w,'#add-requirement');assert.equal(d.querySelector('#result-title').textContent,'設定を確認してください');
  change(w,'[data-path="0"] [data-action="condition-value"]','3');
  assert.notEqual(d.querySelector('#count-confirmed').textContent,'—');
  pick(w,'B06');click(w,'#add-requirement');change(w,'[data-path=""] > .condition-heading [data-action="logic"]','or');
  const config=await share(w);assert.equal(config.requirements.operator,'or');assert.equal(config.requirements.conditions.length,2);
  click(w,'[data-path=""] > .condition-actions [data-action="add-group"]');assert.equal(d.querySelector('#result-title').textContent,'設定を確認してください');
  click(w,'[data-path="2"] > .condition-heading [data-action="remove-condition"]');assert.notEqual(d.querySelector('#count-confirmed').textContent,'—');
  change(w,'[data-path=""] > .condition-heading [data-action="logic"]','not');
  assert.equal((await share(w)).requirements.conditions[0].operator,'or');
  const base={version:2,snapshot:config.snapshot,rubric:config.rubric,weights:{},selected:[],targetFits:{},modality:'daytrip',query:'',sort:'score',groupBudgets:null};
  for(const [initial,value] of [[true,'false'],['allowed','denied']]){
    const settings={...base,requirements:{operator:'and',conditions:[{metricKey:'B06',operator:'equals',value:initial}]}};
    const scalar=await boot('http://127.0.0.1:8877/docs/#'+new URLSearchParams({config:JSON.stringify(settings)}));
    const sw=scalar.window;change(sw,'[data-path="0"] [data-action="condition-value"]',value);
    const actual=await share(sw);assert.equal(actual.requirements.conditions[0].value,initial===true?false:value);scalar.window.close();
  }
  dom.window.close();
});


test('the published release loads through the UI and retains source evidence alongside preference calculations',async()=>{
  const current=JSON.parse(await readAsset('data/manifest.json'));
  const actual={'data/manifest.json':current};
  for(const key of ['regions_url','ranking_url','views_url','rubric_url','fee_populations_url'].filter(key=>current[key]))actual[current[key].slice(2)]=JSON.parse(await readAsset(current[key]));
  const sourceRegions=actual[current.regions_url.slice(2)].regions;
  for(const region of sourceRegions){if(region.ledger_url)actual[region.ledger_url.slice(2)]=JSON.parse(await readAsset(region.ledger_url));}
  const dom=await boot(undefined,actual),w=dom.window,d=w.document;
  assert.equal(d.querySelector('#snapshot-label').textContent,current.snapshot_id);
  click(w,'[data-preset="value"]');assert.match(d.querySelector('#result-title').textContent,/番付/);
  assert.ok(d.querySelector('.ranking-card'));
  click(w,'[data-detail]');await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(d.querySelector('#detail-content').textContent,/重み 1/);
  assert.match(d.querySelector('#detail-content').textContent,/数値確定度/);
  if(current.dataset_kind==='evidence_pilot')assert.ok(d.querySelector('#detail-content a[target="_blank"]'));
  if(current.dataset_kind==='evidence_pilot'){
    click(w,'#close-detail');
    change(w,'#region-query','大手町','input');change(w,'#day-type','weekend');
    assert.match(d.querySelector('.pool-label').textContent,/土日祝/);
    assert.match(d.querySelector('.price-label').textContent,/1300/);
    assert.doesNotMatch(d.querySelector('.price-label').textContent,/1100/);
    assert.equal((await share(w)).dayType,'weekend');
    const restored=await boot(w.location.href,actual),rd=restored.window.document;
    assert.equal(rd.querySelector('#day-type').value,'weekend');
    assert.match(rd.querySelector('.price-label').textContent,/1300/);
    restored.window.close();
    change(w,'#region-query','','input');change(w,'#modality','stay');
    assert.equal(Number(d.querySelector('#count-confirmed').textContent)+Number(d.querySelector('#count-unknown').textContent)+Number(d.querySelector('#count-failed').textContent),current.region_count);
    assert.equal(d.querySelector('#count-unknown').textContent,'6');
  }
  dom.window.close();
});


test('regional affordable counts use a Japanese budget control, change with day type, and restore through sharing',async()=>{
  const feeManifest={...manifest,fee_populations_url:'./test-data/fees.json',fee_policy_id:catalog.regional_daytrip_fee_policy.id};
  const populations=regions.flatMap(region=>['weekday','weekend'].map(day=>({
    id:region.id+'-'+day,regionId:region.id,day_type:day,
    policy_id:feeManifest.fee_policy_id,condition_key:catalog.regional_daytrip_fee_policy.condition_key,inventory_complete:true,
    facilities:[{facility_id:region.id+'-facility',membership:'included',evidence_ids:['test-source'],tariff_inventory_complete:true,tariff_inventory_evidence_ids:['test-source'],
      tariffs:[{id:region.id+'-'+day+'-ticket',rawLower:day==='weekday'&&region.id==='test-b'?1500:500,rawUpper:day==='weekday'&&region.id==='test-b'?1500:500,status:'K',evidence_ids:['test-source'],plan_ids:[]}]}]
  })));
  const data={...datasets,'data/manifest.json':feeManifest,'test-data/fees.json':{...envelope,policy:catalog.regional_daytrip_fee_policy,populations}};
  const dom=await boot(undefined,data),w=dom.window,d=w.document;
  pick(w,'Y24');assert.equal(d.querySelector('#metric-budget-field').hidden,false);assert.equal(d.querySelector('#metric-parameters-field').hidden,true);
  change(w,'#metric-budget','1000');click(w,'#add-preference');
  change(w,preference('Y24[budget=1000]','weight'),'0.373','input');
  assert.deepEqual([...d.querySelectorAll('.ranking-card')].map(card=>parseFloat(card.querySelector('.score-number').textContent)),[10,0]);
  click(w,'#add-requirement');change(w,'[data-path="0"] [data-action="condition-value"]','1');
  assert.equal(d.querySelector('#count-confirmed').textContent,'1');assert.equal(d.querySelector('#count-failed').textContent,'1');
  change(w,'#day-type','weekend');assert.equal(d.querySelector('#count-confirmed').textContent,'2');
  const config=await share(w);assert.equal(config.weights['Y24[budget=1000]'],.373);assert.equal(config.dayType,'weekend');
  const restored=await boot(w.location.href,data);assert.equal(restored.window.document.querySelector('#count-confirmed').textContent,'2');assert.deepEqual(await share(restored.window),config);
  dom.window.close();restored.window.close();
});
