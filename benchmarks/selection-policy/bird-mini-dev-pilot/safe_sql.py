"""Read-only, bounded SQLite result-set EX evaluation; never executes generated Python."""
import hashlib
import json
import pathlib
import re
import sqlite3
import sys
import time

MAX_ROWS = 5000
MAX_BYTES = 1024 * 1024


def readonly_query(database, sql, seconds=5):
    if not isinstance(sql, str) or len(sql.encode("utf8")) > 32768 or not re.match(r"^\s*(SELECT|WITH)\b", sql, re.IGNORECASE):
        raise ValueError("query_contract")
    deadline = time.monotonic() + seconds
    connection = sqlite3.connect(pathlib.Path(database).resolve().as_uri() + "?mode=ro&immutable=1", uri=True, isolation_level=None, timeout=0.1)
    try:
        connection.execute("PRAGMA query_only=ON")
        def authorize(action, first, second, db, _source):
            if action == sqlite3.SQLITE_READ:
                return sqlite3.SQLITE_OK if db in ("main", "temp") else sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_SELECT or action == sqlite3.SQLITE_RECURSIVE:
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION:
                return sqlite3.SQLITE_DENY if (second or first or "").lower() in {"load_extension", "readfile", "writefile", "eval", "fts3_tokenizer"} else sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY
        connection.set_authorizer(authorize)
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        cursor = connection.execute(sql)
        if cursor.description is None:
            raise ValueError("query_not_select")
        rows = cursor.fetchmany(MAX_ROWS + 1)
        if len(rows) > MAX_ROWS or len(json.dumps(rows, default=lambda x: x.hex() if isinstance(x, bytes) else str(x)).encode("utf8")) > MAX_BYTES:
            raise ValueError("result_bound")
        return rows
    finally:
        connection.close()


def result_digest(rows):
    # Official Mini-Dev EX uses set(row tuples), ignoring duplicate rows/order.
    encoded = [json.dumps(row, ensure_ascii=False, default=lambda x: x.hex() if isinstance(x, bytes) else str(x), separators=(",", ":")) for row in set(rows)]
    return hashlib.sha256("\n".join(sorted(encoded)).encode("utf8")).hexdigest()


def evaluate(root, question_id, candidate):
    root = pathlib.Path(root)
    try:
        acquisition = json.loads((root / "ACQUISITION.json").read_text(encoding="utf8"))
        rows = json.loads((root / "questions.json").read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError("dataset_metadata_invalid") from error
    if hashlib.sha256((root / "questions.json").read_bytes()).hexdigest() != acquisition["questionsSha256"]:
        raise ValueError("question_data_changed")
    matches = [row for row in rows if str(row["question_id"]) == str(question_id)]
    if len(matches) != 1:
        raise ValueError("question_identity")
    row = matches[0]
    if not re.fullmatch(r"[a-z0-9_]+", row["db_id"]):
        raise ValueError("database_identity")
    database = root / (row["db_id"] + ".sqlite")
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    expected_database = next(item["sha256"] for item in acquisition["databases"] if item["db_id"] == row["db_id"])
    if before != expected_database:
        raise ValueError("database_not_acquired_version")
    expected = readonly_query(database, row["SQL"])
    if not expected:
        raise ValueError("empty_reference_not_in_pilot")
    started = time.monotonic()
    try:
        actual = readonly_query(database, pathlib.Path(candidate).read_text(encoding="utf8"))
        result = {"status": "evaluated", "executionMatch": set(actual) == set(expected), "predictedRows": len(actual), "predictedSetSha256": result_digest(actual)}
    except (ValueError, sqlite3.Error):
        result = {"status": "query_error_or_rejected", "executionMatch": False}
    if hashlib.sha256(database.read_bytes()).hexdigest() != before:
        raise ValueError("database_changed")
    return {"questionId": row["question_id"], **result, "goldRows": len(expected), "goldSetSha256": result_digest(expected), "databaseSha256": before,
            "databaseUnchanged": True, "readOnlyAuthorizer": True, "validationMs": (time.monotonic() - started) * 1000,
            "metric": "single-database result-set EX; restricted SELECT-only pilot", "modelCalls": 0}


if __name__ == "__main__":
    print(json.dumps(evaluate(sys.argv[1], sys.argv[2], sys.argv[3])))
