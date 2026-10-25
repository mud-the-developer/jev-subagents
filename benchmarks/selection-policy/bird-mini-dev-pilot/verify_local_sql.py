"""Re-execute identical EX only when authorized local dataset AND historical query files are supplied."""
import hashlib
import json
import pathlib
import sys
from safe_sql import evaluate


def main():
    dataset = pathlib.Path(sys.argv[1]).resolve()
    fixtures = pathlib.Path(sys.argv[2]).resolve()
    here = pathlib.Path(__file__).resolve().parent
    try:
        result = json.loads((here / "results.json").read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError("recorded_metadata_invalid") from error
    verified = 0
    for row in result["rows"]:
        candidate = fixtures / row["id"] / "query.sql"
        assert hashlib.sha256(candidate.read_bytes()).hexdigest() == row["querySha256"]
        current = evaluate(dataset, row["questionId"], candidate)
        for key in ["status", "executionMatch", "goldRows", "goldSetSha256", "databaseSha256", "databaseUnchanged", "readOnlyAuthorizer", "predictedRows", "predictedSetSha256"]:
            assert current.get(key) == row["validation"].get(key), "Historical SQL outcome changed"
        verified += 1
    print(json.dumps({"historicalSqlQueriesRechecked": verified, "sameFrozenMetric": True, "providerCalls": 0, "rawSqlPublished": False}))


if __name__ == "__main__":
    main()
