"""Validate the fee population independently of point scoring and other regions."""
import copy
import unittest

import build_public_data as build


class FeePopulationBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = build.read_json(build.CATALOG_PATH)
        cls.pricing = build.read_json(
            build.ROOT / 'research/pricing/ordinary-daytrip-2026-10-03.json')['regions']
        cls.studies = {
            region: build.read_json(build.ROOT / 'research/regions' / f'{region}.json')
            for region in build.TARGET_IDS
        }

    def inputs(self, region):
        return (build.build_region(self.studies[region], self.catalog),
                copy.deepcopy(self.pricing[region]))

    def populations(self, region):
        ledger, classification = self.inputs(region)
        return build.build_fee_populations(ledger, classification, self.catalog)

    def test_each_trial_covers_recorded_facilities_and_classifies_every_plan(self):
        for region in build.TARGET_IDS:
            with self.subTest(region=region):
                ledger, classification = self.inputs(region)
                populations = build.build_fee_populations(ledger, classification, self.catalog)
                self.assertEqual({p['day_type'] for p in populations}, {'weekday', 'weekend'})
                expected_facilities = {f['id'] for f in ledger['facilities']}
                self.assertEqual(
                    {pid for entry in classification['facilities'].values()
                     for pid in entry['plan_classifications']},
                    {p['id'] for p in ledger['plans']})
                for population in populations:
                    self.assertEqual({f['facility_id'] for f in population['facilities']},
                                     expected_facilities)
                    self.assertFalse(population['inventory_complete'])
                    self.assertTrue(all(not f['tariff_inventory_complete']
                                        for f in population['facilities']))
                    self.assertEqual(population['policy_id'],
                                     self.catalog['regional_daytrip_fee_policy']['id'])

    def test_shared_ticket_baths_are_one_facility_and_one_tariff(self):
        population = self.populations('zao')[0]
        facility = next(f for f in population['facilities']
                        if f['facility_id'] == 'zao-shinzaemon')
        self.assertEqual(facility['membership'], 'included')
        self.assertEqual(len(facility['tariffs']), 1)
        ticket = facility['tariffs'][0]
        self.assertEqual(len(ticket['plan_ids']), 3)
        self.assertEqual((ticket['rawLower'], ticket['rawUpper']), (1000, 1000))
        self.assertEqual(ticket['evidence_ids'], sorted(set(ticket['evidence_ids'])))

    def test_same_admission_ticket_merges_evidence_and_does_not_mutate_plan_rows(self):
        ledger, classification = self.inputs('toyotomi')
        facility_id = 'toyotomi-fureai'
        plans = [p for p in ledger['plans'] if p['facility_id'] == facility_id]
        self.assertEqual(len(plans), 2)
        # Both copied bath rows may cite different subsets of the same source corpus.
        source_ids = [source['id'] for source in ledger['sources']]
        for plan, source_id in zip(plans, source_ids):
            plan['metrics']['Y01']['evidence_ids'] = [source_id]
        before = copy.deepcopy(ledger)
        population = build.build_fee_populations(ledger, classification, self.catalog)[0]
        facility = next(f for f in population['facilities'] if f['facility_id'] == facility_id)
        self.assertEqual(facility['tariffs'][0]['evidence_ids'], sorted(source_ids[:2]))
        self.assertEqual(ledger, before)

    def test_rest_package_excluded_but_known_ordinary_provider_remains_without_tariff(self):
        population = self.populations('hakone')[0]
        facility = next(f for f in population['facilities'] if f['facility_id'] == 'shumeikan')
        self.assertEqual(facility['membership'], 'included')
        self.assertEqual(facility['tariffs'], [])
        entries = self.pricing['hakone']['facilities']['shumeikan']['plan_classifications']
        self.assertEqual({entry['series'] for entry in entries.values()}, {'rest_package'})
        # The acquired rest package must not become a supposedly cheapest ordinary ticket.
        self.assertFalse(facility['tariff_inventory_complete'])

    def test_known_providers_with_unresearched_prices_are_not_dropped(self):
        for region, facility_ids in [('kusatsu', {'gozanoyu'}),
                                     ('hakone', {'shumeikan', 'tenzan'}),
                                     ('arima', {'arima_gin'})]:
            population = self.populations(region)[0]
            actual = {f['facility_id']: f for f in population['facilities']}
            for facility_id in facility_ids:
                with self.subTest(region=region, facility_id=facility_id):
                    self.assertEqual(actual[facility_id]['membership'], 'included')
                    self.assertEqual(actual[facility_id]['tariffs'], [])

    def test_unknown_membership_and_confirmed_exclusions_are_retained_as_records(self):
        population = self.populations('zao')[0]
        facilities = {f['facility_id']: f for f in population['facilities']}
        self.assertEqual(facilities['zao-kamiyu']['membership'], 'unknown')
        self.assertEqual(facilities['zao-kamiyu']['tariffs'], [])
        population = self.populations('otemachi')[0]
        facilities = {f['facility_id']: f for f in population['facilities']}
        self.assertEqual(facilities['otemachi-hoshinoya']['membership'], 'excluded')
        self.assertEqual(facilities['otemachi-hoshinoya']['tariffs'], [])

    def test_day_types_keep_different_published_prices_separate(self):
        populations = self.populations('otemachi')
        tariffs = {}
        for population in populations:
            facility = next(f for f in population['facilities'] if f['facility_id'] == 'otemachi-spa')
            self.assertEqual(len(facility['tariffs']), 1)
            tariffs[population['day_type']] = facility['tariffs'][0]
        self.assertEqual(tariffs['weekday']['rawLower'], 1100)
        self.assertEqual(tariffs['weekend']['rawLower'], 1300)
        self.assertNotEqual(tariffs['weekday']['id'], tariffs['weekend']['id'])
        self.assertNotEqual(tariffs['weekday']['plan_ids'], tariffs['weekend']['plan_ids'])

    def test_missing_total_upper_bound_is_not_filled_from_published_base_price(self):
        population = self.populations('otemachi')[0]
        facility = next(f for f in population['facilities'] if f['facility_id'] == 'otemachi-spa')
        ticket = facility['tariffs'][0]
        self.assertEqual((ticket['status'], ticket['rawLower'], ticket['rawUpper']), ('C', 1100, None))

    def test_conflicting_copies_of_same_ticket_are_rejected(self):
        ledger, classification = self.inputs('toyotomi')
        plan = next(p for p in ledger['plans'] if p['id'] == 'toyotomi-fureai-toji-day')
        plan['metrics']['Y01']['rawLower'] += 1
        with self.assertRaisesRegex(ValueError, 'inconsistent copies'):
            build.build_fee_populations(ledger, classification, self.catalog)

    def test_missing_facility_or_plan_classification_is_rejected(self):
        ledger, classification = self.inputs('zao')
        classification['facilities'].pop('zao-kamiyu')
        with self.assertRaisesRegex(ValueError, 'every recorded facility'):
            build.build_fee_populations(ledger, classification, self.catalog)
        ledger, classification = self.inputs('zao')
        classification['facilities']['zao-dairoten']['plan_classifications'].pop(
            'zao-dairoten-weekday')
        with self.assertRaisesRegex(ValueError, 'every plan'):
            build.build_fee_populations(ledger, classification, self.catalog)

    def test_plan_classification_cannot_move_to_another_facility(self):
        ledger, classification = self.inputs('zao')
        source = classification['facilities']['zao-dairoten']['plan_classifications']
        entry = source.pop('zao-dairoten-weekday')
        classification['facilities']['zao-shinzaemon']['plan_classifications'][
            'zao-dairoten-weekday'] = entry
        with self.assertRaisesRegex(ValueError, 'dangling fee plan'):
            build.build_fee_populations(ledger, classification, self.catalog)

    def test_all_classification_reference_types_are_checked(self):
        paths = [('inventory_evidence_ids',),
                 ('facilities', 'zao-shinzaemon', 'evidence_ids'),
                 ('facilities', 'zao-shinzaemon', 'tariff_inventory_evidence_ids'),
                 ('facilities', 'zao-shinzaemon', 'plan_classifications',
                  'zao-shinzaemon-mogami', 'evidence_ids')]
        for path in paths:
            ledger, classification = self.inputs('zao')
            target = classification
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = ['source-not-registered-in-this-region']
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, 'evidence'):
                    build.build_fee_populations(ledger, classification, self.catalog)

    def test_completion_and_confirmed_membership_claims_need_sources(self):
        for change, error in [('inventory', 'complete fee population'),
                              ('tariff', 'complete tariff inventory'),
                              ('membership', 'confirmed fee membership')]:
            ledger, classification = self.inputs('zao')
            definition = classification['facilities']['zao-shinzaemon']
            if change == 'inventory':
                classification['inventory_complete'] = True
            elif change == 'tariff':
                definition['tariff_inventory_complete'] = True
            else:
                definition['evidence_ids'] = []
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, error):
                    build.build_fee_populations(ledger, classification, self.catalog)

    def test_known_nonordinary_series_cannot_silently_discard_a_ticket_without_sources(self):
        ledger, classification = self.inputs('hakone')
        entry = next(iter(classification['facilities']['shumeikan']['plan_classifications'].values()))
        entry['evidence_ids'] = []
        with self.assertRaisesRegex(ValueError, 'confirmed fee series needs evidence'):
            build.build_fee_populations(ledger, classification, self.catalog)

    def test_ordinary_fee_requires_confirmed_membership_daytrip_and_nonnegative_cost(self):
        for change in ['membership', 'modality', 'negative', 'unavailable', 'missing']:
            ledger, classification = self.inputs('zao')
            plan = next(p for p in ledger['plans'] if p['id'] == 'zao-dairoten-weekday')
            if change == 'membership':
                classification['facilities'][plan['facility_id']]['membership'] = 'unknown'
            elif change == 'modality':
                plan['modality'] = 'stay'
            elif change == 'negative':
                plan['metrics']['Y01']['rawLower'] = -1
            elif change == 'unavailable':
                plan['metrics']['Y01']['status'] = 'A'
            else:
                plan['metrics'].pop('Y01')
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, 'ordinary'):
                    build.build_fee_populations(ledger, classification, self.catalog)

    def test_fee_population_is_detached_from_classification_input(self):
        ledger, classification = self.inputs('zao')
        source_id = ledger['sources'][0]['id']
        classification['inventory_evidence_ids'] = [source_id]
        definition = classification['facilities']['zao-shinzaemon']
        definition['tariff_inventory_evidence_ids'] = [source_id]
        before = copy.deepcopy(classification)
        populations = build.build_fee_populations(ledger, classification, self.catalog)
        population = populations[0]
        facility = next(f for f in population['facilities'] if f['facility_id'] == 'zao-shinzaemon')
        population['inventory_evidence_ids'].append('mutation')
        facility['evidence_ids'].append('mutation')
        facility['tariff_inventory_evidence_ids'].append('mutation')
        facility['tariffs'][0]['evidence_ids'].append('mutation')
        self.assertEqual(classification, before)
        self.assertNotIn('mutation', populations[1]['inventory_evidence_ids'])

    def test_record_order_does_not_change_fee_populations(self):
        ledger, classification = self.inputs('zao')
        expected = build.build_fee_populations(ledger, classification, self.catalog)
        ledger['facilities'].reverse()
        ledger['plans'].reverse()
        classification['facilities'] = dict(reversed(list(classification['facilities'].items())))
        for definition in classification['facilities'].values():
            definition['plan_classifications'] = dict(
                reversed(list(definition['plan_classifications'].items())))
        self.assertEqual(build.build_fee_populations(ledger, classification, self.catalog), expected)

    def test_combined_and_independent_pricing_trials_match_without_mutating_inputs(self):
        before_studies, before_pricing = copy.deepcopy(self.studies), copy.deepcopy(self.pricing)
        separate = {
            region: build.build_region(study, self.catalog, self.pricing[region])
            for region, study in self.studies.items()
        }
        aggregate = {
            region: build.build_region(self.studies[region], self.catalog, self.pricing[region])
            for region in reversed(build.TARGET_IDS)
        }
        self.assertEqual(separate, aggregate)
        self.assertEqual(self.studies, before_studies)
        self.assertEqual(self.pricing, before_pricing)
        self.assertTrue(all(ledger['trial']['depends_on_regions'] == []
                            and ledger['trial']['pricing_input_sha256']
                            for ledger in separate.values()))


if __name__ == '__main__':
    unittest.main()
