# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import logging
import mimetypes
import os
import socket
import sys
import threading
import uuid
from pathlib import Path

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)

import auth
import config
import db
import jobs


# ============================================================
# pythonw（コンソール無し）で動かしたときの出力先
# ============================================================

def _ensure_streams() -> None:
    """
    pythonw.exe で起動すると sys.stdout / sys.stderr が None になる。

    そのまま動かすと、書き込もうとしたライブラリ側で例外が起き、
    とくに HTTPS のときは接続を受け付けるループごと止まってしまう
    （TCP は繋がるのに何も返ってこない、という状態になる）。
    出力先をログファイルに向けて、None のままにしない。
    """
    if sys.stdout is not None and sys.stderr is not None:
        return

    config.ensure_dirs()
    log_path = config.DATA_DIR / "server.log"

    # Python 側（sys.stdout）だけ差し替えても、OS 側の 0/1/2 番は
    # 塞がったまま。その状態だと下位のライブラリが書き込みに失敗し、
    # 接続を受け付けるループごと巻き込まれる。番号ごと張り替える。
    try:
        fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        for target in (1, 2):
            if fd != target:
                os.dup2(fd, target)
        if fd not in (0, 1, 2):
            os.close(fd)
    except OSError:
        pass

    try:
        null_fd = os.open(os.devnull, os.O_RDONLY)
        if null_fd != 0:
            os.dup2(null_fd, 0)
            os.close(null_fd)
    except OSError:
        pass

    stream = open(log_path, "a", encoding="utf-8", buffering=1)

    if sys.stdout is None:
        sys.stdout = stream

    if sys.stderr is None:
        sys.stderr = stream

    sys.__stdout__ = sys.stdout
    sys.__stderr__ = sys.stderr


_ensure_streams()


# ============================================================
# Flask
# ============================================================

app = Flask(__name__)

# nginx / Caddy の後ろに置いたとき、本来の https / ホスト名を見失わないようにする。
# これが無いと url_for(_external=True) が http:// で URL を作ってしまう。
if os.environ.get("VR_BEHIND_PROXY"):
    from werkzeug.middleware.proxy_fix import ProxyFix

    app.wsgi_app = ProxyFix(
        app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1
    )

app.config["MAX_CONTENT_LENGTH"] = (
    config.MAX_UPLOAD_MB * 1024 * 1024
)

# テンプレートを毎回ディスクから読み直す。
# これが無いと、サーバーを起動したままテンプレートを直しても
# 起動時のものが配信され続け、画面が変わらない。
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

# CSS / JS もブラウザにため込ませない
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.context_processor
def _static_version():
    """
    CSS / JS の URL に更新時刻を付けて、ブラウザのキャッシュを外す。

        {{ static_v('style.css') }} -> /static/style.css?v=1723627200
    """

    def static_v(filename: str) -> str:
        path = Path(app.static_folder or "static") / filename

        try:
            stamp = int(path.stat().st_mtime)
        except OSError:
            stamp = 0

        return url_for("static", filename=filename) + f"?v={stamp}"

    return {"static_v": static_v}


# ============================================================
# 初期化
# ============================================================

db.init_db()
auth.init_db()


# ============================================================
# ログ
# ============================================================

def _setup_logging() -> None:
    """
    data/app.log に記録する。

    これが無いと、入力エラー（400）が起きても理由が残らず、
    「作成できない」という報告だけで原因を追えなくなる。
    """

    config.ensure_dirs()

    root = logging.getLogger()
    root.setLevel(logging.INFO)

    already = any(
        isinstance(h, logging.FileHandler)
        and getattr(h, "baseFilename", "") == str(config.LOG_PATH)
        for h in root.handlers
    )

    if already:
        return

    handler = logging.FileHandler(
        config.LOG_PATH,
        encoding="utf-8",
    )

    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
        )
    )

    root.addHandler(handler)


_setup_logging()


# ============================================================
# ログイン（ID + パスワード + Google Authenticator）
# ============================================================

auth.install(app)


# ============================================================
# 共通
# ============================================================

ALLOWED_FIELDS = {
    "reference_role",
    "material_feature",
    "improvement_note",
    "reference_feedback",
    "text_raw",
    "material",
    "role",
    "scene_feeling",
    "feedback",
    "row_height",
}


def _error_page(message: str, status: int = 400):

    logging.getLogger("app").warning(
        "%s %s -> %s : %s",
        request.method,
        request.path,
        status,
        " ".join(message.split()),
    )

    return (
        render_template(
            "error.html",
            message=message,
            back=url_for("index"),
        ),
        status,
    )


def _safe_filename(name: str) -> str:
    name = Path(name or "upload").name

    stem = Path(name).stem
    suffix = Path(name).suffix

    safe_stem = "".join(
        c if (
            c.isalnum()
            or c in " _-"
        ) else "_"
        for c in stem
    )

    if not safe_stem:
        safe_stem = "upload"

    return safe_stem[:100] + suffix.lower()


def make_slug(name: str, project_no: str, exclude_id: int | None = None) -> str:
    """
    案件名＋案件番号から、URL に使う短い名前（パーマリンク）を作る。

    /projects/12 のような連番だと、URL を見ても何の案件か分からない。
    「退職給付金1」のように中身が分かる形にする。

    記号と空白は詰め、同じものが既にあれば末尾に -2, -3 … を付けて重複を避ける。
    """
    import re as _re

    base = f"{name or ''}{project_no or ''}"

    # 日本語のままだと共有時に %E9%80%80… と化けるのでローマ字にする。
    # pykakasi が無い環境でも動くよう、失敗したら日本語のまま使う。
    try:
        import pykakasi

        base = "".join(
            part["hepburn"]
            for part in pykakasi.kakasi().convert(base)
        )
    except Exception:
        pass

    base = base.lower()

    # URL で扱いにくい文字を落とす
    base = _re.sub(r"[\s/\\?#&%+.,:;'\"<>|*\[\]{}()]+", "", base)
    base = base.strip("-_") or "project"
    base = base[:80]

    slug = base
    n = 2

    while True:
        row = db.query(
            """
            SELECT id
            FROM projects
            WHERE slug = ?
              AND (? IS NULL OR id <> ?)
            LIMIT 1
            """,
            (slug, exclude_id, exclude_id),
            one=True,
        )

        if row is None:
            return slug

        slug = f"{base}-{n}"
        n += 1


def _project_url(project_id: int, video_id: int | None = None) -> str:
    """案件ページの URL。slug があればそちらを使う。"""
    row = db.query(
        "SELECT slug FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    slug = (row["slug"] if row else "") or str(project_id)

    if video_id:
        return url_for("project_page", key=slug, v=video_id)

    return url_for("project_page", key=slug)


def _find_project(key: str):
    """slug でも id でも案件を引けるようにする。"""
    project = db.query(
        "SELECT * FROM projects WHERE slug = ?",
        (key,),
        one=True,
    )

    if project is not None:
        return project

    if str(key).isdigit():
        return db.query(
            "SELECT * FROM projects WHERE id = ?",
            (int(key),),
            one=True,
        )

    return None


def _validate_upload(file):
    if file is None:
        return "動画ファイルを選択してください。"

    if not file.filename:
        return "動画ファイルを選択してください。"

    suffix = Path(file.filename).suffix.lower()

    if suffix not in VIDEO_SUFFIXES:
        return "対応していない動画形式です。"

    return None


VIDEO_SUFFIXES = {
    ".mp4",
    ".mov",
    ".m4v",
    ".avi",
    ".mkv",
    ".webm",
    ".wmv",
    ".mpeg",
    ".mpg",
}


def _validate_video_url(url: str):
    """
    貼り付けられたリンクを、ダウンロードを始める前に軽くチェックする。

    実際に取得できるかは jobs 側でしか分からないが、
    明らかな入力ミス（http 以外、拡張子が動画でない）はここで弾く。
    """
    from urllib.parse import urlparse

    if not url:
        return "動画のリンクを入力してください。"

    try:
        parsed = urlparse(url)
    except ValueError:
        return "リンクの形式が正しくありません。"

    if parsed.scheme not in ("http", "https"):
        return "リンクは http:// または https:// で始めてください。"

    if not parsed.netloc:
        return "リンクの形式が正しくありません。"

    suffix = Path(parsed.path).suffix.lower()

    if suffix and suffix not in VIDEO_SUFFIXES:
        return (
            f"動画ファイルへの直接リンクを指定してください"
            f"（末尾が {suffix} になっています）。"
        )

    if not suffix:
        return (
            "動画ファイルへの直接リンク（末尾が .mp4 など）を指定してください。"
            "YouTube などのページ URL は扱えません。"
        )

    return None


DRAFT_ROWS = 30


def _create_draft_video(project_id: int, rows: int = DRAFT_ROWS) -> int:
    """
    動画がまだ無い案件に、空の表だけを用意する。

    先に台本（テキストや役割）を書いておき、あとから動画を足すと
    生成されたスクリーンショットが上の行から順に入っていく。
    screenshots は video に紐づくので、器として status='none' の
    動画レコードを1つ作っておく。
    """
    video_id = db.execute(
        """
        INSERT INTO videos
        (
            project_id, version_label, original_name, file_path,
            source_url, duration_sec, status, progress, stage,
            error_message, sort_order, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id, "初稿", "", "",
            "", None, "none", 0, "動画の追加待ち",
            None, 0, db.now(),
        ),
    )

    ts = db.now()

    for seq in range(1, rows + 1):
        db.execute(
            """
            INSERT INTO screenshots
                (video_id, seq, image_path, timestamp_sec, updated_at)
            VALUES (?, ?, '', 0, ?)
            """,
            (video_id, seq, ts),
        )

    return video_id


def _store_video_url(
    project_id: int,
    version_label: str,
    url: str,
    sort_order: int = 0,
) -> int:
    """
    リンク指定の動画を「これからダウンロードする」状態で登録する。

    ダウンロードは時間がかかるので、ここでは待たずに jobs 側へ任せる。
    file_path はダウンロード完了時に jobs が埋める。
    """
    config.ensure_dirs()

    from urllib.parse import unquote, urlparse

    original_name = (
        Path(unquote(urlparse(url).path)).name
        or "video.mp4"
    )

    video_id = db.execute(
        """
        INSERT INTO videos
        (
            project_id,
            version_label,
            original_name,
            file_path,
            source_url,
            duration_sec,
            status,
            progress,
            stage,
            error_message,
            sort_order,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            version_label,
            original_name,
            "",
            url,
            None,
            "queued",
            0,
            "ダウンロードを待っています",
            None,
            sort_order,
            db.now(),
        ),
    )

    db.touch_project(project_id)

    return video_id


def _store_video(
    project_id: int,
    version_label: str,
    file,
    sort_order: int = 0,
) -> int:

    config.ensure_dirs()

    videos_dir = Path(config.VIDEO_DIR)
    videos_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    original_name = file.filename or "video"

    suffix = Path(
        original_name
    ).suffix.lower()

    filename = (
        f"{uuid.uuid4().hex}"
        f"{suffix}"
    )

    path = videos_dir / filename

    file.save(path)

    video_id = db.execute(
        """
        INSERT INTO videos
        (
            project_id,
            version_label,
            original_name,
            file_path,
            duration_sec,
            status,
            progress,
            stage,
            error_message,
            sort_order,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            version_label,
            original_name,
            str(path),
            None,
            "queued",
            0,
            "準備しています",
            None,
            sort_order,
            db.now(),
        ),
    )

    db.touch_project(project_id)

    return video_id


# ============================================================
# テンプレート用 filter
# ============================================================

# ジャンル／担当者のラベルに割り当てる色数。style.css の .pill-c0〜 と揃える。
PILL_COLOR_COUNT = 12


def _color_map(column: str, offset: int = 0) -> dict:
    """
    値ごとに色番号を割り当てた辞書を返す。

    文字列のハッシュで決めると、値が少ないうちは衝突しやすく
    （実際に「テスト」と「給付金」が同じ色になった）、
    「違うジャンルは違う色」という肝心の要件を満たせない。

    そこで「先に登場した順」に色を配っていく。こうすると
      ・種類が色数以内なら必ず別の色になる
      ・後から新しい値が増えても、既存の値の色は変わらない
        （並び順ではなく最初に現れた id を基準にしているため）
    という両方が成り立つ。
    """
    rows = db.query(
        f"""
        SELECT {column} AS value, MIN(id) AS first_id
        FROM projects
        WHERE TRIM({column}) <> ''
        GROUP BY {column}
        ORDER BY first_id
        """
    )

    return {
        r["value"]: (i + offset) % PILL_COLOR_COUNT
        for i, r in enumerate(rows)
    }


@app.template_filter("mmss")
def mmss(value):

    try:
        seconds = float(value)
    except (
        TypeError,
        ValueError,
    ):
        return "--:--"

    minutes = int(seconds // 60)
    remain = int(seconds % 60)

    return (
        f"{minutes:02d}:"
        f"{remain:02d}"
    )


# ============================================================
# 案件一覧
# ============================================================
@app.get("/")
def index():

    # version_labels は「この案件が持つバージョン名」を , 区切りで並べたもの。
    # 画面側のバージョン絞り込みで使う。
    projects = db.query(
        """
        SELECT
            p.*,
            COUNT(v.id) AS video_count,
            COALESCE(
                GROUP_CONCAT(v.version_label, ','),
                ''
            ) AS version_labels
        FROM projects p
        LEFT JOIN videos v
            ON v.project_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
        """
    )

    genres = db.query(
        """
        SELECT DISTINCT genre
        FROM projects
        WHERE TRIM(genre) <> ''
        ORDER BY genre COLLATE NOCASE
        """
    )

    assignees = db.query(
        """
        SELECT DISTINCT assignee
        FROM projects
        WHERE TRIM(assignee) <> ''
        ORDER BY assignee COLLATE NOCASE
        """
    )

    return render_template(
        "index.html",
        projects=projects,
        genres=genres,
        assignees=assignees,
        genre_colors=_color_map("genre"),
        # 担当者はずらしておく。同じ行でジャンルと同じ色が並ぶのを避ける。
        assignee_colors=_color_map("assignee", offset=6),
    )


def _backfill_slugs() -> None:
    """slug がまだ入っていない既存案件に、起動時に一度だけ割り当てる。"""
    rows = db.query(
        "SELECT id, name, project_no FROM projects WHERE TRIM(slug) = ''"
    )

    for r in rows:
        db.execute(
            "UPDATE projects SET slug = ? WHERE id = ?",
            (make_slug(r["name"], r["project_no"], r["id"]), r["id"]),
        )

    if rows:
        logging.getLogger("app").info(
            "%s 件の案件にパーマリンクを割り当てました", len(rows)
        )


_backfill_slugs()


# ============================================================
# 動画が無い案件に、あとから動画を足す
# ============================================================

@app.post("/projects/<int:project_id>/video")
def add_video(project_id: int):

    project = db.query(
        "SELECT * FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if project is None:
        abort(404)

    file = request.files.get("video")

    video_url = (
        request.form.get("video_url") or ""
    ).strip()

    has_file = bool(file and file.filename)

    if has_file and video_url:
        return _error_page(
            "ファイルとリンクの両方が指定されています。"
            "どちらか一方にしてください。"
        )

    if has_file:
        err = _validate_upload(file)
    elif video_url:
        err = _validate_video_url(video_url)
    else:
        err = "動画ファイルを選ぶか、動画のリンクを入力してください。"

    if err:
        return _error_page(err)

    # 空の表を先に作っている場合は、その器へ動画を入れる。
    # 新しい動画レコードを足すと、書き込み済みの下書きが取り残される。
    draft = db.query(
        """
        SELECT id
        FROM videos
        WHERE project_id = ?
          AND status = 'none'
        ORDER BY id
        LIMIT 1
        """,
        (project_id,),
        one=True,
    )

    if draft is not None:

        video_id = draft["id"]

        if has_file:
            config.ensure_dirs()
            videos_dir = Path(config.VIDEO_DIR)
            videos_dir.mkdir(parents=True, exist_ok=True)

            suffix = Path(file.filename or "video").suffix.lower()
            path = videos_dir / f"{uuid.uuid4().hex}{suffix}"
            file.save(path)

            db.execute(
                """
                UPDATE videos
                SET original_name = ?, file_path = ?, source_url = '',
                    status = 'queued', progress = 0,
                    stage = '準備しています', error_message = NULL
                WHERE id = ?
                """,
                (file.filename or "video", str(path), video_id),
            )
        else:
            from urllib.parse import unquote, urlparse

            db.execute(
                """
                UPDATE videos
                SET original_name = ?, file_path = '', source_url = ?,
                    status = 'queued', progress = 0,
                    stage = 'ダウンロードを待っています', error_message = NULL
                WHERE id = ?
                """,
                (
                    Path(unquote(urlparse(video_url).path)).name or "video.mp4",
                    video_url,
                    video_id,
                ),
            )

        db.touch_project(project_id)

    else:

        row = db.query(
            """
            SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
            FROM videos
            WHERE project_id = ?
            """,
            (project_id,),
            one=True,
        )

        sort_order = row["next_order"] if row else 0

        if has_file:
            video_id = _store_video(
                project_id, "初稿", file, sort_order=sort_order
            )
        else:
            video_id = _store_video_url(
                project_id, "初稿", video_url, sort_order=sort_order
            )

    jobs.start(video_id)

    return redirect(
        _project_url(project_id, video_id)
    )


# ============================================================
# スクリーンショットの削除（ゴミ箱方式）
# ============================================================

def _trash_path(image_path: str) -> Path:
    """ゴミ箱側での置き場所。screenshots/ 以下の構造をそのまま保つ。"""
    src = Path(image_path)

    try:
        rel = src.relative_to(config.SHOT_DIR)
    except ValueError:
        rel = Path(src.name)

    return Path(config.TRASH_DIR) / rel


def _is_shared_image(image_path: str, shot_id: int) -> bool:
    """同じ画像ファイルを、他の行も使っているか。"""
    row = db.query(
        """
        SELECT COUNT(*) AS n
        FROM screenshots
        WHERE image_path = ?
          AND id <> ?
          AND deleted_at = ''
        """,
        (image_path, shot_id),
        one=True,
    )

    return bool(row and row["n"])


def _move_to_trash(image_path: str, shot_id: int = 0) -> bool:
    """
    画像をゴミ箱へ移す。消さずに残すので、あとから戻せる。

    「コピーを作成」で作った案件は、元の案件と同じ画像ファイルを見ている。
    片方で行を消したときにファイルまで動かすと、もう片方の画像が
    消えてしまうので、他に使っている行があれば動かさない。
    """
    if not image_path:
        return False

    if shot_id and _is_shared_image(image_path, shot_id):
        return False

    src = Path(image_path)

    if not src.is_file():
        return False

    dst = _trash_path(image_path)

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            dst.unlink()
        src.replace(dst)
        return True
    except OSError as exc:
        logging.getLogger("app").warning(
            "ゴミ箱へ移せませんでした: %s (%s)", image_path, exc
        )
        return False


def _restore_from_trash(image_path: str) -> bool:
    if not image_path:
        return False

    src = _trash_path(image_path)
    dst = Path(image_path)

    if not src.is_file():
        return False

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
        return True
    except OSError as exc:
        logging.getLogger("app").warning(
            "ゴミ箱から戻せませんでした: %s (%s)", image_path, exc
        )
        return False


def _renumber(video_id: int) -> int:
    """残っている行の # を 1 から振り直す。"""
    rows = db.query(
        """
        SELECT id
        FROM screenshots
        WHERE video_id = ?
          AND deleted_at = ''
        ORDER BY seq ASC, id ASC
        """,
        (video_id,),
    )

    for i, row in enumerate(rows, start=1):
        db.execute(
            "UPDATE screenshots SET seq = ? WHERE id = ?",
            (i, row["id"]),
        )

    return len(rows)

@app.post("/api/screenshots/delete")
def delete_screenshots():
    """
    選択された行（スクリーンショット）を削除する。

    画像ファイルも一緒に消す。DB の行だけ消えて画像が residual として
    残り続けるのを避けるため、両方をここでまとめて片付ける。
    """
    data = request.get_json(silent=True) or {}

    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify(
            ok=False,
            error="削除する行が指定されていません。",
        ), 400

    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return jsonify(ok=False, error="行の指定が不正です。"), 400

    placeholders = ",".join("?" for _ in ids)

    shots = db.query(
        f"""
        SELECT id, video_id, image_path
        FROM screenshots
        WHERE id IN ({placeholders})
          AND deleted_at = ''
        """,
        ids,
    )

    if not shots:
        return jsonify(ok=False, error="対象が見つかりませんでした。"), 404

    video_id = shots[0]["video_id"]

    # 画像は消さずにゴミ箱へ移す。あとから「元に戻す」ができるようにするため。
    moved = 0

    for row in shots:
        if _move_to_trash(row["image_path"], row["id"]):
            moved += 1

    db.execute(
        f"""
        UPDATE screenshots
        SET deleted_at = ?
        WHERE id IN ({placeholders})
        """,
        [db.now()] + ids,
    )

    _renumber(video_id)

    logging.getLogger("app").info(
        "スクリーンショット %s 行をゴミ箱へ移しました（画像 %s 件）",
        len(shots),
        moved,
    )

    return jsonify(
        ok=True,
        deleted=len(shots),
        files=moved,
        ids=ids,
    )


@app.post("/api/videos/<int:video_id>/rows")
def add_row(video_id: int):
    """表の一番下に空の行を1つ足す。"""
    video = db.query(
        "SELECT id FROM videos WHERE id = ?",
        (video_id,),
        one=True,
    )

    if video is None:
        return jsonify(ok=False, error="動画が見つかりません。"), 404

    row = db.query(
        """
        SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
        FROM screenshots
        WHERE video_id = ?
          AND deleted_at = ''
        """,
        (video_id,),
        one=True,
    )

    seq = row["next_seq"] if row else 1

    shot_id = db.execute(
        """
        INSERT INTO screenshots
            (video_id, seq, image_path, timestamp_sec, updated_at)
        VALUES (?, ?, '', 0, ?)
        """,
        (video_id, seq, db.now()),
    )

    return jsonify(ok=True, id=shot_id, seq=seq)


def _insert_position(video_id: int, at: float) -> int:
    """
    撮った秒数から、何行目に入れるかを決める。

    0:30 で撮ったら 0:28 と 0:31 の間、というふうに、
    いまの並びの中で秒数が自分より後になる最初の行の手前に入れる。

    ・秒数の入っていない行（＋で足した空の行）は目印にしない。
      すべて 0 秒なので、これを見ると先頭に寄ってしまう。
    ・当てはまる行が無ければ、一番下に足す。
    """
    rows = db.query(
        """
        SELECT seq, timestamp_sec, image_path
        FROM screenshots
        WHERE video_id = ?
          AND deleted_at = ''
        ORDER BY seq ASC, id ASC
        """,
        (video_id,),
    )

    position = len(rows) + 1

    for index, row in enumerate(rows, start=1):

        # 中身のある行だけを見る
        if not row["image_path"] and not row["timestamp_sec"]:
            continue

        if (row["timestamp_sec"] or 0) > at:
            position = index
            break

    return position


@app.post("/api/videos/<int:video_id>/capture")
def capture_frame(video_id: int):
    """
    動画プレイヤーで見ている場面を、そのまま1行として足す。

    画像はブラウザ側で作って送ってくる（video を canvas に描いたもの）。
    サーバーで動画を開き直すより速く、見えているものとずれない。
    """
    video = db.query(
        "SELECT id FROM videos WHERE id = ?",
        (video_id,),
        one=True,
    )

    if video is None:
        return jsonify(ok=False, error="動画が見つかりません。"), 404

    image = request.files.get("image")

    if image is None or not image.filename:
        return jsonify(ok=False, error="画像がありません。"), 400

    try:
        at = float(request.form.get("t") or 0)
    except ValueError:
        at = 0.0

    at = max(0.0, at)

    seq = _insert_position(video_id, at)

    folder = config.SHOT_DIR / str(video_id)
    folder.mkdir(parents=True, exist_ok=True)

    # auto_screenshot.py は「1.jpg」のような連番だけを消す。
    # 手で撮ったものが巻き込まれないよう、別の名前にしておく。
    name = f"m{seq}-{uuid.uuid4().hex[:8]}.jpg"
    path = folder / name

    image.save(path)

    if not path.is_file() or path.stat().st_size == 0:
        return jsonify(ok=False, error="画像を保存できませんでした。"), 500

    # 差し込む場所から下を1つずつ後ろへずらす
    db.execute(
        """
        UPDATE screenshots
        SET seq = seq + 1
        WHERE video_id = ?
          AND deleted_at = ''
          AND seq >= ?
        """,
        (video_id, seq),
    )

    shot_id = db.execute(
        """
        INSERT INTO screenshots
            (video_id, seq, image_path, timestamp_sec, is_manual, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
        """,
        (video_id, seq, str(path), at, db.now()),
    )

    logging.getLogger("app").info(
        "場面を追加しました: video=%s shot=%s %.2f秒 → %s行目",
        video_id,
        shot_id,
        at,
        seq,
    )

    return jsonify(
        ok=True,
        id=shot_id,
        seq=seq,
        timestamp_sec=at,
        time_label=mmss(at),
        url=url_for("media_shot", shot_id=shot_id),
    )


@app.post("/api/videos/<int:video_id>/reorder")
def reorder_rows(video_id: int):
    """
    行の並べ替え。送られてきた順に番号を振り直す。
    """
    data = request.get_json(silent=True) or {}

    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify(ok=False, error="並び順がありません。"), 400

    rows = db.query(
        """
        SELECT id
        FROM screenshots
        WHERE video_id = ?
          AND deleted_at = ''
        """,
        (video_id,),
    )

    current = sorted(r["id"] for r in rows)

    if sorted(ids) != current:
        return jsonify(ok=False, error="表の中身が変わっています。"), 409

    for index, shot_id in enumerate(ids, start=1):
        db.execute(
            "UPDATE screenshots SET seq = ? WHERE id = ?",
            (index, shot_id),
        )

    return jsonify(ok=True, count=len(ids))


@app.post("/api/screenshots/<int:shot_id>/insert-after")
def insert_row_after(shot_id: int):
    """この行のすぐ下に、空の行を1つ差し込む。"""

    shot = db.query(
        """
        SELECT id, video_id, seq
        FROM screenshots
        WHERE id = ?
          AND deleted_at = ''
        """,
        (shot_id,),
        one=True,
    )

    if shot is None:
        return jsonify(ok=False, error="行が見つかりません。"), 404

    video_id = shot["video_id"]
    seq = shot["seq"] + 1

    # 差し込む場所から下を1つずつ後ろへずらす
    db.execute(
        """
        UPDATE screenshots
        SET seq = seq + 1
        WHERE video_id = ?
          AND deleted_at = ''
          AND seq >= ?
        """,
        (video_id, seq),
    )

    new_id = db.execute(
        """
        INSERT INTO screenshots
            (video_id, seq, image_path, timestamp_sec, is_manual, updated_at)
        VALUES (?, ?, '', 0, 1, ?)
        """,
        (video_id, seq, db.now()),
    )

    return jsonify(ok=True, id=new_id, seq=seq)


@app.post("/api/screenshots/restore")
def restore_screenshots():
    """ゴミ箱へ移した行を元に戻す。"""
    data = request.get_json(silent=True) or {}

    ids = data.get("ids")

    if not isinstance(ids, list) or not ids:
        return jsonify(ok=False, error="戻す行が指定されていません。"), 400

    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return jsonify(ok=False, error="行の指定が不正です。"), 400

    placeholders = ",".join("?" for _ in ids)

    shots = db.query(
        f"""
        SELECT id, video_id, image_path
        FROM screenshots
        WHERE id IN ({placeholders})
          AND deleted_at <> ''
        """,
        ids,
    )

    if not shots:
        return jsonify(ok=False, error="戻せる行がありませんでした。"), 404

    restored = 0

    for row in shots:
        if _restore_from_trash(row["image_path"]):
            restored += 1

    db.execute(
        f"""
        UPDATE screenshots
        SET deleted_at = ''
        WHERE id IN ({placeholders})
        """,
        ids,
    )

    _renumber(shots[0]["video_id"])

    logging.getLogger("app").info(
        "スクリーンショット %s 行を元に戻しました", len(shots)
    )

    return jsonify(ok=True, restored=len(shots), files=restored)


# ============================================================
# ジャンル別 / 担当者別の一覧
# ============================================================

def _filtered_project_list(kind: str, column: str, value: str, label: str):
    """
    ジャンル別・担当者別の一覧を作る。中身は同じなので共通化する。

    kind   … 'genre' / 'assignee'（画面側で「自分の項目」を隠すのに使う）
    column … 絞り込みに使う列名
    value  … その値
    """
    value = (value or "").strip()

    projects = db.query(
        f"""
        SELECT
            p.*,
            COUNT(v.id) AS video_count
        FROM projects p
        LEFT JOIN videos v
            ON v.project_id = p.id
        WHERE p.{column} = ?
        GROUP BY p.id
        ORDER BY p.created_at DESC
        """,
        (value,),
    )

    if not projects:
        return _error_page(
            f"{label}「{value}」の案件は見つかりませんでした。",
            404,
        )

    # 絞り込みの候補は、この一覧に実際に出てくる値だけにする
    genres = sorted(
        {p["genre"] for p in projects if (p["genre"] or "").strip()}
    )
    assignees = sorted(
        {p["assignee"] for p in projects if (p["assignee"] or "").strip()}
    )

    colors = _color_map(column, offset=0 if kind == "genre" else 6)

    return render_template(
        "project_list.html",
        page_kind=kind,
        page_value=value,
        page_color=colors.get(value, 0),
        projects=projects,
        genres=genres,
        assignees=assignees,
        genre_colors=_color_map("genre"),
        assignee_colors=_color_map("assignee", offset=6),
    )


@app.get("/genres/<path:genre>")
def genre_page(genre: str):
    return _filtered_project_list(
        "genre",
        "genre",
        genre,
        "ジャンル",
    )


@app.get("/assignees/<path:assignee>")
def assignee_page(assignee: str):
    return _filtered_project_list(
        "assignee",
        "assignee",
        assignee,
        "担当者",
    )


# ============================================================
# 分析／転用の切り分け
#
# 表は「フィードバックメモ」と「テキスト」の間で左右に分かれている。
# 左（reference-group）＝参考動画を見て分析するところ、
# 右（result-group）＝それを自分の動画に転用するところ。
# 作業時間もこの区切りで数える。
# ============================================================

ANALYSIS_FIELDS = (
    "reference_role",
    "material_feature",
    "improvement_note",
    "reference_feedback",
)

REUSE_FIELDS = (
    "text_raw",
    "material",
    "role",
    "scene_feeling",
    "feedback",
)

SIDES = ("analysis", "reuse", "other")

SIDE_LABELS = {
    "analysis": "分析",
    "reuse": "転用",
    "other": "その他",
    "total": "合計",
}


# ============================================================
# 進捗ボード
# ============================================================

BOARD_STATUSES = (
    ("todo", "取組前"),
    ("doing", "いまやってる中"),
    ("waiting", "FB待ち"),
    ("done", "完全にdone"),
)

BOARD_STATUS_KEYS = {key for key, _ in BOARD_STATUSES}


def _work_seconds_by_project() -> dict:
    """案件ごとの作業秒数。{project_id: {analysis, reuse, other, total}}"""

    rows = db.query(
        """
        SELECT project_id, side, SUM(seconds) AS s
        FROM work_time
        GROUP BY project_id, side
        """
    )

    out: dict = {}

    for row in rows:
        entry = out.setdefault(
            row["project_id"],
            {"analysis": 0, "reuse": 0, "other": 0, "total": 0},
        )
        if row["side"] in entry:
            entry[row["side"]] = row["s"] or 0
        entry["total"] += row["s"] or 0

    return out


def _hhmm(seconds: int) -> str:
    """秒を「1時間20分」の形にする。1分未満は「1分未満」。"""

    seconds = int(seconds or 0)

    if seconds <= 0:
        return "—"

    if seconds < 60:
        return "1分未満"

    hours, rest = divmod(seconds, 3600)
    minutes = rest // 60

    if hours and minutes:
        return f"{hours}時間{minutes}分"

    if hours:
        return f"{hours}時間"

    return f"{minutes}分"


# ============================================================
# 目標値の設定
# ============================================================

DEFAULT_SETTINGS = {
    # 1か月に完成させたい件数
    "monthly_target": "20",
    # 1案件あたりの目標時間（秒）
    "target_analysis": str(2 * 3600),
    "target_reuse": str(3 * 3600),
}


def get_settings() -> dict:
    values = dict(DEFAULT_SETTINGS)

    for row in db.query("SELECT key, value FROM settings"):
        if row["key"] in values:
            values[row["key"]] = row["value"]

    out = {}

    for key, value in values.items():
        try:
            out[key] = int(float(value))
        except (TypeError, ValueError):
            out[key] = int(DEFAULT_SETTINGS[key])

    out["target_total"] = out["target_analysis"] + out["target_reuse"]

    return out


@app.post("/api/settings")
def update_settings():

    data = request.get_json(silent=True) or {}

    saved = {}

    for key in DEFAULT_SETTINGS:

        if key not in data:
            continue

        try:
            value = max(0, int(float(data[key])))
        except (TypeError, ValueError):
            return jsonify(ok=False, error=f"{key} の値が数字ではありません。"), 400

        db.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, str(value), db.now()),
        )

        saved[key] = value

    return jsonify(ok=True, saved=saved)


# ============================================================
# メンバー別・ボトルネック
# ============================================================

def _month_key(when: str) -> str:
    return (when or "")[:7]


def _project_owner_map() -> dict:
    """
    案件ごとの担当ユーザー。

    owner_user_id が入っていればそれ。
    入っていない案件は「その案件に一番長く時間をかけた人」を担当とみなす。
    どちらも無ければ未割当。
    """
    owners = {}

    for row in db.query("SELECT id, owner_user_id FROM projects"):
        owners[row["id"]] = row["owner_user_id"] or 0

    top = db.query(
        """
        SELECT project_id, user_id, SUM(seconds) AS s
        FROM work_time
        GROUP BY project_id, user_id
        ORDER BY s DESC
        """
    )

    for row in top:
        if not owners.get(row["project_id"]):
            owners[row["project_id"]] = row["user_id"] or 0

    return owners


def _member_stats():
    """メンバーごとの完成数と平均時間。"""

    users = {
        row["id"]: (
            row["display_name"] or (row["username"] or "").split("@")[0]
        )
        for row in db.query("SELECT id, username, display_name FROM users")
    }

    owners = _project_owner_map()

    projects = db.query("SELECT id, status FROM projects")
    status_of = {p["id"]: (p["status"] or "todo") for p in projects}

    work = _work_seconds_by_project()

    per_user = {}

    for pid, owner in owners.items():

        if pid not in status_of:
            continue

        entry = per_user.setdefault(
            owner,
            {
                "user_id": owner,
                "name": users.get(owner, "未割当"),
                "done": 0,
                "total_projects": 0,
                "analysis": 0,
                "reuse": 0,
                "measured": 0,
            },
        )

        entry["total_projects"] += 1

        if status_of[pid] == "done":
            entry["done"] += 1

        times = work.get(pid)

        if times and times["total"]:
            entry["analysis"] += times["analysis"]
            entry["reuse"] += times["reuse"]
            entry["measured"] += 1

    rows = []

    for entry in per_user.values():

        n = entry["measured"] or 1

        rows.append(
            {
                **entry,
                "avg_analysis": entry["analysis"] // n,
                "avg_reuse": entry["reuse"] // n,
                "avg_total": (entry["analysis"] + entry["reuse"]) // n,
            }
        )

    rows.sort(key=lambda r: (-r["done"], r["name"]))

    return rows


def _feedback_load():
    """
    案件ごとの「指摘の多さ」。

    修正回数そのものは記録していないので、
    フィードバック欄が書かれた行の数を代わりの目安にする。
    """
    rows = db.query(
        """
        SELECT p.id, p.name, p.slug, p.project_no, p.status, p.status_at,
               COUNT(s.id) AS rows_total,
               SUM(
                   CASE WHEN TRIM(s.reference_feedback) <> ''
                          OR TRIM(s.feedback) <> ''
                          OR TRIM(s.improvement_note) <> ''
                   THEN 1 ELSE 0 END
               ) AS noted
        FROM projects p
        JOIN videos v ON v.project_id = p.id
        JOIN screenshots s ON s.video_id = v.id AND s.deleted_at = ''
        GROUP BY p.id
        ORDER BY noted DESC
        """
    )

    out = []

    for r in rows:
        total = r["rows_total"] or 0
        noted = r["noted"] or 0

        out.append(
            {
                "row": r,
                "rows_total": total,
                "noted": noted,
                "rate": round(noted * 100 / total, 1) if total else 0.0,
            }
        )

    return out


@app.get("/board")
def board_page():

    projects = db.query(
        """
        SELECT p.*, COUNT(v.id) AS video_count
        FROM projects p
        LEFT JOIN videos v ON v.project_id = p.id
        GROUP BY p.id
        ORDER BY p.board_order, p.updated_at DESC
        """
    )

    work = _work_seconds_by_project()

    columns = []

    for key, label in BOARD_STATUSES:

        cards = []

        for p in projects:

            if (p["status"] or "todo") != key:
                continue

            times = work.get(p["id"], {})

            cards.append(
                {
                    "row": p,
                    "analysis": times.get("analysis", 0),
                    "reuse": times.get("reuse", 0),
                    "total": times.get("total", 0),
                }
            )

        columns.append({"key": key, "label": label, "cards": cards})

    # 平均は「作業時間が記録されている案件」だけで出す。
    # 触っていない案件を混ぜると、平均がいくらでも下がってしまう。
    measured = [v for v in work.values() if v["total"] > 0]

    done_measured = [
        work[p["id"]]
        for p in projects
        if (p["status"] or "todo") == "done" and work.get(p["id"], {}).get("total")
    ]

    def _avg(items, key):
        if not items:
            return 0
        return int(sum(i[key] for i in items) / len(items))

    summary = {
        "measured_count": len(measured),
        "avg_analysis": _avg(measured, "analysis"),
        "avg_reuse": _avg(measured, "reuse"),
        "avg_total": _avg(measured, "total"),
        "done_count": len(done_measured),
        "avg_done_total": _avg(done_measured, "total"),
    }

    # ---- 月間目標 ----
    settings = get_settings()

    this_month = db.now()[:7]

    done_this_month = sum(
        1
        for p in projects
        if (p["status"] or "todo") == "done"
        and _month_key(p["status_at"]) == this_month
    )

    target = settings["monthly_target"] or 0

    goal = {
        "month": this_month,
        "target": target,
        "done": done_this_month,
        "rate": min(100, int(done_this_month * 100 / target)) if target else 0,
        "left": max(0, target - done_this_month),
    }

    counts = {
        "total": len(projects),
        "todo": sum(1 for p in projects if (p["status"] or "todo") == "todo"),
        "doing": sum(1 for p in projects if p["status"] == "doing"),
        "waiting": sum(1 for p in projects if p["status"] == "waiting"),
        "done": sum(1 for p in projects if p["status"] == "done"),
    }

    counts["open"] = counts["total"] - counts["done"]

    return render_template(
        "board.html",
        columns=columns,
        summary=summary,
        goal=goal,
        counts=counts,
        settings=settings,
        hhmm=_hhmm,
        genre_colors=_color_map("genre"),
        assignee_colors=_color_map("assignee", offset=6),
    )


@app.post("/api/projects/<int:project_id>/status")
def update_project_status(project_id: int):

    data = request.get_json(silent=True) or {}

    status = (data.get("status") or "").strip()

    if status not in BOARD_STATUS_KEYS:
        return jsonify({"ok": False, "error": "不明な状態です"}), 400

    project = db.query(
        "SELECT id FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if project is None:
        return jsonify({"ok": False, "error": "案件がありません"}), 404

    order = data.get("order")

    db.execute(
        """
        UPDATE projects
        SET status = ?, status_at = ?, board_order = ?
        WHERE id = ?
        """,
        (
            status,
            db.now(),
            int(order) if isinstance(order, int) else 0,
            project_id,
        ),
    )

    return jsonify({"ok": True, "status": status})


@app.post("/api/board/order")
def update_board_order():
    """列の中の並び順をまとめて保存する。"""

    data = request.get_json(silent=True) or {}

    ids = data.get("ids")

    if not isinstance(ids, list):
        return jsonify({"ok": False, "error": "並び順がありません"}), 400

    for index, pid in enumerate(ids):

        if not isinstance(pid, int):
            continue

        db.execute(
            "UPDATE projects SET board_order = ? WHERE id = ?",
            (index, pid),
        )

    return jsonify({"ok": True})


# ============================================================
# 作業時間
# ============================================================

@app.post("/api/worktime")
def record_worktime():
    """
    画面を触っていた秒数を受け取って足しこむ。

    ブラウザ側が15秒ごと（と離れるとき）に送ってくる。
    """

    data = request.get_json(silent=True) or {}

    project_id = data.get("project_id")

    if not isinstance(project_id, int):
        return jsonify({"ok": False, "error": "案件がありません"}), 400

    user = auth.current_user()
    user_id = user["id"] if user else 0

    day = db.now()[:10]

    saved = 0

    for side in SIDES:

        seconds = data.get(side)

        if not isinstance(seconds, (int, float)) or seconds <= 0:
            continue

        # 送信間隔よりあきらかに大きい値は捨てる（時計のずれ・改ざん対策）
        seconds = min(int(seconds), 600)

        db.execute(
            """
            INSERT INTO work_time
                (project_id, user_id, side, day, seconds, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, user_id, side, day)
            DO UPDATE SET
                seconds = seconds + excluded.seconds,
                updated_at = excluded.updated_at
            """,
            (project_id, user_id, side, day, seconds, db.now()),
        )

        saved += seconds

    return jsonify({"ok": True, "saved": saved})


@app.get("/report")
def report_page():

    projects = db.query(
        """
        SELECT id, genre, name, project_no, slug, assignee, status
        FROM projects
        ORDER BY name COLLATE NOCASE
        """
    )

    work = _work_seconds_by_project()

    rows = []

    for p in projects:

        times = work.get(
            p["id"], {"analysis": 0, "reuse": 0, "other": 0, "total": 0}
        )

        if not times["total"]:
            continue

        rows.append({"row": p, **times})

    rows.sort(key=lambda r: r["total"], reverse=True)

    total = {
        "analysis": sum(r["analysis"] for r in rows),
        "reuse": sum(r["reuse"] for r in rows),
        "other": sum(r["other"] for r in rows),
    }
    total["total"] = total["analysis"] + total["reuse"] + total["other"]

    count = len(rows) or 1

    average = {
        "analysis": total["analysis"] // count,
        "reuse": total["reuse"] // count,
        "other": total["other"] // count,
        "total": total["total"] // count,
    }

    # 日ごとの推移（直近14日）
    daily = db.query(
        """
        SELECT day, side, SUM(seconds) AS s
        FROM work_time
        GROUP BY day, side
        ORDER BY day DESC
        LIMIT 60
        """
    )

    by_day: dict = {}

    for d in daily:
        entry = by_day.setdefault(
            d["day"], {"analysis": 0, "reuse": 0, "other": 0, "total": 0}
        )
        if d["side"] in entry:
            entry[d["side"]] = d["s"] or 0
        entry["total"] += d["s"] or 0

    days = sorted(by_day.items(), reverse=True)[:14]

    settings = get_settings()

    members = _member_stats()

    team = {
        "done": sum(m["done"] for m in members),
        "avg_analysis": (
            sum(m["avg_analysis"] for m in members) // len(members)
            if members else 0
        ),
        "avg_reuse": (
            sum(m["avg_reuse"] for m in members) // len(members)
            if members else 0
        ),
        "avg_total": (
            sum(m["avg_total"] for m in members) // len(members)
            if members else 0
        ),
    }

    member_max = max(
        [m["avg_analysis"] for m in members]
        + [m["avg_reuse"] for m in members]
        + [1]
    )

    # ---- ボトルネック ----
    slower = "reuse" if average["reuse"] >= average["analysis"] else "analysis"

    bottleneck = {
        "side": slower,
        "label": SIDE_LABELS[slower],
        "seconds": average[slower],
        "share": (
            int(average[slower] * 100 / average["total"])
            if average["total"] else 0
        ),
        "target": settings["target_" + slower],
        "over": average[slower] - settings["target_" + slower],
    }

    goals = []

    for key in ("analysis", "reuse", "total"):
        target = settings["target_" + key] if key != "total" else settings["target_total"]
        actual = average[key]

        goals.append(
            {
                "key": key,
                "label": SIDE_LABELS.get(key, "合計"),
                "target": target,
                "actual": actual,
                "diff": actual - target,
                "rate": int(actual * 100 / target) if target else 0,
            }
        )

    return render_template(
        "report.html",
        rows=rows,
        total=total,
        average=average,
        measured=len(rows),
        days=days,
        day_max=max([v["total"] for _, v in days], default=1) or 1,
        members=members,
        team=team,
        member_max=member_max,
        bottleneck=bottleneck,
        goals=goals,
        settings=settings,
        loads=_feedback_load(),
        hhmm=_hhmm,
        genre_colors=_color_map("genre"),
        assignee_colors=_color_map("assignee", offset=6),
    )


# ============================================================
# 共通フィードバックのノート
# ============================================================

NOTE_FIELDS = (
    ("reference_feedback", "フィードバックメモ（分析）"),
    ("feedback", "フィードバックメモ（転用）"),
    ("improvement_note", "備考・改善案"),
)


def _normalize_note(line: str) -> str:
    """
    集計用に文字をそろえる。

    表記ゆれを全部吸収するのは無理なので、
    「前後の空白・記号・全角半角・大文字小文字」だけをそろえる。
    """
    import unicodedata

    text = unicodedata.normalize("NFKC", line).strip()

    # 行頭の箇条書き記号を落とす
    text = text.lstrip("・-*—–ー 　\t")

    # 末尾の句点や記号
    text = text.rstrip("。.、,！!？? 　\t")

    return text.casefold()


# ============================================================
# ガイドライン
# ============================================================

def _guidelines(status: str = "active"):
    return db.query(
        """
        SELECT *
        FROM guidelines
        WHERE status = ?
        ORDER BY sort_order ASC, id ASC
        """,
        (status,),
    )


@app.post("/api/guidelines")
def add_guideline():
    """共通ノートで見つけた指摘を、ガイドラインとして採用する。"""

    data = request.get_json(silent=True) or {}

    text = (data.get("text") or "").strip()

    if not text:
        return jsonify(ok=False, error="内容がありません。"), 400

    if len(text) > 500:
        return jsonify(ok=False, error="長すぎます（500文字まで）。"), 400

    same = db.query(
        "SELECT id FROM guidelines WHERE text = ? AND status = 'active'",
        (text,),
        one=True,
    )

    if same:
        return jsonify(ok=False, error="すでに入っています。"), 409

    user = auth.current_user()

    order = db.query(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM guidelines",
        one=True,
    )

    gid = db.execute(
        """
        INSERT INTO guidelines
            (text, source, seen, status, sort_order, created_by, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
        """,
        (
            text,
            (data.get("source") or "").strip()[:500],
            int(data.get("seen") or 0),
            order["n"] if order else 1,
            user["id"] if user else 0,
            db.now(),
        ),
    )

    return jsonify(ok=True, id=gid)


@app.post("/api/guidelines/<int:guideline_id>/delete")
def drop_guideline(guideline_id: int):

    row = db.query(
        "SELECT id FROM guidelines WHERE id = ?", (guideline_id,), one=True
    )

    if row is None:
        return jsonify(ok=False, error="見つかりません。"), 404

    db.execute("DELETE FROM guidelines WHERE id = ?", (guideline_id,))

    return jsonify(ok=True)


@app.post("/api/guidelines/draft")
def draft_guidelines():
    """
    共通フィードバックから、ガイドラインの文案を作る。

    文章にまとめるところだけ Claude に任せる。
    API キー（ANTHROPIC_API_KEY）が入っていないときは、
    課金が起きないよう何もせずに断る。
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()

    if not key:
        return jsonify(
            ok=False,
            error=(
                "AI で文章にまとめるには、Anthropic の API キーが要ります。"
                "環境変数 ANTHROPIC_API_KEY を設定してから起動してください。"
            ),
        ), 400

    data = request.get_json(silent=True) or {}

    items = data.get("items")

    if not isinstance(items, list) or not items:
        return jsonify(ok=False, error="材料がありません。"), 400

    lines = []

    for item in items[:40]:
        text = str(item.get("text", "")).strip()[:200]
        count = int(item.get("count") or 0)

        if text:
            lines.append(f"- {text}（{count}件の案件で指摘）")

    if not lines:
        return jsonify(ok=False, error="材料がありません。"), 400

    prompt = (
        "あなたは動画広告の制作チームの編集者です。\n"
        "以下は、複数の案件で繰り返し出てきたフィードバックです。\n"
        "これを、制作前に読むガイドラインの文章にまとめてください。\n\n"
        "条件:\n"
        "- 元の指摘に書かれていないことは足さない。"
        "数値や基準を勝手に作らない。\n"
        "- 1項目1行、箇条書き。多くても8項目。\n"
        "- 「〜する」「〜しない」の形で、作業者が判断できる書き方にする。\n"
        "- 前置きや結びの文はいらない。箇条書きだけ返す。\n\n"
        "繰り返し出てきた指摘:\n" + "\n".join(lines)
    )

    try:
        import anthropic
    except ImportError:
        return jsonify(
            ok=False,
            error="anthropic が入っていません。pip install anthropic を実行してください。",
        ), 500

    try:
        client = anthropic.Anthropic(api_key=key)

        reply = client.messages.create(
            model=os.environ.get("VR_AI_MODEL", "claude-sonnet-5"),
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )

        text = "".join(
            part.text for part in reply.content if getattr(part, "type", "") == "text"
        )

    except Exception as exc:
        logging.getLogger("app").warning("ガイドライン生成に失敗: %s", exc)
        return jsonify(ok=False, error=f"AI から返事がありません（{exc}）"), 502

    drafts = [
        line.strip().lstrip("-・*　 ").strip()
        for line in text.splitlines()
        if line.strip()
    ]

    return jsonify(ok=True, drafts=[d for d in drafts if d][:8])


@app.get("/notes")
def notes_page():

    selected = request.args.getlist("field") or [f for f, _ in NOTE_FIELDS]
    selected = [f for f in selected if f in dict(NOTE_FIELDS)]

    try:
        threshold = max(2, int(request.args.get("n", 2)))
    except ValueError:
        threshold = 2

    columns = ", ".join(f"s.{f}" for f in selected)

    rows = db.query(
        f"""
        SELECT p.id AS project_id, p.name AS project_name,
               p.slug AS slug, p.project_no AS project_no,
               p.copied_from AS copied_from,
               {columns}
        FROM screenshots s
        JOIN videos v ON v.id = s.video_id
        JOIN projects p ON p.id = v.project_id
        WHERE s.deleted_at = ''
        """
    ) if selected else []

    # 正規化した1行 -> {表示用の原文, 出てきた案件, 件数}
    found: dict = {}

    for row in rows:

        for field in selected:

            value = row[field] or ""

            for line in value.splitlines():

                key = _normalize_note(line)

                if len(key) < 3:
                    continue

                entry = found.setdefault(
                    key,
                    {
                        "text": line.strip(),
                        "projects": {},
                        "count": 0,
                        "fields": set(),
                    },
                )

                entry["count"] += 1
                entry["fields"].add(field)
                entry["projects"][row["project_id"]] = {
                    "id": row["project_id"],
                    "name": row["project_name"],
                    "slug": row["slug"],
                    "project_no": row["project_no"],
                    # コピーで増えたぶんを1件と数えるための目印
                    "family": row["copied_from"] or row["project_id"],
                }

    total_rows = db.query(
        """
        SELECT DISTINCT p.id AS id, p.copied_from AS copied_from
        FROM projects p
        JOIN videos v ON v.project_id = p.id
        JOIN screenshots s ON s.video_id = v.id AND s.deleted_at = ''
        """
    )

    # コピーは元と同じ1件として数える
    project_total = len({r["copied_from"] or r["id"] for r in total_rows})

    def families(projects):
        """コピーどうしは1つとして数える。"""
        return {p["family"] for p in projects}

    items = []

    for v in found.values():

        projects = list(v["projects"].values())
        family_count = len(families(projects))

        if family_count < threshold:
            continue

        items.append({
            "text": v["text"],
            "count": v["count"],
            "projects": projects,
            "project_count": family_count,
            # 「3件のうち2件は同じ案件のコピー」と分かるように
            "copy_count": len(projects) - family_count,
            "fields": sorted(v["fields"]),
        })

    items.sort(key=lambda i: (-i["project_count"], -i["count"], i["text"]))

    adopted = _guidelines()

    already = {g["text"] for g in adopted}

    return render_template(
        "notes.html",
        items=items,
        threshold=threshold,
        selected=selected,
        note_fields=NOTE_FIELDS,
        project_total=project_total,
        field_labels=dict(NOTE_FIELDS),
        guidelines=adopted,
        already=already,
        ai_ready=bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
    )


# ============================================================
# 新規案件
# ============================================================

@app.post("/projects")
def create_project():

    genre = (
        request.form.get("genre") or ""
    ).strip()

    name = (
        request.form.get("name") or ""
    ).strip()

    project_no = (
        request.form.get("project_no") or ""
    ).strip()

    version_label = (
        request.form.get("version_label") or ""
    ).strip() or "初稿"

    assignee = (
        request.form.get("assignee") or ""
    ).strip()

    file = request.files.get("video")

    video_url = (
        request.form.get("video_url") or ""
    ).strip()

    if not name:
        return _error_page(
            "案件名を入力してください。"
        )

    # 動画は「ファイル」「リンク」「どちらも無し」の3通り。
    # 動画を後から足したいだけの案件も作れるようにする。
    has_file = bool(
        file and file.filename
    )

    if has_file and video_url:
        return _error_page(
            "ファイルとリンクの両方が指定されています。"
            "どちらか一方にしてください。"
        )

    if has_file:
        err = _validate_upload(file)
    elif video_url:
        err = _validate_video_url(video_url)
    else:
        err = None          # 動画なしで案件だけ作る

    if err:
        return _error_page(err)

    project_id = db.execute(
        """
        INSERT INTO projects
        (
            genre,
            name,
            project_no,
            assignee,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            genre,
            name,
            project_no,
            assignee,
            db.now(),
            db.now(),
        ),
    )

    db.execute(
        "UPDATE projects SET slug = ? WHERE id = ?",
        (make_slug(name, project_no, project_id), project_id),
    )

    if has_file:
        video_id = _store_video(
            project_id,
            version_label,
            file,
            sort_order=0,
        )
        jobs.start(video_id)
    elif video_url:
        video_id = _store_video_url(
            project_id,
            version_label,
            video_url,
            sort_order=0,
        )
        jobs.start(video_id)
    else:
        # 動画なし。空の表（30行）だけ用意しておく。
        video_id = _create_draft_video(project_id)

    return redirect(
        _project_url(project_id, video_id)
    )


# ============================================================
# 案件ページ
# ============================================================

@app.get("/projects/<int:project_id>")
def project_page_by_id(project_id: int):
    """古い /projects/12 形式のリンクは、パーマリンクへ転送する。"""
    row = db.query(
        "SELECT slug FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if row is None:
        abort(404)

    return redirect(
        _project_url(project_id, request.args.get("v", type=int))
    )


@app.get("/p/<path:key>")
def project_page(key: str):

    project = _find_project(key)

    if project is None:
        abort(404)

    project_id = project["id"]

    videos = db.query(
        """
        SELECT *
        FROM videos
        WHERE project_id = ?
        ORDER BY sort_order ASC, id ASC
        """,
        (project_id,),
    )

    if not videos:
        # 動画がまだ無い案件。案件情報だけを出して、あとから追加できるようにする。
        return render_template(
            "project.html",
            project=project,
            videos=[],
            current=None,
            shots=[],
        )

    requested_video = request.args.get(
        "v",
        type=int,
    )

    current = None

    if requested_video is not None:
        current = next(
            (
                v
                for v in videos
                if v["id"] == requested_video
            ),
            None,
        )

    if current is None:
        current = videos[0]

    shots = db.query(
        """
        SELECT *
        FROM screenshots
        WHERE video_id = ?
          AND deleted_at = ''
        ORDER BY seq ASC
        """,
        (current["id"],),
    )

    return render_template(
        "project.html",
        project=project,
        videos=videos,
        current=current,
        shots=shots,
    )


# ============================================================
# 案件情報更新
# ============================================================

@app.post("/projects/<int:project_id>/copy")
def copy_project(project_id: int):
    """
    案件のコピーを作る。

    参考動画とそのスクリーンショット、表の左側（分析）の入力はそのまま残し、
    右側（転用）の入力だけ空にする。
    同じ参考動画をもとに、別の動画をもう1本作るときのため。

    動画と画像のファイルは複製せず、同じものを見に行く。
    1案件で 200MB 近くになるため、コピーのたびに増やさない。
    消すときに巻き込まないよう、削除の側で使用中かどうかを見ている。
    """
    project = db.query(
        "SELECT * FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if project is None:
        abort(404)

    name = f"{project['name']}のコピー"

    user = auth.current_user()

    new_id = db.execute(
        """
        INSERT INTO projects
            (genre, name, project_no, slug, assignee,
             status, status_at, board_order, owner_user_id,
             copied_from, created_at, updated_at)
        VALUES (?, ?, '', ?, ?, 'todo', ?, 0, ?, ?, ?, ?)
        """,
        (
            project["genre"],
            name,
            make_slug(name, ""),
            project["assignee"],
            db.now(),
            user["id"] if user else 0,
            # コピー元をたどれるようにする。元がコピーならその元をたどる
            project["copied_from"] or project["id"],
            db.now(),
            db.now(),
        ),
    )

    videos = db.query(
        """
        SELECT *
        FROM videos
        WHERE project_id = ?
        ORDER BY sort_order, id
        """,
        (project_id,),
    )

    copied_rows = 0

    for video in videos:

        new_video = db.execute(
            """
            INSERT INTO videos
                (project_id, version_label, original_name, file_path,
                 source_url, duration_sec, status, progress, stage,
                 sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 100, '', ?, ?)
            """,
            (
                new_id,
                video["version_label"],
                video["original_name"],
                video["file_path"],
                video["source_url"],
                video["duration_sec"],
                video["status"],
                video["sort_order"],
                db.now(),
            ),
        )

        shots = db.query(
            """
            SELECT *
            FROM screenshots
            WHERE video_id = ?
              AND deleted_at = ''
            ORDER BY seq ASC, id ASC
            """,
            (video["id"],),
        )

        for shot in shots:

            db.execute(
                """
                INSERT INTO screenshots
                    (video_id, seq, image_path, timestamp_sec, row_height,
                     is_manual,
                     reference_role, material_feature,
                     improvement_note, reference_feedback,
                     text_raw, material, role, scene_feeling, feedback,
                     updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', ?)
                """,
                (
                    new_video,
                    shot["seq"],
                    shot["image_path"],
                    shot["timestamp_sec"],
                    shot["row_height"],
                    shot["is_manual"],
                    # 表の左側（分析）はそのまま持っていく
                    shot["reference_role"],
                    shot["material_feature"],
                    shot["improvement_note"],
                    shot["reference_feedback"],
                    db.now(),
                ),
            )

            copied_rows += 1

    logging.getLogger("app").info(
        "案件をコピーしました: %s -> %s（%s行）", project_id, new_id, copied_rows
    )

    return redirect(_project_url(new_id))


@app.post("/api/projects/<int:project_id>/info")
def update_project_info(project_id: int):
    """
    案件ページの見出しから、その場で直したときの保存。

    直した欄だけを送ってくる。案件名を変えるとパーマリンクも変わるので、
    新しい URL を返して画面側で差し替えてもらう。
    """
    project = db.query(
        "SELECT * FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if project is None:
        return jsonify(ok=False, error="案件がありません。"), 404

    data = request.get_json(silent=True) or {}

    fields = {}

    for key in ("genre", "name", "project_no", "assignee"):

        if key not in data:
            continue

        value = (data.get(key) or "").strip()

        if len(value) > 120:
            return jsonify(ok=False, error="長すぎます（120文字まで）。"), 400

        fields[key] = value

    if not fields:
        return jsonify(ok=False, error="直すところがありません。"), 400

    name = fields.get("name", project["name"])

    if not name:
        return jsonify(ok=False, error="案件名は空にできません。"), 400

    project_no = fields.get("project_no", project["project_no"] or "")

    slug = project["slug"]

    if "name" in fields or "project_no" in fields:
        slug = make_slug(name, project_no, project_id)

    db.execute(
        """
        UPDATE projects
        SET genre = ?, name = ?, project_no = ?, assignee = ?,
            slug = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            fields.get("genre", project["genre"] or ""),
            name,
            project_no,
            fields.get("assignee", project["assignee"] or ""),
            slug,
            db.now(),
            project_id,
        ),
    )

    updated = db.query(
        "SELECT * FROM projects WHERE id = ?", (project_id,), one=True
    )

    return jsonify(
        ok=True,
        url=_project_url(project_id),
        updated_at=updated["updated_at"],
        slug=updated["slug"],
    )


@app.post("/projects/<int:project_id>/update")
def update_project(project_id: int):

    project = db.query(
        """
        SELECT *
        FROM projects
        WHERE id = ?
        """,
        (project_id,),
        one=True,
    )

    if project is None:
        abort(404)

    genre = (
        request.form.get("genre") or ""
    ).strip()

    name = (
        request.form.get("name") or ""
    ).strip()

    project_no = (
        request.form.get("project_no") or ""
    ).strip()

    assignee = (
        request.form.get("assignee") or ""
    ).strip()

    if not name:
        return _error_page(
            "案件名を入力してください。"
        )

    db.execute(
        """
        UPDATE projects
        SET
            genre = ?,
            name = ?,
            project_no = ?,
            slug = ?,
            assignee = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            genre,
            name,
            project_no,
            # 名前や番号を直したらパーマリンクも作り直す
            make_slug(name, project_no, project_id),
            assignee,
            db.now(),
            project_id,
        ),
    )

    return redirect(
        _project_url(project_id)
    )


# ============================================================
# 動画再処理
# ============================================================

@app.post("/videos/<int:video_id>/retry")
def retry_video(video_id: int):

    video = db.query(
        """
        SELECT *
        FROM videos
        WHERE id = ?
        """,
        (video_id,),
        one=True,
    )

    if video is None:
        abort(404)

    db.execute(
        """
        UPDATE videos
        SET
            status = 'queued',
            progress = 0,
            stage = '再処理を準備しています',
            error_message = NULL
        WHERE id = ?
        """,
        (video_id,),
    )

    jobs.start(video_id)

    return redirect(
        _project_url(video["project_id"], video_id)
    )


# ============================================================
# 動画削除
# ============================================================

@app.post("/videos/<int:video_id>/delete")
def delete_video(video_id: int):

    video = db.query(
        """
        SELECT *
        FROM videos
        WHERE id = ?
        """,
        (video_id,),
        one=True,
    )

    if video is None:
        abort(404)

    project_id = video["project_id"]

    file_path = video["file_path"]

    db.execute(
        """
        DELETE FROM videos
        WHERE id = ?
        """,
        (video_id,),
    )

    # 「コピーを作成」で作った案件は、元の案件と同じ動画ファイルを見ている。
    # まだ使っているところがあれば、ファイルは消さない。
    still_used = db.query(
        "SELECT COUNT(*) AS n FROM videos WHERE file_path = ?",
        (file_path,),
        one=True,
    )

    try:
        if file_path and not (still_used and still_used["n"]):
            Path(file_path).unlink(
                missing_ok=True
            )
    except OSError:
        pass

    db.touch_project(project_id)

    return redirect(
        _project_url(project_id)
    )


# ============================================================
# スクショ内容の自動保存
# ============================================================

@app.post("/api/projects/<int:project_id>/columns")
def update_columns(project_id: int):
    """
    表の列幅を保存する。

    {"widths": {"3": 180, "5": 300}}  … 列番号（0始まり）→ 幅px
    値が 0 や無い列は自動幅のままにする。
    """

    project = db.query(
        "SELECT id FROM projects WHERE id = ?",
        (project_id,),
        one=True,
    )

    if project is None:
        return jsonify(
            {
                "ok": False,
                "error": "Project not found",
            }
        ), 404

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify(
            {
                "ok": False,
                "error": "Invalid JSON",
            }
        ), 400

    widths = data.get("widths")

    if not isinstance(widths, dict):
        return jsonify(
            {
                "ok": False,
                "error": "widths must be an object",
            }
        ), 400

    clean = {}

    for key, value in widths.items():

        try:
            index = int(key)
            px = int(value)
        except (TypeError, ValueError):
            continue

        if index < 0 or px <= 0:
            continue

        clean[str(index)] = max(40, min(1200, px))

    db.execute(
        "UPDATE projects SET column_widths = ?, updated_at = ? WHERE id = ?",
        (json.dumps(clean), db.now(), project_id),
    )

    return jsonify(
        {
            "ok": True,
            "widths": clean,
        }
    )


@app.post("/api/screenshots/<int:shot_id>")
def update_screenshot(shot_id: int):

    shot = db.query(
        """
        SELECT *
        FROM screenshots
        WHERE id = ?
        """,
        (shot_id,),
        one=True,
    )

    if shot is None:
        return jsonify(
            {
                "ok": False,
                "error": "Screenshot not found",
            }
        ), 404

    data = request.get_json(
        silent=True
    )

    if not isinstance(data, dict):
        return jsonify(
            {
                "ok": False,
                "error": "Invalid JSON",
            }
        ), 400

    updates = []

    values = []

    for field in ALLOWED_FIELDS:

        if field not in data:
            continue

        value = data[field]

        if value is None:
            value = ""

        if not isinstance(value, str):
            value = str(value)

        updates.append(
            f"{field} = ?"
        )

        values.append(value)

    if not updates:
        return jsonify(
            {
                "ok": True,
                "changed": False,
            }
        )

    updates.append(
        "updated_at = ?"
    )

    values.append(
        db.now()
    )

    values.append(
        shot_id
    )

    db.execute(
        f"""
        UPDATE screenshots
        SET {", ".join(updates)}
        WHERE id = ?
        """,
        tuple(values),
    )

    video = db.query(
        """
        SELECT project_id
        FROM videos
        WHERE id = ?
        """,
        (shot["video_id"],),
        one=True,
    )

    if video:
        db.touch_project(
            video["project_id"]
        )

    return jsonify(
        {
            "ok": True,
            "changed": True,
        }
    )


# ============================================================
# 動画処理状態
# ============================================================

@app.get("/api/videos/<int:video_id>/status")
def video_status(video_id: int):

    video = db.query(
        """
        SELECT
            id,
            project_id,
            status,
            progress,
            stage,
            error_message
        FROM videos
        WHERE id = ?
        """,
        (video_id,),
        one=True,
    )

    if video is None:
        return jsonify(
            {
                "ok": False,
                "error": "Video not found",
            }
        ), 404

    return jsonify(
        {
            "ok": True,
            "id": video["id"],
            "project_id": video["project_id"],
            "status": video["status"],
            "progress": video["progress"] or 0,
            "stage": video["stage"] or "",
            "error_message": (
                video["error_message"] or ""
            ),
        }
    )


# ============================================================
# 動画配信
# ============================================================

@app.get("/media/video/<int:video_id>")
def media_video(video_id: int):

    video = db.query(
        """
        SELECT file_path
        FROM videos
        WHERE id = ?
        """,
        (video_id,),
        one=True,
    )

    if video is None:
        abort(404)

    # ダウンロード前やリンク登録直後は file_path が空。
    # Path("") はカレントディレクトリになり exists() が真になってしまうので、
    # 空かどうかを先に見てから、ファイルであることも確かめる。
    if not video["file_path"]:
        abort(404)

    path = Path(
        video["file_path"]
    )

    if not path.is_file():
        abort(404)

    mime = (
        mimetypes.guess_type(
            path.name
        )[0]
        or "video/mp4"
    )

    return send_file(
        path,
        mimetype=mime,
        conditional=True,
    )


# ============================================================
# スクショ配信
# ============================================================

@app.get("/media/shot/<int:shot_id>")
def media_shot(shot_id: int):

    shot = db.query(
        """
        SELECT image_path
        FROM screenshots
        WHERE id = ?
        """,
        (shot_id,),
        one=True,
    )

    if shot is None:
        abort(404)

    # 空の行（画像がまだ無い行）は 404 を返す
    if not shot["image_path"]:
        abort(404)

    path = Path(
        shot["image_path"]
    )

    if not path.is_file():
        abort(404)

    return send_file(
        path,
        conditional=True,
    )


# ============================================================
# 413
# ============================================================

@app.errorhandler(413)
def too_large(_):

    return (
        render_template(
            "error.html",
            message=(
                "動画ファイルが大きすぎます。"
                f" 上限は "
                f"{config.MAX_UPLOAD_MB}MB "
                "です。"
            ),
            back=url_for("index"),
        ),
        413,
    )


# ============================================================
# 404
# ============================================================

@app.errorhandler(404)
def not_found(e):

    return (
        render_template(
            "error.html",
            message="ページが見つかりません。",
            back=url_for("index"),
        ),
        404,
    )


# ============================================================
# 起動
# ============================================================

class _LazySSLAdapter:
    """
    TLS の握手を「接続を受け付けたところ」ではなく、
    実際に読み書きする作業スレッド側で行うための差し替え。

    受付側で握手すると、つないだだけで黙っている相手が1つあるだけで
    サーバー全体が止まる。ブラウザは表示を速くするために先回りして
    接続を張るので、これが現実に起きる。
    """

    def __init__(self, certificate: str, private_key: str):
        import ssl

        self.certificate = certificate
        self.private_key = private_key

        self.context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self.context.load_cert_chain(certificate, private_key)

    def bind(self, sock):
        return sock

    def wrap(self, sock):
        import ssl

        try:
            wrapped = self.context.wrap_socket(
                sock,
                server_side=True,
                do_handshake_on_connect=False,
            )
        except (ssl.SSLError, OSError):
            return None, {}

        return wrapped, self.get_environ(wrapped)

    def get_environ(self, sock=None):
        # 握手前なので暗号方式などはまだ分からない。
        # アプリが見るのは https かどうかだけなので、これで足りる。
        return {"wsgi.url_scheme": "https", "HTTPS": "on"}

    def makefile(self, sock, mode="r", bufsize=-1):
        from cheroot.makefile import MakeFile

        return MakeFile(sock, mode, bufsize)


def _tls_quiet_log(msg: str = "", level: int = logging.ERROR,
                   traceback: bool = False) -> None:
    """
    cheroot のエラー出力。

    自己署名の証明書だとブラウザが警告画面で接続を切るため、
    そのたびに TLS の例外が出る。異常ではないのでログには残さない。
    """
    import ssl

    if traceback:
        kind = sys.exc_info()[0]

        if kind is not None and issubclass(
            kind, (ssl.SSLError, ConnectionError)
        ):
            return

    logging.getLogger("app").log(level, msg, exc_info=traceback)


def _free_port() -> int:
    """空いているポート番号をひとつ借りる。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _redirect_to_https(conn: socket.socket, port: int) -> None:
    """
    平文で来た相手に「https で入り直して」と返す。

    ブラウザのアドレス欄に 192.168.11.5:5000 と打つと http:// で
    繋ぎにくる。そのままだと TLS のポートなので接続が切れるだけで、
    何が悪いのか分からない。ここで案内を返して同じアドレスの
    https へ飛ばす。
    """
    try:
        head = conn.recv(8192).decode("latin-1", "replace")
    except OSError:
        return

    parts = head.split("\r\n", 1)[0].split(" ")
    path = parts[1] if len(parts) > 2 and parts[1].startswith("/") else "/"

    host = ""

    for raw in head.split("\r\n")[1:]:
        if raw.lower().startswith("host:"):
            host = raw.split(":", 1)[1].strip().rsplit(":", 1)[0]
            break

    if not host:
        try:
            host = conn.getsockname()[0]
        except OSError:
            host = "localhost"

    location = f"https://{host}:{port}{path}"

    body = (
        '<!doctype html><meta charset="utf-8"><title>移動します</title>'
        f'<p>安全な接続に切り替えます。<a href="{location}">{location}</a></p>'
    ).encode("utf-8")

    try:
        conn.sendall(
            b"HTTP/1.1 301 Moved Permanently\r\n"
            b"Location: " + location.encode("latin-1") + b"\r\n"
            b"Content-Type: text/html; charset=utf-8\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + body
        )
    except OSError:
        pass


def _pump(src: socket.socket, dst: socket.socket) -> None:
    """片方向にひたすら流す。"""
    try:
        while True:
            chunk = src.recv(65536)

            if not chunk:
                break

            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _handle_front(conn: socket.socket, inner: int, port: int) -> None:
    """
    最初の1バイトを覗いて、TLS かどうかで振り分ける。

    TLS の通信は 0x16 で始まる決まりなので、それだけ見れば分かる。
    覗くだけ（MSG_PEEK）なので、中身は本体側でもう一度読める。
    """
    upstream = None

    try:
        conn.settimeout(20)

        first = conn.recv(1, socket.MSG_PEEK)

        if not first:
            return

        if first != b"\x16":
            _redirect_to_https(conn, port)
            return

        conn.settimeout(None)

        upstream = socket.create_connection(("127.0.0.1", inner))

        threading.Thread(target=_pump, args=(conn, upstream), daemon=True).start()

        _pump(upstream, conn)

    except OSError:
        pass

    finally:
        for s in (conn, upstream):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


def _front_door(port: int, inner: int) -> None:
    """
    外から見えるポートで待ち受けて、
    https はそのまま本体へ、平文は案内へ回す。
    """
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # Windows の SO_REUSEADDR は「同じポートに二重に bind できてしまう」
    # 挙動になり、古いサーバーが残っていても気付けない。
    # あえて付けず、使用中ならその場でエラーにする。
    srv.bind(("0.0.0.0", port))
    srv.listen(128)

    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            break

        threading.Thread(
            target=_handle_front,
            args=(conn, inner, port),
            daemon=True,
        ).start()


def _serve_https(cert, key, port: int) -> None:
    """
    HTTPS のときは cheroot で待ち受ける。

    Flask 付属の開発サーバーは、TLS の握手を「接続を受け付ける
    ループの中」で行う。そのため、つないだだけで何も送ってこない
    相手が1つでもいると、そこで全体が止まってしまう。
    ブラウザは表示を速くするために先回りして接続を張るので、
    実際にこれで固まる（TCP は繋がるのに何も返らない）。

    cheroot も既定では受付側で握手するので、握手を後回しにして
    作業スレッド側で済ませるようにしてある（_LazySSLAdapter）。

    本体は内側のポートで動かし、外向きのポートは _front_door が持つ。
    こうすると、http で来た人を https へ案内できる。
    """
    import time

    from cheroot.wsgi import Server

    inner = _free_port()

    server = Server(
        ("127.0.0.1", inner),
        app,
        numthreads=16,
        # 1回の読み書きの待ち時間。長い動画のアップロードでも
        # 少しずつ届くので、これで足りる。
        timeout=60,
    )

    server.ssl_adapter = _LazySSLAdapter(str(cert), str(key))
    server.error_log = _tls_quiet_log

    threading.Thread(target=server.start, daemon=True).start()

    # 本体が待ち受けを始めるまで待つ
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", inner), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.1)

    try:
        _front_door(port, inner)
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":

    port = int(
        os.environ.get(
            "VR_PORT",
            "5000",
        )
    )

    # 画面（テンプレート）は保存すればすぐ反映されるが、
    # Python 側の変更は再起動しないと反映されない。
    # 「直したはずなのに古い動きをする」を防ぐため、
    # 今動いているコードの日付を起動時に出しておく。
    import datetime

    stamp = datetime.datetime.fromtimestamp(
        Path(__file__).stat().st_mtime
    ).strftime("%Y-%m-%d %H:%M")

    print(f"  app.py の更新日時: {stamp}")
    print(
        "  ※ Python のコードを変えたら、このウィンドウを閉じて"
        "start.bat を実行し直してください"
    )

    # 証明書があれば https で起動する。
    # https だとブラウザの「安全なページ」扱いになり、
    # リンクのコピーなど一部の機能が LAN からでも使えるようになる。
    cert = config.DATA_DIR / "cert" / "server.crt"
    key = config.DATA_DIR / "cert" / "server.key"

    ssl_context = None

    if cert.is_file() and key.is_file():
        ssl_context = (str(cert), str(key))
        os.environ["VR_HTTPS"] = "1"
        app.config["SESSION_COOKIE_SECURE"] = True
        scheme = "https"
    else:
        scheme = "http"
        print("  ※ 証明書が無いため http で起動します"
              "（python make_cert.py で作れます）")

    print(f"  このPC     : {scheme}://localhost:{port}/")
    print(f"  社内LANから : {scheme}://<このPCのIP>:{port}/")
    print()

    if ssl_context is None:
        app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
    else:
        _serve_https(cert, key, port)