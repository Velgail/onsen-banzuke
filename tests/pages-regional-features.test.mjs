import test from 'node:test';
import assert from 'node:assert/strict';
import {attachRegionalFeeMetrics} from '../docs/assets/regional-features.mjs';
import {rankRegions, evaluateRequirement} from '../docs/assets/scoring.mjs';
const facility=(id,fee)=>({facility_id:id,membership:'included',evidence_ids:['source'],tariff_inventory_complete:true,tariff_inventory_evidence_ids:['source'],tariffs:[{id:id+'-ticket',rawLower:fee,rawUpper:fee,status:'K',evidence_ids:['source'],plan_ids:[id+'-plan']}]});
const population=(id,fees,complete=true)=>({id:id+'-ordinary-weekday',regionId:id,day_type:'weekday',inventory_complete:complete,facilities:fees.map((fee,i)=>facility(id+i,fee)),condition_note:'一般成人1名、通常入浴のみ'});
const plans=['a','b'].map(id=>({id:id+'-chosen',regionId:id,label:id+' facility',modality:'daytrip',metrics:{Y01:{status:'K',rawLower:1800,rawUpper:1800,lower:10,upper:10}}}));
const regions=['a','b'].map(id=>({id,name:id,kana:id}));

test('one cheap facility among ten and ten cheap facilities yield distinct regional axes without changing chosen-plan fees',()=>{
  const populations=[population('a',[500,...Array(9).fill(1800)]),population('b',Array(10).fill(500))];
  const original=JSON.stringify({plans,populations});
  const result=attachRegionalFeeMetrics(plans,populations,['Y24[budget=1000]','Y25[budget=1000]']);
  assert.deepEqual(result.map(p=>p.metrics.Y23.rawLower),[1800,500]);
  assert.deepEqual(result.map(p=>p.metrics['Y24[budget=1000]'].rawLower),[1,10]);
  assert.deepEqual(result.map(p=>p.metrics['Y25[budget=1000]'].rawLower),[.1,1]);
  assert.deepEqual(result.map(p=>p.metrics.Y01.rawLower),[1800,1800]);
  assert.equal(evaluateRequirement(result[1].metrics.Y01,{metricKey:'Y01',operator:'atMost',value:1000}),'fail');
  assert.deepEqual(rankRegions(regions,result,{weights:{'Y24[budget=1000]':1}}).confirmed.map(r=>r.id),['b','a']);
  assert.equal(JSON.stringify({plans,populations}),original);
});

test('incomplete populations keep median/share unknown while confirmed affordable counts are usable lower bounds',()=>{
  const result=attachRegionalFeeMetrics(plans,[population('a',[500,1800],false)],['Y24[budget=1000]','Y25[budget=1000]']);
  assert.equal(result[0].metrics.Y23.status,'E');
  assert.equal(result[0].metrics.Y23.rawLower,null);
  assert.equal(result[0].metrics['Y25[budget=1000]'].status,'E');
  assert.equal(result[0].metrics['Y24[budget=1000]'].status,'C');
  assert.equal(result[0].metrics['Y24[budget=1000]'].rawLower,1);
  assert.equal(result[0].metrics['Y24[budget=1000]'].rawUpper,null);
  assert.equal(evaluateRequirement(result[0].metrics['Y24[budget=1000]'],{metricKey:'Y24[budget=1000]',operator:'atLeast',value:1}),'pass');
  assert.equal(evaluateRequirement(result[0].metrics['Y24[budget=1000]'],{metricKey:'Y24[budget=1000]',operator:'atMost',value:1}),'unknown');
  assert.equal(result[1].metrics['Y24[budget=1000]'].status,'E');
});

test('day and budget parameters change derived facts; malformed keys and duplicate populations stop calculation',()=>{
  const weekday=population('a',[500]),weekend={...population('a',[1500]),id:'a-ordinary-weekend',day_type:'weekend'};
  const rows=attachRegionalFeeMetrics(plans,[weekday,weekend],['Y24[budget=1000]','Y24[budget=2000]'],{dayType:'weekend'});
  assert.equal(rows[0].metrics.Y23.rawLower,1500);
  assert.equal(rows[0].metrics['Y24[budget=1000]'].rawLower,0);
  assert.equal(rows[0].metrics['Y24[budget=2000]'].rawLower,1);
  for(const key of ['Y24','Y25[budget=-1]','Y25[budget=NaN]'])assert.throws(()=>attachRegionalFeeMetrics(plans,[weekday],[key]),/budget/);
  assert.throws(()=>attachRegionalFeeMetrics(plans,[weekday,weekday],[]),/重複/);
});

test('a verified empty population is inapplicable rather than a free regional fee',()=>{
  const row=attachRegionalFeeMetrics(plans,[population('a',[])],['Y24[budget=1000]','Y25[budget=1000]'])[0];
  for(const key of ['Y23','Y24[budget=1000]','Y25[budget=1000]']){
    assert.equal(row.metrics[key].status,'A');assert.equal(row.metrics[key].upper,0);assert.equal(row.metrics[key].rawLower,null);
  }
});
