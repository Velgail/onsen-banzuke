#!/usr/bin/env python3
"""温泉番付仕様の検算専用モデル。標準ライブラリのみで実行する。

本番の調査・予約・経路探索・自然言語解釈エンジンではない。Markdownと
JSONの登録内容を照合し、尺度と条件判定の代表的な境界挙動を再現する。
実際の施設情報、根拠の正しさ、網羅性は検証しない。旧検品書にある
5,964入力・49シナリオを再現したとの主張はせず、この実行の検査数を数える。

実行: python3 validate_scoring.py [--directory /path/to/onsen-banzuke]
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import itertools
import json
import math
from pathlib import Path
import re
import statistics
import sys
from typing import Any, Callable, Iterable


NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
METRIC_ID = re.compile(r"[A-Z]\d{2,}")
INT_LEVELS = (0.0, 25.0, 50.0, 75.0, 100.0)
UNKNOWN_STATES = {"U", "E", "F"}
STATES = {"K", "C", "Z", "U", "X", "F", "E", "A"}


def finite(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("finite numeric value required")
    try:
        number = float(value)
    except (ValueError, OverflowError) as error:
        raise ValueError("finite numeric value required") from error
    if not math.isfinite(number):
        raise ValueError("NaN and infinity are not permitted")
    return number


def number_token(token: str) -> float:
    if not NUMBER.fullmatch(token):
        raise ValueError(f"invalid numeric token: {token!r}")
    return finite(float(token))


def fraction(value: Any) -> float:
    number = finite(value)
    if not 0 <= number <= 1:
        raise ValueError("fraction must be in [0, 1]")
    return number


@dataclass(frozen=True)
class Interval:
    low: float
    high: float

    def __post_init__(self) -> None:
        low, high = finite(self.low), finite(self.high)
        if low > high:
            raise ValueError("reversed interval")
        object.__setattr__(self, "low", low)
        object.__setattr__(self, "high", high)

    def score_interval(self) -> "Interval":
        if not 0 <= self.low <= self.high <= 100:
            raise ValueError("score interval must be in [0, 100]")
        return self


@dataclass(frozen=True)
class Scale:
    kind: str
    parameters: tuple[Any, ...] = ()

    @classmethod
    def parse(cls, formula: str) -> "Scale":
        """許可した文法だけを解析する。eval/execは使用しない。"""
        if not isinstance(formula, str):
            raise ValueError("formula must be text")
        if formula in {"B", "R", "INT", "RARITY", "INTERSECTION", "100−INT", "100-INT"}:
            return cls("REVERSE_INT" if formula in {"100−INT", "100-INT"} else formula)
        match = re.fullmatch(r"(U|D|N|T|PL|L)\(([^()]*)\)", formula)
        if not match:
            raise ValueError(f"unsupported formula: {formula!r}")
        kind, body = match.groups()
        tokens = [token.strip() for token in body.split(",")]
        if kind == "PL":
            points = []
            for token in tokens:
                pair = token.split(":")
                if len(pair) != 2:
                    raise ValueError("PL requires x:y pairs")
                points.append((number_token(pair[0]), number_token(pair[1])))
            if len(points) < 2 or any(
                not 0 <= y <= 100 for _, y in points
            ) or any(x1 >= x2 or not math.isfinite(x2 - x1)
                     for (x1, _), (x2, _) in zip(points, points[1:])):
                raise ValueError("invalid PL knots")
            return cls(kind, tuple(points))
        # a/b/kは検算用設定であり、実利用者の好みやV10の分母を補完しない。
        parameters = tuple(
            38.0 if kind == "T" and index == 0 and token == "a" else
            41.0 if kind == "T" and index == 1 and token == "b" else
            8.0 if kind == "N" and index == 0 and token == "k" else
            number_token(token)
            for index, token in enumerate(tokens)
        )
        required = {"U": 2, "D": 2, "N": 1, "T": 3, "L": 1}[kind]
        if len(parameters) != required:
            raise ValueError("wrong parameter count")
        if kind in {"U", "D"}:
            a, b = parameters
            if a >= b or not math.isfinite(b - a):
                raise ValueError("U/D require finite a < b")
        elif kind == "T":
            a, b, distance = parameters
            if a > b or distance <= 0 or not all(
                math.isfinite(x) for x in (a - distance, b + distance)
            ):
                raise ValueError("T requires a <= b and d > 0")
        elif parameters[0] <= 0 or (kind == "L" and parameters[0] / 10 == 0):
            raise ValueError("N/L require a positive finite scale")
        return cls(kind, parameters)

    def point(self, raw: Any) -> float:
        kind, parameters = self.kind, self.parameters
        if kind == "B":
            if isinstance(raw, bool):
                return 100.0 if raw else 0.0
            value = finite(raw)
            if value not in (0, 1):
                raise ValueError("B requires explicit false/true or 0/1")
            return value * 100
        if kind == "RARITY":
            if not isinstance(raw, (tuple, list)) or len(raw) != 2:
                raise ValueError("RARITY requires (N, k)")
            population, count = (finite(x) for x in raw)
            if not population.is_integer() or not count.is_integer() or not (
                population >= 2 and 1 <= count <= population
            ):
                raise ValueError("RARITY requires integers N >= 2 and 1 <= k <= N")
            return 100 * (population - count) / (population - 1)
        if kind == "INTERSECTION":
            raise ValueError("use intersection_bounds for INTERSECTION")
        value = finite(raw)
        if kind == "R":
            return 100 * fraction(value)
        if kind in {"INT", "REVERSE_INT"}:
            if value not in INT_LEVELS:
                raise ValueError("INT requires a registered strength level")
            return 100 - value if kind == "REVERSE_INT" else value
        if kind in {"U", "D"}:
            a, b = parameters
            ascending = (0.0 if value <= a else 100.0 if value >= b else
                         100 * (value - a) / (b - a))
            return 100 - ascending if kind == "D" else ascending
        if kind == "N":
            if value < 0:
                raise ValueError("negative count")
            return 100.0 if value >= parameters[0] else 100 * value / parameters[0]
        if kind == "T":
            a, b, distance = parameters
            if a <= value <= b:
                return 100.0
            if value <= a - distance or value >= b + distance:
                return 0.0
            return 100 * (1 - (a - value if value < a else value - b) / distance)
        if kind == "L":
            if value < 0:
                raise ValueError("negative concentration")
            base = parameters[0] / 10
            if value == 0:
                return 0.0
            if value < base:
                return 25 * value / base
            score = 25 + 25 * (math.log10(value) - math.log10(base))
            return max(0.0, min(100.0, score))
        if kind == "PL":
            if value <= parameters[0][0]:
                return parameters[0][1]
            if value >= parameters[-1][0]:
                return parameters[-1][1]
            for (x1, y1), (x2, y2) in zip(parameters, parameters[1:]):
                if x1 <= value <= x2:
                    return y1 + (y2 - y1) * (value - x1) / (x2 - x1)
        raise ValueError("unsupported scale kind")

    def bounds(self, raw: Any, state: str = "K") -> Interval:
        if state not in STATES:
            raise ValueError("invalid state")
        if state in UNKNOWN_STATES or state == "A" or raw is None:
            if raw is not None:
                # 欠測コードは入力不正の隠蔽に使わない。
                if self.kind == "INTERSECTION":
                    intersection_bounds(raw)
                elif self.kind == "RARITY":
                    self.point(raw)
                elif isinstance(raw, (Interval, tuple, list)):
                    supplied = raw if isinstance(raw, Interval) else Interval(*raw)
                    self.point(supplied.low)
                    self.point(supplied.high)
                else:
                    self.point(raw)
            return Interval(0, 100)
        if self.kind == "INTERSECTION":
            return intersection_bounds(raw)
        if self.kind == "RARITY":
            value = self.point(raw)
            return Interval(value, value).score_interval()
        if isinstance(raw, Interval):
            raw_interval = raw
        elif isinstance(raw, (tuple, list)):
            if len(raw) != 2:
                raise ValueError("raw interval requires two endpoints")
            raw_interval = Interval(*raw)
        else:
            value = self.point(raw)
            return Interval(value, value).score_interval()
        points = [raw_interval.low, raw_interval.high]
        if self.kind == "T":
            points.extend(x for x in self.parameters[:2]
                          if raw_interval.low <= x <= raw_interval.high)
        elif self.kind == "PL":
            points.extend(x for x, _ in self.parameters
                          if raw_interval.low <= x <= raw_interval.high)
        values = [self.point(x) for x in points]
        return Interval(min(values), max(values)).score_interval()


def intersection_bounds(proportions: Iterable[Any]) -> Interval:
    rows = list(proportions)
    if not rows:
        raise ValueError("INTERSECTION requires at least one condition")
    ranges = []
    for raw in rows:
        if isinstance(raw, Interval):
            interval = raw
        elif isinstance(raw, (tuple, list)) and len(raw) == 2:
            interval = Interval(*raw)
        else:
            value = fraction(raw)
            interval = Interval(value, value)
        fraction(interval.low)
        fraction(interval.high)
        ranges.append(interval)
    return Interval(100 * max(0, sum(x.low for x in ranges) - (len(ranges) - 1)),
                    100 * min(x.high for x in ranges)).score_interval()


def retention_ratio_bounds(raw: Any) -> Interval:
    """F05の濃度比は真の割合とは別。1を超えた値を100に切り詰める。"""
    if isinstance(raw, Interval):
        interval = raw
    elif isinstance(raw, (tuple, list)) and len(raw) == 2:
        interval = Interval(*raw)
    else:
        value = finite(raw)
        interval = Interval(value, value)
    if interval.low < 0:
        raise ValueError("negative concentration ratio")
    return Interval(min(100, 100 * interval.low), min(100, 100 * interval.high))


@dataclass(frozen=True)
class ProfileRow:
    entity_id: str
    condition_id: str
    observation_id: str
    profile: tuple[Any, ...]


def profile_count_bounds(rows: Iterable[ProfileRow]) -> Interval:
    """V11の小規模検算。未知をNoneとし、最大クリークを総当たりする。

    外包の上下限であり、全ての中間値の実現・確率を保証しない。
    本番の大規模データ用アルゴリズムではなく、20行以下に制限する。
    """
    unique = {}
    width = None
    for row in rows:
        key = (row.entity_id, row.condition_id, row.observation_id)
        if any(not isinstance(value, str) or not value for value in key):
            raise ValueError("profile observation key required")
        if not row.profile or (width is not None and width != len(row.profile)):
            raise ValueError("profile fields must be nonempty and aligned")
        width = len(row.profile)
        if key in unique and unique[key] != row.profile:
            raise ValueError("conflicting profile observation")
        unique[key] = row.profile
    profiles = []
    complete = []
    for profile in unique.values():
        if all(value is not None for value in profile):
            if profile in complete:
                continue
            complete.append(profile)
        profiles.append(profile)
    count = len(profiles)
    if count > 20:
        raise ValueError("profile enumeration is limited to 20 rows")
    best = 0
    for mask in range(1, 1 << count):
        indices = [i for i in range(count) if mask & (1 << i)]
        if len(indices) <= best:
            continue
        if all(any(a is not None and b is not None and a != b
                   for a, b in zip(profiles[i], profiles[j]))
               for i, j in itertools.combinations(indices, 2)):
            best = len(indices)
    return Interval(best, count)


def contribution_bounds(bounds: Interval, weight: Any, state: str = "K") -> Interval:
    bounds.score_interval()
    weight = finite(weight)
    if abs(weight) > 1 or state not in STATES:
        raise ValueError("invalid weight/state")
    if state == "A" or weight == 0:
        return Interval(0, 0)
    if state in UNKNOWN_STATES:
        return Interval(0, 100)
    return bounds if weight > 0 else Interval(100 - bounds.high, 100 - bounds.low)


@dataclass(frozen=True)
class ScoreRow:
    bounds: Interval
    weight: float
    state: str = "K"
    evidence_matches: bool = True


@dataclass(frozen=True)
class Result:
    bounds: Interval
    evidence_rate: float
    numeric_certainty: float


def weighted_result(rows: Iterable[ScoreRow]) -> Result | None:
    active = []
    for row in rows:
        weight = finite(row.weight)
        contribution = contribution_bounds(row.bounds, weight, row.state)
        if weight:
            active.append((row, abs(weight), contribution))
    denominator = sum(weight for _, weight, _ in active)
    if denominator == 0:
        return None
    evidence = sum(weight for row, weight, _ in active
                   if row.state in {"K", "C", "Z"} and row.evidence_matches)
    certainty = sum(weight * (1 - (row.bounds.high - row.bounds.low) / 100)
                    for row, weight, _ in active
                    if row.state not in UNKNOWN_STATES | {"A"})
    return Result(
        Interval(sum(weight * value.low for _, weight, value in active) / denominator,
                 sum(weight * value.high for _, weight, value in active) / denominator),
        100 * evidence / denominator, 100 * certainty / denominator,
    )


def grouped_result(groups: Iterable[tuple[float, Iterable[ScoreRow]]]) -> Result | None:
    parts = []
    for budget, rows in groups:
        budget = finite(budget)
        if budget < 0:
            raise ValueError("negative group budget")
        result = weighted_result(rows)
        if budget and result is None:
            raise ValueError("positive budget with no active metric")
        if budget:
            parts.append((budget, result))
    total = sum(budget for budget, _ in parts)
    if not total:
        return None
    return Result(
        Interval(sum(b * r.bounds.low for b, r in parts) / total,
                 sum(b * r.bounds.high for b, r in parts) / total),
        sum(b * r.evidence_rate for b, r in parts) / total,
        sum(b * r.numeric_certainty for b, r in parts) / total,
    )


def best_plan_bounds(plans: Iterable[Interval]) -> Interval | None:
    ranges = list(plans)
    if not ranges:
        return None
    for interval in ranges:
        interval.score_interval()
    return Interval(max(x.low for x in ranges), max(x.high for x in ranges))


def tri_and(values: Iterable[str]) -> str:
    values = tuple(values)
    if not values or any(x not in {"true", "false", "unknown"} for x in values):
        raise ValueError("invalid three-valued conditions")
    return "false" if "false" in values else "unknown" if "unknown" in values else "true"


def tri_or(values: Iterable[str]) -> str:
    values = tuple(values)
    if not values or any(x not in {"true", "false", "unknown"} for x in values):
        raise ValueError("invalid three-valued conditions")
    return "true" if "true" in values else "unknown" if "unknown" in values else "false"


def mandatory_range(raw: Interval, required: Interval) -> str:
    if required.low <= raw.low <= raw.high <= required.high:
        return "true"
    if raw.high < required.low or raw.low > required.high:
        return "false"
    return "unknown"


def threshold_state(bounds: Interval, threshold: float) -> str:
    bounds.score_interval()
    threshold = finite(threshold)
    if not 0 <= threshold <= 100:
        raise ValueError("invalid score threshold")
    if bounds.low >= threshold:
        return "true"
    return "false" if bounds.high < threshold else "unknown"


def observation_median(observations: Iterable[tuple[str, float]]) -> float | None:
    """観測IDは同一人物・同一訪問等を正規化済みと仮定する。"""
    unique = {}
    for observation_id, value in observations:
        if not isinstance(observation_id, str) or not observation_id:
            raise ValueError("observation id required")
        value = finite(value)
        if not 0 <= value <= 100:
            raise ValueError("invalid observation score")
        if observation_id in unique and unique[observation_id] != value:
            raise ValueError("conflicting duplicate observation")
        unique[observation_id] = value
    return statistics.median(unique.values()) if unique else None


def alias_bounds(alias: dict[str, Any], raw: Any, source_formula: str,
                 state: str = "K", user_parameters: dict[str, Any] | None = None) -> Interval | None:
    """別名の検算用実行。元の生値に別名の尺度を適用し、元の点を再利用しない。"""
    parameters = dict(alias.get("parameters", {}))
    parameters.update(user_parameters or {})
    series = alias.get("series")
    if series == "target_fit":
        if parameters.get("a") is None or parameters.get("b") is None:
            return None
        a, b, distance = (finite(parameters[key]) for key in ("a", "b", "d"))
        return Scale.parse(f"T({a},{b},{distance})").bounds(raw, state)
    if series == "non_japanese_language_count":
        if parameters.get("task") is None or parameters.get("channel") is None:
            return None
        if raw is None or state in UNKNOWN_STATES:
            return Interval(0, 100)
        if not isinstance(raw, (list, tuple, set, frozenset)) or any(
            not isinstance(language, str) or not language.strip() for language in raw
        ):
            raise ValueError("canonical language codes required")
        raw = len({language.strip().lower() for language in raw} - {"ja"})
    return Scale.parse(alias.get("formula", source_formula)).bounds(raw, state)


def parse_parameter_key(key: str) -> tuple[str, dict[str, str]]:
    if not isinstance(key, str):
        raise ValueError("parameter redirect key must be text")
    match = re.fullmatch(r"([A-Z]\d{2,})\[([^\[\]]+)\]", key)
    if not match:
        raise ValueError("parameter redirect requires ID[key=value,...]")
    metric_id, content = match.groups()
    parameters = {}
    for token in content.split(","):
        pair = token.strip().split("=")
        if len(pair) != 2 or not re.fullmatch(r"[A-Za-z_]\w*", pair[0]) or not pair[1].strip():
            raise ValueError("invalid parameter redirect key")
        if pair[0] in parameters:
            raise ValueError("duplicate parameter in redirect key")
        parameters[pair[0]] = pair[1].strip()
    return metric_id, parameters


def validate_json_parameter(value: Any) -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, (int, float)):
        finite(value)
        return
    if isinstance(value, list):
        for item in value:
            validate_json_parameter(item)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            validate_json_parameter(item)
        return
    raise ValueError("parameter must be finite JSON data")


class Checks:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.failures: list[str] = []
        self.section = ""

    def check(self, label: str, condition: bool) -> None:
        self.counts[self.section] = self.counts.get(self.section, 0) + 1
        if not condition:
            self.failures.append(f"{self.section}: {label}")

    def equal(self, label: str, actual: Any, expected: Any) -> None:
        if isinstance(actual, Interval) and isinstance(expected, Interval):
            ok = math.isclose(actual.low, expected.low, abs_tol=1e-8) and math.isclose(
                actual.high, expected.high, abs_tol=1e-8)
        elif isinstance(actual, (float, int)) and isinstance(expected, (float, int)):
            ok = math.isclose(actual, expected, abs_tol=1e-8)
        else:
            ok = actual == expected
        self.check(f"{label}: got {actual!r}, expected {expected!r}", ok)

    def rejects(self, label: str, call: Callable[[], Any]) -> None:
        try:
            call()
        except ValueError:
            self.check(label, True)
        except Exception as error:
            self.check(f"{label}: wrong exception {type(error).__name__}", False)
        else:
            self.check(f"{label}: did not reject", False)


def validate_registry_metadata(data: dict[str, Any]) -> None:
    """基本項目の増減・移動・派生別名を、当該版の宣言から検証する。"""
    metrics = data["metrics"]
    ids = [metric["id"] for metric in metrics]
    if any(not isinstance(metric_id, str) or not METRIC_ID.fullmatch(metric_id) for metric_id in ids):
        raise ValueError("invalid registered metric id")
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate registered metric id")
    declared_count = data["basic_metric_count"]
    if isinstance(declared_count, bool) or not isinstance(declared_count, int) or declared_count < 0:
        raise ValueError("basic_metric_count must be a nonnegative integer")
    if declared_count != len(metrics):
        raise ValueError("basic_metric_count differs from registered row count")
    if any(metric["group"] != metric["id"][0] for metric in metrics):
        raise ValueError("metric id/group mismatch")
    active = set(ids)
    retired = data.get("retired_metric_ids", [])
    if not isinstance(retired, list) or any(
        not isinstance(metric_id, str) or not METRIC_ID.fullmatch(metric_id) for metric_id in retired
    ) or len(set(retired)) != len(retired):
        raise ValueError("retired_metric_ids must contain unique metric ids")
    retired = set(retired)
    if active & retired:
        raise ValueError("retired metric remains in basic metrics")
    # 件数を固定せず、当該版の各群に現れる最大番号までの欠番を調べる。
    for group in {metric_id[0] for metric_id in active | retired}:
        numbers = [int(metric_id[1:]) for metric_id in active | retired if metric_id[0] == group]
        if any(number < 1 for number in numbers):
            raise ValueError("metric sequence must begin at 01")
        expected = {f"{group}{number:02}" for number in range(1, max(numbers) + 1)}
        if expected - active - retired:
            raise ValueError(f"undeclared metric gaps in group {group}")
    counts = dict(Counter(metric["group"] for metric in metrics))
    if "group_counts" in data:
        declared_groups = data["group_counts"]
        if not isinstance(declared_groups, dict) or any(
            not isinstance(group, str) or not re.fullmatch(r"[A-Z]", group)
            or isinstance(count, bool) or not isinstance(count, int) or count < 0
            for group, count in declared_groups.items()
        ):
            raise ValueError("invalid group_counts")
        if {group: count for group, count in declared_groups.items() if count} != counts:
            raise ValueError("declared group_counts differ from registered metrics")
    aliases = data.get("parameter_aliases", {})
    if isinstance(aliases, dict):
        entries = list(aliases.items())
    elif isinstance(aliases, list):
        entries = [(alias.get("old_id", alias.get("id")), alias) for alias in aliases
                   if isinstance(alias, dict)]
        if len(entries) != len(aliases):
            raise ValueError("invalid alias entry")
    else:
        raise ValueError("parameter_aliases must be a mapping or list")
    alias_ids = set()
    for old_id, alias in entries:
        if old_id not in retired or old_id in alias_ids or not isinstance(alias, dict):
            raise ValueError("alias old id must be unique and declared retired")
        alias_ids.add(old_id)
        if not isinstance(alias.get("metric_id"), str) or alias["metric_id"] not in active:
            raise ValueError("alias references a missing/retired source metric")
        parameters = alias.get("parameters", {})
        if not isinstance(parameters, dict) or any(not isinstance(key, str) or not key for key in parameters):
            raise ValueError("alias parameters must be a mapping with named keys")

        for value in parameters.values():
            validate_json_parameter(value)
        formula_scale = Scale.parse(alias["formula"]) if "formula" in alias else None
        if alias.get("series") == "target_fit":
            if set(parameters) - {"a", "b", "d"}:
                raise ValueError("target_fit parameters are a, b, d")
            a = None if parameters.get("a") is None else finite(parameters["a"])
            b = None if parameters.get("b") is None else finite(parameters["b"])
            if "d" in parameters:
                distance = finite(parameters["d"])
            elif formula_scale is not None and formula_scale.kind == "T":
                distance = formula_scale.parameters[2]
            else:
                raise ValueError("target_fit alias requires positive d or a T formula")
            if distance <= 0 or (a is not None and b is not None and a > b):
                raise ValueError("invalid alias target_fit interval/distance")
        if alias.get("default_weight", data["default_weight"]) != 0:
            raise ValueError("alias default weight must be zero")
    redirects = data.get("metric_redirects", {})
    if not isinstance(redirects, dict):
        raise ValueError("metric_redirects must be a mapping")
    for old_id, destination in redirects.items():
        target = destination.get("metric_id") if isinstance(destination, dict) else destination
        if old_id not in retired or not isinstance(target, str) or target not in active:
            raise ValueError("metric redirect must map a retired id to a surviving id")
    parameter_redirects = data.get("parameter_redirects", {})
    if not isinstance(parameter_redirects, dict):
        raise ValueError("parameter_redirects must be a mapping")
    for old_key, redirect in parameter_redirects.items():
        old_id, _ = parse_parameter_key(old_key)
        if old_id not in active or not isinstance(redirect, dict):
            raise ValueError("parameter redirect source must be a surviving metric")
        target = redirect.get("metric_id")
        parameters = redirect.get("parameters")
        if not isinstance(target, str) or target not in active or not isinstance(parameters, dict):
            raise ValueError("parameter redirect requires surviving destination and parameters")
        if any(not isinstance(key, str) or not key for key in parameters):
            raise ValueError("parameter redirect keys must be named")
        for value in parameters.values():
            validate_json_parameter(value)
    dimensions = data.get("dimension_dictionary", {})
    if not isinstance(dimensions, dict):
        raise ValueError("dimension_dictionary must be a mapping")
    for dimension, tags in dimensions.items():
        if not isinstance(dimension, str) or not dimension or not isinstance(tags, list) or not tags:
            raise ValueError("dimension requires a nonempty tag array")
        if any(not isinstance(tag, str) or not tag for tag in tags) or len(set(tags)) != len(tags):
            raise ValueError("dimension tags must be unique nonempty strings")


def parse_markdown_catalog(markdown: str, checks: Checks) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """第5節の群見出し・6列ヘッダのある辞書表だけを読む。"""
    table = []
    markdown_groups = {}
    current_group = None
    in_dictionary = False
    table_header_seen = False
    for line in markdown.splitlines():
        section = re.match(r"## (\d+)\.", line)
        if section:
            in_dictionary = section.group(1) == "5"
            current_group = None
            table_header_seen = False
        if not in_dictionary:
            continue
        header = re.match(r"### ([A-Z])\. .*?[（(](\d+)基本項目[）)]", line)
        if header:
            current_group, group_count = header.groups()
            checks.check(f"unique Markdown group header {current_group}", current_group not in markdown_groups)
            markdown_groups[current_group] = int(group_count)
            table_header_seen = False
        elif line.startswith("#"):
            current_group = None
            table_header_seen = False
        cells = [cell.strip() for cell in line.strip().split("|")]
        if current_group is not None and len(cells) == 8 and cells[1] == "ID":
            table_header_seen = cells[2:7] == ["採点項目", "対象", "生値・判定条件", "100点尺度", "適用規則"]
            checks.check(f"{current_group} six-column dictionary header", table_header_seen)
        if current_group is not None and table_header_seen and len(cells) >= 2 and METRIC_ID.fullmatch(cells[1]):
            if len(cells) != 8:
                raise ValueError(f"invalid Markdown metric row: {line}")
            metric_id, name, scope, raw, formula, note = cells[1:7]
            checks.check(f"{metric_id} under its Markdown group", metric_id[0] == current_group)
            table.append({"id": metric_id, "group": metric_id[0], "name": name,
                          "scope": scope, "raw": raw, "formula": formula, "note": note})
    return table, markdown_groups


def catalog_checks(directory: Path, checks: Checks) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    checks.section = "catalog"
    markdown = (directory / "onsen_banzuke_master_prompt_v1.md").read_text(encoding="utf-8")
    # parse_constantでJSONの非標準NaN/Infinityも拒否する。
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON constant: {value}")
    data = json.loads((directory / "onsen_banzuke_metric_catalog_v1.json").read_text(
        encoding="utf-8"), parse_constant=reject_constant)
    metrics = data["metrics"]
    table, markdown_groups = parse_markdown_catalog(markdown, checks)
    checks.equal("JSON basic_metric_count/registered rows", data["basic_metric_count"], len(metrics))
    checks.equal("Markdown/JSON row count", len(table), len(metrics))
    ids = [metric["id"] for metric in metrics]
    table_ids = [metric["id"] for metric in table]
    checks.equal("unique JSON ids", len(set(ids)), len(ids))
    checks.equal("unique Markdown ids", len(set(table_ids)), len(table_ids))
    checks.equal("same ids and order", table_ids, ids)
    checks.check("valid metric ids", all(METRIC_ID.fullmatch(x) for x in ids))
    registered_counts = dict(Counter(metric["group"] for metric in metrics))
    checks.equal("Markdown/registered group counts", markdown_groups, registered_counts)
    try:
        validate_registry_metadata(data)
    except ValueError as error:
        checks.check(f"registry/migration metadata: {error}", False)
    else:
        checks.check("registry/migration metadata", True)
    checks.equal("default weight", data["default_weight"], 0)
    checks.check("Markdown default weights zero", "既定の重みはすべて0" in markdown)
    checks.equal("score range", data["score_range"], [0, 100])
    checks.equal("unknown score interval", data["unknown_score_interval"], [0, 100])
    version = re.search(r"仕様版：([^\s/]+)", markdown)
    checks.check("version declared", version is not None)
    if version:
        checks.equal("version synchronized", version.group(1), data["version"])
    dates = re.findall(r"(?:設計日|改訂日)：(\d{4}-\d{2}-\d{2})", markdown)
    checks.check("date declared", bool(dates))
    if dates:
        checks.equal("date synchronized", dates[-1], data["date"])
    by_id = {metric["id"]: metric for metric in table}
    fields = ("id", "group", "name", "scope", "raw", "formula", "note")
    for metric in metrics:
        metric_id = metric["id"]
        for field in fields:
            checks.equal(f"{metric_id}.{field}", by_id.get(metric_id, {}).get(field), metric.get(field))
        checks.equal(f"{metric_id} explicit/default weight", metric.get("default_weight", data["default_weight"]), 0)
    for dimension, tags in data.get("dimension_dictionary", {}).items():
        scale = Scale.parse(f"N({len(tags)})")
        for raw, expected in [(0, 0), (len(tags) / 2, 50), (len(tags), 100), (len(tags) + 1, 100)]:
            checks.equal(f"V10 dimension={dimension} k={len(tags)} raw={raw}", scale.point(raw), expected)
    return metrics, data


def scale_checks(metrics: list[dict[str, Any]], checks: Checks) -> None:
    checks.section = "scale"
    for metric in metrics:
        metric_id = metric["id"]
        try:
            scale = Scale.parse(metric["formula"])
        except ValueError as error:
            checks.check(f"{metric_id}: {error}", False)
            continue
        checks.check(f"{metric_id}: parsed", True)
        kind, parameters = scale.kind, scale.parameters
        point = scale.point
        if metric_id == "F05":
            point = lambda value: retention_ratio_bounds(value).low
        if kind == "B":
            samples, boundaries = [False, True], [(False, 0), (True, 100)]
        elif kind == "R":
            samples, boundaries = [0, 0.1, 0.5, 0.9, 1], [(0, 0), (0.5, 50), (1, 100)]
            if metric_id == "F05":
                samples.append(1.5)
                boundaries.append((1.5, 100))
        elif kind in {"INT", "REVERSE_INT"}:
            samples = list(INT_LEVELS)
            boundaries = [(x, 100 - x if kind == "REVERSE_INT" else x) for x in samples]
        elif kind == "RARITY":
            samples, boundaries = [(2, 1), (2, 2), (10, 3), (10, 10)], [((2, 1), 100), ((2, 2), 0)]
        elif kind == "INTERSECTION":
            samples, boundaries = [], []
            checks.equal(f"{metric_id} intersection", scale.bounds([0.75, 0.75]), Interval(50, 75))
            checks.equal(f"{metric_id} certain", scale.bounds([1, 1]), Interval(100, 100))
        elif kind in {"U", "D"}:
            a, b = parameters
            samples = [a - (b - a), a, (a + b) / 2, b, b + (b - a)]
            boundaries = [(a, 100 if kind == "D" else 0), ((a + b) / 2, 50), (b, 0 if kind == "D" else 100)]
        elif kind == "N":
            limit = parameters[0]
            samples = [0, limit / 4, limit / 2, limit, limit * 2]
            boundaries = [(0, 0), (limit / 2, 50), (limit, 100)]
        elif kind == "T":
            a, b, distance = parameters
            samples = [a - 2 * distance, a - distance, a - distance / 2, a, (a + b) / 2,
                       b, b + distance / 2, b + distance, b + 2 * distance]
            boundaries = [(a - distance, 0), (a, 100), (b, 100), (b + distance, 0)]
        elif kind == "L":
            t = parameters[0]
            samples = [0, t / 20, t / 10, t, 10 * t, 100 * t, 1000 * t]
            boundaries = [(0, 0), (t / 20, 12.5), (t / 10, 25), (t, 50), (10 * t, 75), (100 * t, 100)]
        else:
            samples = [parameters[0][0] - 1, parameters[-1][0] + 1]
            samples.extend(x for x, _ in parameters)
            samples.extend((p1[0] + p2[0]) / 2 for p1, p2 in zip(parameters, parameters[1:]))
            boundaries = list(parameters)
        for index, sample in enumerate(samples):
            try:
                value = point(sample)
                checks.check(f"{metric_id} range input {index}", math.isfinite(value) and 0 <= value <= 100)
            except ValueError as error:
                checks.check(f"{metric_id} input {index}: {error}", False)
        for sample, expected in boundaries:
            checks.equal(f"{metric_id} boundary {sample}", point(sample), expected)


def scenario_checks(checks: Checks, catalog: dict[str, Any] | None = None) -> None:
    checks.section = "scenario"
    for state, weight in itertools.product(["U", "E", "F"], [-1, 1]):
        interval = Scale.parse("100−INT").bounds(None, state)
        checks.equal(f"missing {state}/{weight}", contribution_bounds(interval, weight, state), Interval(0, 100))
    for weight in [-1, 1]:
        checks.equal(f"A contribution/{weight}", contribution_bounds(Interval(0, 100), weight, "A"), Interval(0, 0))
    checks.equal("unknown reversed INT", Scale.parse("100−INT").bounds(None, "U"), Interval(0, 100))
    checks.equal("T nonmonotonic interval includes top", Scale.parse("T(38,41,5)").bounds((35, 44)), Interval(40, 100))
    for first, second in itertools.product(["true", "false", "unknown"], repeat=2):
        expected_and = "false" if "false" in (first, second) else "true" if first == second == "true" else "unknown"
        expected_or = "true" if "true" in (first, second) else "false" if first == second == "false" else "unknown"
        checks.equal(f"AND {first}/{second}", tri_and([first, second]), expected_and)
        checks.equal(f"OR {first}/{second}", tri_or([first, second]), expected_or)
    checks.equal("mandatory temperature interval", mandatory_range(Interval(39, 42), Interval(38, 41)), "unknown")
    checks.equal("mandatory temperature confirmed", mandatory_range(Interval(39, 40), Interval(38, 41)), "true")
    checks.equal("mandatory temperature outside", mandatory_range(Interval(42, 43), Interval(38, 41)), "false")
    bathtub_a = weighted_result([ScoreRow(Interval(100, 100), 1), ScoreRow(Interval(0, 0), 1)])
    bathtub_b = weighted_result([ScoreRow(Interval(0, 0), 1), ScoreRow(Interval(100, 100), 1)])
    checks.equal("same bathtub maximum", best_plan_bounds([bathtub_a.bounds, bathtub_b.bounds]), Interval(50, 50))
    candidate = weighted_result([ScoreRow(Interval(80, 100), 1), ScoreRow(Interval(20, 60), -1)])
    checks.equal("candidate aggregate interval", candidate.bounds, Interval(60, 90))
    checks.equal("best max bounds", best_plan_bounds([candidate.bounds, Interval(70, 80)]), Interval(70, 90))
    checks.equal("free price", Scale.parse("D(0,2000)").bounds(0), Interval(100, 100))
    for weight in [-1, 1]:
        absent = Scale.parse("D(0,2000)").bounds(None, "A")
        checks.equal(f"unavailable price A/{weight}", contribution_bounds(absent, weight, "A"), Interval(0, 0))
    grouped = grouped_result([(0.8, [ScoreRow(Interval(100, 100), 1)]),
                              (0.2, [ScoreRow(Interval(0, 100), 1, "U")])])
    checks.equal("group score 80/20", grouped.bounds, Interval(80, 100))
    checks.equal("group evidence rate 80/20", grouped.evidence_rate, 80)
    checks.equal("group numerical certainty 80/20", grouped.numeric_certainty, 80)
    checks.equal("all weights zero", weighted_result([ScoreRow(Interval(100, 100), 0)]), None)
    checks.equal("all group budgets zero", grouped_result([(0, [ScoreRow(Interval(100, 100), 1)])]), None)
    time_scale, fare_scale = Scale.parse("D(0,480)"), Scale.parse("D(0,30000)")
    routes = [(60, 6000), (180, 2000), (90, 2500)]
    route_results = [weighted_result([ScoreRow(time_scale.bounds(time), 1), ScoreRow(fare_scale.bounds(fare), 1)])
                     for time, fare in routes]
    checks.equal("middle route selected", max(range(3), key=lambda i: route_results[i].bounds.low), 2)
    checks.equal("middle route score", route_results[2].bounds.low, (81.25 + 100 * (30000 - 2500) / 30000) / 2)
    checks.equal("V13 threshold interval", threshold_state(Interval(65, 85), 70), "unknown")
    checks.equal("V13 threshold equality", threshold_state(Interval(70, 85), 70), "true")
    checks.equal("V13 threshold excluded", threshold_state(Interval(65, 69), 70), "false")
    checks.equal("two 75% conditions", intersection_bounds([0.75, 0.75]), Interval(50, 75))
    checks.equal("uncertain intersection", intersection_bounds([(0.6, 0.8), (0.7, 0.9)]), Interval(30, 80))
    observations = [("person1/visit1", 25), ("person2/visit2", 75)]
    checks.equal("duplicate observation invariant", observation_median(observations + [observations[0]]), observation_median(observations))
    checks.equal("zero-weight metric invariant", weighted_result([ScoreRow(Interval(80, 80), 1), ScoreRow(Interval(0, 100), 0, "U")]),
                 weighted_result([ScoreRow(Interval(80, 80), 1)]))
    checks.equal("positive constrained interval", contribution_bounds(Interval(40, 75), 1), Interval(40, 75))
    checks.equal("negative constrained interval", contribution_bounds(Interval(40, 75), -1), Interval(25, 60))
    checks.equal("F05 ratio above one", retention_ratio_bounds(1.2), Interval(100, 100))
    checks.equal("F05 ratio interval", retention_ratio_bounds((0.8, 1.2)), Interval(80, 100))
    checks.equal("A15 +50 percent is raw 50", Scale.parse("PL(-50:0,0:50,50:100)").point(100 * (150 / 100 - 1)), 100)
    profiles = [ProfileRow("A", "day", "obsA", ("white", None)),
                ProfileRow("B", "day", "obsB", (None, "sulfur")),
                ProfileRow("C", "day", "obsC", ("black", "sulfur"))]
    counts = profile_count_bounds(profiles)
    checks.equal("V11 partial profiles", counts, Interval(2, 3))
    checks.equal("V11 partial profile score", Scale.parse("N(12)").bounds(counts), Interval(100 * 2 / 12, 25))
    for permutation in itertools.permutations(profiles):
        checks.equal("V11 row order invariant", profile_count_bounds(permutation), counts)
    checks.equal("V11 duplicate observation invariant", profile_count_bounds(profiles + [profiles[0]]), counts)
    checks.equal("V11 same partial distinct entity", profile_count_bounds([
        profiles[0], ProfileRow("D", "day", "obsD", ("white", None))]), Interval(1, 2))
    checks.equal("V11 complete profile merged", profile_count_bounds([
        profiles[2], ProfileRow("D", "day", "obsD", ("black", "sulfur"))]), Interval(1, 1))
    aliases = (catalog or {}).get("parameter_aliases", {})
    c03 = aliases.get("C03", {"metric_id": "C01", "series": "target_fit",
                              "parameters": {"a": 6, "b": 7.5, "d": 1.5}})
    checks.equal("C03 raw pH target_fit", alias_bounds(c03, 7, "D(1,7)"), Interval(100, 100))
    checks.equal("C01 base raw pH remains separate", Scale.parse("D(1,7)").bounds(7), Interval(0, 0))
    c07 = aliases.get("C07", {"metric_id": "C06", "series": "target_fit",
                              "parameters": {"a": None, "b": None, "d": 10}})
    checks.equal("C07 no user target uncalculated", alias_bounds(c07, 40, "U(0,100)"), None)
    checks.equal("C07 specified target", alias_bounds(c07, 40, "U(0,100)", user_parameters={"a": 38, "b": 41}), Interval(100, 100))
    m06 = aliases.get("M06", {"metric_id": "A01", "series": "event_count", "formula": "N(4)"})
    checks.equal("M06 two same events legacy scale", alias_bounds(m06, 2, "N(12)"), Interval(50, 50))
    checks.equal("A01 two same events base scale", Scale.parse("N(12)").bounds(2), Interval(100 * 2 / 12, 100 * 2 / 12))
    z17 = aliases.get("Z17", {"metric_id": "Z24", "series": "non_japanese_language_count",
                              "formula": "N(5)", "parameters": {"task": None, "channel": None}})
    # 固定する条件が不明なら未算出。言語一覧の未取得と確認済み空集合も分ける。
    unknown_task = dict(z17, parameters={"task": None, "channel": None})
    language_conditions = {"task": "booking", "channel": "human"}
    checks.equal("Z17 no task/channel uncalculated", alias_bounds(unknown_task, ["en"], "B"), None)
    checks.equal("Z17 unique non-Japanese languages", alias_bounds(z17, ["ja", "en", "EN", "fr"], "B",
                 user_parameters=language_conditions), Interval(40, 40))
    checks.equal("Z17 confirmed no non-Japanese language", alias_bounds(z17, ["ja"], "B", "Z",
                 language_conditions), Interval(0, 0))
    checks.equal("Z17 unknown language list", alias_bounds(z17, None, "B", "U",
                 language_conditions), Interval(0, 100))
    miniature_markdown = """## 5. 採点項目辞書
### 5.1 旧ID対応
| C03 | C01 target_fit | alias |
### I. 公開情報（1基本項目）
| ID | 採点項目 | 対象 | 生値・判定条件 | 100点尺度 | 適用規則 |
|---|---|---|---|---|---|
| I01 | 名前 | 地域 | 値 | B | 規則 |
## 6. 集計
| C03 | 外部表 | 地域 | 値 | B | 規則 |
"""
    miniature, miniature_groups = parse_markdown_catalog(miniature_markdown, checks)
    checks.equal("dictionary parser ignores alias/outside tables", [row["id"] for row in miniature], ["I01"])
    checks.equal("dictionary parser counts declared group", miniature_groups, {"I": 1})
    checks.equal("safe N(k) test parameter", Scale.parse("N(k)").point(4), 50)


def rejection_checks(checks: Checks) -> None:
    checks.section = "rejection"
    invalid_formulas = ["eval('1')", "__import__('os').system('echo unsafe')", "U(0,1);1",
                        "U(0,nan)", "D(0,inf)", "L(1e999)", "T(41,38,5)",
                        "T(38,41,0)", "T(38,41,-1)", "U(1,1)", "D(2,1)",
                        "N(0)", "L(-1)", "U(0,1,2)", "T(x,b,5)",
                        "PL(0:0,0:100)", "PL(1:0,0:100)", "PL(0:0,1:101)",
                        "PL(0:0)", "PL(0:0,1:nan)"]
    for formula in invalid_formulas:
        checks.rejects(f"formula {formula}", lambda f=formula: Scale.parse(f))
    for value in [math.nan, math.inf, -math.inf]:
        checks.rejects(f"nonfinite raw {value}", lambda v=value: Scale.parse("U(0,100)").point(v))
        checks.rejects(f"nonfinite interval {value}", lambda v=value: Interval(0, v))
        checks.rejects(f"nonfinite weight {value}", lambda v=value: contribution_bounds(Interval(0, 100), v))
        checks.rejects(f"nonfinite rarity {value}", lambda v=value: Scale.parse("RARITY").point((10, v)))
        checks.rejects(f"nonfinite missing raw {value}", lambda v=value: Scale.parse("U(0,100)").bounds(v, "U"))
    for pair in [(1, 1), (10, 0), (10, 11), (2.5, 1), (10, 1.5)]:
        checks.rejects(f"invalid rarity {pair}", lambda p=pair: Scale.parse("RARITY").point(p))
    checks.rejects("reversed interval", lambda: Interval(42, 39))
    checks.rejects("reversed raw interval", lambda: Scale.parse("T(38,41,5)").bounds((42, 39)))
    checks.rejects("reversed missing raw interval", lambda: Scale.parse("T(38,41,5)").bounds((42, 39), "U"))
    checks.rejects("reversed proportion", lambda: intersection_bounds([(0.8, 0.7)]))
    checks.rejects("invalid fraction", lambda: Scale.parse("R").point(1.1))
    checks.rejects("negative concentration", lambda: Scale.parse("L(100)").point(-1))
    checks.rejects("unregistered INT", lambda: Scale.parse("INT").point(40))
    checks.rejects("positive empty group", lambda: grouped_result([(0.8, [ScoreRow(Interval(100, 100), 0)])]))
    checks.rejects("invalid score interval", lambda: contribution_bounds(Interval(-1, 100), 1))
    checks.rejects("invalid weight", lambda: contribution_bounds(Interval(0, 100), 2))
    checks.rejects("unknown state", lambda: contribution_bounds(Interval(0, 100), 1, "?"))
    checks.rejects("empty AND", lambda: tri_and([]))
    checks.rejects("invalid OR", lambda: tri_or(["yes"]))
    checks.rejects("duplicate conflict", lambda: observation_median([("visit", 25), ("visit", 75)]))
    checks.rejects("negative F05 ratio", lambda: retention_ratio_bounds(-0.1))
    checks.rejects("infinite F05 ratio", lambda: retention_ratio_bounds(math.inf))
    checks.rejects("conflicting profile observation", lambda: profile_count_bounds([
        ProfileRow("A", "day", "obs", ("white", None)),
        ProfileRow("A", "day", "obs", ("black", None))]))
    checks.rejects("misaligned profile", lambda: profile_count_bounds([
        ProfileRow("A", "day", "obsA", ("white", None)),
        ProfileRow("B", "day", "obsB", ("black",))]))


def migration_checks(checks: Checks) -> None:
    checks.section = "migration"

    def fixture() -> dict[str, Any]:
        return {"basic_metric_count": 3, "default_weight": 0,
                "metrics": [{"id": "I01", "group": "I"}, {"id": "I03", "group": "I"},
                            {"id": "C01", "group": "C"}],
                "group_counts": {"I": 2, "C": 1},
                "retired_metric_ids": ["I02", "C02", "P01"],
                "parameter_aliases": {
                    "I02": {"metric_id": "I03", "parameters": {"field": "temperature"}},
                    "C02": {"metric_id": "C01", "series": "target_fit", "parameters": {"d": 5}}},
                "metric_redirects": {"P01": "I03"},
                "parameter_redirects": {"I01[field=temperature]": {
                    "metric_id": "I03", "parameters": {"field": "temperature"}}},
                "dimension_dictionary": {"medium": ["water", "mud", "sand", "steam"]}}

    try:
        validate_registry_metadata(fixture())
    except ValueError as error:
        checks.check(f"dynamic registry/retired/aliases: {error}", False)
    else:
        checks.check("dynamic registry/retired/aliases", True)
    changed = fixture()
    changed["parameter_aliases"] = [
        {"old_id": "I02", "metric_id": "I03"},
        {"id": "C02", "metric_id": "C01", "series": "target_fit",
         "parameters": {"a": 6, "b": 7.5, "d": 1.5}}]
    try:
        validate_registry_metadata(changed)
    except ValueError as error:
        checks.check(f"list aliases and fixed target: {error}", False)
    else:
        checks.check("list aliases and fixed target", True)

    variants = []
    changed = fixture()
    changed["basic_metric_count"] = 4
    variants.append(("incorrect dynamic count", changed))
    changed = fixture()
    changed["group_counts"]["I"] = 3
    variants.append(("incorrect declared group count", changed))
    changed = fixture()
    changed["retired_metric_ids"].append("I01")
    variants.append(("retired still active", changed))
    changed = fixture()
    changed["retired_metric_ids"].remove("I02")
    variants.append(("undeclared sequence gap", changed))
    changed = fixture()
    changed["parameter_aliases"]["I02"]["metric_id"] = "C02"
    variants.append(("alias to retired source", changed))
    changed = fixture()
    changed["parameter_aliases"]["I02"]["metric_id"] = "Z01"
    variants.append(("alias to absent source", changed))
    changed = fixture()
    changed["parameter_aliases"]["I01"] = {"metric_id": "C01"}
    variants.append(("active old alias id", changed))
    changed = fixture()
    changed["parameter_aliases"]["C02"]["parameters"]["d"] = 0
    variants.append(("alias invalid distance", changed))
    changed = fixture()
    changed["parameter_aliases"]["C02"]["parameters"].update({"a": 41, "b": 38})
    variants.append(("alias reversed target", changed))
    changed = fixture()
    changed["parameter_aliases"]["I02"]["parameters"]["value"] = math.nan
    variants.append(("nonfinite categorical parameter", changed))
    changed = fixture()
    changed["metrics"][0]["group"] = "C"
    variants.append(("registered wrong group", changed))
    changed = fixture()
    changed["metric_redirects"]["P01"] = "C02"
    variants.append(("redirect to retired destination", changed))
    changed = fixture()
    changed["parameter_redirects"]["I01[field=temperature]"]["metric_id"] = "C02"
    variants.append(("parameter redirect to retired destination", changed))
    changed = fixture()
    changed["parameter_redirects"] = {"P01[field=temperature]": {"metric_id": "I03", "parameters": {}}}
    variants.append(("parameter redirect from retired source", changed))
    changed = fixture()
    changed["parameter_redirects"] = {"I01[field=flow,field=temperature]": {"metric_id": "I03", "parameters": {}}}
    variants.append(("duplicate parameter redirect key", changed))
    changed = fixture()
    changed["dimension_dictionary"]["medium"].append("water")
    variants.append(("duplicate dimension tag", changed))
    for label, variant in variants:
        checks.rejects(label, lambda value=variant: validate_registry_metadata(value))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent)
    arguments = parser.parse_args()
    checks = Checks()
    try:
        metrics, catalog = catalog_checks(arguments.directory, checks)
        scale_checks(metrics, checks)
        scenario_checks(checks, catalog)
        rejection_checks(checks)
        migration_checks(checks)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    total = sum(checks.counts.values())
    print("検算専用モデル（施設情報・実経路・予約可否の検証は対象外）")
    for section, count in checks.counts.items():
        print(f"{section}: {count} checks")
    print(f"TOTAL: {total} checks; PASS: {total - len(checks.failures)}; FAIL: {len(checks.failures)}")
    for failure in checks.failures:
        print(f"FAIL: {failure}")
    return 1 if checks.failures else 0


if __name__ == "__main__":
    sys.exit(main())
