"""Recheck unchanged historical final SQL using authorized private dataset/query artifacts."""
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
        results = json.loads((here / "results.json").read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError("metadata_invalid") from error
    dataset, fixtures = pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()
    count = 0
    for row in results["rows"]:
        query = fixtures / row["id"] / "query.sql"
        assert hashlib.sha256(query.read_bytes()).hexdigest() == row["querySha256"]
        checked = module.evaluate(dataset, row["questionId"], query)
        for key in ["status", "executionMatch", "goldSetSha256", "databaseSha256", "databaseUnchanged", "predictedSetSha256", "predictedRows"]:
            assert checked.get(key) == row["finalValidation"].get(key)
        count += 1
    print(json.dumps({"workflowFinalQueriesRechecked": count, "sameFrozenSqlMetric": True, "providerCalls": 0, "rawReportsOrSqlPublished": False}))


if __name__ == "__main__":
    main()
