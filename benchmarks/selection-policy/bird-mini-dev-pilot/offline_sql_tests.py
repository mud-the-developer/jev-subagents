"""No-model SQL safety/control tests using a fresh synthetic SQLite database."""
import hashlib
from contextlib import closing
import pathlib
import sqlite3
import tempfile
import time
from safe_sql import readonly_query


def main():
    with tempfile.TemporaryDirectory(prefix="jev-sql-safety-") as directory:
        database = pathlib.Path(directory) / "synthetic.sqlite"
        with closing(sqlite3.connect(database)) as connection:
            connection.execute("CREATE TABLE facts (id INTEGER, value TEXT)")
            connection.executemany("INSERT INTO facts VALUES (?, ?)", [(1, "a"), (2, "b")])
            connection.commit()
        before = hashlib.sha256(database.read_bytes()).hexdigest()
        assert readonly_query(database, "SELECT value FROM facts ORDER BY id") == [("a",), ("b",)]
        assert readonly_query(database, "WITH chosen AS (SELECT id FROM facts) SELECT max(id) FROM chosen") == [(2,)]
        rejected = 0
        for sql in ["DELETE FROM facts", "PRAGMA writable_schema=ON", "ATTACH 'outside.sqlite' AS other", "SELECT load_extension('not-a-library')", "SELECT writefile('outside', 'data')", "SELECT readfile('outside')", "SELECT 1; DELETE FROM facts", "WITH x AS (SELECT 1) DELETE FROM facts"]:
            try:
                readonly_query(database, sql)
            except (ValueError, sqlite3.Error):
                rejected += 1
            else:
                raise AssertionError("Unsafe SQL was admitted")
        started = time.monotonic()
        try:
            readonly_query(database, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n", seconds=0.02)
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("Unbounded query was not interrupted")
        assert time.monotonic() - started < 2
        assert hashlib.sha256(database.read_bytes()).hexdigest() == before
        assert not (pathlib.Path(directory) / "outside").exists()
        print({"safe_select_and_cte": True, "unsafe_queries_rejected": rejected, "progress_deadline": True, "database_unchanged": True, "generated_code_executed": False, "model_calls": 0})


if __name__ == "__main__":
    main()
