"""Bounded official BIRD Mini-Dev acquisition; no model call or archive-wide extraction."""
import collections
import hashlib
import io
import json
import pathlib
import re
import sys
import urllib.request
import zipfile

REVISION = "f65faf4ae3b638c1fa6df1d3370c8d92c8366301"
HF = f"https://huggingface.co/datasets/birdsql/bird_mini_dev/resolve/{REVISION}/"
ARCHIVE = "https://bird-bench.oss-cn-beijing.aliyuncs.com/minidev.zip"
MAX_DB = 32 * 1024 * 1024


def fetch(url, limit):
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Dataset response bound exceeded")
    return data


class Ranges(io.RawIOBase):
    def __init__(self):
        with urllib.request.urlopen(urllib.request.Request(ARCHIVE, method="HEAD"), timeout=45) as response:
            self.size = int(response.headers["Content-Length"])
            self.etag = response.headers["ETag"]
        self.pos = 0
        self.downloaded = 0

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        if not 0 <= self.pos <= self.size:
            raise ValueError("Invalid bounded archive seek")
        return self.pos

    def read(self, size=-1):
        size = self.size - self.pos if size < 0 else min(size, self.size - self.pos)
        if size == 0:
            return b""
        if size > 8 * 1024 * 1024:
            raise ValueError("Archive read bound exceeded")
        start, end = self.pos, self.pos + size - 1
        req = urllib.request.Request(ARCHIVE, headers={"Range": f"bytes={start}-{end}", "If-Match": self.etag})
        with urllib.request.urlopen(req, timeout=45) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{self.size}":
                raise ValueError("Archive range not honored; no full-download fallback")
            data = response.read(size + 1)
        if len(data) != size:
            raise ValueError("Archive range length mismatch")
        self.pos += size
        self.downloaded += size
        return data


def main():
    root = pathlib.Path(sys.argv[1]).resolve()
    if not root.is_dir() or list(root.iterdir()):
        raise ValueError("An existing fresh private empty dataset directory is required")
    questions = fetch(HF + "data/mini_dev_sqlite-00000-of-00001.json", 2 * 1024 * 1024)
    card = fetch(HF + "README.md", 64 * 1024)
    try:
        rows = json.loads(questions) if questions.lstrip().startswith(b"[") else [json.loads(line) for line in questions.splitlines() if line.strip()]
    except ValueError as error:
        raise ValueError("Official question JSON was malformed") from error
    if not rows or not all(isinstance(row, dict) and {"db_id", "question", "SQL", "difficulty"} <= row.keys() for row in rows):
        raise ValueError("Unexpected official SQLite data schema")
    (root / "questions.json").write_bytes(questions)
    (root / "DATASET-CARD.md").write_bytes(card)
    available = {row["db_id"] for row in rows}
    remote = Ranges()
    databases = []
    with zipfile.ZipFile(remote) as archive:
        candidates = []
        for entry in archive.infolist():
            name = pathlib.PurePosixPath(entry.filename).name
            if name.endswith(".sqlite") and name[:-7] in available and re.fullmatch(r"[a-z0-9_]+", name[:-7]) and 0 < entry.file_size <= MAX_DB:
                candidates.append(entry)
        chosen = sorted(candidates, key=lambda entry: (entry.file_size, entry.filename))[:3]
        if len(chosen) != 3:
            raise ValueError("Need three bounded official database files; no alternative dataset substituted")
        for entry in chosen:
            destination = root / pathlib.PurePosixPath(entry.filename).name
            digest = hashlib.sha256()
            total = 0
            with archive.open(entry) as source, destination.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_DB:
                        raise ValueError("Database expansion bound exceeded")
                    digest.update(chunk)
                    output.write(chunk)
            if total != entry.file_size or destination.read_bytes()[:16] != b"SQLite format 3\x00":
                raise ValueError("Database bytes or format mismatch")
            databases.append({"db_id": destination.stem, "member": entry.filename, "bytes": total, "compressedBytes": entry.compress_size, "crc32": entry.CRC, "sha256": digest.hexdigest()})
    manifest = {"dataset": "BIRD Mini-Dev SQLite", "hfRevision": REVISION, "license": "CC-BY-SA-4.0", "attribution": "BIRD-SQL team / bird-bench/mini_dev / birdsql/bird_mini_dev", "questionsUrl": HF + "data/mini_dev_sqlite-00000-of-00001.json", "questionBytes": len(questions), "questionsSha256": hashlib.sha256(questions).hexdigest(), "rows": len(rows), "difficultyCounts": dict(collections.Counter(row["difficulty"] for row in rows)), "databaseArchive": ARCHIVE, "archiveBytes": remote.size, "archiveETag": remote.etag, "rangeBytesDownloaded": remote.downloaded, "fullArchiveSha256Available": False, "availabilityRule": "Three smallest official SQLite members up to32MiB; chosen before model outcomes", "databases": databases, "modelCalls": 0, "rawDatasetRedistributedInMitRepo": False}
    (root / "ACQUISITION.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
