# -*- coding: utf-8 -*-
"""
本番用の起動スクリプト。

Flask 付属の開発サーバーは同時アクセスや長時間の運用に向かないため、
公開して使うときはこちらを使う。

    python serve.py

環境変数
    VR_PORT           待ち受けポート（既定 5000）
    VR_BEHIND_PROXY   nginx / Caddy の後ろに置くなら 1
    VR_HTTPS          Cookie を https 限定にするなら 1
"""

import os

from waitress import serve

import app as application


def main() -> None:
    # Render など PaaS は PORT を渡してくる
    port = int(os.environ.get("PORT") or os.environ.get("VR_PORT", "5000"))

    behind = bool(os.environ.get("VR_BEHIND_PROXY"))

    # 同じ機械の nginx の後ろなら 127.0.0.1 でよいが、
    # PaaS は外側のネットワークから来るので 0.0.0.0 で待つ必要がある。
    # VR_BIND で明示できるようにしておく。
    host = os.environ.get("VR_BIND") or (
        "127.0.0.1" if behind else "0.0.0.0"
    )

    print("=" * 60)
    print(" 動画分析（本番用サーバー）")
    print("=" * 60)
    print(f"  待ち受け      : {host}:{port}")
    print(f"  プロキシ配下  : {'はい' if behind else 'いいえ'}")
    print(f"  Cookie https  : {'限定' if os.environ.get('VR_HTTPS') else '限定しない'}")
    print("=" * 60)

    serve(
        application.app,
        host=host,
        port=port,
        threads=8,
        # 動画のアップロードに時間がかかるので長めに取る
        channel_timeout=1200,
    )


if __name__ == "__main__":
    main()
