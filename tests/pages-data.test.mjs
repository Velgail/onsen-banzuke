import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { evaluatePlan, rankRegions } from '../docs/assets/scoring.mjs';
import { buildCatalogViews, parameterView, normalizeMetricKey } from '../docs/assets/catalog.mjs';

const docs = new URL('../docs/', import.meta.url);
const read = async url => JSON.parse(await readFile(url, 'utf8'));
const manifest = await read(new URL('data/manifest.json', docs));
const isPilot = manifest.dataset_kind === 'evidence_pilot';
const pilotOnly = { skip: !isPilot };
const artifactNames = ['regions','ranking','views','rubric',...(isPilot ? ['roster'] : [])];
const artifacts = Object.fromEntries(await Promise.all(artifactNames.map(async name=>{
  const path=manifest[`${name}_url`];assert.equal(typeof path,'string');assert.ok(path.startsWith(`./data/releases/${manifest.snapshot_id}/`));
  const url = new URL(path,docs);assert.ok(url.href.startsWith(docs.href), `${name} must stay inside docs`);
  return [name,await read(url)];
})));
const catalog=await read(new URL('../onsen_banzuke_metric_catalog_v1.json',import.meta.url));
const regions=artifacts.regions.regions, plans=artifacts.ranking.plans;
const ledgers=isPilot ? await Promise.all(regions.map(region=>{
 assert.equal(typeof region.ledger_url,'string', `${region.id}: ledger URL is required`);
 assert.ok(region.ledger_url.startsWith(`./data/releases/${manifest.snapshot_id}/ledgers/`));
 const url=new URL(region.ledger_url,docs);assert.ok(url.href.startsWith(docs.href));return read(url);
})) : [];
const targetIds=['zao','kaminoyama','kusatsu','hakone','toyotomi','arima','beppu','shiobara','otemachi','shirahone'];
const unique=values=>{
 for(const value of values)assert.ok(typeof value==='string'&&value&&value.trim()===value,'identifiers must be nonempty text');
 assert.equal(new Set(values).size,values.length);
};
const envelopeKeys=['schema_version','rubric_version','snapshot_id','dataset_kind'];
const metricMap=new Map(catalog.metrics.map(metric=>[metric.id,metric]));
const catalogueViews=buildCatalogViews(catalog,artifacts.views.views,plans);
const viewMap=new Map(catalogueViews.map(view=>[view.key,view]));

test('every supported release has consistent envelopes, complete files, and unique entity references',()=>{
 assert.ok(['synthetic_demo','evidence_pilot'].includes(manifest.dataset_kind));
 assert.equal(manifest.schema_version,isPilot?'2':'1');
 for(const key of envelopeKeys)assert.ok(typeof manifest[key]==='string'&&manifest[key]);
 for(const name of ['regions','ranking','views'])for(const key of envelopeKeys)assert.equal(artifacts[name][key],manifest[key]);
 assert.ok(Array.isArray(regions)&&Array.isArray(plans)&&Array.isArray(artifacts.views.views));
 assert.ok(Number.isInteger(manifest.region_count)&&manifest.region_count>0);
 assert.ok(Number.isInteger(manifest.plan_count)&&manifest.plan_count>0);
 assert.equal(regions.length,manifest.region_count);assert.equal(plans.length,manifest.plan_count);
 unique(regions.map(region=>region.id));unique(plans.map(plan=>plan.id));unique(artifacts.views.views.map(view=>view.key));
 const regionIds=new Set(regions.map(region=>region.id));
 for(const plan of plans)assert.ok(regionIds.has(plan.regionId),`${plan.id}: dangling region reference`);
 for(const region of regions)assert.ok(plans.some(plan=>plan.regionId===region.id),`${region.id}: no published candidate`);
});

test('published real pilot contains exactly the requested ten regions, without synthetic releases',pilotOnly,async()=>{
 assert.equal(manifest.schema_version,'2');assert.equal(manifest.dataset_kind,'evidence_pilot');assert.equal(manifest.investigation_status,'partial');
 assert.deepEqual(regions.map(r=>r.id),targetIds);assert.equal(regions.length,manifest.region_count);assert.equal(plans.length,manifest.plan_count);
 assert.ok(!(await readdir(new URL('data/releases/',docs))).some(name=>name.startsWith('demo-')));
 unique(plans.map(p=>p.id));
 for(const name of ['regions','ranking','views']) for(const key of ['schema_version','rubric_version','snapshot_id','dataset_kind']) assert.equal(artifacts[name][key],manifest[key]);
 for(const plan of plans) assert.ok(targetIds.includes(plan.regionId));
});

test('synthetic release identities and provenance cannot be mistaken for real research',{skip:isPilot},()=>{
 assert.ok(manifest.snapshot_id.startsWith('demo-'));
 for(const region of regions)assert.ok(region.id.startsWith('demo-'));
 for(const plan of plans){assert.ok(plan.condition_label.includes('架空'));assert.ok(plan.evidence_note.includes('架空'));}
});

test('published criteria and fixed-scale catalogue match authoritative files',async()=>{
 assert.deepEqual(artifacts.rubric,catalog);assert.equal(manifest.rubric_version,catalog.version);
 assert.equal(await readFile(new URL('criteria/scoring-1.1.md',docs),'utf8'),await readFile(new URL('../onsen_banzuke_master_prompt_v1.md',import.meta.url),'utf8'));
});

test('all 246 axes remain selectable, with observed parameter combinations validated',()=>{
 const views=catalogueViews;
 assert.equal(views.filter(v=>!v.key.includes('[')).length,246);
 assert.equal(views.filter(v=>!v.key.includes('[')).length,catalog.basic_metric_count);
 for(const view of artifacts.views.views)assert.equal(normalizeMetricKey(catalog,view.key),view.key,`${view.key}: publish canonical keys`);
 for(const plan of plans)for(const [key,row] of Object.entries(plan.metrics)){
  assert.equal(normalizeMetricKey(catalog,key),key,`${plan.id}: aliases must resolve before publication`);
  const view=viewMap.get(key);assert.ok(view,`${key}: observed keys must be visible`);
  if(view.template)assert.throws(()=>parameterView(catalog,views,key),`${key}: parent inventory still requires parameter input before selection`);
  else assert.equal(parameterView(catalog,views,key).key,key);
 }
 // Selection must not be narrowed to this pilot's observations.
 assert.equal(parameterView(catalog,views,'Z24','language=en,task=reservation,channel=phone').key,'Z24[channel=phone,language=en,task=reservation]');
});

test('each independent ledger covers the full basic inventory and uninvestigated access slots honestly',pilotOnly,()=>{
 for(const ledger of ledgers){
  assert.equal(ledger.metric_inventory.length,246);assert.equal(ledger.coverage.complete,false);
  assert.equal(ledger.coverage.basic_metrics_with_observations+ledger.coverage.basic_metrics_not_investigated,246);
  assert.deepEqual(ledger.trial.depends_on_regions,[]);assert.equal(ledger.trial.independent,true);assert.equal(ledger.trial.rarity_comparison_connected,false);
  assert.match(ledger.trial.input_sha256,/^[a-f0-9]{64}$/);assert.equal(ledger.access_inventory.length,188);
  assert.ok(ledger.access_inventory.every(row=>row.status==='E'));
  unique(ledger.access_inventory.map(r=>[r.origin_prefecture,r.date,r.mode].join('|')));
  assert.deepEqual(ledger.metric_inventory.filter(r=>r.investigation_state==='E').flatMap(r=>r.observations).filter(r=>r.status!=='E'),[]);
  unique(ledger.metric_inventory.map(row=>row.metric_id));
  assert.deepEqual(ledger.metric_inventory.map(row=>row.metric_id).sort(),catalog.metrics.map(metric=>metric.id).sort());
  for(const key of envelopeKeys)assert.equal(ledger[key],manifest[key],`${ledger.region.id}: ledger ${key}`);
  assert.equal(ledger.coverage.source_count,ledger.sources.length);assert.equal(ledger.coverage.facility_count,ledger.facilities.length);
  assert.equal(ledger.coverage.plan_count,ledger.plans.length);
 }
});

test('provenance and physical entity boundaries survive the published vectors',pilotOnly,()=>{
 for(const ledger of ledgers){
  const sourceIds=new Set(ledger.sources.map(s=>s.id)),facilityIds=new Set(ledger.facilities.map(f=>f.id));
  unique(ledger.sources.map(source=>source.id));unique(ledger.facilities.map(facility=>facility.id));unique(ledger.plans.map(plan=>plan.id));
  const entityIds=new Set([ledger.region.id,...facilityIds,...ledger.plans.map(plan=>plan.id),...ledger.plans.map(plan=>plan.bath_id).filter(Boolean),...(ledger.analysis_samples??[]).map(sample=>sample.id),...(ledger.source_entities??[]).map(source=>source.id),...(ledger.supply_entities??[]).map(supply=>supply.id)]);
  for(const facility of ledger.facilities)assert.ok(facility.source_ids.length>0&&facility.source_ids.every(id=>sourceIds.has(id)));
  for(const source of ledger.sources){assert.match(source.url,/^https?:\/\//);assert.ok(source.locator);assert.ok(source.retrieved_at);}
  for(const plan of ledger.plans){
   assert.deepEqual(plan,plans.find(published=>published.id===plan.id),`${plan.id}: ranking must preserve its ledger candidate`);
   assert.ok(facilityIds.has(plan.facility_id));assert.ok(['weekday','weekend','all'].includes(plan.day_type));
   if(!plan.bath_id)assert.equal(plan.entity_scope,'facility_scope');
   for(const [key,row] of Object.entries(plan.metrics)){
    assert.doesNotThrow(()=>evaluatePlan({...plan,metrics:{[key]:row}}));
    assert.ok(row.reason);assert.ok(row.entity_id);assert.ok(row.entity_scope);assert.ok(row.catalog_scope);
    assert.ok(entityIds.has(row.entity_id),`${plan.id}/${key}: dangling physical or plan entity`);
    assert.ok(row.evidence_ids.every(id=>sourceIds.has(id)));
    if(['K','C','Z','X','A'].includes(row.status))assert.ok(row.evidence_ids.length>0);
    if(['E','U','F'].includes(row.status)){assert.deepEqual([row.rawLower,row.rawUpper],[null,null]);assert.deepEqual([row.lower,row.upper],[0,100]);}
    if(row.status==='A')assert.deepEqual([row.lower,row.upper],[0,0]);
    if(row.catalog_scope==='利用プラン')assert.equal(row.entity_id,plan.id);
    if(row.catalog_scope.startsWith('施設'))assert.equal(row.entity_id,plan.facility_id);
   }
  }
 }
});

test('one-sided mandatory fees do not become exact cheap totals or confirmed budgets',pilotOnly,()=>{
 const plan=plans.find(p=>p.id==='otemachi-spa-weekday');assert.ok(plan);
 assert.deepEqual([plan.metrics.Y01.rawLower,plan.metrics.Y01.rawUpper],[1100,null]);
 assert.deepEqual([plan.metrics.Y01.lower,plan.metrics.Y01.upper],[0,45]);
 assert.equal(evaluatePlan(plan,{weights:{Y01:1},requirements:[{metricKey:'Y01',operator:'atMost',value:1500}]}).eligibility,'unknown');
 assert.equal(evaluatePlan(plan,{requirements:[{metricKey:'Y01',operator:'atMost',value:1000}]}).eligibility,'fail');
});

test('source analysis values never become the current bath pH or temperature without correspondence',pilotOnly,()=>{
 for(const ledger of ledgers){
  for(const plan of ledger.plans)for(const key of ['C01','C02']){
   const row=plan.metrics[key];if(row)assert.ok(['E','U','F','A'].includes(row.status),`${plan.id} must not infer current pH from source samples`);
  }
 }
 const beppu=ledgers.find(l=>l.region.id==='beppu');assert.equal(beppu.analysis_samples[0].measurements[0].value,3.1);
 const outdoor=plans.find(p=>p.id==='beppu-hyotan-female-wind');assert.equal(outdoor.metrics.B06.rawLower,1);assert.notEqual(outdoor.metrics.P17.rawLower,1);
});

test('independent current official roster retains all characters, duplicates, overseas and uninvestigated candidates',pilotOnly,()=>{
 const roster=artifacts.roster;assert.equal(roster.onsen_character_count,135);assert.equal(roster.other_character_count,2);assert.equal(roster.linked_character_count,137);
 assert.equal(roster.region_candidate_count,134);unique(roster.characters.map(c=>c.id));
 const arima=roster.region_candidates.find(r=>r.id==='arima');assert.equal(arima.character_ids.length,2);
 assert.ok(roster.region_candidates.some(r=>r.prefecture==='台湾'));assert.equal(roster.overlap_candidates.length,4);
 assert.equal(roster.region_candidates.filter(r=>r.study_status==='E').length,124);
 assert.ok(roster.region_candidates.every(r=>r.availability_status==='E'));
 for(const c of roster.characters)assert.ok(roster.region_candidates.find(r=>r.id===c.region_candidate_id)?.character_ids.includes(c.id));
});

test('initial names-only presentation produces no total scores or ranks',()=>{
 const result=rankRegions(regions,plans,{modality:'all'});assert.equal(result.confirmed.length,regions.length);
 assert.ok(result.confirmed.every(r=>r.score===null&&r.rank===null));
});
