# -*- coding: utf-8 -*-
"""アプリ全体の設定。環境変数で上書きできる。"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# --- データの保存先 ---------------------------------------------------------------
DATA_DIR = Path(os.environ.get("VR_DATA_DIR", BASE_DIR / "data"))
VIDEO_DIR = DATA_DIR / "videos"
SHOT_DIR = DATA_DIR / "screenshots"
TRASH_DIR = DATA_DIR / "trash"
MATERIAL_DIR = DATA_DIR / "materials"
DB_PATH = DATA_DIR / "app.db"
LOG_PATH = DATA_DIR / "app.log"

# --- スクリーンショット生成 -------------------------------------------------------
# 既存の auto_screenshot.py をそのまま呼び出す（コピーしない）。
AUTO_SCREENSHOT_PY = Path(os.environ.get(
    "VR_AUTO_SCREENSHOT",
    BASE_DIR / "auto_screenshot.py"
))

# 60秒前後のショート動画で「取りこぼしゼロ」を確認済みの設定。
# 表示用に幅 540px の JPG で書き出す（原寸 PNG は 1本 80MB になり一覧が重いため）。
SCREENSHOT_ARGS = [
    "--telop-sensitivity", "0.10",
    "--min-gap", "0.2",
    "--format", "jpg",
    "--max-width", "540",
]

# auto_screenshot.py の実行がこれを超えたら打ち切る（秒）
JOB_TIMEOUT_SEC = int(os.environ.get("VR_JOB_TIMEOUT", "1800"))

# --- アップロード -----------------------------------------------------------------
ALLOWED_EXT = {
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".avi",
    ".mkv",
}

MAX_UPLOAD_MB = int(
    os.environ.get(
        "VR_MAX_UPLOAD_MB",
        "2048"
    )
)

# 素材画像としてアップロードできる形式
ALLOWED_IMAGE_EXT = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}

# --- サーバー ---------------------------------------------------------------------
# 0.0.0.0 で待ち受けると社内 LAN の他 PC からアクセスできる。
HOST = os.environ.get("VR_HOST", "0.0.0.0")
PORT = int(os.environ.get("VR_PORT", "5000"))

DEFAULT_VERSION_LABELS = [
    "初稿",
    "修正版",
]


def ensure_dirs() -> None:

    for d in (
        DATA_DIR,
        VIDEO_DIR,
        SHOT_DIR,
        TRASH_DIR,
        MATERIAL_DIR,
    ):
        d.mkdir(
            parents=True,
            exist_ok=True,
        )