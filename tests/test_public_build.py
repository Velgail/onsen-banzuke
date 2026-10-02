import copy
import json
import unittest
from pathlib import Path
import build_public_data as build

ROOT=Path(__file__).resolve().parents[1]
class IndependentBuildTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.catalog=build.read_json(ROOT/'onsen_banzuke_metric_catalog_v1.json')
  cls.studies=[build.read_json(ROOT/'research/regions'/f'{region}.json') for region in build.TARGET_IDS]
 def test_single_trial_equals_aggregate_build_and_inputs_unchanged(self):
  before=copy.deepcopy(self.studies)
  separate={study['region']['id']:build.build_region(study,self.catalog) for study in self.studies}
  # Population and order cannot enter the pure regional conversion.
  combined={study['region']['id']:build.build_region(study,self.catalog) for study in reversed(self.studies)}
  self.assertEqual(separate,combined)
  self.assertEqual(before,self.studies)
  for region,ledger in separate.items():
   self.assertEqual(ledger['trial']['depends_on_regions'],[])
   self.assertEqual(build.build_region(before[next(i for i,s in enumerate(before) if s['region']['id']==region)],self.catalog),ledger)
 def test_partial_decreasing_fee_bound_preserves_unknown_total_upper(self):
  metric=next(m for m in self.catalog['metrics'] if m['id']=='Y01')
  row={'status':'C','rawLower':1100,'rawUpper':None,'reason':'published fee only','evidence_ids':['fee']}
  actual=build.normalize_row(row,metric,{'fee'},'Y01')
  self.assertEqual((actual['lower'],actual['upper']),(0,45))
  row['status']='U'
  with self.assertRaisesRegex(ValueError,'invented raw bounds'):build.normalize_row(row,metric,{'fee'},'Y01')
 def test_unknown_cannot_acquire_an_evidenced_value_without_source(self):
  metric=next(m for m in self.catalog['metrics'] if m['id']=='B06')
  row={'status':'K','rawLower':1,'rawUpper':1,'reason':'outdoor','evidence_ids':[]}
  with self.assertRaisesRegex(ValueError,'requires sources'):build.normalize_row(row,metric,set(),'B06')
 def test_duplicate_and_unbound_physical_entities_are_rejected(self):
  study=copy.deepcopy(self.studies[0]);study['plans'][0]['bath_id']=None
  with self.assertRaisesRegex(ValueError,'facility_scope'):build.build_region(study,self.catalog)
  study=copy.deepcopy(self.studies[0]);study['plans'].append(study['plans'][0])
  with self.assertRaisesRegex(ValueError,'duplicate plan'):build.build_region(study,self.catalog)
 def test_rare_axes_need_a_fixed_comparison_ledger(self):
  with self.assertRaisesRegex(ValueError,'additional context'):build.formula_score('RARITY',1)
 def study(self,region):
  return copy.deepcopy(next(s for s in self.studies if s['region']['id']==region))
 def test_water_origins_match_their_registered_scope_for_all_ten_trials(self):
  for study in self.studies:
   ledger=build.build_region(study,self.catalog)
   registry={e['id']:scope for scope,table in build.WATER_TABLES.items() for e in ledger.get(table,[])}
   for item in ledger['metric_inventory']:
    for row in item['observations']:
     expected=build.WATER_SCOPES.get(row['catalog_scope'])
     if expected:
      self.assertEqual(row['entity_scope'],expected)
      self.assertEqual(registry[row['entity_id']],expected)
   for plan in ledger['plans']:
    if plan['bath_id']:
     self.assertTrue(plan['bath_id'].startswith(plan['facility_id']+':'))
    if plan['entity_scope']=='bath_group':
     self.assertEqual(plan['group_policy'],'common_observations_only')
     for row in plan['metrics'].values():
      if row['catalog_scope']=='浴槽条件' and row['status'] in build.EVIDENCED_STATES:
       self.assertEqual(row['group_applicability'],'common')
 def test_known_historical_sample_does_not_award_current_bath_points(self):
  ledger=build.build_region(self.study('toyotomi'),self.catalog)
  sample=next(s for s in ledger['analysis_samples'] if s['id']=='toyotomi-sample-fureai-20200721')
  self.assertEqual(sample['archived_metrics']['I05']['lower'],100)
  self.assertFalse(sample['archived_metrics']['I05']['applies_to_plan'])
  for plan in ledger['plans']:
   for key in ['I04','I05','I06']:
    self.assertEqual(plan['metrics'][key]['status'],'U')
    self.assertEqual((plan['metrics'][key]['lower'],plan['metrics'][key]['upper']),(0,100))
 def test_water_value_requires_correspondence_to_the_actual_target(self):
  study=self.study('toyotomi');row=study['plans'][0]['metrics']['I05']
  row.update(status='C',rawLower=1,rawUpper=1)
  with self.assertRaisesRegex(ValueError,'target correspondence'):build.build_region(study,self.catalog)
  study=self.study('shiobara')
  plan=next(p for p in study['plans'] if 'sumi_mixed' in p['id'])
  plan['metrics']['I03']['target_correspondence']['target_entity_id']='another-bath'
  with self.assertRaisesRegex(ValueError,'target correspondence'):build.build_region(study,self.catalog)
 def test_water_entity_cannot_be_relabelled_as_a_bath_or_another_sample(self):
  study=self.study('toyotomi');row=study['plans'][0]['metrics']['I05']
  row['entity_scope']='bath'
  with self.assertRaisesRegex(ValueError,'analysis_sample entity reference'):build.build_region(study,self.catalog)
  study=self.study('toyotomi');row=study['plans'][0]['metrics']['I05']
  row['entity_id']='toyotomi-sample-hotel-20190827'
  with self.assertRaisesRegex(ValueError,'plan water entity mismatch'):build.build_region(study,self.catalog)
 def test_unknown_water_ids_are_not_claimed_as_resolved_physical_sources(self):
  study=self.study('arima')
  self.assertTrue(any(s['identity_status']=='U' and s['name'] is None for s in study['source_entities']))
  study['plans'][0]['source_entity_id']='unregistered-source'
  with self.assertRaisesRegex(ValueError,'dangling source reference'):build.build_region(study,self.catalog)
 def test_duplicate_bath_across_facilities_and_mixed_scope_are_rejected(self):
  study=self.study('shirahone')
  a=next(p for p in study['plans'] if p['facility_id']=='public_roten')
  b=next(p for p in study['plans'] if p['facility_id']=='baikoan')
  self.assertNotEqual(a['bath_id'],b['bath_id'])
  b['bath_id']=a['bath_id']
  with self.assertRaisesRegex(ValueError,'include facility_id'):build.build_region(study,self.catalog)
  study=self.study('zao');a=next(p for p in study['plans'] if 'dairoten-weekday' in p['id'])
  b=next(p for p in study['plans'] if 'dairoten-weekend' in p['id']);b['entity_scope']='bath'
  with self.assertRaisesRegex(ValueError,'conflicting physical entity'):build.build_region(study,self.catalog)
 def test_group_cannot_borrow_a_member_property_or_a_single_temperature(self):
  study=self.study('zao');plan=next(p for p in study['plans'] if 'shinzaemon-mogami' in p['id'])
  self.assertEqual(plan['entity_scope'],'bath_group')
  plan['metrics']['B06']['group_applicability']='member'
  with self.assertRaisesRegex(ValueError,'borrow a single member'):build.build_region(study,self.catalog)
  study=self.study('shirahone');plan=next(p for p in study['plans'] if 'nuruyu_day' in p['id'])
  self.assertEqual(plan['metrics']['B01']['status'],'U')
  self.assertIn('B01',plan['unapplied_component_observations'])
  study=self.study('kaminoyama');plan=next(p for p in study['plans'] if 'koyo' in p['id'])
  self.assertEqual(plan['metrics']['B06']['status'],'U')
 def test_archived_rows_are_validated_but_never_inherited_by_plans(self):
  study=self.study('toyotomi');sample=study['analysis_samples'][0]
  for mutation,pattern in [
   ({'entity_id':'missing-sample'},'entity reference'),
   ({'entity_scope':'bath'},'entity reference'),
   ({'status':'bogus'},'invalid status'),
   ({'evidence_ids':['missing-source']},'dangling evidence'),
   ({'rawLower':float('nan')},'finite or null')]:
   broken=copy.deepcopy(study);broken['analysis_samples'][0]['archived_metrics']['I05'].update(mutation)
   with self.subTest(mutation=mutation):
    with self.assertRaisesRegex(ValueError,pattern):build.build_region(broken,self.catalog)
  broken=copy.deepcopy(study)
  broken['analysis_samples'][0]['archived_metrics']['I05']['entity_id']=study['analysis_samples'][1]['id']
  with self.assertRaisesRegex(ValueError,'containing entity'):build.build_region(broken,self.catalog)
  broken=copy.deepcopy(study);arch=broken['analysis_samples'][0]['archived_metrics'];arch['I05[x=1,x=2]']=arch.pop('I05')
  with self.assertRaisesRegex(ValueError,'duplicate parameters'):build.build_region(broken,self.catalog)
 def test_reports_distinguish_archived_scope_and_source_registration_counts(self):
  ledgers=[build.build_region(s,self.catalog) for s in self.studies]
  roster=build.read_json(ROOT/'research/roster/official-2026-10-03.json')
  report=build.pilot_report(ledgers,roster)
  self.assertIn('地域別重複と取得失敗を含む',report)
  self.assertIn('原資料だけを確認して候補への適用が未確認',report)
  self.assertNotIn('件の根拠資料',report)
  self.assertTrue(all('資料台帳登録件数' in l['coverage']['source_count_definition'] for l in ledgers))
  region_report=build.region_report(next(l for l in ledgers if l['region']['id']=='toyotomi'))
  self.assertIn('参照資料のみ・候補への適用未確認',region_report)
  self.assertIn('scope=analysis_sample / ID=toyotomi-sample-fureai-20200721',region_report)
  self.assertIn('候補への適用確認数ではありません',region_report)

if __name__=='__main__':unittest.main()
