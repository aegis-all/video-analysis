#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
auto_screenshot.py
==================
ショート動画広告（9:16 / 約60秒）から、

  1. テロップ（字幕）が切り替わった瞬間
  2. 背景シーンが切り替わった瞬間

を自動検出して、スクリーンショットを output/ に連番で保存する。

    python auto_screenshot.py video.mp4

出力は output/1.png, 2.png, 3.png … だけ。

詳細は README.md を参照。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import tempfile
import time
from collections import deque
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover
    sys.stderr.write("opencv-python が必要です:  python -m pip install -r requirements.txt\n")
    raise

__version__ = "2.0.0"

_VERBOSE = False


# ======================================================================================
# ログ
# ======================================================================================

def log(msg: str = "") -> None:
    print(msg, flush=True)


def vlog(msg: str) -> None:
    if _VERBOSE:
        print(f"  [debug] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"  [warn] {msg}", flush=True)


def _setup_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except Exception:
            pass


# ======================================================================================
# 設定
# ======================================================================================

@dataclass
class Config:
    video: Path
    output: Path

    # 検出
    sensitivity: float = 0.30
    telop_sensitivity: float = 0.20
    telop_floor: float = 0.18    # しきい値の絶対的な下限。これ未満には決して下がらない
    telop_strip: float = 0.045
    telop_bands: list[tuple[float, float]] = field(default_factory=lambda: [(0.06, 0.97)])
    analyze_fps: float = 10.0
    min_gap: float = 0.40
    settle_steps: int = 2
    max_settle: float = 0.80
    baseline_sec: float = 3.0
    start: float = 0.0
    end: float = 0.0
    max_frames: int = 0
    dedup: float = 0.12          # 直前のコマとの相違度がこれ未満なら重複とみなす。0 で無効

    # 画像
    auto_crop: bool = False
    crop: tuple[int, int, int, int] | None = None
    img_format: str = "png"
    jpeg_quality: int = 92
    max_width: int = 0
    zero_pad: int = 0
    keep_old_images: bool = False

    # その他
    contact_sheet: bool = False
    debug_csv: Path | None = None
    index_json: Path | None = None
    work_width: int = 480


# ======================================================================================
# 引数
# ======================================================================================

def parse_bands(text: str) -> list[tuple[float, float]]:
    """'0.06-0.97' や '0-0.2,0.8-1.0' を [(0.06,0.97)] 形式へ。"""
    bands: list[tuple[float, float]] = []
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*-\s*([0-9]*\.?[0-9]+)", chunk)
        if not m:
            raise argparse.ArgumentTypeError(
                f"--telop-bands の書式が不正です: {chunk!r}（例 0.06-0.97 / 0-0.2,0.8-1.0）")
        a, b = float(m.group(1)), float(m.group(2))
        if not (0.0 <= a < b <= 1.0):
            raise argparse.ArgumentTypeError(f"--telop-bands の範囲が不正です: {chunk!r}")
        bands.append((a, b))
    if not bands:
        raise argparse.ArgumentTypeError("--telop-bands が空です")
    return bands


def parse_crop(text: str) -> tuple[int, int, int, int]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4 or not all(p.lstrip("-").isdigit() for p in parts):
        raise argparse.ArgumentTypeError("--crop は 'x,y,w,h'（ピクセル）で指定してください")
    x, y, w, h = (int(p) for p in parts)
    if w <= 0 or h <= 0:
        raise argparse.ArgumentTypeError("--crop の w,h は正の値にしてください")
    return x, y, w, h


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="auto_screenshot.py",
        description="ショート動画のテロップ変化／シーン変化を自動検出してスクショを連番保存する",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("video", nargs="+", help="入力動画ファイル（複数可）")
    p.add_argument("-o", "--output-folder", default="./output", help="出力フォルダ")

    g = p.add_argument_group("検出")
    g.add_argument("--sensitivity", type=float, default=0.30,
                   help="シーン変化のしきい値（低い=敏感）")
    g.add_argument("--telop-sensitivity", type=float, default=0.20,
                   help="テロップ変化のしきい値（低い=敏感）。直近の背景ノイズを基準に自動補正される")
    g.add_argument("--telop-floor", type=float, default=0.18,
                   help="テロップしきい値の絶対的な下限。--telop-sensitivity をいくら下げても "
                        "ここより敏感にはならない。取りこぼしが残るならこれも下げる")
    g.add_argument("--telop-strip", type=float, default=0.045,
                   help="テロップ変化を測る横帯の高さ（画面高比）。テロップ1行の半分程度が目安")
    g.add_argument("--telop-bands", default="0.06-0.97",
                   help="テロップを探す縦範囲（画面高に対する割合）")
    g.add_argument("--analyze-fps", type=float, default=10.0, help="解析フレームレート（間引き）")
    g.add_argument("--min-gap", type=float, default=0.40, help="連続検出の最小間隔（秒）")
    g.add_argument("--settle-steps", type=int, default=2,
                   help="変化後この回数ぶん静止したら撮影（アニメ途中の撮影を防ぐ）")
    g.add_argument("--max-settle", type=float, default=0.80, help="静止を待つ上限（秒）")
    g.add_argument("--baseline-sec", type=float, default=3.0,
                   help="テロップ変化の基準値を取る直近秒数（カメラ揺れの吸収に使う）。"
                        "0 で自動補正を無効化し、--telop-floor だけで判定する")
    g.add_argument("--dedup", type=float, default=0.12,
                   help="直前のコマとの相違度がこの値未満なら重複として捨てる。0 で無効")
    g.add_argument("--start", type=float, default=0.0, help="解析開始秒")
    g.add_argument("--end", type=float, default=0.0, help="解析終了秒（0=最後まで）")
    g.add_argument("--max-frames", type=int, default=0, help="最大スクショ枚数（0=無制限）")

    g = p.add_argument_group("画像")
    g.add_argument("--auto-crop", action="store_true", help="黒枠を自動検出してトリミング")
    g.add_argument("--crop", type=parse_crop, default=None, help="手動トリミング 'x,y,w,h'")
    g.add_argument("--format", dest="img_format", choices=("png", "jpg"), default="png",
                   help="保存形式")
    g.add_argument("--jpeg-quality", type=int, default=92, help="--format jpg のときの品質")
    g.add_argument("--max-width", type=int, default=0, help="保存画像の最大幅（0=原寸）")
    g.add_argument("--zero-pad", type=int, default=0,
                   help="連番の桁数をそろえる（3 なら 001.png）。0 なら 1.png")
    g.add_argument("--keep-old-images", action="store_true",
                   help="出力フォルダに残っている前回のスクショを削除しない")

    g = p.add_argument_group("その他")
    g.add_argument("--contact-sheet", action="store_true", help="一覧サムネイル画像も出力")
    g.add_argument("--index-json", default=None,
                   help="どの画像が動画の何秒地点かを JSON で書き出す。"
                        "指定したときだけ作成され、画像の出力内容は変わらない")
    g.add_argument("--debug-csv", default=None,
                   help="全解析フレームのスコアとしきい値を CSV に書き出す。"
                        "「この瞬間が撮れない」原因を数字で確認できる")
    g.add_argument("-v", "--verbose", action="store_true", help="詳細ログ")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def config_from_args(argv: Sequence[str] | None = None) -> tuple[Config, list[Path]]:
    args = build_parser().parse_args(argv)
    global _VERBOSE
    _VERBOSE = args.verbose

    videos = [Path(v).expanduser() for v in args.video]
    cfg = Config(
        video=videos[0],
        output=Path(args.output_folder).expanduser(),
        sensitivity=args.sensitivity,
        telop_sensitivity=args.telop_sensitivity,
        telop_floor=max(0.0, args.telop_floor),
        telop_strip=max(0.005, args.telop_strip),
        telop_bands=parse_bands(args.telop_bands),
        analyze_fps=max(1.0, args.analyze_fps),
        min_gap=max(0.0, args.min_gap),
        settle_steps=max(0, args.settle_steps),
        max_settle=max(0.0, args.max_settle),
        baseline_sec=max(0.0, args.baseline_sec),
        dedup=max(0.0, args.dedup),
        start=max(0.0, args.start),
        end=max(0.0, args.end),
        max_frames=max(0, args.max_frames),
        auto_crop=args.auto_crop,
        crop=args.crop,
        img_format=args.img_format,
        jpeg_quality=args.jpeg_quality,
        max_width=max(0, args.max_width),
        zero_pad=max(0, args.zero_pad),
        keep_old_images=args.keep_old_images,
        contact_sheet=args.contact_sheet,
        debug_csv=Path(args.debug_csv).expanduser() if args.debug_csv else None,
        index_json=Path(args.index_json).expanduser() if args.index_json else None,
    )
    return cfg, videos


# ======================================================================================
# 画像ユーティリティ
# ======================================================================================

def imwrite_unicode(path: Path, img: np.ndarray, *, jpeg_quality: int = 92) -> bool:
    """cv2.imwrite は Windows の日本語パスに書けないため imencode 経由で保存する。"""
    ext = path.suffix.lower()
    params: list[int] = []
    if ext in (".jpg", ".jpeg"):
        params = [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_quality)]
    elif ext == ".png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 6]
    ok, buf = cv2.imencode(ext, img, params)
    if not ok:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.tobytes())
    return True


def open_video(path: Path) -> tuple[cv2.VideoCapture, Path | None]:
    """VideoCapture を開く。日本語パスで失敗する環境では ASCII 一時コピーへ退避する。"""
    cap = cv2.VideoCapture(str(path))
    if cap.isOpened():
        return cap, None
    cap.release()
    try:
        str(path).encode("ascii")
    except UnicodeEncodeError:
        tmp_dir = Path(tempfile.mkdtemp(prefix="auto_ss_"))
        tmp = tmp_dir / f"input{path.suffix or '.mp4'}"
        warn(f"日本語パスのため一時ファイルへコピーします: {tmp}")
        shutil.copy2(path, tmp)
        cap = cv2.VideoCapture(str(tmp))
        if cap.isOpened():
            return cap, tmp_dir
        cap.release()
        shutil.rmtree(tmp_dir, ignore_errors=True)
    raise SystemExit(f"動画を開けませんでした: {path}")


def apply_crop(frame: np.ndarray, crop: tuple[int, int, int, int] | None) -> np.ndarray:
    if crop is None:
        return frame
    x, y, w, h = crop
    return frame[y:y + h, x:x + w]


def detect_letterbox(cap: cv2.VideoCapture, total: int, samples: int = 24,
                     thresh: int = 18) -> tuple[int, int, int, int] | None:
    """複数フレームの最大輝度から、常に真っ黒な上下左右の帯を検出する。"""
    if total <= 0:
        return None
    idxs = np.linspace(0, max(0, total - 1), num=min(samples, total), dtype=int)
    acc: np.ndarray | None = None
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, frame = cap.read()
        if not ok:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        acc = gray if acc is None else np.maximum(acc, gray)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    if acc is None:
        return None
    h, w = acc.shape
    rows = acc.max(axis=1) > thresh
    cols = acc.max(axis=0) > thresh
    if not rows.any() or not cols.any():
        return None
    y0, y1 = int(np.argmax(rows)), int(h - np.argmax(rows[::-1]))
    x0, x1 = int(np.argmax(cols)), int(w - np.argmax(cols[::-1]))
    cw, ch = x1 - x0, y1 - y0
    if cw <= 0 or ch <= 0:
        return None
    if cw * ch < 0.4 * w * h:
        warn("自動トリミングが画面の6割以上を削るため無効化しました")
        return None
    if (x0, y0, cw, ch) == (0, 0, w, h):
        return None
    return x0, y0, cw - cw % 2, ch - ch % 2


def band_slices(height: int, bands: Iterable[tuple[float, float]]) -> list[tuple[int, int]]:
    out = []
    for a, b in bands:
        y0 = max(0, min(height - 1, int(round(a * height))))
        y1 = max(y0 + 1, min(height, int(round(b * height))))
        out.append((y0, y1))
    return out


def band_mask(height: int, bands: list[tuple[int, int]]) -> np.ndarray:
    keep = np.zeros(height, bool)
    for y0, y1 in bands:
        keep[y0:y1] = True
    return keep


# ======================================================================================
# 変化シグナル
# ======================================================================================

_EDGE_DILATE = np.ones((3, 3), np.uint8)


def edge_map(gray_band: np.ndarray) -> np.ndarray:
    """テロップ帯のエッジ画像。局所コントラストを均してから Canny をかける。"""
    eq = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray_band)
    return cv2.Canny(eq, 70, 170)


def _row_cumsum(mask: np.ndarray) -> np.ndarray:
    counts = np.count_nonzero(mask, axis=1).astype(np.int64)
    out = np.zeros(counts.size + 1, np.int64)
    np.cumsum(counts, out=out[1:])
    return out


def edge_change(a: np.ndarray, b: np.ndarray, strip_h: int, min_edges: int) -> float:
    """
    2枚のエッジ画像の相違度（0-1）。

    画面全体で平均すると、テロップの入れ替わり（画面の一部が総取っ替え）が
    背景の細かい変化に薄められてしまう。そこで横ストリップに切り、
    「もっとも大きく変わった帯」の変化率を採用する。
    テロップ差し替えは局所的に 1.0 近くまで振れる一方、手ブレは全体が中程度に留まるため、
    両者をはっきり分離できる。

    1px の手ブレを変化と数えないよう、相手側を1画素膨張させてから
    「相手に対応するエッジが無い画素」を数える。
    """
    ad = cv2.dilate(a, _EDGE_DILATE)
    bd = cv2.dilate(b, _EDGE_DILATE)
    lost = cv2.bitwise_and(a, cv2.bitwise_not(bd))
    gain = cv2.bitwise_and(b, cv2.bitwise_not(ad))
    ca, cb = _row_cumsum(a), _row_cumsum(b)
    cl, cg = _row_cumsum(lost), _row_cumsum(gain)

    h = a.shape[0]
    strip_h = max(4, strip_h)
    best = 0.0
    # テロップ行が2つのストリップにまたがって薄まらないよう、半分ずらした系列も見る
    for offset in (0, strip_h // 2):
        for y0 in range(offset, h, strip_h):
            y1 = min(h, y0 + strip_h)
            if y1 - y0 < strip_h // 2:
                continue
            den = max(int(ca[y1] - ca[y0]), int(cb[y1] - cb[y0]))
            if den < min_edges:
                continue
            changed = int(cl[y1] - cl[y0]) + int(cg[y1] - cg[y0])
            best = max(best, min(1.0, changed / (2.0 * den)))
    return best


def hist_distance(a: np.ndarray, b: np.ndarray) -> float:
    """HSV ヒストグラムの Bhattacharyya 距離（0-1）。"""
    ha = cv2.calcHist([a], [0, 1], None, [32, 32], [0, 180, 0, 256])
    hb = cv2.calcHist([b], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(ha, ha)
    cv2.normalize(hb, hb)
    return float(cv2.compareHist(ha, hb, cv2.HISTCMP_BHATTACHARYYA))


# ======================================================================================
# 検出
# ======================================================================================

@dataclass
class Shot:
    frame_index: int
    ts: float
    kind: str                 # start | subtitle | scene
    image: np.ndarray = field(repr=False)
    edges: np.ndarray = field(repr=False, default=None)  # type: ignore[assignment]


def timestamp_label(sec: float) -> str:
    m, s = divmod(max(0.0, sec), 60.0)
    return f"{int(m):02d}:{s:06.3f}"


def detect_shots(cfg: Config, cap: cv2.VideoCapture, fps: float, total: int) -> list[Shot]:
    """動画を1パス走査して、撮影すべきフレームを集める。"""
    step = max(1, int(round(fps / cfg.analyze_fps)))
    start_idx = int(round(cfg.start * fps))
    end_idx = int(round(cfg.end * fps)) if cfg.end > 0 else (total if total > 0 else 1 << 30)
    min_gap_idx = int(round(cfg.min_gap * fps))
    max_settle_idx = int(round(cfg.max_settle * fps))
    baseline_n = max(5, int(round(cfg.baseline_sec * cfg.analyze_fps)))

    shots: list[Shot] = []
    debug_rows: list[tuple] = []
    history: deque[float] = deque(maxlen=baseline_n)
    prev_small: np.ndarray | None = None
    prev_edges: np.ndarray | None = None
    pending: dict | None = None
    last_capture_idx = -(1 << 30)
    idx = -1
    processed = 0
    next_report = 0.1
    t_start = time.time()

    while True:
        if not cap.grab():
            break
        idx += 1
        if idx < start_idx:
            continue
        if idx >= end_idx:
            break
        if (idx - start_idx) % step:
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break

        frame = apply_crop(frame, cfg.crop)
        ts = idx / fps
        processed += 1

        wh = max(1, int(round(frame.shape[0] * cfg.work_width / frame.shape[1])))
        small = cv2.resize(frame, (cfg.work_width, wh), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        rows = band_mask(wh, band_slices(wh, cfg.telop_bands))
        band = gray.copy()
        band[~rows] = 0
        edges = edge_map(band)
        strip_h = max(6, int(round(cfg.telop_strip * wh)))
        min_edges = max(60, int(0.006 * strip_h * cfg.work_width))

        if prev_small is None:
            shots.append(Shot(idx, ts, "start", frame.copy(), edges))
            last_capture_idx = idx
            prev_small, prev_edges = small, edges
            vlog(f"{timestamp_label(ts)} 先頭フレームを保存")
            continue

        pix = min(1.0, float(np.mean(cv2.absdiff(small, prev_small))) / 255.0 * 3.0)
        scene_score = min(1.0, 0.75 * hist_distance(small, prev_small) + 0.25 * pix)
        telop_score = edge_change(edges, prev_edges, strip_h, min_edges)

        # 直近のエッジ変化（＝カメラ揺れや人の動き）を基準線として差し引く。
        # --baseline-sec 0 で無効化でき、そのときは --telop-floor だけで判定する。
        if cfg.baseline_sec > 0 and len(history) >= 5:
            baseline = float(np.median(history))
        else:
            baseline = 0.0
        telop_thresh = max(baseline + cfg.telop_sensitivity * (1.0 - baseline), cfg.telop_floor)
        history.append(telop_score)

        event = ""
        if pending is None:
            trig_scene = scene_score > cfg.sensitivity
            trig_telop = telop_score > telop_thresh
            if trig_scene or trig_telop:
                if (idx - last_capture_idx) < min_gap_idx:
                    event = "skipped_min_gap"     # しきい値は超えたが --min-gap で捨てた
                    vlog(f"{timestamp_label(ts)} しきい値超えだが --min-gap で無視 "
                         f"(telop={telop_score:.3f} > {telop_thresh:.3f})")
                else:
                    pending = {"t0": idx, "quiet": 0,
                               "kind": "scene" if trig_scene else "subtitle",
                               "calm_scene": cfg.sensitivity * 0.5,
                               "calm_telop": max(0.10, telop_thresh * 0.5)}
                    event = "trigger"
                    vlog(f"{timestamp_label(ts)} 変化 kind={pending['kind']} "
                         f"scene={scene_score:.3f} telop={telop_score:.3f} (>{telop_thresh:.3f})")
        else:
            if scene_score > cfg.sensitivity:
                pending["kind"] = "scene"
            calm = scene_score < pending["calm_scene"] and telop_score < pending["calm_telop"]
            pending["quiet"] = pending["quiet"] + 1 if calm else 0
            timed_out = (idx - pending["t0"]) >= max_settle_idx
            if pending["quiet"] >= cfg.settle_steps or timed_out:
                shots.append(Shot(idx, ts, pending["kind"], frame.copy(), edges))
                last_capture_idx = idx
                event = "capture"
                vlog(f"{timestamp_label(ts)} 撮影 #{len(shots)} kind={pending['kind']}"
                     f"{' (settle timeout)' if timed_out else ''}")
                pending = None
                if cfg.max_frames and len(shots) >= cfg.max_frames:
                    log(f"      --max-frames {cfg.max_frames} に達したため打ち切ります")
                    break
            else:
                event = "settling"

        if cfg.debug_csv is not None:
            debug_rows.append((f"{ts:.3f}", f"{scene_score:.4f}", f"{telop_score:.4f}",
                               f"{telop_thresh:.4f}", f"{baseline:.4f}", event))

        prev_small, prev_edges = small, edges
        if total > 0 and idx / total >= next_report:
            log(f"      {idx / total * 100:5.1f}%  ({len(shots)} 枚 / {time.time() - t_start:.0f}s)")
            next_report += 0.1

    if cfg.debug_csv is not None:
        cfg.debug_csv.parent.mkdir(parents=True, exist_ok=True)
        with cfg.debug_csv.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["秒", "scene_score", "telop_score", "telop_threshold",
                        "baseline", "event"])
            w.writerows(debug_rows)
        log(f"      検出スコアを書き出しました: {cfg.debug_csv}")

    vlog(f"解析フレーム数 {processed}（step={step}）")
    return shots


def dedup_shots(cfg: Config, shots: list[Shot]) -> list[Shot]:
    """
    ほぼ同じ絵が続けて撮れてしまった分をまとめる。

    背景が少し動いただけで撮影が走ることがあるため、撮ったコマ同士を
    検出と同じエッジ指標で比べ、相違度が小さければ後から来た方を捨てる。
    """
    if cfg.dedup <= 0 or len(shots) < 2:
        return shots
    kept = [shots[0]]
    for s in shots[1:]:
        prev = kept[-1]
        if prev.edges is None or s.edges is None:
            kept.append(s)
            continue
        h = s.edges.shape[0]
        strip_h = max(6, int(round(cfg.telop_strip * h)))
        min_edges = max(60, int(0.006 * strip_h * cfg.work_width))
        diff = edge_change(s.edges, prev.edges, strip_h, min_edges)
        if diff < cfg.dedup:
            vlog(f"{timestamp_label(s.ts)} 直前とほぼ同じ（{diff:.3f}）ため除外")
            continue
        kept.append(s)
    return kept


# ======================================================================================
# 出力
# ======================================================================================

_OUR_IMAGE_RE = re.compile(r"^\d+\.(png|jpg)$")


def purge_old_images(cfg: Config) -> int:
    """
    前回の実行で出力したスクショを消す。

    枚数が減ったときに古い連番が残ると、どれが今回の結果か分からなくなる。
    削除するのは本ツールの命名規則（数字だけのファイル名）に一致するものだけで、
    ユーザーが置いた他のファイルには触れない。
    """
    if not cfg.output.is_dir():
        return 0
    n = 0
    for p in cfg.output.iterdir():
        if p.is_file() and _OUR_IMAGE_RE.match(p.name):
            try:
                p.unlink()
                n += 1
            except OSError as exc:
                warn(f"古い画像を削除できませんでした: {p.name} ({exc})")
    return n


def save_images(cfg: Config, shots: list[Shot]) -> list[tuple[Path, Shot]]:
    """保存できた画像と、その元になった Shot の対応を返す。"""
    ext = ".png" if cfg.img_format == "png" else ".jpg"
    saved: list[tuple[Path, Shot]] = []
    for i, s in enumerate(shots, start=1):
        img = s.image
        if cfg.max_width and img.shape[1] > cfg.max_width:
            k = cfg.max_width / img.shape[1]
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        name = (f"{i:0{cfg.zero_pad}d}" if cfg.zero_pad else str(i)) + ext
        path = cfg.output / name
        if imwrite_unicode(path, img, jpeg_quality=cfg.jpeg_quality):
            saved.append((path, s))
        else:
            warn(f"画像を保存できませんでした: {name}")
    return saved


def write_index_json(cfg: Config, saved: list[tuple[Path, "Shot"]],
                     video_duration: float) -> None:
    """
    どの画像が動画の何秒地点かを JSON に書き出す。

    ファイル名は連番だけなので、画像だけを見ても時刻が分からない。
    後段のツール（レビュー用 Web アプリなど）が時刻を必要とするため、
    保存した画像と Shot.ts の対応をここで確定させて残す。
    --index-json を付けたときだけ作成し、画像の出力内容には影響しない。
    """
    assert cfg.index_json is not None
    items = []
    for seq, (path, shot) in enumerate(saved, start=1):
        items.append({
            "seq": seq,
            "file": path.name,
            "timestamp_sec": round(shot.ts, 3),
            "timestamp": timestamp_label(shot.ts),
            "type": shot.kind,
            "frame_index": shot.frame_index,
        })
    payload = {
        "video": str(cfg.video),
        "video_name": cfg.video.stem,
        "duration_sec": round(video_duration, 3),
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "tool_version": __version__,
        "count": len(items),
        "screenshots": items,
    }
    cfg.index_json.parent.mkdir(parents=True, exist_ok=True)
    cfg.index_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    log(f"      時刻インデックスを書き出しました: {cfg.index_json}")


def make_contact_sheet(cfg: Config, shots: list[Shot], cols: int = 8, cell_w: int = 180) -> None:
    if not shots:
        return
    thumbs = []
    for s in shots:
        k = cell_w / s.image.shape[1]
        thumbs.append(cv2.resize(s.image, None, fx=k, fy=k, interpolation=cv2.INTER_AREA))
    cell_h = max(t.shape[0] for t in thumbs)
    rows = (len(thumbs) + cols - 1) // cols
    sheet = np.zeros((rows * (cell_h + 18), cols * cell_w, 3), np.uint8)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        y, x = r * (cell_h + 18), c * cell_w
        sheet[y:y + t.shape[0], x:x + t.shape[1]] = t
        cv2.putText(sheet, f"{i + 1}  {timestamp_label(shots[i].ts)}",
                    (x + 4, y + t.shape[0] + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.38,
                    (255, 255, 255), 1, cv2.LINE_AA)
    imwrite_unicode(cfg.output / "contact_sheet.jpg", sheet, jpeg_quality=85)


def sanitize_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", str(name)).strip()[:120] or "video"


# ======================================================================================
# 1本ぶんの処理
# ======================================================================================

def process_video(cfg: Config) -> int:
    """成功したら保存枚数、失敗したら 0 を返す。"""
    cfg.output.mkdir(parents=True, exist_ok=True)

    log(f"[1/3] 動画を読み込み中: {cfg.video}")
    cap, tmp_dir = open_video(cfg.video)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        log(f"      {width}x{height} / {fps:.3f} fps / {total} frames / "
            f"{(total / fps if total else 0):.2f} 秒")

        if cfg.auto_crop and cfg.crop is None:
            crop = detect_letterbox(cap, total)
            if crop:
                cfg.crop = crop
                log(f"      黒枠を検出: x={crop[0]} y={crop[1]} w={crop[2]} h={crop[3]}")
            else:
                log("      黒枠は検出されませんでした（トリミングなし）")
        elif cfg.crop:
            log(f"      手動トリミング: {cfg.crop}")

        bands_pct = ", ".join(f"{a:.0%}-{b:.0%}" for a, b in cfg.telop_bands)
        log(f"[2/3] 変化を検出中（帯 {bands_pct} / scene>{cfg.sensitivity} / "
            f"telop>{cfg.telop_sensitivity}(適応)）")
        t0 = time.time()
        shots = detect_shots(cfg, cap, fps, total)
        log(f"      {len(shots)} 枚を検出（{time.time() - t0:.1f}s）")
    finally:
        cap.release()
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    if not shots:
        warn("1枚も検出できませんでした。--telop-sensitivity を下げてください")
        return 0

    log("[3/3] 保存中")
    before = len(shots)
    shots = dedup_shots(cfg, shots)
    if before != len(shots):
        log(f"      ほぼ同じコマを {before - len(shots)} 枚除外 → {len(shots)} 枚")

    if not cfg.keep_old_images:
        removed = purge_old_images(cfg)
        if removed:
            log(f"      前回のスクショ {removed} 枚を削除しました")
    saved = save_images(cfg, shots)
    if cfg.contact_sheet:
        make_contact_sheet(cfg, shots)
    if cfg.index_json is not None:
        write_index_json(cfg, saved, (total / fps) if total else 0.0)
    return len(saved)


# ======================================================================================
# main
# ======================================================================================

def main(argv: Sequence[str] | None = None) -> int:
    _setup_console()
    cfg, videos = config_from_args(argv)

    missing = [v for v in videos if not v.is_file()]
    if missing:
        for v in missing:
            sys.stderr.write(f"入力ファイルが見つかりません: {v}\n")
        return 2

    log(f"auto_screenshot v{__version__}")
    t_all = time.time()
    total_saved = 0
    ok_count = 0

    for i, video in enumerate(videos, start=1):
        if len(videos) > 1:
            log("")
            log("─" * 64)
            log(f" [{i}/{len(videos)}] {video.name}")
            log("─" * 64)
        job = replace(cfg, video=video, crop=cfg.crop)
        if len(videos) > 1:
            # 動画ごとにフォルダを分けて、連番が混ざらないようにする
            job.output = cfg.output / sanitize_name(video.stem)

        t_one = time.time()
        try:
            n = process_video(job)
        except SystemExit as exc:
            warn(str(exc))
            continue
        if not n:
            continue
        ok_count += 1
        total_saved += n
        ext = "png" if cfg.img_format == "png" else "jpg"
        num = (lambda k: f"{k:0{cfg.zero_pad}d}") if cfg.zero_pad else str
        log("")
        log("=" * 64)
        log(f" 完了: {n} 枚  →  {job.output.resolve()}")
        log(f"        {num(1)}.{ext} 〜 {num(n)}.{ext}")
        log(f" 所要時間: {time.time() - t_one:.1f}s")
        log("=" * 64)

    if len(videos) > 1:
        log("")
        log(f"すべて完了: {ok_count}/{len(videos)} 本 / 合計 {total_saved} 枚 / "
            f"{time.time() - t_all:.1f}s")
    return 0 if ok_count == len(videos) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.stderr.write("\n中断しました\n")
        raise SystemExit(130)
