/* ============================================================
   動画から場面を切り出して保存する（ブラウザで動かす版）

   前は Python が別のプロセスでやっていた仕事を、
   案件ページを開いている間にこの中でやる。
   サーバーが要らなくなるかわり、途中で画面を閉じると止まる。

   ・変わり目を見つけるのは detector.js（Python 版の移植）
   ・見つけた場面の絵を JPEG にして Storage へ送る
   ・進み具合は videos の行に書く。
     画面の進捗バーは、これまでどおり app.js が読みに来る。
   ============================================================ */

/* 名前を外に出さない。app.js と同じ名前の関数があると
   読み込みの時点で丸ごと止まってしまう。 */
(function () {

/* Python 版（config.py の SCREENSHOT_ARGS）と同じにしてある */
const MAX_WIDTH = 540;
const JPEG_QUALITY = 0.92;

/* いちどに送る枚数。増やしすぎると回線が詰まる */
const AT_ONCE = 4;

/* やり直したときに消さずに引き継ぐ入力欄 */
const KEEP = [
  'reference_role', 'material_feature', 'improvement_note', 'reference_feedback',
  'text_raw', 'material', 'role', 'scene_feeling', 'feedback',
];

/* 同じ動画を2つの画面で同時に処理しないための目印 */
const LOCK_MS = 20000;


/* ------------------------------------------------------------
   選んだファイルの一時置き場（IndexedDB）

   案件登録の画面で選んだ動画を、案件ページまで持ち越すために使う。
   持ち越せると、いま送ったばかりの動画をもう一度もらい直さずに済む。
   （もらい直すと、その分だけ通信量を食う）
   ------------------------------------------------------------ */

const STORE = 'pending-videos';

function openBox() {
  return new Promise(function (done, fail) {
    const req = indexedDB.open('video-analysis', 1);

    req.onupgradeneeded = function () {
      req.result.createObjectStore(STORE);
    };

    req.onsuccess = function () { done(req.result); };
    req.onerror = function () { fail(req.error); };
  });
}

function useBox(mode, work) {
  return openBox().then(function (box) {
    return new Promise(function (done, fail) {
      const tx = box.transaction(STORE, mode);
      const req = work(tx.objectStore(STORE));

      tx.oncomplete = function () {
        box.close();
        done(req ? req.result : undefined);
      };

      tx.onerror = function () { box.close(); fail(tx.error); };
    });
  });
}

/** あとで使えるようにファイルを取っておく */
async function keep(videoId, file) {
  try {
    await useBox('readwrite', function (s) { return s.put(file, String(videoId)); });
  } catch (err) {
    /* 取っておけなくても致命傷ではない。もらい直せばよい */
  }
}

async function pick(videoId) {
  try {
    return await useBox('readonly', function (s) { return s.get(String(videoId)); });
  } catch (err) {
    return null;
  }
}

async function drop(videoId) {
  try {
    await useBox('readwrite', function (s) { return s.delete(String(videoId)); });
  } catch (err) {
    /* 消せなくてもかまわない */
  }
}


/* ------------------------------------------------------------
   部品の読み込み

   opencv.js は 10MB 近くある。
   処理する動画があるときだけ読む。
   ------------------------------------------------------------ */

let parts = null;

function loadScript(src) {
  return new Promise(function (done, fail) {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = function () { done(); };
    tag.onerror = function () { fail(new Error(src + ' を読み込めませんでした。')); };
    document.head.appendChild(tag);
  });
}

function loadParts() {

  if (parts) { return parts; }

  parts = (async function () {

    await loadScript('js/opencv.js');

    /* 読み込みが終わっても、中身が使えるようになるのは少しあと */
    await new Promise(function (done, fail) {

      if (window.cv && window.cv.Mat) { done(); return; }

      let over = false;

      const ok = function () { if (!over) { over = true; done(); } };

      window.cv['onRuntimeInitialized'] = ok;

      /* 合図を取り逃しても止まらないように、見にも行く */
      const timer = setInterval(function () {
        if (window.cv && window.cv.Mat) { clearInterval(timer); ok(); }
      }, 50);

      setTimeout(function () {
        clearInterval(timer);
        if (!over) {
          over = true;
          fail(new Error('画像処理の部品を用意できませんでした。'));
        }
      }, 60000);
    });

    if (!window.VideoDetector) { await loadScript('js/detector.js'); }

    /* cv をそのまま返さないこと。
       OpenCV の実体は then という関数を持っている。
       async 関数がそれを返すと、JavaScript は「これも約束事だ」と見なして
       中身を取り出そうとし、取り出した先がまた同じものなので終わらなくなる。
       画面ごと固まるので、必ず包んで返す。 */
    return { cv: window.cv };
  }());

  return parts;
}


/* ------------------------------------------------------------
   小道具
   ------------------------------------------------------------ */

/** 指定の時間まで動かして、そのコマが出るのを待つ */
function seekTo(el, time) {
  return new Promise(function (done) {
    if (Math.abs(el.currentTime - time) < 1e-6) { done(); return; }
    const on = function () { el.removeEventListener('seeked', on); done(); };
    el.addEventListener('seeked', on);
    el.currentTime = time;
  });
}

function toBlob(canvas) {
  return new Promise(function (done) {
    canvas.toBlob(function (blob) { done(blob); }, 'image/jpeg', JPEG_QUALITY);
  });
}

/**
 * 1秒あたりのコマ数を測る。
 *
 * ブラウザは動画のコマ数を教えてくれないので、
 * 少しだけ再生して、コマの間隔から割り出す。
 * 測れなければ 30 とみなす（この値は結果をほとんど左右しない。
 * 判定の基準はすべて「秒」で書いてあるため）。
 */
function measureFps(el) {

  return new Promise(function (done) {

    if (!el.requestVideoFrameCallback) { done(0); return; }

    const gaps = [];

    let prev = null;
    let over = false;

    const finish = function () {

      if (over) { return; }
      over = true;

      el.pause();

      if (gaps.length < 4) { done(0); return; }

      gaps.sort(function (a, b) { return a - b; });

      const mid = gaps[gaps.length >> 1];

      done(mid > 0 ? Math.min(240, Math.max(1, 1 / mid)) : 0);
    };

    const step = function (now, meta) {

      if (prev !== null && meta.mediaTime > prev) {
        gaps.push(meta.mediaTime - prev);
      }

      prev = meta.mediaTime;

      if (gaps.length >= 12) { finish(); return; }

      el.requestVideoFrameCallback(step);
    };

    el.requestVideoFrameCallback(step);

    setTimeout(finish, 2500);

    const playing = el.play();

    if (playing && playing.catch) { playing.catch(function () { finish(); }); }
  });
}

/** 同じ動画を2つの画面で同時に処理しないようにする */
function claim(videoId) {

  const key = 'detect:' + videoId;

  let last = 0;

  try { last = Number(localStorage.getItem(key)) || 0; } catch (err) { last = 0; }

  if (last && Date.now() - last < LOCK_MS) { return null; }

  const beat = function () {
    try { localStorage.setItem(key, String(Date.now())); } catch (err) { /* 無視 */ }
  };

  beat();

  return {
    beat: beat,
    release: function () {
      try { localStorage.removeItem(key); } catch (err) { /* 無視 */ }
    },
  };
}


/* ------------------------------------------------------------
   本体
   ------------------------------------------------------------ */

/**
 * 動画1本を処理する。
 *
 * @param video  videos テーブルの行
 * @returns 保存した枚数
 */
async function run(video) {

  const lock = claim(video.id);

  /* すでに別の画面が処理している */
  if (!lock) { return -1; }

  let el = null;
  let objectUrl = null;

  let wroteAt = 0;

  /** 進み具合を画面と videos の行に伝える */
  async function step(percent, text, force) {

    lock.beat();

    const now = Date.now();

    /* 毎回書きに行くと回数が多すぎる。2秒に1回にする */
    if (!force && now - wroteAt < 2000) { return; }

    wroteAt = now;

    await API.db.from('videos')
      .update({ progress: Math.round(percent), stage: text, status: 'running' })
      .eq('id', video.id);
  }

  try {

    await step(1, '動画を読み込んでいます', true);

    /* --- 動画をどこから読むか --- */

    const local = await pick(video.id);

    let src = '';

    if (local) {
      objectUrl = URL.createObjectURL(local);
      src = objectUrl;
    } else if (video.storage_path) {
      src = await API.Files.url('videos', video.storage_path, 6 * 3600);
    } else {
      src = video.source_url;
    }

    if (!src) { throw new Error('動画が見つかりませんでした。'); }

    el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';

    /* 手元のファイル以外は、別の場所から借りてくる扱いになる。
       これを付けておかないと、絵を取り出すところで断られる */
    if (!objectUrl) { el.crossOrigin = 'anonymous'; }

    el.src = src;

    await new Promise(function (done, fail) {
      el.addEventListener('loadeddata', function () { done(); }, { once: true });
      el.addEventListener('error', function () {
        fail(new Error('動画を再生できませんでした。'
          + '形式が対応していないか、リンクが切れています。'));
      }, { once: true });
      el.load();
    });

    const duration = el.duration;

    if (!isFinite(duration) || duration <= 0) {
      throw new Error('動画の長さが分かりませんでした。');
    }

    const cv = (await loadParts()).cv;

    await step(4, '動画を読み込んでいます', true);

    const fps = (await measureFps(el)) || 30;

    await seekTo(el, 0);


    /* --- 変わり目を探す --- */

    const found = await window.VideoDetector.detectShots(cv, {
      video: el,
      fps: fps,
      frameCount: Math.max(1, Math.round(duration * fps)),
      onProgress: function (done, total, shots) {
        step(5 + 65 * done / total, '変化を検出しています（' + shots + '枚）');
      },
    });

    const shots = found.shots || [];

    if (!shots.length) { throw new Error('場面の変わり目を見つけられませんでした。'); }


    /* --- 絵を取り出して送る --- */

    await step(70, '画像を保存しています', true);

    const width = Math.min(MAX_WIDTH, el.videoWidth);
    const height = Math.max(1, Math.round(el.videoHeight * width / el.videoWidth));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    const stamp = Date.now();
    const jobs = [];

    for (let i = 0; i < shots.length; i += 1) {

      await seekTo(el, Math.min(duration - 1e-3, shots[i].ts + 0.5 / fps));

      ctx.drawImage(el, 0, 0, width, height);

      let blob = null;

      try {
        blob = await toBlob(canvas);
      } catch (err) {
        throw new Error('動画の絵を取り出せませんでした。'
          + '別の場所にある動画は、そこが許していないと読めません。');
      }

      jobs.push({
        seq: i + 1,
        ts: shots[i].ts,
        blob: blob,
        path: video.id + '/a' + (i + 1) + '-' + stamp + '.jpg',
      });

      await step(70 + 15 * (i + 1) / shots.length, '画像を保存しています');
    }

    /* 送るのは何本かまとめて。1枚ずつ待つと待ち時間が積み上がる */
    let sent = 0;

    for (let i = 0; i < jobs.length; i += AT_ONCE) {

      const batch = jobs.slice(i, i + AT_ONCE);

      await Promise.all(batch.map(function (job) {
        return API.Files.upload('screenshots', job.path, job.blob);
      }));

      sent += batch.length;

      await step(85 + 10 * sent / jobs.length, '画像を保存しています');
    }


    /* --- 表の行を作る --- */

    await step(96, '表を作っています', true);

    await writeRows(video.id, jobs);

    await API.db.from('videos').update({
      status: 'done', progress: 100, stage: '',
      duration_sec: duration, error_message: null,
    }).eq('id', video.id);

    await drop(video.id);

    return jobs.length;

  } catch (err) {

    await API.db.from('videos').update({
      status: 'error', progress: 0, stage: '',
      error_message: err.message || String(err),
    }).eq('id', video.id);

    throw err;

  } finally {

    lock.release();

    if (el) { el.removeAttribute('src'); el.load(); }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); }
  }
}


/**
 * 行を作り直す。
 *
 * やり直したときに書いた内容が消えないよう、
 * 同じ番号の行の入力はそのまま引き継ぐ。
 * 枚数より下書きの行数が多い場合も、
 * 中身が入っている行は画像なしのまま後ろに残す。
 * （動画より先に台本を書いておく使い方を壊さないため）
 */
async function writeRows(videoId, jobs) {

  const { data } = await API.db
    .from('screenshots')
    .select('id, seq, storage_path, row_height, ' + KEEP.join(', '))
    .eq('video_id', videoId);

  const before = data || [];

  const prev = {};
  before.forEach(function (r) { prev[r.seq] = r; });

  const rows = jobs.map(function (job) {

    const old = prev[job.seq] || {};

    const row = {
      video_id: videoId,
      seq: job.seq,
      storage_path: job.path,
      timestamp_sec: job.ts,
      row_height: old.row_height || 0,
    };

    KEEP.forEach(function (field) { row[field] = old[field] || ''; });

    return row;
  });

  /* 枚数からあふれた行のうち、中身のあるものだけ後ろに残す */
  let extra = jobs.length;

  Object.keys(prev)
    .map(Number)
    .sort(function (a, b) { return a - b; })
    .forEach(function (seq) {

      if (seq <= jobs.length) { return; }

      const old = prev[seq];

      const written = KEEP.some(function (field) {
        return String(old[field] || '').trim();
      });

      if (!written) { return; }

      extra += 1;

      const row = {
        video_id: videoId, seq: extra, storage_path: '',
        timestamp_sec: 0, row_height: old.row_height || 0,
      };

      KEEP.forEach(function (field) { row[field] = old[field] || ''; });

      rows.push(row);
    });

  /* 前の画像は置いたままにしない。溜まると置き場を圧迫する */
  const stale = before.map(function (r) { return r.storage_path; }).filter(Boolean);

  await API.db.from('screenshots').delete().eq('video_id', videoId);

  await API.Shots.insertMany(rows);

  if (stale.length) { await API.Files.remove('screenshots', stale); }
}


window.Detection = { run: run, keep: keep, drop: drop };

}());
