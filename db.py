# -*- coding: utf-8 -*-

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any, Iterable

import config


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    genre       TEXT    NOT NULL DEFAULT '',
    name        TEXT    NOT NULL,
    project_no  TEXT    NOT NULL DEFAULT '',
    slug        TEXT    NOT NULL DEFAULT '',
    assignee    TEXT    NOT NULL DEFAULT '',
    fb_assignee TEXT    NOT NULL DEFAULT '',
    fb_done     INTEGER NOT NULL DEFAULT 0,
    column_widths TEXT  NOT NULL DEFAULT '',

    -- 進捗ボード用。todo / doing / waiting / done
    status         TEXT    NOT NULL DEFAULT 'todo',
    status_at      TEXT    NOT NULL DEFAULT '',
    board_order    INTEGER NOT NULL DEFAULT 0,

    -- メンバー別の集計に使う担当ユーザー。0 なら未割当。
    owner_user_id  INTEGER NOT NULL DEFAULT 0,

    -- 「コピーを作成」で作られた案件は、元の案件の id。
    -- 共通ノートで「同じ指摘が何件の案件で出たか」を数えるとき、
    -- コピーどうしは1件として扱うために使う。
    copied_from    INTEGER NOT NULL DEFAULT 0,

    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_label TEXT    NOT NULL,
    original_name TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,
    source_url    TEXT    NOT NULL DEFAULT '',
    duration_sec  REAL,
    status        TEXT    NOT NULL,
    progress      INTEGER NOT NULL DEFAULT 0,
    stage         TEXT    NOT NULL DEFAULT '',
    error_message TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_project
ON videos(project_id, sort_order);

CREATE TABLE IF NOT EXISTS screenshots (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id              INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    seq                   INTEGER NOT NULL,
    image_path            TEXT    NOT NULL,
    timestamp_sec         REAL    NOT NULL,

    row_height            INTEGER NOT NULL DEFAULT 0,

    -- 動画プレイヤーの「この場面を追加」で撮った行は 1。
    -- 自動生成の行は固定、こちらだけ並べ替えできる。
    is_manual             INTEGER NOT NULL DEFAULT 0,

    reference_role        TEXT    NOT NULL DEFAULT '',
    material_feature      TEXT    NOT NULL DEFAULT '',
    improvement_note      TEXT    NOT NULL DEFAULT '',
    reference_feedback    TEXT    NOT NULL DEFAULT '',

    text_raw              TEXT    NOT NULL DEFAULT '',
    material              TEXT    NOT NULL DEFAULT '',
    role                  TEXT    NOT NULL DEFAULT '',
    scene_feeling         TEXT    NOT NULL DEFAULT '',
    feedback              TEXT    NOT NULL DEFAULT '',

    deleted_at            TEXT    NOT NULL DEFAULT '',

    updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shots_video
ON screenshots(video_id, seq);

CREATE TABLE IF NOT EXISTS material_images (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shot_id       INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    file_path     TEXT    NOT NULL,
    original_name TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_material_images_shot
ON material_images(shot_id);


/*
   作業時間。

   画面を触っている（マウスが動いている・入力している）秒数だけを
   数えて、表の左側＝分析、右側＝転用 に振り分けて貯める。
   1秒ごとに書くと重いので、案件×人×側×日 で1行にまとめる。
*/
CREATE TABLE IF NOT EXISTS work_time (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL DEFAULT 0,
    side       TEXT    NOT NULL,
    day        TEXT    NOT NULL,
    seconds    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_time_key
ON work_time(project_id, user_id, side, day);


/* 目標値などの設定。1行1項目の入れ物。 */
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);


/*
   ガイドライン。

   共通フィードバックの中から「これは毎回気をつける」と決めたものを
   ためていく。source は元になった指摘の原文、seen は何件の案件で
   言われていたか。あとから根拠をたどれるように残しておく。
*/
CREATE TABLE IF NOT EXISTS guidelines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    source     TEXT    NOT NULL DEFAULT '',
    seen       INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'active',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);


/*
   結合したセル。

   表の縦横に並んだセルをひとつにまとめたもの。
   まとめた左上のセル（shot_id と field）を覚えておき、
   そこから何行ぶん・何列ぶん広がるかを持つ。

   画面には全部のセルを出したうえで、覆われたセルを隠して見せている。
   こうしておくと、行を足したり並べ替えたりしても組み直せる。
*/
CREATE TABLE IF NOT EXISTS cell_merges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   INTEGER NOT NULL,
    shot_id    INTEGER NOT NULL,
    field      TEXT    NOT NULL,
    row_span   INTEGER NOT NULL DEFAULT 1,
    col_span   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT '',

    FOREIGN KEY (video_id) REFERENCES videos(id)   ON DELETE CASCADE,
    FOREIGN KEY (shot_id)  REFERENCES screenshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cell_merges_video_idx
    ON cell_merges (video_id);

CREATE UNIQUE INDEX IF NOT EXISTS cell_merges_cell_key
    ON cell_merges (shot_id, field);


/*
   いま誰がどのセルを見ているか。

   数秒ごとに書き換えられる、その場かぎりの情報。
   古くなった行は読むときに捨てるので、貯め込まない。
*/
CREATE TABLE IF NOT EXISTS presence (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    shot_id    INTEGER NOT NULL DEFAULT 0,
    field      TEXT    NOT NULL DEFAULT '',
    name       TEXT    NOT NULL DEFAULT '',
    updated_at TEXT    NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS presence_who
    ON presence (video_id, user_id);
"""


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect() -> sqlite3.Connection:
    config.ensure_dirs()

    conn = sqlite3.connect(
        config.DB_PATH,
        timeout=30.0
    )

    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    return conn


def init_db() -> None:

    with connect() as conn:

        conn.executescript(SCHEMA)

        # ====================================================
        # projects の既存DBへの追加項目
        # ====================================================

        existing_projects = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(projects)"
            ).fetchall()
        }

        project_columns = {
            "genre": "TEXT NOT NULL DEFAULT ''",
            "project_no": "TEXT NOT NULL DEFAULT ''",
            "slug": "TEXT NOT NULL DEFAULT ''",
            "assignee": "TEXT NOT NULL DEFAULT ''",
            "fb_assignee": "TEXT NOT NULL DEFAULT ''",
            "fb_done": "INTEGER NOT NULL DEFAULT 0",
            "column_widths": "TEXT NOT NULL DEFAULT ''",
            "status": "TEXT NOT NULL DEFAULT 'todo'",
            "status_at": "TEXT NOT NULL DEFAULT ''",
            "board_order": "INTEGER NOT NULL DEFAULT 0",
            "owner_user_id": "INTEGER NOT NULL DEFAULT 0",
            "copied_from": "INTEGER NOT NULL DEFAULT 0",
        }

        for column, definition in project_columns.items():

            if column not in existing_projects:

                conn.execute(
                    f"""
                    ALTER TABLE projects
                    ADD COLUMN {column} {definition}
                    """
                )

        # ====================================================
        # videos の既存DBへの追加項目
        # ====================================================

        existing_videos = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(videos)"
            ).fetchall()
        }

        video_columns = {
            # リンクから登録した場合の取得元。ファイル選択のときは空。
            "source_url": "TEXT NOT NULL DEFAULT ''",
        }

        for column, definition in video_columns.items():

            if column not in existing_videos:

                conn.execute(
                    f"""
                    ALTER TABLE videos
                    ADD COLUMN {column} {definition}
                    """
                )

        # ====================================================
        # screenshots の既存DBへの追加項目
        # ====================================================

        existing_screenshots = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(screenshots)"
            ).fetchall()
        }

        screenshot_columns = {
            "reference_role": "TEXT NOT NULL DEFAULT ''",
            "material_feature": "TEXT NOT NULL DEFAULT ''",
            "improvement_note": "TEXT NOT NULL DEFAULT ''",
            "reference_feedback": "TEXT NOT NULL DEFAULT ''",
            "text_raw": "TEXT NOT NULL DEFAULT ''",
            "material": "TEXT NOT NULL DEFAULT ''",
            "role": "TEXT NOT NULL DEFAULT ''",
            "scene_feeling": "TEXT NOT NULL DEFAULT ''",
            "feedback": "TEXT NOT NULL DEFAULT ''",
            "row_height": "INTEGER NOT NULL DEFAULT 0",
            "deleted_at": "TEXT NOT NULL DEFAULT ''",
            "is_manual": "INTEGER NOT NULL DEFAULT 0",
            # 修正版でだけ使う、修正したあとのフィードバック
            "revised_feedback": "TEXT NOT NULL DEFAULT ''",
        }

        for column, definition in screenshot_columns.items():

            if column not in existing_screenshots:

                conn.execute(
                    f"""
                    ALTER TABLE screenshots
                    ADD COLUMN {column} {definition}
                    """
                )

        conn.commit()


def query(
    sql: str,
    args: Iterable[Any] = (),
    one: bool = False
):

    with connect() as conn:

        cur = conn.execute(
            sql,
            tuple(args)
        )

        rows = cur.fetchall()

    if one:
        return rows[0] if rows else None

    return rows


def execute(
    sql: str,
    args: Iterable[Any] = ()
) -> int:

    with connect() as conn:

        cur = conn.execute(
            sql,
            tuple(args)
        )

        conn.commit()

        return cur.lastrowid or 0


def touch_project(project_id: int) -> None:

    execute(
        """
        UPDATE projects
        SET updated_at = ?
        WHERE id = ?
        """,
        (
            now(),
            project_id
        )
    )