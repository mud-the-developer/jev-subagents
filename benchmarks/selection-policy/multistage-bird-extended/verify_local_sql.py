"""Replay only final historical SQL using authorized private artifacts from both unchanged cohorts."""
import hashlib
import importlib.util
import json
import pathlib
import sys


def main():
    here = pathlib.Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("frozen_sql", here.parent / "bird-mini-dev-pilot" / "safe_sql.py")
    if spec is None or spec.loader is None:
        raise ValueError("frozen_sql_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        recorded = json.loads((here / "results.json").read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError("extension_metadata_invalid") from error
    dataset = pathlib.Path(sys.argv[1]).resolve()
    roots = {"pilot3": pathlib.Path(sys.argv[2]).resolve(), "extension7": pathlib.Path(sys.argv[3]).resolve()}
    count = 0
    for row in recorded["rows"]:
        query = roots[row["cohort"]] / row["id"] / "query.sql"
        assert hashlib.sha256(query.read_bytes()).hexdigest() == row["querySha256"]
        current = module.evaluate(dataset, row["questionId"], query)
        for key in ["status", "executionMatch", "goldSetSha256", "databaseSha256", "databaseUnchanged", "predictedSetSha256", "predictedRows"]:
            assert current.get(key) == row["finalValidation"].get(key)
        count += 1
    print(json.dumps({"historicalFinalQueriesReplayed": count, "sameFrozenMetric": True, "initialPreCorrectionSqlReplayed": False,
                      "providerCalls": 0, "rawDataOrReportsPublished": False}))


if __name__ == "__main__":
    main()
