# -*- coding: utf-8 -*-
"""
いまの SQLite と data/ の中身を Supabase へ移す。

    python supabase/migrate.py --check     どれだけ移すかを見るだけ
    python supabase/migrate.py             実際に移す

必要な情報は .env から読む（このファイルは GitHub に上げない）。

    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_SERVICE_KEY=（Settings → API → service_role）

先に supabase/schema.sql を SQL Editor で実行しておくこと。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "data" / "app.db"


def load_env() -> dict:
    """.env を読む。無ければ環境変数から。"""
    values = {}

    path = BASE_DIR / ".env"

    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")

    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        values.setdefault(key, os.environ.get(key, ""))

    return values


class Supabase:
    """必要な分だけの、ごく小さな入口。"""

    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/")
        self.key = key

    def _request(self, method: str, path: str, *, body=None,
                 content_type="application/json", extra=None):

        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
        }

        if body is not None:
            headers["Content-Type"] = content_type

        if extra:
            headers.update(extra)

        data = body

        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(
            self.url + path, data=data, headers=headers, method=method
        )

        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"{method} {path} → {e.code} {detail}") from None

    def insert(self, table: str, rows: list) -> list:
        if not rows:
            return []

        return self._request(
            "POST",
            f"/rest/v1/{table}",
            body=rows,
            extra={"Prefer": "return=representation"},
        ) or []

    def upload(self, bucket: str, path: str, data: bytes) -> None:
        kind = mimetypes.guess_type(path)[0] or "application/octet-stream"

        self._request(
            "POST",
            f"/storage/v1/object/{bucket}/{path}",
            body=data,
            content_type=kind,
            extra={"x-upsert": "true"},
        )

    def patch(self, table: str, where: str, fields: dict) -> None:
        self._request("PATCH", f"/rest/v1/{table}?{where}", body=fields)

    def delete_all(self, table: str) -> None:
        key = "key" if table == "settings" else "id"
        op = "neq.__none__" if key == "key" else "gt.0"
        self._request("DELETE", f"/rest/v1/{table}?{key}={op}")

    def has(self, table: str, column: str = "id") -> bool:
        """向こうにその表と列があるか。無ければ移す前に止めたい。"""
        try:
            self._request("GET", f"/rest/v1/{table}?select={column}&limit=1")
            return True
        except RuntimeError:
            return False

    def list_users(self) -> list:
        out = self._request("GET", "/auth/v1/admin/users?per_page=200")
        return (out or {}).get("users", []) if isinstance(out, dict) else (out or [])


def shrink_video(src: Path, limit_mb: int, work: Path) -> Path:
    """
    大きすぎる動画を、送れる大きさに圧縮した複製を作る。

    Supabase の無料プランは1ファイル 50MB まで。
    元のファイルには手を触れず、別の場所に作る。
    """
    import shutil
    import subprocess

    if src.stat().st_size <= limit_mb * 1048576:
        return src

    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            f"{src.name} は {src.stat().st_size / 1048576:.0f}MB あり、"
            "そのままでは送れません。ffmpeg を入れるか --skip-videos を付けてください。"
        )

    work.mkdir(parents=True, exist_ok=True)
    out = work / (src.stem + "-web.mp4")

    if out.is_file() and out.stat().st_size <= limit_mb * 1048576:
        return out

    print(f"    {src.stat().st_size / 1048576:.0f}MB あるので圧縮します …", flush=True)

    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(src),
         "-c:v", "libx264", "-preset", "medium", "-crf", "24",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         "-c:a", "aac", "-b:a", "128k", str(out)],
        check=True,
    )

    size = out.stat().st_size / 1048576
    print(f"    → {size:.0f}MB になりました")

    if size > limit_mb:
        raise RuntimeError(f"{src.name} は圧縮しても {size:.0f}MB で送れません。")

    return out


def rows(conn, sql: str) -> list:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql)]


def summary(conn) -> None:
    print("― 移すもの ―")

    for table in ("projects", "videos", "screenshots", "cell_merges",
                  "material_images", "work_time", "guidelines", "settings"):
        try:
            n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.Error:
            n = 0
        print(f"  {table:<16} {n:>5} 行")

    total = 0
    count = 0

    for folder in ("videos", "screenshots", "materials"):
        base = BASE_DIR / "data" / folder
        if not base.is_dir():
            continue
        for f in base.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
                count += 1

    print(f"  ファイル         {count:>5} 個 / {total / 1048576:.0f} MB")

    print()
    print("― 先に手で用意していただくもの ―")
    print("  ・SQL Editor で順に実行")
    print("      schema.sql")
    print("      002_copy_lineage.sql")
    print("      003_members_only.sql")
    print("      004_versions_and_merges.sql")
    print("  ・いまの4名を Supabase Auth に招待（メールアドレスは同じもの）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="移す量を見るだけ")
    ap.add_argument("--skip-videos", action="store_true",
                    help="動画は移さない（スクショと入力内容だけ）")
    ap.add_argument("--reset", action="store_true",
                    help="Supabase 側を空にしてから入れ直す")
    ap.add_argument("--max-upload-mb", type=int, default=45,
                    help="これを超える動画は圧縮してから送る（既定 45MB）")
    args = ap.parse_args()

    if not DB_PATH.is_file():
        print(f"  データベースが見つかりません: {DB_PATH}")
        return 1

    conn = sqlite3.connect(DB_PATH)

    if args.check:
        summary(conn)
        return 0

    env = load_env()

    if not env.get("SUPABASE_URL") or not env.get("SUPABASE_SERVICE_KEY"):
        print("  .env に SUPABASE_URL と SUPABASE_SERVICE_KEY を書いてください。")
        print("  （supabase/migrate.py の先頭にある説明を参照）")
        return 1

    sb = Supabase(env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"])

    # ---- 向こう側の用意 ----------------------------------------------------
    # 列や表が足りないまま流すと、途中で止まって中途半端に入ってしまう。
    missing = []

    for table, column, sql in (
        ("projects", "copied_from", "002_copy_lineage.sql"),
        ("screenshots", "revised_feedback", "004_versions_and_merges.sql"),
        ("cell_merges", "id", "004_versions_and_merges.sql"),
    ):
        if not sb.has(table, column):
            missing.append((table, column, sql))

    if missing:
        print("― 先に SQL Editor で流してください ―")
        for table, column, sql in missing:
            print(f"  {table}.{column} がありません → supabase/{sql}")
        return 1

    if args.reset:
        print("― 入れ直しのため、Supabase 側を空にします ―")
        # 親を消せば、ぶら下がっている行も一緒に消える
        for table in ("work_time", "guidelines", "settings", "projects"):
            sb.delete_all(table)
            print(f"  {table} を空にしました")
        print()

    # ---- ユーザーの対応表 -------------------------------------------------
    print("― ユーザーの対応づけ ―")

    remote = {u.get("email", "").lower(): u["id"] for u in sb.list_users()}
    local = rows(conn, "SELECT id, username, display_name FROM users")

    user_map = {}

    for u in local:
        email = (u["username"] or "").lower()
        if email in remote:
            user_map[u["id"]] = remote[email]
            print(f"  OK  {u['username']}")
        else:
            print(f"  --  {u['username']} は Supabase にいません（担当は空にします）")

    # ---- 案件 -------------------------------------------------------------
    print()
    print("― 案件 ―")

    project_map = {}

    for p in rows(conn, "SELECT * FROM projects ORDER BY id"):
        body = {
            "genre": p["genre"] or "",
            "name": p["name"],
            "project_no": p["project_no"] or "",
            "slug": p["slug"] or "",
            "assignee": p["assignee"] or "",
            "column_widths": json.loads(p["column_widths"] or "{}") if p["column_widths"] else {},
            "status": p["status"] or "todo",
            "status_at": p["status_at"] or None,
            "board_order": p["board_order"] or 0,
            "owner_id": user_map.get(p["owner_user_id"] or 0),
            "created_at": p["created_at"],
            "updated_at": p["updated_at"],
        }

        made = sb.insert("projects", [body])
        project_map[p["id"]] = made[0]["id"]
        print(f"  {p['name'][:24]:<26} → id={made[0]['id']}")

    # コピーで増えた案件は、元をたどれるようにしておく。
    # 共通ノートで、コピーどうしを1件として数えるために使う。
    lineage = 0

    for p in rows(conn, "SELECT id, copied_from FROM projects WHERE copied_from <> 0"):

        if p["id"] not in project_map or p["copied_from"] not in project_map:
            continue

        sb.patch(
            "projects",
            f"id=eq.{project_map[p['id']]}",
            {"copied_from": project_map[p["copied_from"]]},
        )
        lineage += 1

    if lineage:
        print(f"  コピー元の結びつけ {lineage} 件")

    # ---- 動画 -------------------------------------------------------------
    print()
    print("― 動画 ―")

    video_map = {}

    for v in rows(conn, "SELECT * FROM videos ORDER BY id"):

        src = Path(v["file_path"]) if v["file_path"] else None
        storage_path = ""

        if src and src.is_file() and not args.skip_videos:
            send = shrink_video(src, args.max_upload_mb,
                                BASE_DIR / "data" / "_upload")
            storage_path = f"{project_map[v['project_id']]}/{send.name}"
            size = send.stat().st_size / 1048576
            print(f"  送信中 {send.name} ({size:.0f}MB) …", flush=True)
            sb.upload("videos", storage_path, send.read_bytes())

        body = {
            "project_id": project_map[v["project_id"]],
            "version_label": v["version_label"] or "初稿",
            "original_name": v["original_name"] or "",
            "storage_path": storage_path,
            "source_url": v["source_url"] or "",
            "duration_sec": v["duration_sec"],
            "status": v["status"] or "none",
            "progress": v["progress"] or 0,
            "stage": v["stage"] or "",
            "error_message": v["error_message"],
            "sort_order": v["sort_order"] or 0,
            "created_at": v["created_at"],
        }

        made = sb.insert("videos", [body])
        video_map[v["id"]] = made[0]["id"]

    # ---- スクリーンショット -----------------------------------------------
    print()
    print("― スクリーンショット ―")

    shots = rows(conn, "SELECT * FROM screenshots ORDER BY video_id, seq, id")
    shot_map = {}
    sent = 0

    for s in shots:

        src = Path(s["image_path"]) if s["image_path"] else None
        storage_path = ""

        if src and src.is_file():
            storage_path = f"{video_map[s['video_id']]}/{src.name}"
            sb.upload("screenshots", storage_path, src.read_bytes())
            sent += 1

            if sent % 25 == 0:
                print(f"  {sent} 枚 …", flush=True)

        body = {
            "video_id": video_map[s["video_id"]],
            "seq": s["seq"],
            "storage_path": storage_path,
            "timestamp_sec": s["timestamp_sec"] or 0,
            "row_height": s["row_height"] or 0,
            "is_manual": bool(s["is_manual"]),
            "reference_role": s["reference_role"] or "",
            "material_feature": s["material_feature"] or "",
            "improvement_note": s["improvement_note"] or "",
            "reference_feedback": s["reference_feedback"] or "",
            "text_raw": s["text_raw"] or "",
            "material": s["material"] or "",
            "role": s["role"] or "",
            "scene_feeling": s["scene_feeling"] or "",
            "feedback": s["feedback"] or "",
            "revised_feedback": s.get("revised_feedback") or "",
            "deleted_at": s["deleted_at"] or None,
        }

        made = sb.insert("screenshots", [body])
        shot_map[s["id"]] = made[0]["id"]

    print(f"  {len(shots)} 行 / 画像 {sent} 枚")

    # ---- 結合したセル -------------------------------------------------------
    merges = []

    for m in rows(conn, "SELECT * FROM cell_merges"):

        if m["video_id"] not in video_map or m["shot_id"] not in shot_map:
            continue

        merges.append({
            "video_id": video_map[m["video_id"]],
            "shot_id": shot_map[m["shot_id"]],
            "field": m["field"],
            "row_span": m["row_span"] or 1,
            "col_span": m["col_span"] or 1,
        })

    sb.insert("cell_merges", merges)
    print(f"  結合したセル {len(merges)} 件")

    # ---- 作業時間・設定・ガイドライン ---------------------------------------
    print()
    print("― のこり ―")

    work = []

    for w in rows(conn, "SELECT * FROM work_time"):
        uid = user_map.get(w["user_id"])
        if not uid or w["project_id"] not in project_map:
            continue
        work.append({
            "project_id": project_map[w["project_id"]],
            "user_id": uid,
            "side": w["side"],
            "day": w["day"],
            "seconds": w["seconds"],
        })

    sb.insert("work_time", work)
    print(f"  作業時間     {len(work)} 行")

    guides = [
        {
            "text": g["text"], "source": g["source"] or "",
            "seen": g["seen"] or 0, "status": g["status"] or "active",
            "sort_order": g["sort_order"] or 0,
            "created_by": user_map.get(g["created_by"]),
        }
        for g in rows(conn, "SELECT * FROM guidelines")
    ]

    sb.insert("guidelines", guides)
    print(f"  ガイドライン {len(guides)} 行")

    prefs = [
        {"key": s["key"], "value": s["value"]}
        for s in rows(conn, "SELECT * FROM settings")
    ]

    sb.insert("settings", prefs)
    print(f"  設定         {len(prefs)} 行")

    conn.close()

    print()
    print("  移し終わりました。")
    print("  もとの data/ はそのまま残してあります。")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
