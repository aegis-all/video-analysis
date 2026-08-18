/* ============================================================
   テロップ・場面の変わり目を見つける（ブラウザ版）

   auto_screenshot.py の detect_shots をそのまま移したもの。
   同じ結果が出ることを確かめながら書いている。

   Python 版との違いは動画の読み方だけ。
   あちらは1コマずつ順に読むが、こちらは <video> の再生位置を
   動かしてコマを取り出す。
   ============================================================ */

/* 名前を外に出さない。app.js にも toast などがあり、
   同じ名前が2つあると読み込み時に丸ごと止まってしまう。 */
(function () {

const DEFAULTS = {
  sensitivity: 0.30,
  telopSensitivity: 0.10,
  telopFloor: 0.18,
  telopStrip: 0.045,
  telopBands: [[0.06, 0.97]],
  analyzeFps: 10.0,
  minGap: 0.2,
  settleSteps: 2,
  maxSettle: 0.80,
  baselineSec: 3.0,
  dedup: 0.12,
  workWidth: 480,
};


/** 中央値。Python の np.median と同じ扱い（偶数個は真ん中2つの平均） */
function median(values) {
  const a = values.slice().sort(function (x, y) { return x - y; });
  const n = a.length;
  if (!n) { return 0; }
  const half = n >> 1;
  return n % 2 ? a[half] : (a[half - 1] + a[half]) / 2;
}


/** 行ごとの「白い画素の数」を先頭から足し込んだ表 */
function rowCumsum(mask) {
  const h = mask.rows;
  const w = mask.cols;
  const data = mask.data;
  const out = new Int32Array(h + 1);

  for (let y = 0; y < h; y += 1) {
    let n = 0;
    const base = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[base + x]) { n += 1; }
    }
    out[y + 1] = out[y] + n;
  }

  return out;
}


/**
 * 2枚のエッジ画像の相違度（0-1）。
 *
 * 画面全体で平均すると、テロップの入れ替わりが背景の細かい変化に
 * 薄められてしまう。横ストリップに切って「もっとも変わった帯」を採る。
 */
function edgeChange(cv, a, b, stripH, minEdges, work) {

  cv.dilate(a, work.ad, work.kernel);
  cv.dilate(b, work.bd, work.kernel);

  cv.bitwise_not(work.bd, work.notBd);
  cv.bitwise_and(a, work.notBd, work.lost);

  cv.bitwise_not(work.ad, work.notAd);
  cv.bitwise_and(b, work.notAd, work.gain);

  const ca = rowCumsum(a);
  const cb = rowCumsum(b);
  const cl = rowCumsum(work.lost);
  const cg = rowCumsum(work.gain);

  const h = a.rows;
  const sh = Math.max(4, stripH);
  let best = 0;

  /* テロップ行が2つのストリップにまたがって薄まらないよう、
     半分ずらした系列も見る */
  for (const offset of [0, sh >> 1]) {
    for (let y0 = offset; y0 < h; y0 += sh) {
      const y1 = Math.min(h, y0 + sh);

      if (y1 - y0 < (sh >> 1)) { continue; }

      const den = Math.max(ca[y1] - ca[y0], cb[y1] - cb[y0]);

      if (den < minEdges) { continue; }

      const changed = (cl[y1] - cl[y0]) + (cg[y1] - cg[y0]);
      best = Math.max(best, Math.min(1, changed / (2 * den)));
    }
  }

  return best;
}


/**
 * 色みの隔たり（Bhattacharyya 距離）。
 *
 * Python 版は BGR のまま channels [0,1]、範囲 [0,180] と [0,256] で
 * ヒストグラムを取っている。同じ結果にするため、ここでも同じにする。
 */
function histDistance(cv, a, b) {

  const ha = new cv.Mat();
  const hb = new cv.Mat();
  const mask = new cv.Mat();
  const va = new cv.MatVector();
  const vb = new cv.MatVector();

  va.push_back(a);
  vb.push_back(b);

  try {
    cv.calcHist(va, [0, 1], mask, ha, [32, 32], [0, 180, 0, 256]);
    cv.calcHist(vb, [0, 1], mask, hb, [32, 32], [0, 180, 0, 256]);

    /* cv2.normalize の既定は L2 ノルムを 1 にそろえる動き */
    cv.normalize(ha, ha, 1, 0, cv.NORM_L2);
    cv.normalize(hb, hb, 1, 0, cv.NORM_L2);

    return cv.compareHist(ha, hb, cv.HISTCMP_BHATTACHARYYA);
  } finally {
    ha.delete(); hb.delete(); mask.delete(); va.delete(); vb.delete();
  }
}


/** 何行目から何行目までをテロップ帯として見るか */
function bandRows(height, bands) {
  const out = [];
  for (const [a, b] of bands) {
    const y0 = Math.max(0, Math.min(height - 1, Math.round(a * height)));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.round(b * height)));
    out.push([y0, y1]);
  }
  return out;
}


/**
 * 動画を頭から見て、撮るべきコマを集める。
 *
 * @param {object} opts
 *   video      … <video> 要素（読み込み済み）
 *   fps        … 動画のコマ数／秒
 *   frameCount … 総コマ数
 *   config     … しきい値など
 *   onProgress … 進み具合を知らせる関数
 */
async function detectShots(cv, opts) {

  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const video = opts.video;
  const fps = opts.fps;
  const total = opts.frameCount;

  const step = Math.max(1, Math.round(fps / cfg.analyzeFps));
  const minGapIdx = Math.round(cfg.minGap * fps);
  const maxSettleIdx = Math.round(cfg.maxSettle * fps);
  const baselineN = Math.max(5, Math.round(cfg.baselineSec * cfg.analyzeFps));

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const workW = cfg.workWidth;
  const workH = Math.max(1, Math.round(srcH * workW / srcW));

  /* コマを取り出すための下敷き */
  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /* 使い回す入れ物。毎回作ると重いし、メモリも溢れる */
  const rgba = new cv.Mat(srcH, srcW, cv.CV_8UC4);
  const bgr = new cv.Mat();
  const small = new cv.Mat();
  const prevSmall = new cv.Mat();
  const gray = new cv.Mat();
  const band = new cv.Mat();
  const eq = new cv.Mat();
  const edges = new cv.Mat();
  const prevEdges = new cv.Mat();
  const diff = new cv.Mat();

  const work = {
    kernel: cv.Mat.ones(3, 3, cv.CV_8U),
    ad: new cv.Mat(), bd: new cv.Mat(),
    notAd: new cv.Mat(), notBd: new cv.Mat(),
    lost: new cv.Mat(), gain: new cv.Mat(),
  };

  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));

  const rows = bandRows(workH, cfg.telopBands);
  const stripH = Math.max(6, Math.round(cfg.telopStrip * workH));
  const minEdges = Math.max(60, Math.trunc(0.006 * stripH * workW));

  const shots = [];
  const debug = [];
  const history = [];

  let hasPrev = false;
  let pending = null;
  let lastCaptureIdx = -1e9;

  const indices = [];
  for (let i = 0; i < total; i += step) { indices.push(i); }

  for (let n = 0; n < indices.length; n += 1) {

    const idx = indices[n];
    const ts = idx / fps;

    await seekTo(video, (idx + 0.5) / fps);

    ctx.drawImage(video, 0, 0, srcW, srcH);
    const img = ctx.getImageData(0, 0, srcW, srcH);
    rgba.data.set(img.data);

    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    cv.resize(bgr, small, new cv.Size(workW, workH), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_BGR2GRAY);

    /* テロップ帯の外は黒で潰す */
    gray.copyTo(band);
    for (let y = 0; y < workH; y += 1) {
      let keep = false;
      for (const [y0, y1] of rows) {
        if (y >= y0 && y < y1) { keep = true; break; }
      }
      if (!keep) {
        band.data.fill(0, y * workW, (y + 1) * workW);
      }
    }

    clahe.apply(band, eq);
    cv.Canny(eq, edges, 70, 170);

    if (!hasPrev) {
      shots.push({ index: idx, ts: ts, kind: 'start' });
      lastCaptureIdx = idx;
      small.copyTo(prevSmall);
      edges.copyTo(prevEdges);
      hasPrev = true;
      if (opts.onProgress) { opts.onProgress(n + 1, indices.length, shots.length); }
      continue;
    }

    cv.absdiff(small, prevSmall, diff);
    const pix = Math.min(1, cv.mean(diff).slice(0, 3).reduce(function (s, v, i) {
      return s + v;
    }, 0) / 3 / 255 * 3);

    const sceneScore = Math.min(1, 0.75 * histDistance(cv, small, prevSmall) + 0.25 * pix);
    const telopScore = edgeChange(cv, edges, prevEdges, stripH, minEdges, work);

    const baseline = (cfg.baselineSec > 0 && history.length >= 5)
      ? median(history) : 0;

    const telopThresh = Math.max(
      baseline + cfg.telopSensitivity * (1 - baseline), cfg.telopFloor);

    history.push(telopScore);
    if (history.length > baselineN) { history.shift(); }

    let event = '';

    if (pending === null) {

      const trigScene = sceneScore > cfg.sensitivity;
      const trigTelop = telopScore > telopThresh;

      if (trigScene || trigTelop) {
        if ((idx - lastCaptureIdx) < minGapIdx) {
          event = 'skipped_min_gap';
        } else {
          pending = {
            t0: idx,
            quiet: 0,
            kind: trigScene ? 'scene' : 'subtitle',
            calmScene: cfg.sensitivity * 0.5,
            calmTelop: Math.max(0.10, telopThresh * 0.5),
          };
          event = 'trigger';
        }
      }

    } else {

      if (sceneScore > cfg.sensitivity) { pending.kind = 'scene'; }

      const calm = sceneScore < pending.calmScene && telopScore < pending.calmTelop;
      pending.quiet = calm ? pending.quiet + 1 : 0;

      const timedOut = (idx - pending.t0) >= maxSettleIdx;

      if (pending.quiet >= cfg.settleSteps || timedOut) {
        const keep = new cv.Mat();
        edges.copyTo(keep);
        shots.push({ index: idx, ts: ts, kind: pending.kind, edges: keep });
        lastCaptureIdx = idx;
        event = 'capture';
        pending = null;
      } else {
        event = 'settling';
      }
    }

    debug.push({
      ts: ts, scene: sceneScore, telop: telopScore,
      thresh: telopThresh, baseline: baseline, event: event,
      /* どのコマを読んだかを照合するための目印 */
      gray: cv.mean(gray)[0],
    });

    small.copyTo(prevSmall);
    edges.copyTo(prevEdges);

    if (opts.onProgress) { opts.onProgress(n + 1, indices.length, shots.length); }
  }

  /* 先頭のコマにもエッジを持たせる（重複除去で使う） */
  if (shots.length && !shots[0].edges) {
    await seekTo(video, (shots[0].index + 0.5) / fps);
    ctx.drawImage(video, 0, 0, srcW, srcH);
    rgba.data.set(ctx.getImageData(0, 0, srcW, srcH).data);
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    cv.resize(bgr, small, new cv.Size(workW, workH), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_BGR2GRAY);
    gray.copyTo(band);
    for (let y = 0; y < workH; y += 1) {
      let keep = false;
      for (const [y0, y1] of rows) {
        if (y >= y0 && y < y1) { keep = true; break; }
      }
      if (!keep) { band.data.fill(0, y * workW, (y + 1) * workW); }
    }
    clahe.apply(band, eq);
    const keep = new cv.Mat();
    cv.Canny(eq, keep, 70, 170);
    shots[0].edges = keep;
  }

  const kept = dedupShots(cv, shots, cfg, workW, work);

  /* 後片付け */
  [rgba, bgr, small, prevSmall, gray, band, eq, edges, prevEdges, diff,
   work.kernel, work.ad, work.bd, work.notAd, work.notBd, work.lost, work.gain]
    .forEach(function (m) { m.delete(); });
  clahe.delete();
  shots.forEach(function (s) { if (s.edges) { s.edges.delete(); } });

  return { shots: kept.map(function (s) {
    return { index: s.index, ts: s.ts, kind: s.kind };
  }), debug: debug };
}


/** ほぼ同じ絵が続けて撮れた分をまとめる */
function dedupShots(cv, shots, cfg, workW, work) {

  if (cfg.dedup <= 0 || shots.length < 2) { return shots; }

  const kept = [shots[0]];

  for (let i = 1; i < shots.length; i += 1) {

    const s = shots[i];
    const prev = kept[kept.length - 1];

    if (!s.edges || !prev.edges) {
      kept.push(s);
      continue;
    }

    const h = s.edges.rows;
    const stripH = Math.max(6, Math.round(cfg.telopStrip * h));
    const minEdges = Math.max(60, Math.trunc(0.006 * stripH * workW));
    const diff = edgeChange(cv, s.edges, prev.edges, stripH, minEdges, work);

    if (diff < cfg.dedup) { continue; }

    kept.push(s);
  }

  return kept;
}


/** 指定の時間まで動かして、そのコマが出るのを待つ */
function seekTo(video, time) {
  return new Promise(function (done) {
    if (Math.abs(video.currentTime - time) < 1e-6) { done(); return; }
    const on = function () { video.removeEventListener('seeked', on); done(); };
    video.addEventListener('seeked', on);
    video.currentTime = time;
  });
}


window.VideoDetector = { detectShots: detectShots, DEFAULTS: DEFAULTS };

}());
