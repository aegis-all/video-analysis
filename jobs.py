# -*- coding: utf-8 -*-
"""
動画アップロード後に auto_screenshot.py を実行して、
生成された画像と時刻を DB に登録するバックグラウンド処理。
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse

import config
import db

log = logging.getLogger("jobs")

# リンクからのダウンロードで使う設定
_DOWNLOAD_TIMEOUT_SEC = 60
_DOWNLOAD_CHUNK = 1024 * 1024
_DOWNLOAD_UA = "Mozilla/5.0 (compatible; video-review/1.0)"

_PROGRESS_RE = re.compile(r"^\s*([0-9]+(?:\.[0-9]+)?)%")

_STAGES = {
    "[1/3]": "動画を読み込んでいます",
    "[2/3]": "変化を検出しています",
    "[3/3]": "画像を保存しています",
}


def start(video_id: int) -> None:
    """別スレッドでスクリーンショット生成を開始する。"""
    t = threading.Thread(
        target=_run_guarded,
        args=(video_id,),
        name=f"shot-{video_id}",
        daemon=True,
    )
    t.start()


def _set(video_id: int, **fields) -> None:
    if not fields:
        return

    cols = ", ".join(f"{k} = ?" for k in fields)

    db.execute(
        f"UPDATE videos SET {cols} WHERE id = ?",
        (*fields.values(), video_id),
    )


def _run_guarded(video_id: int) -> None:
    try:
        _run(video_id)

    except Exception as exc:
        log.exception(
            "スクリーンショット生成に失敗しました video_id=%s",
            video_id,
        )

        _set(
            video_id,
            status="error",
            stage="",
            error_message=f"想定外のエラーが発生しました: {exc}",
        )


def _download_video(
    video_id: int,
    url: str,
) -> Path | None:
    """
    リンク先の動画をダウンロードして videos.file_path を埋める。

    成功したら保存先を返す。失敗したら status=error を書き込んで None を返す。
    進捗はダウンロード量から算出して画面に出す。
    """
    config.ensure_dirs()

    videos_dir = Path(config.VIDEO_DIR)
    videos_dir.mkdir(parents=True, exist_ok=True)

    suffix = (
        Path(unquote(urlparse(url).path)).suffix.lower()
        or ".mp4"
    )

    path = videos_dir / f"{uuid.uuid4().hex}{suffix}"

    limit_bytes = config.MAX_UPLOAD_MB * 1024 * 1024

    _set(
        video_id,
        status="processing",
        progress=0,
        stage="動画をダウンロードしています",
        error_message=None,
    )

    request = urllib.request.Request(
        url,
        headers={"User-Agent": _DOWNLOAD_UA},
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=_DOWNLOAD_TIMEOUT_SEC,
        ) as response:

            ctype = (
                response.headers.get("Content-Type")
                or ""
            ).lower()

            # HTML が返るのは、動画直リンクではなくページ URL のとき
            if "text/html" in ctype:
                _set(
                    video_id,
                    status="error",
                    error_message=(
                        "リンク先が動画ファイルではありませんでした"
                        "（HTML が返ってきました）。\n"
                        "動画ファイルへの直接リンク（末尾が .mp4 など）を"
                        "指定してください。\n\n"
                        f"{url}"
                    ),
                )
                return None

            total = 0

            try:
                declared = int(
                    response.headers.get("Content-Length") or 0
                )
            except ValueError:
                declared = 0

            if declared and declared > limit_bytes:
                _set(
                    video_id,
                    status="error",
                    error_message=(
                        f"動画が大きすぎます"
                        f"（{declared / 1024 / 1024:.0f}MB / "
                        f"上限 {config.MAX_UPLOAD_MB}MB）。"
                    ),
                )
                return None

            with path.open("wb") as out:

                while True:

                    chunk = response.read(_DOWNLOAD_CHUNK)

                    if not chunk:
                        break

                    total += len(chunk)

                    if total > limit_bytes:
                        out.close()
                        path.unlink(missing_ok=True)
                        _set(
                            video_id,
                            status="error",
                            error_message=(
                                f"動画が大きすぎます"
                                f"（上限 {config.MAX_UPLOAD_MB}MB）。"
                            ),
                        )
                        return None

                    out.write(chunk)

                    if declared:
                        _set(
                            video_id,
                            progress=min(
                                99,
                                int(total * 100 / declared),
                            ),
                            stage=(
                                f"動画をダウンロードしています"
                                f"（{total / 1024 / 1024:.0f}"
                                f"/{declared / 1024 / 1024:.0f}MB）"
                            ),
                        )

    except urllib.error.HTTPError as exc:
        path.unlink(missing_ok=True)
        _set(
            video_id,
            status="error",
            error_message=(
                f"リンク先を取得できませんでした（HTTP {exc.code}）。\n"
                "URL が正しいか、公開されているか確認してください。\n\n"
                f"{url}"
            ),
        )
        return None

    except Exception as exc:
        path.unlink(missing_ok=True)
        _set(
            video_id,
            status="error",
            error_message=(
                f"リンク先を取得できませんでした: {exc}\n\n{url}"
            ),
        )
        return None

    if not path.is_file() or path.stat().st_size == 0:
        path.unlink(missing_ok=True)
        _set(
            video_id,
            status="error",
            error_message=(
                f"ダウンロードした動画が空でした。\n\n{url}"
            ),
        )
        return None

    db.execute(
        """
        UPDATE videos
        SET file_path = ?
        WHERE id = ?
        """,
        (str(path), video_id),
    )

    log.info(
        "video_id=%s ダウンロード完了 %.1fMB",
        video_id,
        path.stat().st_size / 1024 / 1024,
    )

    return path


def _run(video_id: int) -> None:

    row = db.query(
        "SELECT * FROM videos WHERE id = ?",
        (video_id,),
        one=True,
    )

    if row is None:
        log.error(
            "video_id=%s が見つかりません",
            video_id,
        )
        return

    # ---------------------------------------------------------
    # リンク登録なら、まず動画を取ってくる
    # ---------------------------------------------------------

    source_url = (
        row["source_url"]
        if "source_url" in row.keys()
        else ""
    )

    if source_url and not row["file_path"]:

        downloaded = _download_video(
            video_id,
            source_url,
        )

        if downloaded is None:
            return          # エラー内容は _download_video が記録済み

        row = db.query(
            "SELECT * FROM videos WHERE id = ?",
            (video_id,),
            one=True,
        )

    video_path = Path(row["file_path"])

    out_dir = (
        config.SHOT_DIR /
        str(video_id)
    )

    index_path = (
        out_dir /
        "index.json"
    )

    # ---------------------------------------------------------
    # auto_screenshot.py の確認
    # ---------------------------------------------------------

    if not config.AUTO_SCREENSHOT_PY.is_file():

        _set(
            video_id,
            status="error",
            error_message=(
                "スクリーンショット生成スクリプトが見つかりません。\n"
                f"{config.AUTO_SCREENSHOT_PY}"
            ),
        )

        return

    # ---------------------------------------------------------
    # 動画ファイルの確認
    # ---------------------------------------------------------

    if not video_path.is_file():

        _set(
            video_id,
            status="error",
            error_message=(
                f"動画ファイルが見つかりません: "
                f"{video_path}"
            ),
        )

        return

    out_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    _set(
        video_id,
        status="processing",
        progress=0,
        stage="準備しています",
        error_message=None,
    )

    # ---------------------------------------------------------
    # auto_screenshot.py 実行
    # ---------------------------------------------------------

    cmd = [
        sys.executable,
        str(config.AUTO_SCREENSHOT_PY),
        str(video_path),
        "-o",
        str(out_dir),
        "--index-json",
        str(index_path),
        *config.SCREENSHOT_ARGS,
    ]

    log.info(
        "実行: %s",
        " ".join(cmd),
    )

    lines: list[str] = []

    try:

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=_child_env(),
        )

    except OSError as exc:

        _set(
            video_id,
            status="error",
            error_message=(
                f"Python を起動できませんでした: {exc}"
            ),
        )

        return

    timer = threading.Timer(
        config.JOB_TIMEOUT_SEC,
        proc.kill,
    )

    timer.start()

    try:

        assert proc.stdout is not None

        for raw in proc.stdout:

            line = raw.rstrip()

            lines.append(line)

            log.debug(
                "[%s] %s",
                video_id,
                line,
            )

            for key, label in _STAGES.items():

                if line.startswith(key):

                    _set(
                        video_id,
                        stage=label,
                    )

            m = _PROGRESS_RE.match(line)

            if m:

                _set(
                    video_id,
                    progress=int(
                        float(
                            m.group(1)
                        )
                    ),
                )

        code = proc.wait()

    finally:

        timer.cancel()

    # ---------------------------------------------------------
    # エラー処理
    # ---------------------------------------------------------

    tail = "\n".join(
        lines[-15:]
    )

    if code != 0:

        _set(
            video_id,
            status="error",
            stage="",
            progress=0,
            error_message=_friendly_error(
                code,
                tail,
            ),
        )

        return

    # ---------------------------------------------------------
    # index.json確認
    # ---------------------------------------------------------

    if not index_path.is_file():

        _set(
            video_id,
            status="error",
            stage="",
            progress=0,
            error_message=(
                "スクリーンショットの一覧ファイルが作られませんでした。\n"
                "auto_screenshot.py が --index-json に対応しているか確認してください。\n\n"
                + tail
            ),
        )

        return

    # ---------------------------------------------------------
    # JSON読み込み
    # ---------------------------------------------------------

    try:

        data = json.loads(
            index_path.read_text(
                encoding="utf-8"
            )
        )

        shots = data.get(
            "screenshots",
            []
        )

    except Exception as exc:

        _set(
            video_id,
            status="error",
            stage="",
            progress=0,
            error_message=(
                f"スクリーンショット一覧を読めませんでした: {exc}"
            ),
        )

        return

    # ---------------------------------------------------------
    # スクショ0枚
    # ---------------------------------------------------------

    if not shots:

        _set(
            video_id,
            status="error",
            stage="",
            progress=0,
            error_message=(
                "スクリーンショットが1枚も生成されませんでした。\n"
                "動画が短すぎるか、変化が検出されなかった可能性があります。"
            ),
        )

        return

    # ---------------------------------------------------------
    # DB登録
    # ---------------------------------------------------------

    _register(
        video_id,
        out_dir,
        shots,
        data.get("duration_sec"),
    )

    _set(
        video_id,
        status="done",
        progress=100,
        stage="",
        duration_sec=data.get(
            "duration_sec"
        ),
    )

    log.info(
        "完了 video_id=%s / %s 枚",
        video_id,
        len(shots),
    )


def _register(
    video_id: int,
    out_dir: Path,
    shots: list[dict],
    duration: float | None,
) -> None:

    """
    生成された画像をDBに登録する。

    再実行した場合も、すでに入力されていた
    11列のテキスト内容を seq ごとに引き継ぐ。
    """

    prev_rows = db.query(
        """
        SELECT
            seq,
            reference_role,
            material_feature,
            improvement_note,
            reference_feedback,
            text_raw,
            material,
            role,
            scene_feeling,
            feedback
        FROM screenshots
        WHERE video_id = ?
        """,
        (video_id,),
    )

    prev = {
        r["seq"]: (
            r["reference_role"],
            r["material_feature"],
            r["improvement_note"],
            r["reference_feedback"],
            r["text_raw"],
            r["material"],
            r["role"],
            r["scene_feeling"],
            r["feedback"],
        )
        for r in prev_rows
    }

    ts = db.now()

    with db.connect() as conn:

        conn.execute(
            "DELETE FROM screenshots WHERE video_id = ?",
            (video_id,),
        )

        rows = []

        for s in shots:

            old = prev.get(
                s["seq"],
                (
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ),
            )

            rows.append(
                (
                    video_id,
                    s["seq"],
                    str(
                        out_dir /
                        s["file"]
                    ),
                    float(
                        s["timestamp_sec"]
                    ),
                    *old,
                    ts,
                )
            )

        # 生成枚数より下書きの行数が多い場合、余った行を捨てない。
        # 動画より先に台本を書いておく使い方（空の30行）を守るため、
        # 中身が入っている行だけ画像なしのまま後ろに残す。
        extra_seq = len(shots)

        for seq in sorted(prev):

            if seq <= len(shots):
                continue

            old = prev[seq]

            if not any(v.strip() for v in old):
                continue

            extra_seq += 1

            rows.append(
                (
                    video_id,
                    extra_seq,
                    "",       # 画像なし
                    0.0,
                    *old,
                    ts,
                )
            )

        conn.executemany(
            """
            INSERT INTO screenshots (
                video_id,
                seq,
                image_path,
                timestamp_sec,

                reference_role,
                material_feature,
                improvement_note,
                reference_feedback,

                text_raw,
                material,
                role,
                scene_feeling,
                feedback,

                updated_at
            )
            VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?
            )
            """,
            rows,
        )

        conn.commit()


def _friendly_error(
    code: int,
    tail: str,
) -> str:

    if code < 0 or code == 137:

        return (
            f"処理が {config.JOB_TIMEOUT_SEC} 秒で終わらなかったため中断しました。\n"
            "動画が長すぎる可能性があります。\n\n"
            f"{tail}"
        )

    if code == 2:

        return (
            "動画ファイルを開けませんでした。"
            "形式を確認してください。\n\n"
            f"{tail}"
        )

    if code == 1:

        return (
            "スクリーンショットを検出できませんでした。\n"
            "動画に変化が少ないか、短すぎる可能性があります。\n\n"
            f"{tail}"
        )

    return (
        f"スクリーンショット生成が失敗しました"
        f"（終了コード {code}）。\n\n"
        f"{tail}"
    )


def _child_env() -> dict:

    import os

    env = os.environ.copy()

    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    return env