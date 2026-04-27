from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def yolo_default() -> bool:
    v = os.environ.get("AI_SESSIONS_YOLO")
    if v is None:
        return True
    return v.lower() not in {"0", "false", "no", "off"}


def data_dir() -> Path:
    raw = os.environ.get("AI_SESSIONS_DATA_DIR") or os.getcwd()
    p = Path(raw).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def port() -> int:
    try:
        return int(os.environ.get("AI_SESSIONS_PORT", "7878"))
    except ValueError:
        return 7878
