import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {comparisonPlans} from '../docs/assets/comparison.mjs';
const manifest=JSON.parse(await readFile(new URL('../docs/data/manifest.json',import.meta.url)));
const plans=JSON.parse(await readFile(new URL('../docs/'+manifest.ranking_url.slice(2),import.meta.url))).plans;
test('weekday, weekend and stay comparisons use coherent conditions before scoring',()=>{
 const weekday=comparisonPlans(plans,{modality:'daytrip',dayType:'weekday'});
 const weekend=comparisonPlans(plans,{modality:'daytrip',dayType:'weekend'});
 assert.equal(weekday.find(p=>p.id==='otemachi-spa-weekday').metrics.Y01.rawLower,1100);
 assert.ok(!weekday.some(p=>p.id==='otemachi-spa-weekend'));
 assert.equal(weekend.find(p=>p.id==='otemachi-spa-weekend').metrics.Y01.rawLower,1300);
 assert.ok(comparisonPlans(plans,{modality:'stay',dayType:'weekday'}).every(p=>p.modality==='stay'));
 assert.throws(()=>comparisonPlans(plans,{dayType:'unregistered'}));
});
