"""Reference-grounded retrospective metadata audit. Standard library only; no provider or SQL calls."""
import argparse
import hashlib
import itertools
import json
import math
import pathlib
import platform
import random
import shutil

HERE = pathlib.Path(__file__).resolve().parent
INPUT = HERE.parent / "multistage-bird-extended" / "results.json"
INPUT_SHA256 = "714f847dc3e3b4e3586df49d70405cbcfcf91498b4417f4c4c26f5fe4e0151ff"
ARMS = ("fixed_cheap", "fixed_strong", "routed")
SEED = 0x6A09E667
DRAWS = 10000


def mean(values):
    return sum(values) / len(values)


def quantile(values, probability):
    ordered = sorted(values)
    index = (len(ordered) - 1) * probability
    lower = math.floor(index)
    upper = math.ceil(index)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def exact_mcnemar(reference, candidate):
    assert len(reference) == len(candidate) and reference
    both_pass = sum(a and b for a, b in zip(reference, candidate))
    reference_only = sum(a and not b for a, b in zip(reference, candidate))
    candidate_only = sum(b and not a for a, b in zip(reference, candidate))
    discordant = reference_only + candidate_only
    probability = 1.0 if not discordant else min(1.0, 2 * sum(math.comb(discordant, k) for k in range(min(reference_only, candidate_only) + 1)) / 2**discordant)
    return {"both_pass": both_pass, "reference_only_pass": reference_only, "candidate_only_pass": candidate_only,
            "both_fail": len(reference) - both_pass - discordant, "discordant": discordant, "exact_two_sided_p": probability,
            "null": "equal paired marginal strict-EX proportions", "not_proof_of_equivalence": True, "reference": "R8"}


def paired_bootstrap(deltas, draws=DRAWS, seed=SEED):
    assert deltas and all(len(row) == len(deltas[0]) for row in deltas)
    rng = random.Random(seed)
    samples = [[] for _ in deltas[0]]
    for _ in range(draws):
        indices = [rng.randrange(len(deltas)) for _ in deltas]
        for column, values in enumerate(samples):
            values.append(mean([deltas[index][column] for index in indices]))
    return [{"mean_difference": mean([row[column] for row in deltas]), "percentile_95_ci": [quantile(values, 0.025), quantile(values, 0.975)]}
            for column, values in enumerate(samples)]


def oracle_pick(reference, candidate):
    # An ex-post upper bound over recorded fixed-workflow outcomes, never a deployable router.
    return min((reference, candidate), key=lambda row: (-int(row["finalValidation"]["executionMatch"]), row["observedUsdEstimate"]))


def self_test():
    assert exact_mcnemar([True], [False])["exact_two_sided_p"] == 1
    assert exact_mcnemar([True] * 4, [False] * 4)["exact_two_sided_p"] == 0.125
    assert exact_mcnemar([True, False], [True, False])["exact_two_sided_p"] == 1
    assert paired_bootstrap([[0.0, 0.0], [0.0, 0.0]], draws=20) == [
        {"mean_difference": 0.0, "percentile_95_ci": [0.0, 0.0]}, {"mean_difference": 0.0, "percentile_95_ci": [0.0, 0.0]}]
    a = {"finalValidation": {"executionMatch": True}, "observedUsdEstimate": 0.1}
    b = {"finalValidation": {"executionMatch": True}, "observedUsdEstimate": 2}
    c = {"finalValidation": {"executionMatch": False}, "observedUsdEstimate": 0.01}
    assert oracle_pick(a, b) is a and oracle_pick(a, c) is a
    assert quantile([1, 2, 3], 0.5) == 2


def arm_summary(rows):
    phases = [phase for row in rows for phase in row["phases"]]
    total_wall = sum(row["totalWallMs"] for row in rows)
    grade = sum(row["initialVerificationMs"] + row["finalVerificationMs"] for row in rows)
    select = sum(phase["selectionMs"] for phase in phases)
    child = sum(phase["result"]["elapsedMs"] for phase in phases)
    process = sum(phase["result"]["parentOwnedElapsedMs"] - phase["result"]["elapsedMs"] for phase in phases)
    prepare = sum(phase["phaseWallMs"] - phase["selectionMs"] - phase["result"]["parentOwnedElapsedMs"] for phase in phases)
    outer = total_wall - sum(phase["phaseWallMs"] for phase in phases) - grade
    assert math.isclose(total_wall, select + child + process + prepare + grade + outer, abs_tol=1e-6)
    correct = sum(row["finalValidation"]["executionMatch"] for row in rows)
    cost = sum(row["observedUsdEstimate"] for row in rows)
    roles = {}
    for phase in phases:
        key = phase["phase"] + ":" + phase["selection"]["profile"]
        roles[key] = roles.get(key, 0) + 1
    stage_summary = {}
    for name in ("investigate", "implement", "review", "correct"):
        selected = [phase for phase in phases if phase["phase"] == name]
        stage_summary[name] = {"stages": len(selected), "phase_wall_ms": sum(phase["phaseWallMs"] for phase in selected),
                               "worker_cost_estimate_usd": sum(phase["result"]["accounting"]["observedUsdEstimate"] for phase in selected)}
    return {"tasks": len(rows), "trials_per_task_per_policy": 1, "strict_ex_correct": correct, "strict_ex_accuracy": correct / len(rows),
            "not_semantic_accuracy": True, "observed_cost_estimate_usd": cost, "cost_estimate_per_task_usd": cost / len(rows),
            "cost_estimate_per_strict_ex_success_usd": cost / correct if correct else None,
            "workflow_wall_ms": {"sum": total_wall, "mean": total_wall / len(rows), "p50": quantile([row["totalWallMs"] for row in rows], 0.5),
                                 "p95_descriptive_only": quantile([row["totalWallMs"] for row in rows], 0.95)},
            "disjoint_recorded_time_components_ms": {"selector_phase_not_pure_api": select, "parent_prepare_and_persist": prepare,
                "owned_process_envelope_not_pure_job": process, "child_session_tools_freshness_cleanup": child,
                "external_initial_and_final_oracle_grading": grade, "outer_bookkeeping": outer},
            "nested_child_time_not_additive_to_components_ms": {"startup": sum(phase["result"]["startupMs"] for phase in phases),
                "generation_tools_freshness_cleanup_not_pure_inference": sum(phase["result"]["generationMs"] for phase in phases)},
            "wall_minus_recorded_oracle_grading_ms_descriptive_not_a_new_clock": total_wall - grade,
            "worker_cost_estimate_usd": sum(phase["result"]["accounting"]["observedUsdEstimate"] for phase in phases),
            "selector_cost_estimate_usd": sum(phase["selection"]["observedUsdEstimate"] for phase in phases),
            "sdk_rounds_not_trials": sum(row["sdkCalls"] for row in rows), "selector_requests": sum(row["selectorRequests"] for row in rows),
            "worker_stages": len(phases), "routed_strong_stage_fraction": sum(phase["selection"]["profile"] == "worker_strong" for phase in phases) / len(phases),
            "stage_role_counts": roles, "stages": stage_summary,
            "runtime_errors": sum(row["status"] != "completed" for row in rows), "known_cleanup_and_accounting": all(row["allCleanupAndAccountingKnown"] for row in rows)}


def bank_analysis(pairs):
    outcomes = []
    for choices in itertools.product((0, 1), repeat=len(pairs)):
        selected = [pair[choice] for pair, choice in zip(pairs, choices)]
        outcomes.append({"correct": sum(row["finalValidation"]["executionMatch"] for row in selected),
                         "recorded_cost_estimate_usd": sum(row["observedUsdEstimate"] for row in selected), "strong_workflows": sum(choices)})
    oracle = [oracle_pick(*pair) for pair in pairs]
    distribution = {}
    for row in outcomes:
        key = str(row["correct"])
        distribution[key] = distribution.get(key, 0) + 1
    n = len(pairs)
    return {"kind": "counterfactual_recorded_fixed_workflow_bank_only", "reference": "R2",
            "not_official_routerbench_score": True, "not_model_response_bank_or_history_dependent_stage_replay": True,
            "no_new_model_calls_cost_or_measured_latency": True, "predictor_service_cost_not_included": True,
            "random_half_half": {"exact_enumerated_routes": len(outcomes), "expected_accuracy": mean([row["correct"] / n for row in outcomes]),
                "expected_recorded_cost_estimate_usd": mean([row["recorded_cost_estimate_usd"] for row in outcomes]),
                "expected_strong_workflow_fraction": 0.5, "probability_by_correct_count": {key: count / len(outcomes) for key, count in sorted(distribution.items())}},
            "oracle_test_label_cheapest_tie_upper_bound_not_deployable": {"strict_ex_correct": sum(row["finalValidation"]["executionMatch"] for row in oracle),
                "accuracy": sum(row["finalValidation"]["executionMatch"] for row in oracle) / n,
                "recorded_cost_estimate_usd": sum(row["observedUsdEstimate"] for row in oracle), "question_ids_using_strong": [pair[1]["questionId"] for pair, row in zip(pairs, oracle) if row is pair[1]]},
            "oracle_minimum_recorded_cost_by_target_successes": [{"at_least_correct": target,
                "minimum_cost_estimate_usd": min((row["recorded_cost_estimate_usd"] for row in outcomes if row["correct"] >= target), default=None)} for target in range(n + 1)],
            "warning": "Shared recorded whole-workflow bank is an ex-post diagnostic, not a measured live router or its latency; actual routed runs used different generations."}


def analyze(data, input_hash):
    rows = data["rows"]
    ids = sorted({row["questionId"] for row in rows})
    assert len(rows) == 30 and len(ids) == 10 and data["completed"] == data["plannedWorkflows"] == 30
    by_arm = {arm: {row["questionId"]: row for row in rows if row["arm"] == arm} for arm in ARMS}
    assert all(set(values) == set(ids) and len(values) == 10 for values in by_arm.values())
    assert all(row["status"] == "completed" and row["allCleanupAndAccountingKnown"] for row in rows)
    summary = {arm: arm_summary([by_arm[arm][qid] for qid in ids]) for arm in ARMS}
    comparisons = {}
    for reference, candidate in (("fixed_cheap", "routed"), ("fixed_strong", "routed"), ("fixed_cheap", "fixed_strong")):
        a = [by_arm[reference][qid] for qid in ids]
        b = [by_arm[candidate][qid] for qid in ids]
        estimates = paired_bootstrap([[int(y["finalValidation"]["executionMatch"]) - int(x["finalValidation"]["executionMatch"]),
                                       (y["totalWallMs"] - x["totalWallMs"]) / 1000, y["observedUsdEstimate"] - x["observedUsdEstimate"]] for x, y in zip(a, b)])
        comparisons[candidate + "_minus_" + reference] = {"sign": "candidate minus reference", "task_pairs": len(ids),
            "strict_ex_accuracy_difference": estimates[0], "workflow_mean_seconds_difference": estimates[1], "mean_cost_estimate_usd_difference": estimates[2],
            "exact_mcnemar": exact_mcnemar([x["finalValidation"]["executionMatch"] for x in a], [x["finalValidation"]["executionMatch"] for x in b]),
            "discordant_question_ids": [qid for qid in ids if by_arm[reference][qid]["finalValidation"]["executionMatch"] != by_arm[candidate][qid]["finalValidation"]["executionMatch"]]}
    return {"schema_version": 1, "kind": "reference_grounded_retrospective_metadata_audit_not_new_model_benchmark",
            "input_sha256": input_hash, "input_source_commit": "6a35c27a38594ada1b43506eeb3b35b2e88a9cc6", "question_ids": ids,
            "questions": 10, "completed_workflows": 30, "arm_summary": summary, "paired_comparisons": comparisons,
            "bootstrap": {"method": "paired task-level percentile", "confidence": 0.95, "resamples": DRAWS, "seed": SEED, "references": ["R7", "R9"],
                "same_resampled_indices_within_each_pair_and_metric": True, "nominal_not_multiplicity_adjusted": True,
                "conditional_on_recorded_trials_not_model_sampling_uncertainty": True, "not_causal_or_equivalence_evidence": True},
            "route_llm_metrics": {"reference": "R1", "pgr": None, "apgr": None, "cpt": None,
                "pgr_reason": "Fixed-workflow cheap and strong strict-EX accuracy both 0.8, so the quality-gap denominator is zero.",
                "apgr_cpt_reason": "No nonzero baseline gap, held-out threshold sweep or calibrated quality-cost operating curve; JEV choice confidence is not success probability.",
                "not_a_canonical_binary_model_routing_evaluation": True},
            "offline_bank_diagnostic": bank_analysis([(by_arm["fixed_cheap"][qid], by_arm["fixed_strong"][qid]) for qid in ids]),
            "current_live_evaluation_blocker": {"reference": "R6", "host": platform.system(), "docker_command_available": shutil.which("docker") is not None,
                "canonical_swe_bench_executed": False, "coding_benchmark_score": None, "runtime_installation_or_cloud_job_started": False},
            "interpretation": {"strict_ex_not_semantic_quality": True, "known_contract_gold_audit_issues": [247, 248, 744, 1460],
                "no_posthoc_rescore_or_dropped_question": True, "sequential_extension_after_pilot_not_initial_ten_preregistration": True,
                "token_cache_breakdown_and_invoices_not_available": True, "provider_calls": 0, "sql_calls_from_this_metadata_analysis": 0,
                "original_sources_data_scores_and_security_guards_changed": False, "execution_authority": False}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, default=HERE / "report.json")
    args = parser.parse_args()
    self_test()
    if args.self_test:
        print(json.dumps({"self_tests": "passed", "provider_calls": 0, "sql_calls": 0}))
        return
    try:
        raw = INPUT.read_bytes()
        data = json.loads(raw)
    except (OSError, ValueError) as error:
        raise ValueError("historical_metadata_missing_or_invalid") from error
    digest = hashlib.sha256(raw).hexdigest()
    assert digest == INPUT_SHA256, "Historical input changed; do not silently replace the registered audit sample."
    assert args.output.resolve() != INPUT.resolve(), "Audit output must not overwrite historical evidence."
    report = analyze(data, digest)
    assert hashlib.sha256(INPUT.read_bytes()).hexdigest() == digest
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"questions": report["questions"], "workflows": report["completed_workflows"], "provider_calls": 0,
                      "paired_tests": {key: row["exact_mcnemar"]["exact_two_sided_p"] for key, row in report["paired_comparisons"].items()},
                      "pgr": report["route_llm_metrics"]["pgr"], "new_model_or_coding_benchmark": False}))


if __name__ == "__main__":
    main()
