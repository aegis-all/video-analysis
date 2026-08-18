# -*- coding: utf-8 -*-
"""
HTTPS 用の証明書を作る（自己署名）。

    python make_cert.py

data/cert/ に server.crt と server.key を作る。
社内で使う分にはこれで十分だが、正式な認証局の署名ではないので
ブラウザは初回に警告を出す（「詳細設定」→「アクセスする」で進める）。
警告を消したい場合は README の「証明書を信頼させる」を参照。
"""

import datetime
import ipaddress
import socket
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import config


def local_ips() -> list[str]:
    ips = {"127.0.0.1"}

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addr = info[4][0]
            if ":" not in addr:
                ips.add(addr)
    except OSError:
        pass

    return sorted(ips)


def main() -> int:
    config.ensure_dirs()

    out = config.DATA_DIR / "cert"
    out.mkdir(parents=True, exist_ok=True)

    crt = out / "server.crt"
    key = out / "server.key"

    if crt.is_file() and key.is_file() and "--force" not in sys.argv:
        print(f"すでにあります: {crt}")
        print("作り直すには --force を付けてください。")
        return 0

    host = socket.gethostname()
    ips = local_ips()

    print("証明書を作ります…")
    print(f"  ホスト名 : {host}")
    print(f"  IP       : {', '.join(ips)}")

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, host),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "video-review"),
    ])

    alt = [x509.DNSName(host), x509.DNSName("localhost")]
    alt += [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]

    now = datetime.datetime.now(datetime.timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(private.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None), critical=True
        )
        .sign(private, hashes.SHA256())
    )

    key.write_bytes(
        private.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )

    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))

    print()
    print(f"  作成しました: {crt}")
    print(f"                {key}")
    print()
    print("  有効期限: 約2年")
    print("  start_hidden.vbs / start.bat から https で起動されます。")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
