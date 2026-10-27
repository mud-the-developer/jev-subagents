"""Post-hoc contract diagnostics only. No replacement semantic score; no providers or generated Python execution."""
import argparse
import hashlib
import importlib.util
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent


def load_json(file):
    try:
        return json.loads(file.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError("diagnostic_input_missing_or_invalid") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=pathlib.Path)
    parser.add_argument("pilot_fixtures", type=pathlib.Path)
    parser.add_argument("extension_fixtures", type=pathlib.Path)
    args = parser.parse_args()
    records_file = HERE.parent / "multistage-bird-extended" / "results.json"
    recorded = load_json(records_file)
    original_digest = hashlib.sha256(records_file.read_bytes()).hexdigest()
    protocol = load_json(HERE.parent / "multistage-bird-extended" / "protocol.json")
    evaluator_file = HERE.parent / "bird-mini-dev-pilot" / "safe_sql.py"
    assert hashlib.sha256(evaluator_file.read_bytes()).hexdigest() == protocol["sharedSqlEvaluatorSha256"]
    spec = importlib.util.spec_from_file_location("frozen_readonly_sql", evaluator_file)
    if spec is None or spec.loader is None:
        raise ValueError("frozen_evaluator_unavailable")
    evaluator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evaluator)
    acquisition = load_json(args.dataset / "ACQUISITION.json")
    assert hashlib.sha256((args.dataset / "questions.json").read_bytes()).hexdigest() == acquisition["questionsSha256"]
    questions = load_json(args.dataset / "questions.json")
    fixtures = {"pilot3": args.pilot_fixtures, "extension7": args.extension_fixtures}
    diagnostics = []
    for question_id in (247, 248, 744, 1460):
        question = next(row for row in questions if row["question_id"] == question_id)
        database = args.dataset / (question["db_id"] + ".sqlite")
        expected_hash = next(row["sha256"] for row in acquisition["databases"] if row["db_id"] == question["db_id"])
        assert hashlib.sha256(database.read_bytes()).hexdigest() == expected_hash
        gold = evaluator.readonly_query(database, question["SQL"])
        for row in (item for item in recorded["rows"] if item["questionId"] == question_id):
            candidate = fixtures[row["cohort"]] / row["id"] / "query.sql"
            assert hashlib.sha256(candidate.read_bytes()).hexdigest() == row["querySha256"]
            predicted = evaluator.readonly_query(database, candidate.read_text(encoding="utf8"))
            item = {"question_id": question_id, "arm": row["arm"], "official_ex": set(predicted) == set(gold),
                    "gold_columns": len(gold[0]) if gold else 0, "predicted_columns": len(predicted[0]) if predicted else 0,
                    "gold_distinct_rows": len(set(gold)), "predicted_distinct_rows": len(set(predicted))}
            if question_id == 247:
                # Case-specific evidence interpretation, not a new dataset-wide semantic oracle.
                evidence = evaluator.readonly_query(database, "SELECT DISTINCT a.element FROM atom a WHERE a.atom_id NOT IN (SELECT c.atom_id FROM connected c)")
                item.update({"diagnostic": "atom_id_evidence_vs_global_element_gold", "prediction_matches_provided_atom_id_rule": set(predicted) == set(evidence),
                             "gold_matches_that_evidence_rule": set(gold) == set(evidence), "evidence_distinct_rows": len(set(evidence))})
            elif question_id == 1460 and predicted and len(predicted[0]) == 2:
                item.update({"diagnostic": "concatenated_name_projection", "matches_concatenated_gold_facts": set(predicted) == {(str(first) + " " + str(last), cost) for first, last, cost in gold}})
            elif question_id == 744:
                item.update({"diagnostic": "winner_and_difference_vs_scalar", "difference_projection_matches_gold": {(row[-1],) for row in predicted} == set(gold)})
                if predicted and len(predicted[0]) == 2:
                    winner = "Marvel Comics" if gold[0][0] > 0 else "DC Comics" if gold[0][0] < 0 else "Tie"
                    item["winner_matches_difference_sign"] = predicted[0][0] == winner
            elif question_id == 248 and predicted and len(predicted[0]) == 5:
                item.update({"diagnostic": "extra_columns_and_undirected_endpoint_pairs", "unordered_endpoint_sets_match": {tuple(sorted((row[1], row[3]))) for row in predicted} == {tuple(sorted(row)) for row in gold}})
            assert item["official_ex"] == row["finalValidation"]["executionMatch"]
            diagnostics.append(item)
        assert hashlib.sha256(database.read_bytes()).hexdigest() == expected_hash
    assert hashlib.sha256(records_file.read_bytes()).hexdigest() == original_digest
    report = {"kind": "posthoc_case_specific_contract_diagnostics_not_rescoring", "diagnostics": diagnostics,
              "source_results_sha256": original_digest, "frozen_evaluator_sha256": protocol["sharedSqlEvaluatorSha256"],
              "original_scores_changed": False, "new_semantic_accuracy_computed": False, "initial_pre_correction_sql_replayed": False,
              "raw_questions_sql_results_reports_or_paths_published": False, "provider_calls": 0, "execution_authority": False}
    (HERE / "contract-audit.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8", newline="\n")
    print(json.dumps({"case_specific_checks": len(diagnostics), "new_semantic_score": None, "original_ex_unchanged": True, "provider_calls": 0}))


if __name__ == "__main__":
    main()
