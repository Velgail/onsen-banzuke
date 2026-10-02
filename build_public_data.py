#!/usr/bin/env python3
"""Build independent, source-backed region ledgers and the Pages release.

No network I/O and no normalization against another region's observations.
Raw research is authoritative; scoring scales come from the versioned rubric.
"""
import argparse
import copy
import hashlib
import html
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / 'onsen_banzuke_metric_catalog_v1.json'
SNAPSHOT = 'pilot10-fees-2026-10-03'
TARGET_IDS = ['zao', 'kaminoyama', 'kusatsu', 'hakone', 'toyotomi', 'arima',
              'beppu', 'shiobara', 'otemachi', 'shirahone']
STATES = {'K', 'C', 'Z', 'U', 'X', 'F', 'E', 'A'}
PREFECTURES = '北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 岐阜 静岡 愛知 三重 滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄'.split()
LABELS = {'K': '確認済み', 'C': '条件付き', 'Z': '不存在・非該当確認',
          'U': '探索範囲で未確認', 'X': '矛盾', 'F': '取得不能', 'E': '未調査', 'A': '対象外'}
WATER_SCOPES = {'源泉': 'source', '供給系統': 'supply', '分析試料': 'analysis_sample'}
WATER_TABLES = {'source': 'source_entities', 'supply': 'supply_entities',
                'analysis_sample': 'analysis_samples'}
EVIDENCED_STATES = {'K', 'C', 'Z', 'X'}


def no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f'duplicate JSON key: {key}')
        obj[key] = value
    return obj


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=no_duplicate_keys)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def canonical_key(key, metric_map, redirects=None):
    match = re.fullmatch(r'([A-Z]\d{2})(?:\[([^\[\]\s]+)\])?', key)
    if not match or match[1] not in metric_map:
        raise ValueError(f'not an active metric view: {key}')
    if not match[2]:
        return key
    parameters = [part.split('=', 1) for part in match[2].split(',')]
    if any(len(p) != 2 or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', p[0]) or not p[1] for p in parameters):
        raise ValueError(f'invalid parameters: {key}')
    if len({p[0] for p in parameters}) != len(parameters):
        raise ValueError(f'duplicate parameters: {key}')
    canonical = match[1] + '[' + ','.join(f'{k}={v}' for k, v in sorted(parameters)) + ']'
    redirect = (redirects or {}).get(canonical)
    if redirect:
        values = redirect.get('parameters', {})
        return redirect['metric_id'] + ('[' + ','.join(f'{k}={v}' for k, v in sorted(values.items())) + ']' if values else '')
    return canonical


def finite_or_none(value):
    if value is not None and (type(value) not in [int, float] or not math.isfinite(value)):
        raise ValueError(f'raw bound must be finite or null: {value!r}')
    return value


def clip(value):
    return min(1, max(0, value))


def formula_score(formula, value):
    linear = re.fullmatch(r'([UD])\(([-\d.]+),([-\d.]+)\)', formula)
    if linear:
        a, b = float(linear[2]), float(linear[3])
        return 100 * clip((value - a) / (b - a) if linear[1] == 'U' else (b - value) / (b - a))
    if formula == 'B':
        return 100 * clip(value)
    if formula in ['R', 'INTERSECTION']:
        return 100 * clip(value)
    if formula == 'INT':
        return min(100, max(0, value))
    if formula == '100−INT':
        return 100 - min(100, max(0, value))
    count = re.fullmatch(r'N\(([\d.]+)\)', formula)
    if count:
        return 100 * clip(value / float(count[1]))
    logarithmic = re.fullmatch(r'L\(([\d.]+)\)', formula)
    if logarithmic:
        t = float(logarithmic[1])
        if value <= 0:
            return 0
        if value < t / 10:
            return 25 * value / (t / 10)
        return min(100, 25 + 25 * math.log10(value / (t / 10)))
    if formula.startswith('PL('):
        points = [tuple(map(float, part.split(':'))) for part in formula[3:-1].split(',')]
        if value <= points[0][0]:
            return points[0][1]
        for (a, sa), (b, sb) in zip(points, points[1:]):
            if value <= b:
                return sa + (sb - sa) * (value - a) / (b - a)
        return points[-1][1]
    # Relative rarity and unspecified dimensions need their explicit context.
    raise ValueError(f'formula needs additional context or is unsupported: {formula}')


def normalize_row(row, metric, source_ids, key):
    row = copy.deepcopy(row)
    if row['status'] not in STATES:
        raise ValueError(f'{key}: invalid status')
    references = row.get('evidence_ids', [])
    if not set(references) <= source_ids:
        raise ValueError(f'{key}: dangling evidence ID')
    if row['status'] in {'K', 'C', 'Z', 'X', 'A'} and not references:
        raise ValueError(f'{key}: an evidenced status requires sources')
    if not row.get('reason'):
        raise ValueError(f'{key}: missing explanation')
    low, high = finite_or_none(row.get('rawLower')), finite_or_none(row.get('rawUpper'))
    if low is not None and high is not None and low > high:
        raise ValueError(f'{key}: reversed raw interval')
    row['rawLower'], row['rawUpper'] = low, high
    if row['status'] in {'U', 'E', 'F'}:
        if low is not None or high is not None:
            raise ValueError(f'{key}: missing state cannot carry invented raw bounds')
        row['lower'], row['upper'] = 0, 100
    elif row['status'] == 'A':
        if low is not None or high is not None:
            raise ValueError(f'{key}: unavailable numerical services use null')
        row['lower'], row['upper'] = 0, 0
    else:
        formula = metric['formula']
        if row['status'] in {'K', 'Z'} and (low is None or high is None):
            raise ValueError(f'{key}: exact/evidenced absence requires both raw bounds; use C for a lower bound')
        if formula == 'B' and any(v is not None and v not in [0, 1] for v in [low, high]):
            raise ValueError(f'{key}: binary scale must use 0 or 1')
        if formula in {'R', 'INTERSECTION'} and any(v is not None and not 0 <= v <= 1 for v in [low, high]):
            raise ValueError(f'{key}: use a true fraction, not percent')
        if formula in {'INT', '100−INT'} and any(v is not None and v not in [0, 25, 50, 75, 100] for v in [low, high]):
            raise ValueError(f'{key}: invalid intensity dictionary value')
        values = [formula_score(formula, low if low is not None else -math.inf),
                  formula_score(formula, high if high is not None else math.inf)]
        row['lower'], row['upper'] = min(values), max(values)
    row['formula'] = metric['formula']
    row['metricKey'] = key
    return row


def build_fee_populations(ledger, classification, catalog):
    """Explicit membership and ticket IDs; never infer a complete population."""
    region_id = ledger['region']['id']
    source_ids = {s['id'] for s in ledger['sources']}
    facility_ids = {f['id'] for f in ledger['facilities']}
    if set(classification['facilities']) != facility_ids:
        raise ValueError(f'{region_id}: fee classification must cover every recorded facility')
    if not isinstance(classification['inventory_complete'], bool) or not classification['inventory_reason']:
        raise ValueError(f'{region_id}: explicit fee inventory completeness and reason are required')
    if classification['inventory_complete'] and not classification.get('inventory_evidence_ids'):
        raise ValueError(f'{region_id}: complete fee population requires inventory evidence')
    if not set(classification.get('inventory_evidence_ids', [])) <= source_ids:
        raise ValueError(f'{region_id}: dangling inventory evidence')
    plan_map = {p['id']: p for p in ledger['plans']}
    classified_plans = set()
    populations = []
    for day_type in ['weekday', 'weekend']:
        facilities = []
        for facility in sorted(ledger['facilities'], key=lambda item: item['id']):
            definition = classification['facilities'][facility['id']]
            membership = definition['membership']
            if membership not in {'included', 'excluded', 'unknown'} or not definition['reason']:
                raise ValueError(f'{facility["id"]}: invalid fee membership')
            if not set(definition['evidence_ids']) <= source_ids:
                raise ValueError(f'{facility["id"]}: dangling membership evidence')
            if membership != 'unknown' and not definition['evidence_ids']:
                raise ValueError(f'{facility["id"]}: confirmed fee membership needs evidence')
            complete = definition['tariff_inventory_complete']
            if not isinstance(complete, bool) or (complete and not definition['tariff_inventory_evidence_ids']):
                raise ValueError(f'{facility["id"]}: complete tariff inventory needs evidence')
            if not set(definition['tariff_inventory_evidence_ids']) <= source_ids:
                raise ValueError(f'{facility["id"]}: dangling tariff inventory evidence')
            units = {}
            for plan_id, entry in definition['plan_classifications'].items():
                if plan_id not in plan_map or plan_map[plan_id]['facility_id'] != facility['id']:
                    raise ValueError(f'{facility["id"]}: dangling fee plan')
                classified_plans.add(plan_id)
                if entry['series'] not in {'ordinary', 'private', 'meal_required', 'rest_package', 'stay', 'unknown'}:
                    raise ValueError(f'{plan_id}: invalid fee series')
                if not entry['reason'] or not set(entry['evidence_ids']) <= source_ids:
                    raise ValueError(f'{plan_id}: invalid fee classification evidence')
                if entry['series'] != 'unknown' and not entry['evidence_ids']:
                    raise ValueError(f'{plan_id}: confirmed fee series needs evidence')
                plan = plan_map[plan_id]
                if entry['series'] != 'ordinary':
                    continue
                if membership != 'included' or plan['modality'] != 'daytrip' or not entry['evidence_ids']:
                    raise ValueError(f'{plan_id}: ordinary fee needs confirmed ordinary daytrip membership')
                if plan['day_type'] not in {day_type, 'all'}:
                    continue
                row = plan['metrics'].get('Y01')
                if row is None or row['status'] in {'A', 'Z'}:
                    raise ValueError(f'{plan_id}: ordinary fee has no available numerical service')
                if any(bound is not None and bound < 0 for bound in [row['rawLower'], row['rawUpper']]):
                    raise ValueError(f'{plan_id}: ordinary monetary bounds must be nonnegative')
                unit_id = entry['fee_unit_id']
                if not unit_id or not isinstance(unit_id, str):
                    raise ValueError(f'{plan_id}: fee unit ID is required')
                tariff = {'id': unit_id, 'status': row['status'], 'rawLower': row['rawLower'],
                          'rawUpper': row['rawUpper'], 'evidence_ids': sorted(set(row['evidence_ids'])),
                          'plan_ids': [plan_id], 'reason': row['reason'], 'day_type': day_type}
                previous = units.get(unit_id)
                if previous:
                    if any(previous[key] != tariff[key] for key in ['status', 'rawLower', 'rawUpper']):
                        raise ValueError(f'{unit_id}: inconsistent copies of the same admission ticket')
                    previous['plan_ids'] = sorted(previous['plan_ids'] + [plan_id])
                    previous['evidence_ids'] = sorted(set(previous['evidence_ids']) | set(tariff['evidence_ids']))
                else:
                    units[unit_id] = tariff
            facilities.append({'facility_id': facility['id'], 'name': facility['name'],
                               'membership': membership, 'reason': definition['reason'],
                               'evidence_ids': list(definition['evidence_ids']),
                               'tariff_inventory_complete': complete,
                               'tariff_inventory_evidence_ids': list(definition['tariff_inventory_evidence_ids']),
                               'tariffs': [units[key] for key in sorted(units)]})
        populations.append({'id': f'{region_id}-ordinary-{day_type}', 'regionId': region_id,
                            'day_type': day_type, 'policy_id': catalog['regional_daytrip_fee_policy']['id'],
                            'condition_key': catalog['regional_daytrip_fee_policy']['condition_key'],
                            'inventory_complete': classification['inventory_complete'],
                            'inventory_reason': classification['inventory_reason'],
                            'inventory_evidence_ids': list(classification.get('inventory_evidence_ids', [])),
                            'condition_note': '曜日別公表通常料金・入場時刻の指定なし（公表入場時間内）。一般成人1名・非住民非会員・入浴のみ・自前タオル可なら持参。指定日の営業・枠・価格は未確認。',
                            'facilities': facilities})
    if classified_plans != set(plan_map):
        raise ValueError(f'{region_id}: fee series classification must cover every plan')
    return populations


def build_region(study, catalog, pricing=None):
    """Pure regional build: no other study or observed extrema are inputs."""
    region_id = study['region']['id']
    metrics = {m['id']: m for m in catalog['metrics']}
    sources = study['sources']
    source_ids = {s['id'] for s in sources}
    if len(source_ids) != len(sources):
        raise ValueError(f'{region_id}: duplicate source IDs')
    for source in sources:
        if not source.get('url', '').startswith(('https://', 'http://')) or not source.get('locator'):
            raise ValueError(f'{region_id}: source needs a URL and location')
    facility_ids = {f['id'] for f in study['facilities']}
    if len(facility_ids) != len(study['facilities']):
        raise ValueError(f'{region_id}: duplicate facilities')
    ledger = copy.deepcopy(study)
    observations = []
    water_entities = {}
    for scope, table in WATER_TABLES.items():
        entries = study.get(table, [])
        ids = {entry['id'] for entry in entries}
        if len(ids) != len(entries) or ids & set(water_entities):
            raise ValueError(f'{region_id}: duplicate water entity IDs')
        for entry in entries:
            refs = entry.get('source_ids', []) if scope == 'analysis_sample' else entry.get('evidence_ids', [])
            if not set(refs) <= source_ids:
                raise ValueError(f'{entry["id"]}: dangling water entity evidence')
            if entry.get('identity_status') not in STATES:
                raise ValueError(f'{entry["id"]}: missing or invalid water identity status')
            if scope != 'analysis_sample' and not entry.get('reason'):
                raise ValueError(f'{entry["id"]}: water identity needs an explanation')
            water_entities[entry['id']] = scope
    for scope, table in WATER_TABLES.items():
        for entry in study.get(table, []):
            for field, expected in [('source_entity_id', 'source'), ('supply_entity_id', 'supply')]:
                if field in entry and water_entities.get(entry[field]) != expected:
                    raise ValueError(f'{entry["id"]}: dangling {expected} reference')

    # A local identifier is not proof of a source's physical identity or of
    # continuing delivery to a bath. Unknown identities stay explicit records.
    physical_entities = {}
    for plan in study['plans']:
        scope = plan.get('entity_scope', 'bath')
        if scope not in {'bath', 'bath_group', 'facility_scope'}:
            raise ValueError(f'{plan["id"]}: invalid physical entity scope')
        for field, expected in [('source_entity_id', 'source'), ('supply_entity_id', 'supply'),
                                ('analysis_sample_id', 'analysis_sample')]:
            if field in plan and water_entities.get(plan[field]) != expected:
                raise ValueError(f'{plan["id"]}: dangling {expected} reference')
        bath_id = plan.get('bath_id')
        if scope == 'facility_scope':
            if bath_id is not None:
                raise ValueError(f'{plan["id"]}: facility_scope cannot claim a bath identity')
            continue
        if not bath_id:
            raise ValueError(f'{region_id}: missing bath identity must remain facility_scope')
        if not bath_id.startswith(plan['facility_id'] + ':'):
            raise ValueError(f'{plan["id"]}: bath identity must include facility_id')
        identity = (plan['facility_id'], scope)
        if bath_id in physical_entities and physical_entities[bath_id] != identity:
            raise ValueError(f'{bath_id}: conflicting physical entity')
        physical_entities[bath_id] = identity
        if scope == 'bath_group' and plan.get('group_policy') != 'common_observations_only':
            raise ValueError(f'{plan["id"]}: bath_group needs a common-observation policy')
    if set(water_entities) & ({region_id} | facility_ids | {p['id'] for p in study['plans']} | set(physical_entities)):
        raise ValueError(f'{region_id}: water and physical entity IDs must be distinct')

    def convert_map(rows, entity_id, entity_scope, plan_context=None, archived=False):
        result = {}
        for original_key, row in rows.items():
            key = canonical_key(original_key, metrics, catalog.get('parameter_redirects', {}))
            if key in result:
                raise ValueError(f'{entity_id}: duplicate canonical view {key}')
            result[key] = normalize_row(row, metrics[key[:3]], source_ids, key)
            catalog_scope = metrics[key[:3]]['scope']
            result[key]['catalog_scope'] = catalog_scope
            water_scope = WATER_SCOPES.get(catalog_scope)
            if archived and not water_scope:
                raise ValueError(f'{key}: archived metric needs a water entity scope')
            if water_scope:
                origin_id, origin_scope = row.get('entity_id'), row.get('entity_scope')
                if origin_scope != water_scope or water_entities.get(origin_id) != water_scope:
                    raise ValueError(f'{key}: explicit {water_scope} entity reference is required')
                if archived and (origin_id != entity_id or origin_scope != entity_scope):
                    raise ValueError(f'{key}: archived metric must belong to its containing entity')
                if plan_context:
                    reference = {'source': 'source_entity_id', 'supply': 'supply_entity_id',
                                 'analysis_sample': 'analysis_sample_id'}[water_scope]
                    if plan_context.get(reference) != origin_id:
                        raise ValueError(f'{key}: plan water entity mismatch')
                if plan_context and row['status'] in EVIDENCED_STATES:
                    correspondence = row.get('target_correspondence', {})
                    if (correspondence.get('status') not in {'K', 'C'}
                            or not correspondence.get('reason')
                            or not correspondence.get('evidence_ids')
                            or correspondence.get('target_entity_id') != plan_context.get('bath_id')
                            or not set(correspondence['evidence_ids']) <= source_ids):
                        raise ValueError(f'{key}: evidenced water value needs target correspondence')
            elif plan_context and catalog_scope in {'利用プラン', '宿泊プラン', '宿泊・食事プラン', '訪問プラン', '食事プラン', '客室条件'}:
                origin_id, origin_scope = plan_context['id'], 'plan'
            elif plan_context and catalog_scope.startswith('施設'):
                origin_id, origin_scope = plan_context['facility_id'], 'facility'
            else:
                origin_id, origin_scope = entity_id, entity_scope
            if (plan_context and origin_scope == 'bath_group'
                    and catalog_scope == '浴槽条件' and row['status'] in EVIDENCED_STATES
                    and row.get('group_applicability') != 'common'):
                raise ValueError(f'{key}: bath_group cannot borrow a single member value')
            result[key]['entity_id'] = origin_id
            result[key]['entity_scope'] = origin_scope
            result[key]['applies_to_plan'] = not archived
            observations.append(result[key])
        return result

    for scope, table in WATER_TABLES.items():
        for entry in ledger.get(table, []):
            entry['archived_metrics'] = convert_map(entry.get('archived_metrics', {}), entry['id'], scope, archived=True)

    regional = convert_map(study.get('region_metrics', {}), region_id, 'region')
    ledger['region_metrics'] = regional
    plans, seen_plans = [], set()
    for original in study['plans']:
        plan = copy.deepcopy(original)
        if plan['id'] in seen_plans or plan['regionId'] != region_id or plan['facility_id'] not in facility_ids:
            raise ValueError(f'{region_id}: duplicate plan or dangling entity reference')
        seen_plans.add(plan['id'])
        if plan['modality'] not in {'daytrip', 'stay'} or plan.get('day_type', 'all') not in {'weekday', 'weekend', 'all'}:
            raise ValueError(f'{region_id}: invalid comparison condition')
        plan['day_type'] = plan.get('day_type', 'all')
        plan['entity_scope'] = plan.get('entity_scope', 'bath')
        if not plan.get('bath_id') and plan['entity_scope'] != 'facility_scope':
            raise ValueError(f'{region_id}: missing bath identity must remain facility_scope')
        own = convert_map(original['metrics'], plan.get('bath_id') or plan['facility_id'], plan['entity_scope'], plan)
        # Region facts retain their origin; only contextual regional axes attach.
        if set(regional) & set(own):
            raise ValueError(f'{region_id}: regional and plan-specific facts overlap')
        plan['metrics'] = {**regional, **own}
        plan['evidence_note'] = '出典付きの初回独立検証。未調査はE。掲載候補内の暫定比較で、全浴槽の網羅や指定日の予約成立を表さない。'
        plans.append(plan)
    ledger['plans'] = plans
    inventory = []
    for metric in catalog['metrics']:
        entries = [r for r in observations if r['metricKey'][:3] == metric['id']]
        acquired = [r for r in entries if r['status'] != 'E']
        inventory.append({'metric_id': metric['id'], 'name': metric['name'], 'scope': metric['scope'],
                          'investigation_state': 'partial_observations' if acquired else 'E',
                          'views': sorted({r['metricKey'] for r in entries}),
                          'observations': entries,
                          'reason': '記載の実体・パラメータ・条件の行のみ調査。全件・全条件の完了とは異なる。' if acquired else '基本項目の調査未完了。不存在・未開示を示す値ではない。'})
    ledger['metric_inventory'] = inventory
    ledger['coverage'] = {'basic_metric_count': len(inventory),
                          'basic_metrics_with_observations': sum(bool(r['investigation_state'] != 'E') for r in inventory),
                          'basic_metrics_not_investigated': sum(r['investigation_state'] == 'E' for r in inventory),
                          'source_count': len(sources),
                          'source_count_definition': '資料台帳登録件数（地域別重複と取得失敗を含む）',
                          'investigation_count_definition': '調査行ありは原資料のみの確認と探索済み未確認を含む。候補への適用確認数・全槽の取得率ではない。',
                          'facility_count': len(facility_ids), 'plan_count': len(plans),
                          'complete': False}
    ledger['access_inventory'] = [{'origin_prefecture': p, 'origin_definition': '都道府県庁本庁舎一般来庁者入口（入口座標未確認）',
                                   'date': d, 'departure': '09:00', 'mode': mode, 'status': 'E',
                                   'reason': '標準アクセス条件を未調査。距離からの概算は採用しない。'}
                                  for p in PREFECTURES for d in ['2026-10-13', '2026-10-10'] for mode in ['public_transport', 'car']]
    ledger['comparison_dates'] = {'access_weekday': '2026-10-13', 'access_saturday': '2026-10-10',
                                 'stay_weekday': '2026-11-10', 'stay_saturday': '2026-10-31',
                                 'holiday_source': 'https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html',
                                 'note': '基準条件を定義しただけで、運行・営業・価格・空室は取得していない。11月3日は祝日のため宿泊平日基準から除く。'}
    ledger['schema_version'] = '2'
    ledger['rubric_version'] = catalog['version']
    ledger['dataset_kind'] = 'evidence_pilot'
    ledger['snapshot_id'] = SNAPSHOT
    ledger['trial'] = {'id': f'{region_id}-{SNAPSHOT}', 'independent': True,
                       'input_sha256': hashlib.sha256(json.dumps(study, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                       'rubric_sha256': hashlib.sha256(json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                       'depends_on_regions': [], 'rarity_comparison_connected': False,
                       'note': '他温泉地の調査結果・標本の最大最小・順位を入力にしない。希少性は固定比較台帳未接続で未採点。'}
    if pricing is not None:
        ledger['fee_populations'] = build_fee_populations(ledger, pricing, catalog)
        ledger['trial']['pricing_input_sha256'] = hashlib.sha256(json.dumps(pricing, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return ledger


def region_report(ledger):
    esc = html.escape
    r, coverage = ledger['region'], ledger['coverage']
    source_map = {s['id']: s for s in ledger['sources']}

    def refs(row):
        return ' / '.join(f'<a href="{esc(source_map[i]["url"], quote=True)}">{esc(source_map[i]["title"])}</a>' for i in row['evidence_ids'])

    def raw(row):
        a, b = row['rawLower'], row['rawUpper']
        if a is None and b is None:
            return '未確認' if row['status'] != 'A' else '対象外'
        return (str(a) if a == b else f'{a if a is not None else "下限未確定"}〜{b if b is not None else "上限未確定"}') + ' ' + row.get('unit', '')

    def observation(row):
        applicability = '参照資料のみ・候補への適用未確認' if row.get('applies_to_plan') is False else '記載条件の候補行（状態と対応範囲を参照）'
        return f'<p><strong>{esc(row["metricKey"])}</strong> / {LABELS[row["status"]]}<br>実体 scope={esc(row["entity_scope"])} / ID={esc(row["entity_id"])}<br><strong>{applicability}</strong><br>生値 {esc(raw(row))} ／ 点 {row["lower"]:.1f}〜{row["upper"]:.1f}<br>{esc(row.get("condition", ""))}<br>{esc(row["reason"])}<br>{refs(row)}</p>'

    inventory = []
    for item in ledger['metric_inventory']:
        records = ''.join(observation(row) for row in item['observations'])
        inventory.append(f'<tr><th>{item["metric_id"]}<br>{esc(item["name"])}</th><td>{records or "E：未調査"}</td></tr>')
    sources = ''.join(f'<li><a href="{esc(s["url"], quote=True)}">{esc(s["title"])}</a> — {esc(s["publisher"])}／確認 {esc(s["retrieved_at"])}<br>{esc(s["locator"])}：{esc(s["summary"])}</li>' for s in ledger['sources'])
    plans = ''.join(f'<li><strong>{esc(p["label"])}</strong>（{p["modality"]} / {p["day_type"]}）<br>{esc(p["condition_label"])} / 適用範囲 {esc(p["entity_scope"])}</li>' for p in ledger['plans'])
    findings = ''.join(f'<li>{esc(x)}</li>' for x in ledger.get('findings', []))
    remaining = ''.join(f'<li>{esc(x)}</li>' for x in ledger['study']['uninvestigated'])
    issues = ''.join(f'<li>{esc(x)}</li>' for x in ledger.get('issues', []))
    excluded = ''.join(f'<li><strong>{esc(f["name"])}</strong>：{esc(f["reason"])}</li>' for f in ledger.get('excluded_facilities', []))
    samples = esc(json.dumps(ledger.get('analysis_samples', []), ensure_ascii=False, indent=2))
    return f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(r['name'])} 独立検証台帳</title><link rel="stylesheet" href="../assets/styles.css"><link rel="stylesheet" href="../assets/article.css"></head><body><main class="article-shell"><nav class="article-links"><a href="../index.html">番付・一覧</a><a href="./pilot10.html">10温泉地の検証</a><a href="../fees.html">日帰り料金の比較</a><a href="../data/releases/{SNAPSHOT}/ledgers/{r['id']}.json">全台帳JSON</a></nav><h1>{esc(r['name'])}：独立検証</h1><p>評価日 2026-10-03 ／ 採点基準 {ledger['rubric_version']} ／ 初回部分調査</p><p>{esc(r['scope_note'])}</p><div class="demo-notice"><strong>調査未完了</strong><span>{coverage['basic_metrics_with_observations']}/{coverage['basic_metric_count']}基本項目に調査行があります。原資料のみの確認・探索済み未確認も含み、候補への適用確認数ではありません。全施設・全パラメータの網羅ではありません。未調査 {coverage['basic_metrics_not_investigated']}項目、標準アクセス188条件はEです。</span></div><h2>確認した特徴・分岐</h2><ul>{findings}</ul><h2>利用候補と条件</h2><ul>{plans}</ul><h2>分析試料・供給対応</h2><pre>{samples}</pre><h2>資料の矛盾・取得制約</h2><ul>{issues}</ul><h2>対象から外した施設・条件</h2><ul>{excluded or "<li>今回の調査では追加除外の判定なし（全件調査は未完了）。</li>"}</ul><h2>調査残</h2><ul>{remaining}</ul><details><summary>全基本項目の台帳を開く</summary><table><thead><tr><th>基本項目</th><th>実体・条件・原値・点・根拠</th></tr></thead><tbody>{''.join(inventory)}</tbody></table></details><h2>根拠一覧</h2><ul>{sources}</ul><p>試行ID {ledger['trial']['id']}。他温泉地の結果への依存なし。順位・希少性を入力にせず、公開範囲の拡張でも既存の素点は変わりません。</p></main></body></html>'''


def publish_roster(release):
    roster = read_json(ROOT / 'research/roster/official-2026-10-03.json')
    write_json(release / 'roster.json', roster)
    chars = {c['id']: c for c in roster['characters']}
    esc = html.escape
    rows = []
    for region in roster['region_candidates']:
        links = ' / '.join(f'<a href="{esc(chars[c]["official_url"], quote=True)}">{esc(chars[c]["name"])}</a>' for c in region['character_ids'])
        report = f'<a href="./{region["id"]}.html">初回部分調査</a>' if region['id'] in TARGET_IDS else 'E：未調査'
        parent = next((r['candidate_name'] for r in roster['region_candidates'] if r['id'] == region['parent_candidate_id']), '')
        rows.append(f'<tr><th>{esc(region["candidate_name"])}</th><td>{esc(region["prefecture"])}</td><td>{links}</td><td>{report}</td><td>{esc(parent)}<br>{esc(region["overlap_note"])}</td></tr>')
    policies = ''.join(f'<li>{esc(v)}</li>' for v in roster['policy'])
    document = f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>温泉むすめ公式一覧からの対象整理</title><link rel="stylesheet" href="../assets/styles.css"><link rel="stylesheet" href="../assets/article.css"></head><body><main class="article-shell"><nav class="article-links"><a href="../index.html">番付</a><a href="./pilot10.html">10温泉地の検証</a><a href="../fees.html">日帰り料金の比較</a><a href="../data/releases/{SNAPSHOT}/roster.json">対応台帳JSON</a></nav><h1>現行公式一覧から対象を整理する</h1><p>基準日 2026-10-03。<a href="{roster["source_url"]}">温泉むすめ公式の地方別キャラクター一覧</a>から全件を照合しました。</p><div class="demo-notice"><strong>人数と温泉地数は別に管理</strong><span>掲載137キャラクターのうち温泉キャラクター135、その他2。有馬の2人を同じ対象へ統合し、134の地域調査候補を作成しました。親地域と下位地区を含むため、互いに重ならない134温泉地の確定を意味しません。</span></div><p>指定10地域を初回部分調査、残る124候補はEです。130に件数を合わせた切り捨ては行いません。親子関係の施設集合を確認してから、全国の地域数と番付単位を確定します。</p><ul>{policies}</ul><p>地域名は調査用の候補名称です。キャラクター一覧だけでは地域境界・住所付き構成施設一覧・現在の入浴可否を確定できません。</p><div class="report-table-wrap"><table><thead><tr><th>地域調査候補</th><th>公式地方表記</th><th>公式対応キャラクター</th><th>調査状態</th><th>親地域・重なり</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div></main></body></html>'
    (ROOT / 'docs/reports/roster.html').write_text(document)
    return roster


def pilot_report(ledgers, roster):
    esc = html.escape
    rows = []
    for ledger in ledgers:
        r, c = ledger['region'], ledger['coverage']
        findings = '<br>'.join(esc(v) for v in ledger.get('findings', [])[:2])
        rows.append(f'<tr><th><a href="./{r["id"]}.html">{esc(r["name"])}</a></th><td>{c["source_count"]}</td><td>{c["facility_count"]}</td><td>{c["plan_count"]}</td><td>{c["basic_metrics_with_observations"]}/{c["basic_metric_count"]}</td><td>{findings}</td></tr>')
    total_sources = sum(l['coverage']['source_count'] for l in ledgers)
    total_plans = sum(l['coverage']['plan_count'] for l in ledgers)
    return f'<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>10温泉地の独立検証</title><link rel="stylesheet" href="../assets/styles.css"><link rel="stylesheet" href="../assets/article.css"></head><body><main class="article-shell"><nav class="article-links"><a href="../index.html">番付をつくる</a><a href="./roster.html">現行公式一覧と対象整理</a><a href="../concept.html">公開設計</a><a href="../fees.html">日帰り料金の比較</a></nav><h1>指定10温泉地を独立に検証する</h1><p>評価日 2026-10-03 ／ 採点基準{ledgers[0]['rubric_version']} ／ {SNAPSHOT}</p><div class="demo-notice"><strong>初回部分調査</strong><span>実在する10地域・{total_plans}利用プランを記録。資料台帳登録件数は{total_sources}件（地域別重複と取得失敗を含む）。各地域{ledgers[0]["coverage"]["basic_metric_count"]}基本項目の台帳と188標準アクセス条件を用意し、未調査をEとして残しました。全項目・全施設の完了や、現行一覧全地域の採点完了を表しません。</span></div><h2>今回の独立試行</h2><p>各温泉地の調査入力は別JSONです。同じ採点基準と固定尺度で変換し、他温泉地の得点・最大値・最小値・順位を入力にしません。1件だけ再生成でき、対象の追加で既存の素点は変わりません。希少性は固定比較台帳未接続のため未採点です。</p><p>調査行数は、少なくとも一つの実体・パラメータ・条件について調査した基本項目数です。原資料だけを確認して候補への適用が未確認の行と、探索済み未確認の行も含みます。全槽・全条件の取得率や候補への適用確認数とは異なります。施設数には営業掲載の確認のみで採点候補を作らなかった施設も含みます。</p><div class="report-table-wrap"><table><thead><tr><th>対象</th><th>資料登録</th><th>施設台帳</th><th>プラン</th><th>調査行あり</th><th>確認した分岐</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div><h2>基準運用で確認したこと</h2><ul><li>源泉試料のpH・温度・濃度は、採水日・供給対応の確認状態も含めて別台帳へ保存する。現在の浴槽値として一律転用しない。</li><li>浴槽・施設・料金プラン・地域IPの適用実体を記録する。安い日帰り施設と別施設の露天を一つの候補へまとめない。</li><li>税込・税・必須レンタルまで確定しない料金は、公表額の下限と未確定上限で保存する。安さの下限点を作らず、予算の必須条件は3状態で判定する。</li><li>かけ流し・源泉100%という表現だけから五条件同時無加工率を100%にしない。方式の存在と営業中の時間率を区別する。</li><li>油分の有無・油臭の強度・除去工程は別の特性。泉質名から感覚強度や現地体験を作らない。</li><li>営業休止・時間帯・男女別・宿泊限定・季節・貸切人数を利用条件へ保存する。閉業施設は根拠付きで外し、未調査を不存在に読み替えない。</li></ul><h2>項目の整理を判断する材料</h2><p>今回の調査で不足が目立ったのは項目数より、値に結び付く実体・時点・条件です。透明性項目I群と水の特性C/P群、感覚S群、利用条件Y/Z群は異なる問いに答えるため、今回は件数合わせの統合を行っていません。五条件合成P17と個別処理条件は同じ分野で重みを配分し、二重の重視を見直せる形にします。</p><p>次の基準改訂では、公式記述・分析測定・現地観測を識別する観測チャンネルと、公開時点の不一致を保持する形式を明文化するのが有効です。項目の追加・統合・整理は、その分離でも答えられない具体的リクエストを確認してから判断します。</p><h2>通常日帰り料金の地域集約</h2><p>基準1.2で施設一件・同じ通常利用条件による中央値Y23、指定予算内の施設数Y24・割合Y25を追加しました。同一券の複数浴槽は重複排除し、休憩付き券などは別系列です。10地域とも母集団は未完成のため、地域中央値・割合は未算出。<a href="../fees.html">料金の比較画面</a>では取得範囲の参考値、確認済み予算内件数の下限、施設別の対象所属と料金選択肢の調査残を分けて表示します。</p><h2>公開と次の対象</h2><p>架空のデモ6地域・9プランを公開フォルダから削除し、この独立検証へ置き換えました。現行公式一覧の温泉キャラクター{roster["onsen_character_count"]}人から整理した地域候補は{roster["region_candidate_count"]}件。<a href="./roster.html">対象対応表</a>では親地域と下位地区の重なり、台湾、未調査の入浴可否を保持しています。</p><h2>残る調査</h2><p>各地域の全構成施設・浴槽の網羅、現在の成分と供給系統、浴槽での感覚強度、平日/土曜の宿泊見積り、標準アクセス、現行IP展示全件は未完了です。残りは各地域台帳に明示しており、未知の値を補完した確定全国番付は出していません。</p></main></body></html>'


def publish(ledgers, catalog):
    if {l['region']['id'] for l in ledgers} != set(TARGET_IDS):
        raise ValueError('publication requires all ten requested independent study files')
    release = ROOT / 'docs/data/releases' / SNAPSHOT
    envelope = {'schema_version': '2', 'rubric_version': catalog['version'], 'snapshot_id': SNAPSHOT, 'dataset_kind': 'evidence_pilot'}
    regions, plans, all_views, populations = [], [], set(), []
    for ledger in ledgers:
        r = copy.deepcopy(ledger['region'])
        r.update(summary=' '.join(ledger.get('findings', [])[:2]), landscape=r['prefecture'], coverage=ledger['coverage'],
                 report_url=f'./reports/{r["id"]}.html', ledger_url=f'./data/releases/{SNAPSHOT}/ledgers/{r["id"]}.json',
                 study_status=ledger['study']['status'])
        regions.append(r)
        plans.extend(ledger['plans'])
        populations.extend(ledger.get('fee_populations', []))
        for plan in ledger['plans']:
            all_views.update(plan['metrics'])
    # Keep the core water axes visible as missing, without inventing observations.
    all_views.update(['S06[odor=sulfur]', 'P17', 'B06', 'Y01', 'Y03', 'H18[place=bath]', 'C01'])
    metric_map = {m['id']: m for m in catalog['metrics']}
    special = {'S06[odor=sulfur]': ('硫黄の香り', '強い香り', '弱い香り'),
               'Y01': ('日帰り入浴料', '手頃な料金', '高い料金'),
               'B06': ('露天風呂', '露天がある', '露天を選ばない'),
               'H18[place=bath]': ('浴室の静けさ', '静かな浴室', 'にぎやかな浴室'),
               'C01': ('酸性の強さ', '酸性が強い', '酸性が弱い')}
    views = []
    for key in sorted(all_views):
        metric = metric_map[key[:3]]
        name, positive, negative = special.get(key, (metric['name'] + (f' {key[4:-1]}' if '[' in key else ''), '特性が高い', '特性が低い'))
        views.append({'key': key, 'name': name, 'positive': positive, 'negative': negative,
                      'description': metric['raw'] + '。' + metric['note'], 'group': metric['group']})
    write_json(release / 'regions.json', {**envelope, 'regions': regions})
    write_json(release / 'ranking.json', {**envelope, 'plans': plans})
    write_json(release / 'views.json', {**envelope, 'views': views})
    write_json(release / 'fee-populations.json', {**envelope, 'policy': catalog['regional_daytrip_fee_policy'], 'populations': populations})
    write_json(release / f'rubric-{catalog["version"]}.json', catalog)
    (ROOT / 'docs/criteria' / f'scoring-{catalog["version"]}.md').write_text((ROOT / 'onsen_banzuke_master_prompt_v1.md').read_text())
    counts = {'region_count': len(regions), 'plan_count': len(plans),
              'facility_count': sum(l['coverage']['facility_count'] for l in ledgers),
              'source_count': sum(l['coverage']['source_count'] for l in ledgers),
              'source_count_definition': '資料台帳登録件数（地域別重複と取得失敗を含む）',
              'distinct_source_url_count': len({s['url'] for l in ledgers for s in l['sources']})}
    write_json(ROOT / 'docs/data/manifest.json', {**envelope, **counts, 'published_at': '2026-10-03',
        'regions_url': f'./data/releases/{SNAPSHOT}/regions.json', 'ranking_url': f'./data/releases/{SNAPSHOT}/ranking.json',
        'views_url': f'./data/releases/{SNAPSHOT}/views.json', 'roster_url': f'./data/releases/{SNAPSHOT}/roster.json', 'rubric_url': f'./data/releases/{SNAPSHOT}/rubric-{catalog["version"]}.json',
        'fee_populations_url': f'./data/releases/{SNAPSHOT}/fee-populations.json',
        'fee_policy_id': catalog['regional_daytrip_fee_policy']['id'],
        'investigation_status': 'partial', 'requested_expansion_target_count': 130,
        'scope_note': 'ユーザー指定10温泉地の初回独立検証。130温泉地の網羅・各地域の全浴槽網羅・指定日の予約成立を表さない。'})
    roster = publish_roster(release)
    (ROOT / 'docs/reports/pilot10.html').write_text(pilot_report(ledgers, roster))
    print(json.dumps(counts, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region', choices=TARGET_IDS, help='build exactly one independent region')
    parser.add_argument('--publish', action='store_true', help='assemble the ten independently built studies')
    args = parser.parse_args()
    catalog = read_json(CATALOG_PATH)
    pricing = read_json(ROOT / 'research/pricing/ordinary-daytrip-2026-10-03.json')
    if pricing['policy_id'] != catalog['regional_daytrip_fee_policy']['id']:
        raise ValueError('fee classification policy does not match the rubric')
    selected = [args.region] if args.region else TARGET_IDS
    ledgers = []
    for region_id in selected:
        path = ROOT / 'research/regions' / f'{region_id}.json'
        ledger = build_region(read_json(path), catalog, pricing['regions'][region_id])
        ledgers.append(ledger)
        write_json(ROOT / 'docs/data/releases' / SNAPSHOT / 'ledgers' / f'{region_id}.json', ledger)
        report = ROOT / 'docs/reports' / f'{region_id}.html'
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(region_report(ledger))
        print(region_id, ledger['coverage'])
    if args.publish:
        publish(ledgers, catalog)


if __name__ == '__main__':
    main()
