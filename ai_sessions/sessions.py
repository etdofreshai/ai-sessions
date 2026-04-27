from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def file_times(path: Path) -> dict[str, str]:
    s = path.stat()
    return {
        "createdAt": datetime.fromtimestamp(s.st_ctime, tz=timezone.utc).isoformat(),
        "updatedAt": datetime.fromtimestamp(s.st_mtime, tz=timezone.utc).isoformat(),
    }
