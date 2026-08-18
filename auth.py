# -*- coding: utf-8 -*-
"""
ログイン（ID + パスワード + Google Authenticator）。

  ・パスワードは pbkdf2 でハッシュ化して保存する（平文では持たない）
  ・2段階目は TOTP（Google Authenticator などの6桁コード）
  ・セッションは 24 時間で切れて、再ログインが必要になる

初回起動時はユーザーが1人もいないので、/setup で管理者を作る。
"""

from __future__ import annotations

import base64
import io
import logging
import os
import secrets
from datetime import datetime, timedelta
from functools import wraps

import pyotp
from flask import (
    Blueprint,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

import config
import db

log = logging.getLogger("auth")

bp = Blueprint("auth", __name__)

# セッションの有効時間。これを過ぎたら必ず再ログイン。
SESSION_HOURS = 24

# 連続失敗への簡易的な待ち時間（総当たり対策）
MAX_FAILS = 5
LOCK_MINUTES = 10

# ログインしていなくても通す場所。
# enroll は「まだログインできない状態」で通る必要があるが、
# session の enroll_uid が無ければ中で弾くので素通しにはならない。
PUBLIC_ENDPOINTS = {
    "auth.login",
    "auth.setup",
    "auth.enroll",
    "auth.logout",
    "static",
}


# ============================================================
# 初期化
# ============================================================

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    -- 画面に出す名前。案件の担当者欄の初期値にも使う。
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    totp_secret   TEXT    NOT NULL DEFAULT '',
    totp_enabled  INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL,
    last_login_at TEXT    NOT NULL DEFAULT ''
);
"""


def init_db() -> None:
    with db.connect() as conn:
        conn.executescript(SCHEMA)

        # 既に users がある環境にも、あとから足した列を入れる
        existing = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }

        for column, definition in {
            "display_name": "TEXT NOT NULL DEFAULT ''",
        }.items():

            if column not in existing:
                conn.execute(
                    f"ALTER TABLE users ADD COLUMN {column} {definition}"
                )

        conn.commit()


def default_display_name(username: str) -> str:
    """表示名が未設定のときの見せ方。ID がメールなら @ の前を使う。"""
    return (username or "").split("@")[0]


def secret_key() -> bytes:
    """
    Cookie の署名に使う鍵。

    毎回作り直すと、サーバーを再起動するたびに全員ログアウトになる。
    ファイルに保存して使い回す。
    """
    config.ensure_dirs()

    path = config.DATA_DIR / "secret_key"

    if path.is_file():
        value = path.read_bytes().strip()
        if len(value) >= 32:
            return value

    value = secrets.token_bytes(48)
    path.write_bytes(value)

    try:
        os.chmod(path, 0o600)
    except OSError:
        pass

    log.info("署名鍵を作成しました: %s", path)

    return value


def has_users() -> bool:
    row = db.query("SELECT COUNT(*) AS n FROM users", one=True)
    return bool(row and row["n"])


# ============================================================
# セッション
# ============================================================

def _now() -> datetime:
    return datetime.now()


def current_user():
    """ログイン中のユーザー。切れていれば None。"""
    uid = session.get("uid")

    if not uid:
        return None

    started = session.get("login_at")

    if not started:
        return None

    try:
        started_at = datetime.fromisoformat(started)
    except ValueError:
        return None

    # Cookie の期限だけに頼らず、サーバー側でも時間を見る
    if _now() - started_at > timedelta(hours=SESSION_HOURS):
        session.clear()
        return None

    return db.query(
        "SELECT * FROM users WHERE id = ?",
        (uid,),
        one=True,
    )


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return redirect(url_for("auth.login", next=request.full_path))
        return view(*args, **kwargs)

    return wrapper


def install(app) -> None:
    """アプリ全体にログイン必須を掛ける。"""
    app.secret_key = secret_key()

    app.config.update(
        PERMANENT_SESSION_LIFETIME=timedelta(hours=SESSION_HOURS),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # HTTPS のときだけ Cookie を送る。http でも使えるよう既定は False。
        SESSION_COOKIE_SECURE=bool(
            os.environ.get("VR_HTTPS")
        ),
    )

    app.register_blueprint(bp)

    @app.before_request
    def _require_login():

        endpoint = request.endpoint or ""

        if endpoint in PUBLIC_ENDPOINTS:
            return None

        # ユーザーが1人もいなければ、まず管理者を作ってもらう
        if not has_users():
            return redirect(url_for("auth.setup"))

        if current_user() is None:

            if request.path.startswith("/api/"):
                return {"ok": False, "error": "ログインが必要です。"}, 401

            return redirect(url_for("auth.login", next=request.full_path))

        return None

    @app.context_processor
    def _inject_user():
        return {"current_user": current_user()}


# ============================================================
# 画面
# ============================================================

def _qr_data_uri(uri: str) -> str:
    """Google Authenticator で読み取る QR を、画像ファイルにせず埋め込む。"""
    import qrcode

    img = qrcode.make(uri)

    buf = io.BytesIO()
    img.save(buf, format="PNG")

    return (
        "data:image/png;base64,"
        + base64.b64encode(buf.getvalue()).decode("ascii")
    )


@bp.route("/setup", methods=["GET", "POST"])
def setup():
    """初回だけ通る、管理者を作る画面。"""
    if has_users():
        return redirect(url_for("auth.login"))

    error = None

    if request.method == "POST":

        username = (request.form.get("username") or "").strip()
        display_name = (request.form.get("display_name") or "").strip()
        password = request.form.get("password") or ""
        confirm = request.form.get("confirm") or ""

        if not username:
            error = "IDを入力してください。"
        elif len(display_name) > 40:
            error = "表示名は40文字までにしてください。"
        elif len(password) < 8:
            error = "パスワードは8文字以上にしてください。"
        elif password != confirm:
            error = "確認用のパスワードが一致しません。"
        else:
            uid = db.execute(
                """
                INSERT INTO users
                    (username, display_name, password_hash,
                     totp_secret, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    username,
                    display_name or default_display_name(username),
                    generate_password_hash(password),
                    pyotp.random_base32(),
                    db.now(),
                ),
            )

            session.clear()
            session["enroll_uid"] = uid

            log.info("管理者を作成しました: %s", username)

            return redirect(url_for("auth.enroll"))

    return render_template("auth_setup.html", error=error)


@bp.route("/enroll", methods=["GET", "POST"])
def enroll():
    """Google Authenticator の登録。QR を読ませて、コードで確認する。"""
    uid = session.get("enroll_uid")

    if not uid:
        return redirect(url_for("auth.login"))

    user = db.query("SELECT * FROM users WHERE id = ?", (uid,), one=True)

    if user is None:
        session.pop("enroll_uid", None)
        return redirect(url_for("auth.login"))

    error = None

    if request.method == "POST":

        code = (request.form.get("code") or "").replace(" ", "")
        display_name = (request.form.get("display_name") or "").strip()[:40]

        if pyotp.TOTP(user["totp_secret"]).verify(code, valid_window=1):

            db.execute(
                """
                UPDATE users
                SET totp_enabled = 1, display_name = ?
                WHERE id = ?
                """,
                (
                    display_name or user["display_name"]
                    or default_display_name(user["username"]),
                    uid,
                ),
            )

            session.pop("enroll_uid", None)
            _start_session(uid)

            log.info("2段階認証を登録しました: %s", user["username"])

            return redirect(url_for("index"))

        error = "コードが違います。アプリに表示されている6桁を入れてください。"

    uri = pyotp.TOTP(user["totp_secret"]).provisioning_uri(
        name=user["username"],
        issuer_name="動画分析",
    )

    return render_template(
        "auth_enroll.html",
        error=error,
        secret=user["totp_secret"],
        qr=_qr_data_uri(uri),
        username=user["username"],
        display_name=(
            user["display_name"] or default_display_name(user["username"])
        ),
    )


@bp.route("/login", methods=["GET", "POST"])
def login():

    if not has_users():
        return redirect(url_for("auth.setup"))

    if current_user() is not None:
        return redirect(url_for("index"))

    error = None
    stage = "password"

    # --- 2段階目（TOTP）---
    pending = session.get("pending_uid")

    if pending:
        stage = "code"

    if request.method == "POST":

        if stage == "code":

            user = db.query(
                "SELECT * FROM users WHERE id = ?",
                (pending,),
                one=True,
            )

            code = (request.form.get("code") or "").replace(" ", "")

            if user and pyotp.TOTP(user["totp_secret"]).verify(
                code, valid_window=1
            ):
                session.pop("pending_uid", None)
                _start_session(user["id"])
                _reset_fails(user["id"])

                return redirect(_safe_next())

            error = "コードが違います。"
            _count_fail(pending)

        else:

            username = (request.form.get("username") or "").strip()
            password = request.form.get("password") or ""

            user = db.query(
                "SELECT * FROM users WHERE username = ?",
                (username,),
                one=True,
            )

            if user and _is_locked(user):
                error = (
                    f"入力を{MAX_FAILS}回間違えたため、"
                    f"しばらくログインできません。"
                )

            elif user and check_password_hash(
                user["password_hash"], password
            ):
                _reset_fails(user["id"])

                if user["totp_enabled"]:
                    session["pending_uid"] = user["id"]
                    stage = "code"
                else:
                    # 2段階目が未登録なら、その場で登録してもらう
                    session["enroll_uid"] = user["id"]
                    return redirect(url_for("auth.enroll"))

            else:
                error = "IDかパスワードが違います。"

                if user:
                    _count_fail(user["id"])

    return render_template(
        "auth_login.html",
        error=error,
        stage=stage,
    )


@bp.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


# ============================================================
# ユーザー管理（チームで使う場合）
# ============================================================

@bp.route("/users", methods=["GET", "POST"])
def users():

    me = current_user()

    if me is None:
        return redirect(url_for("auth.login"))

    error = None
    notice = None

    if request.method == "POST":

        action = request.form.get("action") or ""

        # ---- 追加 ----
        if action == "add":

            username = (request.form.get("username") or "").strip()
            display_name = (request.form.get("display_name") or "").strip()[:40]
            password = request.form.get("password") or ""

            exists = db.query(
                "SELECT id FROM users WHERE username = ?",
                (username,),
                one=True,
            )

            if not username:
                error = "IDを入力してください。"
            elif exists:
                error = f"「{username}」はすでに使われています。"
            elif len(password) < 8:
                error = "パスワードは8文字以上にしてください。"
            else:
                db.execute(
                    """
                    INSERT INTO users
                        (username, display_name, password_hash,
                         totp_secret, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        username,
                        display_name or default_display_name(username),
                        generate_password_hash(password),
                        pyotp.random_base32(),
                        db.now(),
                    ),
                )
                notice = (
                    f"「{username}」を追加しました。"
                    "本人が最初にログインするとき、"
                    "Google Authenticator の登録画面が出ます。"
                )
                log.info("ユーザーを追加: %s (by %s)", username, me["username"])

        # ---- 表示名を直す ----
        elif action == "rename":

            uid = request.form.get("uid", type=int)
            display_name = (request.form.get("display_name") or "").strip()[:40]

            target = db.query(
                "SELECT * FROM users WHERE id = ?", (uid,), one=True
            )

            if target is None:
                error = "そのユーザーはいません。"
            elif not display_name:
                error = "表示名を入力してください。"
            else:
                db.execute(
                    "UPDATE users SET display_name = ? WHERE id = ?",
                    (display_name, uid),
                )
                notice = f"表示名を「{display_name}」にしました。"

        # ---- パスワード再設定 ----
        elif action == "password":

            uid = request.form.get("uid", type=int)
            password = request.form.get("password") or ""

            if len(password) < 8:
                error = "パスワードは8文字以上にしてください。"
            else:
                db.execute(
                    """
                    UPDATE users
                    SET password_hash = ?, fail_count = 0, locked_until = ''
                    WHERE id = ?
                    """,
                    (generate_password_hash(password), uid),
                )
                notice = "パスワードを変更しました。"
                log.info("パスワードを変更: uid=%s (by %s)", uid, me["username"])

        # ---- 2段階認証のリセット（機種変更・紛失時）----
        elif action == "reset_totp":

            uid = request.form.get("uid", type=int)

            db.execute(
                """
                UPDATE users
                SET totp_secret = ?, totp_enabled = 0
                WHERE id = ?
                """,
                (pyotp.random_base32(), uid),
            )
            notice = (
                "2段階認証をリセットしました。"
                "次回ログイン時に登録画面が出ます。"
            )
            log.info("TOTPをリセット: uid=%s (by %s)", uid, me["username"])

        # ---- 削除 ----
        elif action == "delete":

            uid = request.form.get("uid", type=int)

            if uid == me["id"]:
                error = "自分自身は削除できません。"
            elif db.query("SELECT COUNT(*) AS n FROM users", one=True)["n"] <= 1:
                error = "最後のひとりは削除できません。"
            else:
                target = db.query(
                    "SELECT username FROM users WHERE id = ?", (uid,), one=True
                )
                db.execute("DELETE FROM users WHERE id = ?", (uid,))
                notice = f"「{target['username'] if target else uid}」を削除しました。"
                log.info("ユーザーを削除: uid=%s (by %s)", uid, me["username"])

    rows = db.query(
        """
        SELECT id, username, totp_enabled, created_at, last_login_at
        FROM users
        ORDER BY id
        """
    )

    return render_template(
        "auth_users.html",
        users=rows,
        me=me,
        error=error,
        notice=notice,
    )


# ============================================================
# 補助
# ============================================================

def _start_session(uid: int) -> None:
    session.clear()
    session.permanent = True
    session["uid"] = uid
    session["login_at"] = _now().isoformat(timespec="seconds")

    db.execute(
        "UPDATE users SET last_login_at = ? WHERE id = ?",
        (db.now(), uid),
    )


def _safe_next() -> str:
    """
    ログイン後の戻り先。

    外部サイトへ飛ばされないよう、自分のサイト内のパスだけ許す。
    """
    target = request.args.get("next") or ""

    if target.startswith("/") and not target.startswith("//"):
        return target

    return url_for("index")


def _is_locked(user) -> bool:
    until = user["locked_until"]

    if not until:
        return False

    try:
        return datetime.fromisoformat(until) > _now()
    except ValueError:
        return False


def _count_fail(uid: int) -> None:
    row = db.query(
        "SELECT fail_count FROM users WHERE id = ?", (uid,), one=True
    )

    n = (row["fail_count"] if row else 0) + 1

    locked = ""

    if n >= MAX_FAILS:
        locked = (
            _now() + timedelta(minutes=LOCK_MINUTES)
        ).isoformat(timespec="seconds")
        n = 0

    db.execute(
        "UPDATE users SET fail_count = ?, locked_until = ? WHERE id = ?",
        (n, locked, uid),
    )


def _reset_fails(uid: int) -> None:
    db.execute(
        "UPDATE users SET fail_count = 0, locked_until = '' WHERE id = ?",
        (uid,),
    )
