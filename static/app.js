'use strict';


/* ============================================================
   アップロード中の二重送信防止
   ============================================================ */

document
  .querySelectorAll('form[data-uploading]')
  .forEach(function (form) {

    form.addEventListener(
      'submit',
      function () {

        const btn =
          form.querySelector(
            'button[type=submit]'
          );

        if (btn) {
          btn.disabled = true;
          btn.textContent = 'アップロード中…';
        }

      }
    );

  });


/* ============================================================
   プロジェクトページ初期化
   ============================================================ */

/* ------------------------------------------------------------
   テキスト列の合計秒数で使う変数。

   const / let は「宣言より前では触れない」ため、
   下の初期化ブロック（initTextTotal を呼ぶ場所）より必ず先に置くこと。
   後ろに書くと ReferenceError で合計が出なくなる。
   ------------------------------------------------------------ */

/* 何文字で1秒とみなすか */
const CHARS_PER_SECOND = 5.5;

/* 他の場所（保存完了時など）からも数え直せるようにしておく */
let recountTextTotal = function () {};

/* 空の行を作る処理。＋ボタンと「この場面を追加」で共用する */
let buildEmptyRow = function () { return null; };


/* ------------------------------------------------------------
   表の左右の分けかた（作業時間の集計で使う）。

   「フィードバックメモ」と「テキスト」の間が境目。
   左＝参考動画を分析するところ、右＝自分の動画へ転用するところ。

   これも下の初期化ブロックより先に置くこと。
   ------------------------------------------------------------ */

const ANALYSIS_FIELDS = [
  'reference_role',
  'material_feature',
  'improvement_note',
  'reference_feedback',
];

const REUSE_FIELDS = [
  'text_raw',
  'material',
  'role',
  'scene_feeling',
  'feedback',
];


const root =
  document.querySelector('.project');

if (root) {

  document.body.classList.add('page-project');

  initPlayer();

  initPlayerSize();

  initPlayerWindow();

  initAutoSave();

  initMaterialEditor();

  initMaterialImages();

  initRowResize();

  initColumnResize();

  initLightbox();

  initPolling();

  initTextTotal();

  initRowDelete();

  initRowAdd();

  initCapture();

  initColumnCopy();

  initInlineInfo();

  initWorkTime();

}

initBoard();


/* ============================================================
   作業時間を数える

   「画面を触っている時間」だけを分析／転用に振り分けて貯める。

   ・マウスが動いた・キーを打った・スクロールした → 触っている
   ・60秒なにもなければ止める
   ・別のタブを見ているあいだも止める
   ・どちら側かは「最後に触った入力欄」で決める。
     参考動画を見ながらマウスを動かしている時間も分析に入れたいので、
     一度どちらかに入ったら、反対側に移るまでそのまま数える。
   ============================================================ */

function initWorkTime() {

  const projectId = parseInt(root.dataset.projectId, 10);

  if (!projectId) {
    return;
  }

  /*
     何もしないでいてもよい時間。これを超えたら数えるのを止める。

     短すぎると、参考動画を見ているだけの時間や、考えている時間が
     抜け落ちてしまう。長すぎると、席を立っているあいだも数えてしまう。
     30秒にしてある。
  */
  const IDLE_MS = 30 * 1000;

  /* まとめて送る間隔 */
  const FLUSH_MS = 15 * 1000;

  const bucket = { analysis: 0, reuse: 0, other: 0 };

  let side = 'other';
  let lastActive = Date.now();

  /*
     何をもって「作業している」とみなすか。

     入力・カーソルの移動・スクロールを広めに拾う。
     keydown だけだと、日本語変換の確定・貼り付け・
     マウスでの文字選択が抜け落ちるため、それぞれ足してある。
  */
  const ACTIVITY_EVENTS = [
    /* 入力 */
    'keydown',
    'keyup',
    'input',
    'paste',
    'cut',
    'compositionstart',
    'compositionupdate',
    'compositionend',

    /* カーソルの移動・操作 */
    'pointermove',
    'pointerdown',
    'pointerup',
    'mousemove',
    'mousedown',
    'click',
    'dblclick',
    'contextmenu',
    'dragover',
    'drop',
    'touchstart',
    'touchmove',

    /* スクロール */
    'wheel',
  ];

  function markActive() {
    lastActive = Date.now();
  }

  ACTIVITY_EVENTS.forEach(function (name) {
    document.addEventListener(name, markActive, {
      passive: true,
      capture: true,
    });
  });

  /* スクロールは上に伝わらないので、捕まえる側で拾う。
     表の中身・素材欄・ページ全体のどれを動かしても効く。 */
  document.addEventListener('scroll', markActive, {
    passive: true,
    capture: true,
  });

  /* マウスでの文字選択、キーボードでの範囲選択 */
  document.addEventListener('selectionchange', markActive, { passive: true });

  /* 表の幅・行の高さを変えている最中 */
  window.addEventListener('resize', markActive, { passive: true });

  /*
     いま「分析」と「転用」のどちらをやっているかを決める。

     入力欄はその列で決まる。
     参考動画のプレイヤー・キャプチャ・秒数ボタン・拡大表示は、
     どれも表の左側（参考動画を見るところ）の作業なので分析に入れる。
     どちらとも言えないところを触っただけでは、いまの側を変えない。
  */
  const ANALYSIS_AREAS = [
    '#player-wrap',
    '#capture-shot',
    '.c-shot',
    '.c-time',
    '#lightbox',
  ].join(',');

  function pickSide(target) {

    if (!target || !target.closest) {
      return;
    }

    const field = target.dataset ? target.dataset.field : '';

    if (field && ANALYSIS_FIELDS.indexOf(field) !== -1) {
      side = 'analysis';
      return;
    }

    if (field && REUSE_FIELDS.indexOf(field) !== -1) {
      side = 'reuse';
      return;
    }

    if (target.closest(ANALYSIS_AREAS)) {
      side = 'analysis';
    }
  }

  ['focusin', 'pointerdown'].forEach(function (name) {
    document.addEventListener(name, function (e) {
      pickSide(e.target);
      markActive();
    }, { passive: true, capture: true });
  });

  /* 1秒ごとに数える */
  setInterval(function () {

    /* 別のタブを見ている */
    if (document.hidden) {
      return;
    }

    /* タブは開いたまま、別のアプリを触っている。
       画面は見えていても作業はしていないので数えない。 */
    if (document.hasFocus && !document.hasFocus()) {
      return;
    }

    if (Date.now() - lastActive > IDLE_MS) {
      return;
    }

    bucket[side] += 1;

  }, 1000);

  function payload() {
    return JSON.stringify({
      project_id: projectId,
      analysis: bucket.analysis,
      reuse: bucket.reuse,
      other: bucket.other,
    });
  }

  function clearBucket() {
    bucket.analysis = 0;
    bucket.reuse = 0;
    bucket.other = 0;
  }

  function flush(useBeacon) {

    if (!bucket.analysis && !bucket.reuse && !bucket.other) {
      return;
    }

    const body = payload();

    clearBucket();

    if (useBeacon && navigator.sendBeacon) {
      /* ページを閉じるときは fetch だと間に合わないことがある */
      navigator.sendBeacon(
        '/api/worktime',
        new Blob([body], { type: 'application/json' })
      );
      return;
    }

    fetch('/api/worktime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {
      /* 失敗しても作業の邪魔はしない */
    });
  }

  setInterval(function () {
    flush(false);
  }, FLUSH_MS);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      flush(true);
    }
  });

  window.addEventListener('pagehide', function () {
    flush(true);
  });
}


/* ============================================================
   進捗ボード（ドラッグで列を移動）
   ============================================================ */

function initBoard() {

  const board = document.getElementById('board');

  if (!board) {
    return;
  }

  document.body.classList.add('page-board');

  let dragging = null;

  board.addEventListener('dragstart', function (e) {

    const card = e.target.closest('.board-card');

    if (!card) {
      return;
    }

    dragging = card;
    card.classList.add('is-dragging');

    e.dataTransfer.effectAllowed = 'move';
    /* Firefox はデータを入れないとドラッグが始まらない */
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });

  board.addEventListener('dragend', function () {

    if (dragging) {
      dragging.classList.remove('is-dragging');
    }

    board.querySelectorAll('.board-drop').forEach(function (drop) {
      drop.classList.remove('is-over');
    });

    dragging = null;
  });

  board.querySelectorAll('.board-drop').forEach(function (drop) {

    drop.addEventListener('dragover', function (e) {

      if (!dragging) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      drop.classList.add('is-over');

      /* 落とす位置のカードの前に差し込む */
      const after = cardAfter(drop, e.clientY);

      if (after) {
        drop.insertBefore(dragging, after);
      } else {
        drop.insertBefore(dragging, drop.querySelector('.board-empty'));
      }
    });

    drop.addEventListener('dragleave', function (e) {
      if (!drop.contains(e.relatedTarget)) {
        drop.classList.remove('is-over');
      }
    });

    drop.addEventListener('drop', function (e) {

      e.preventDefault();
      drop.classList.remove('is-over');

      if (!dragging) {
        return;
      }

      const status = drop.closest('.board-col').dataset.status;
      const id = parseInt(dragging.dataset.id, 10);

      save(id, status, drop);
    });
  });

  function cardAfter(drop, y) {

    const cards = [].slice.call(
      drop.querySelectorAll('.board-card:not(.is-dragging)')
    );

    for (let i = 0; i < cards.length; i += 1) {
      const box = cards[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        return cards[i];
      }
    }

    return null;
  }

  function save(id, status, drop) {

    const ids = [].slice
      .call(drop.querySelectorAll('.board-card'))
      .map(function (c) {
        return parseInt(c.dataset.id, 10);
      });

    fetch('/api/projects/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status, order: ids.indexOf(id) }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || '保存できませんでした');
        }

        recountBoard();

        return fetch('/api/board/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids }),
        });
      })
      .catch(function (err) {
        alert('状態を保存できませんでした：' + err.message);
        location.reload();
      });
  }

  function recountBoard() {
    board.querySelectorAll('.board-col').forEach(function (col) {
      col.querySelector('.board-col-count').textContent =
        col.querySelectorAll('.board-card').length;
    });
  }
}


/* ============================================================
   表の一番下の ＋（行を足す）
   ============================================================ */

function initRowAdd() {

  const btn = document.getElementById('row-add');
  const tbody = document.getElementById('rows');

  if (!btn || !tbody) {
    return;
  }


  btn.addEventListener('click', function () {

    const videoId = btn.dataset.video;

    if (!videoId) {
      return;
    }

    btn.disabled = true;

    fetch('/api/videos/' + videoId + '/rows', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {

        if (!data.ok) {
          throw new Error(data.error || '行を追加できませんでした');
        }

        tbody.appendChild(buildRow(data.id, data.seq));

        /* 追加した行にもこれまでの仕掛けを効かせる */
        initAutoSave();
        initMaterialEditor();
        initRowResize();

      })
      .catch(function (err) {
        toast('行を追加できませんでした（' + err.message + '）', true);
      })
      .then(function () {
        btn.disabled = false;
      });

  });


  buildEmptyRow = buildRow;

  /** 既存の行と同じ構造の空行を作る */
  function buildRow(shotId, seq) {

    const model = tbody.querySelector('tr');
    const tr = document.createElement('tr');

    tr.dataset.seek = '0';
    tr.dataset.shotRow = String(shotId);

    /* 列数と種類は見出しから決まるので、既存行を写して中身を空にする */
    if (model) {

      tr.innerHTML = model.innerHTML;

      tr.querySelectorAll('[data-shot]').forEach(function (el) {
        el.dataset.shot = String(shotId);
      });

      tr.querySelectorAll('textarea').forEach(function (t) {
        t.value = '';
        delete t.dataset.saved;
      });

      tr.querySelectorAll('.material-editor').forEach(function (m) {
        m.innerHTML = '';
      });

      const img = tr.querySelector('.c-shot img');

      if (img) {
        img.replaceWith(
          Object.assign(document.createElement('span'), {
            className: 'shot-empty'
          })
        );
      }

      const seqBox = tr.querySelector('.row-seq');
      if (seqBox) { seqBox.textContent = String(seq); }

      const check = tr.querySelector('.row-select');
      if (check) { check.checked = false; }

      const time = tr.querySelector('.c-time');
      if (time) { time.textContent = '--:--'; }

    }

    return tr;

  }

}

initPermalink();


/* ============================================================
   パーマリンクのコピー
   ============================================================ */

function initPermalink() {

  const btn =
    document.getElementById('permalink-button');

  if (!btn) {
    return;
  }


  btn.addEventListener('click', function () {

    const url = btn.dataset.url || location.href;
    const label = btn.dataset.label || url;

    copyRichLink(url, label);

  });


  /**
   * 「文字はラベル、中身はリンク」の形でコピーする。
   *
   * スプレッドシートや文書に貼ったときに
   * 「退職給付金1」という文字がそのままリンクになるよう、
   * text/html と text/plain の両方をクリップボードに入れる。
   * 貼り付け先がリンクに対応していなければ URL が入る。
   */
  function copyRichLink(url, label) {

    const esc = function (s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };

    const html =
      '<a href="' + esc(url) + '">' + esc(label) + '</a>';


    /* 新しい方式。https か localhost でしか使えない */
    if (
      window.ClipboardItem &&
      navigator.clipboard &&
      navigator.clipboard.write
    ) {

      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([url], { type: 'text/plain' })
      });

      navigator.clipboard
        .write([item])
        .then(function () {
          toast('「' + label + '」をリンク付きでコピーしました');
        })
        .catch(function () {
          legacyCopy();
        });

      return;
    }

    legacyCopy();


    /* 社内 LAN（http）などで新しい方式が使えないとき。
       画面外に置いた要素を選択して、昔ながらのコピーを実行する。 */
    function legacyCopy() {

      const holder = document.createElement('div');

      holder.contentEditable = 'true';
      holder.innerHTML = html;

      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      holder.style.top = '0';

      document.body.appendChild(holder);

      const range = document.createRange();
      range.selectNodeContents(holder);

      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      let done = false;

      try {
        done = document.execCommand('copy');
      }
      catch (err) {
        done = false;
      }

      sel.removeAllRanges();
      holder.remove();

      if (done) {
        toast('「' + label + '」をリンク付きでコピーしました');
      }
      else {
        window.prompt('このリンクをコピーしてください', url);
      }

    }

  }

}


/* ============================================================
   行の削除
   ============================================================ */

function initRowDelete() {

  const bar = document.getElementById('row-delete-bar');
  const countBox = document.getElementById('row-delete-count');
  const runBtn = document.getElementById('row-delete-run');
  const clearBtn = document.getElementById('row-delete-clear');
  const tbody = document.getElementById('rows');

  if (!bar || !tbody) {
    return;
  }


  function boxes() {
    return Array.from(
      tbody.querySelectorAll('.row-select')
    );
  }


  function selected() {
    return boxes().filter(function (b) { return b.checked; });
  }


  function refresh() {

    const n = selected().length;

    countBox.textContent = String(n);
    bar.hidden = n === 0;

    boxes().forEach(function (b) {
      const tr = b.closest('tr');
      if (tr) {
        tr.classList.toggle('is-selected', b.checked);
      }
    });

  }


  tbody.addEventListener('change', function (ev) {

    if (ev.target.classList.contains('row-select')) {
      refresh();
    }

  });


  /* 行番号を右クリック → その行を選んで削除確認 */
  tbody.addEventListener('contextmenu', function (ev) {

    const cell = ev.target.closest('.c-num');

    if (!cell) {
      return;
    }

    ev.preventDefault();

    const box = cell.querySelector('.row-select');

    if (!box) {
      return;
    }

    /* すでに複数選んでいるなら、その選択をそのまま消す。
       何も選んでいなければ、右クリックした行だけを対象にする。 */
    if (selected().length === 0) {
      box.checked = true;
      refresh();
    }

    run();

  });


  clearBtn.addEventListener('click', function () {

    boxes().forEach(function (b) { b.checked = false; });
    refresh();

  });


  runBtn.addEventListener('click', run);


  function run() {

    const targets = selected();

    if (!targets.length) {
      return;
    }

    const ids = targets.map(function (b) {
      return parseInt(b.dataset.shot, 10);
    });

    const seqs = targets.map(function (b) {
      const tr = b.closest('tr');
      const seq = tr ? tr.querySelector('.row-seq') : null;
      return seq ? seq.textContent.trim() : '?';
    });

    const message =
      ids.length === 1
        ? seqs[0] + ' 行目を削除します。\n' +
          'スクリーンショットの画像も一緒に消えます。\n\n' +
          'よろしいですか？'
        : ids.length + ' 行（' + seqs.join(', ') + '）を削除します。\n' +
          'スクリーンショットの画像も一緒に消えます。\n\n' +
          'よろしいですか？';

    if (!window.confirm(message)) {
      return;
    }

    runBtn.disabled = true;

    fetch('/api/screenshots/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {

        if (!data.ok) {
          throw new Error(data.error || '削除できませんでした');
        }

        const removed = [];

        targets.forEach(function (b) {
          const tr = b.closest('tr');
          if (tr) {
            /* すぐ戻せるように、消した行は取っておく */
            removed.push({ tr: tr, next: tr.nextElementSibling });
            tr.remove();
          }
        });

        renumber();
        refresh();
        recountTextTotal();

        showUndo(ids, removed);

      })
      .catch(function (err) {
        toast('削除できませんでした（' + err.message + '）', true);
      })
      .then(function () {
        runBtn.disabled = false;
      });

  }


  /**
   * 「元に戻す」を出す。
   *
   * 画像はサーバー側でゴミ箱へ移してあるだけなので、
   * ここから戻せば画像ごと復活する。
   */
  function showUndo(ids, removed) {

    const box = document.getElementById('row-undo');

    if (!box) {
      return;
    }

    box.querySelector('.row-undo-text').textContent =
      ids.length + ' 行を削除しました';

    box.hidden = false;

    const btn = box.querySelector('.row-undo-button');

    /* 前回のボタンに付いた処理が残らないよう作り直す */
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);

    clearTimeout(showUndo.timer);

    showUndo.timer = setTimeout(function () {
      box.hidden = true;
    }, 30000);


    fresh.addEventListener('click', function () {

      fresh.disabled = true;

      fetch('/api/screenshots/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {

          if (!data.ok) {
            throw new Error(data.error || '戻せませんでした');
          }

          /* 元の位置に差し戻す */
          removed.forEach(function (item) {
            if (item.next && item.next.parentNode === tbody) {
              tbody.insertBefore(item.tr, item.next);
            }
            else {
              tbody.appendChild(item.tr);
            }
          });

          renumber();
          refresh();
          recountTextTotal();

          box.hidden = true;
          toast(data.restored + ' 行を元に戻しました');

        })
        .catch(function (err) {
          toast('元に戻せませんでした（' + err.message + '）', true);
          fresh.disabled = false;
        });

    });

  }


  /* 画面上の # を振り直す（サーバー側でも詰め直している） */
  function renumber() {

    Array.from(tbody.querySelectorAll('tr')).forEach(
      function (tr, i) {
        const seq = tr.querySelector('.row-seq');
        if (seq) { seq.textContent = String(i + 1); }
      }
    );

  }


  refresh();

}


/* ============================================================
   テキスト列の合計秒数
   ============================================================ */

function initTextTotal() {

  const box =
    document.getElementById('text-total');

  if (!box) {
    return;
  }


  const output =
    box.querySelector('strong');

  const fields = Array.from(
    document.querySelectorAll(
      'textarea[data-field="text_raw"]'
    )
  );


  function recount() {

    /* 空白と改行は「読む文字」ではないので数えない */
    const chars = fields.reduce(
      function (sum, ta) {
        return sum + ta.value.replace(/\s/g, '').length;
      },
      0
    );

    const seconds =
      chars / CHARS_PER_SECOND;

    output.textContent =
      seconds.toFixed(1);

    box.dataset.chars = String(chars);

    box.title =
      '合計 ' + chars + ' 文字 ÷ ' +
      CHARS_PER_SECOND + ' 文字/秒 = ' +
      seconds.toFixed(1) + ' 秒';

  }


  fields.forEach(function (ta) {

    /* 入力のたびに即反映する（自動保存を待たない）。
       日本語変換の確定でも input は飛ぶので、これで取りこぼさない。 */
    ta.addEventListener('input', recount);

    /* 変換中の未確定文字は数に入れず、確定した時点で数え直す */
    ta.addEventListener('compositionend', recount);

    /* 貼り付け・切り取りは input より後に値が確定する */
    ta.addEventListener('paste', function () {
      setTimeout(recount, 0);
    });

    ta.addEventListener('cut', function () {
      setTimeout(recount, 0);
    });

  });


  /* 保存が終わったタイミングでも念のため合わせる */
  recountTextTotal = recount;


  recount();

}


/* ============================================================
   案件一覧初期化
   ============================================================ */

initProjectFilters();

initSourcePicker();


/* ============================================================
   新規案件：ファイル / リンクの切り替え
   ============================================================ */

function initSourcePicker() {

  const picker =
    document.getElementById('source-picker');

  if (!picker) {
    return;
  }


  const tabs =
    picker.querySelectorAll('.source-tab');

  const panels =
    picker.querySelectorAll('.source-panel');


  function select(kind) {

    tabs.forEach(function (tab) {
      tab.classList.toggle(
        'is-active',
        tab.dataset.source === kind
      );
    });


    panels.forEach(function (panel) {

      const active =
        panel.dataset.panel === kind;

      panel.classList.toggle(
        'is-hidden',
        !active
      );

      /* 使わない側は disabled にして送信対象から外す。
         こうしないと空の video フィールドも一緒に送られ、
         サーバー側で「両方指定された」と誤判定してしまう。 */
      panel
        .querySelectorAll('input')
        .forEach(function (input) {

          input.disabled = !active;

          if (!active) {
            input.value = '';
          }

        });

    });

  }


  tabs.forEach(function (tab) {

    tab.addEventListener(
      'click',
      function () {
        select(tab.dataset.source);
      }
    );

  });


  select('file');

}


/* ============================================================
   動画プレイヤー
   ============================================================ */

function initPlayer() {

  const player =
    document.getElementById('player');

  const cur =
    document.getElementById('cur-time');

  const dur =
    document.getElementById('dur-time');

  if (!player) {
    return;
  }


  function fmt(s) {

    if (!isFinite(s)) {
      return '--:--';
    }

    const m =
      Math.floor(s / 60);

    const r =
      Math.floor(s % 60);

    return (
      String(m).padStart(2, '0') +
      ':' +
      String(r).padStart(2, '0')
    );

  }


  player.addEventListener(
    'loadedmetadata',
    function () {

      if (dur) {
        dur.textContent =
          fmt(player.duration);
      }

    }
  );


  player.addEventListener(
    'timeupdate',
    function () {

      if (cur) {
        cur.textContent =
          fmt(player.currentTime);
      }

    }
  );


  document.addEventListener(
    'click',
    function (ev) {

      const el =
        ev.target.closest(
          '[data-seek]'
        );


      if (
        !el ||
        !root ||
        !root.contains(el)
      ) {
        return;
      }


      if (
        ev.target.tagName === 'TEXTAREA' ||
        ev.target.closest('.material-editor')
      ) {
        return;
      }


      const t =
        parseFloat(
          el.dataset.seek
        );


      if (isNaN(t)) {
        return;
      }


      player.pause();

      player.currentTime =
        t;


      player.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      });

    }
  );

}


/* ============================================================
   通常 textarea 自動保存
   ============================================================ */

function initAutoSave() {

  const timers =
    new WeakMap();


  document
    .querySelectorAll('textarea[data-shot]')
    .forEach(function (ta) {

      ta.dataset.saved =
        ta.value;


      autoGrow(ta);


      ta.addEventListener(
        'input',
        function () {

          autoGrow(ta);


          clearTimeout(
            timers.get(ta)
          );


          timers.set(
            ta,
            setTimeout(
              function () {

                saveField(ta);

              },
              1200
            )
          );

        }
      );


      ta.addEventListener(
        'blur',
        function () {

          clearTimeout(
            timers.get(ta)
          );


          saveField(ta);

        }
      );

    });


  function autoGrow(ta) {

    /* 行の高さを手で決めている行では、
       入力欄の高さは CSS（--row-h）に任せる。
       ここで inline style を書くと CSS より優先されてしまう。 */
    if (ta.closest('tr[data-h]')) {
      ta.style.removeProperty('height');
      return;
    }

    ta.style.height =
      'auto';


    ta.style.height =
      Math.max(
        64,
        ta.scrollHeight + 2
      ) + 'px';

  }

}


/* ============================================================
   素材欄
   ============================================================

   文字＋画像を同じ欄で扱う。

   画像はCtrl+Vで貼り付け可能。
   ドラッグ＆ドロップも可能。

   文字だけなら通常のcontenteditable入力。

   Ctrl+A → Delete → Ctrl+V
   で画像だけにすることも可能。
   ============================================================ */

function initMaterialEditor() {

  const timers =
    new WeakMap();


  document
    .querySelectorAll(
      '.material-editor[data-shot]'
    )
    .forEach(function (editor) {

      editor.dataset.saved =
        editor.innerHTML;


      updateMaterialPlaceholder(
        editor
      );


      editor.addEventListener(
        'input',
        function () {

          updateMaterialPlaceholder(
            editor
          );


          clearTimeout(
            timers.get(editor)
          );


          timers.set(
            editor,
            setTimeout(
              function () {

                saveField(editor);

              },
              1200
            )
          );

        }
      );


      editor.addEventListener(
        'blur',
        function () {

          clearTimeout(
            timers.get(editor)
          );


          saveField(editor);

        }
      );


      /* --------------------------------------------------------
         Ctrl+V 画像貼り付け
         -------------------------------------------------------- */

      editor.addEventListener(
        'paste',
        async function (ev) {

          const items =
            Array.from(
              ev.clipboardData?.items || []
            );


          const imageItem =
            items.find(
              function (item) {

                return (
                  item.kind === 'file' &&
                  item.type.startsWith('image/')
                );

              }
            );


          if (!imageItem) {

            /*
             * 画像がない場合は通常の文字貼り付け。
             */
            return;

          }


          ev.preventDefault();


          const file =
            imageItem.getAsFile();


          if (!file) {
            return;
          }


          try {

            const dataUrl =
              await imageFileToDataUrl(
                file
              );


            insertImageAtCursor(
              editor,
              dataUrl
            );


            editor.dispatchEvent(
              new Event(
                'input',
                {
                  bubbles: true
                }
              )
            );

          }
          catch (err) {

            console.error(err);


            toast(
              '画像を貼り付けられませんでした。',
              true
            );

          }

        }
      );


      /* --------------------------------------------------------
         ドラッグ＆ドロップ
         -------------------------------------------------------- */

      editor.addEventListener(
        'dragover',
        function (ev) {

          const hasImage =
            Array.from(
              ev.dataTransfer?.items || []
            ).some(
              function (item) {

                return (
                  item.kind === 'file' &&
                  item.type.startsWith('image/')
                );

              }
            );


          if (!hasImage) {
            return;
          }


          ev.preventDefault();


          editor.classList.add(
            'material-dragover'
          );

        }
      );


      editor.addEventListener(
        'dragleave',
        function () {

          editor.classList.remove(
            'material-dragover'
          );

        }
      );


      editor.addEventListener(
        'drop',
        async function (ev) {

          editor.classList.remove(
            'material-dragover'
          );


          const files =
            Array.from(
              ev.dataTransfer?.files || []
            );


          const image =
            files.find(
              function (file) {

                return file.type.startsWith(
                  'image/'
                );

              }
            );


          if (!image) {
            return;
          }


          ev.preventDefault();


          try {

            const dataUrl =
              await imageFileToDataUrl(
                image
              );


            editor.focus();


            insertImageAtCursor(
              editor,
              dataUrl
            );


            editor.dispatchEvent(
              new Event(
                'input',
                {
                  bubbles: true
                }
              )
            );

          }
          catch (err) {

            console.error(err);


            toast(
              '画像を貼り付けられませんでした。',
              true
            );

          }

        }
      );


      /* --------------------------------------------------------
         画像クリック
         -------------------------------------------------------- */

      /* 旧実装はここで画像に material-image-selected を付け外ししていたが、
         素材欄は contenteditable で HTML がそのまま保存されるため、
         選択状態がデータに残ってしまっていた。
         選択の表示は素材欄の外に重ねる方式（initMaterialImages）に統一した。 */

    });


  /* ----------------------------------------------------------
     画像軽量化
     ---------------------------------------------------------- */

  async function imageFileToDataUrl(file) {

    const sourceUrl =
      URL.createObjectURL(file);


    try {

      const img =
        await new Promise(
          function (resolve, reject) {

            const image =
              new Image();


            image.onload =
              function () {
                resolve(image);
              };


            image.onerror =
              reject;


            image.src =
              sourceUrl;

          }
        );


      const maxSize =
        1600;


      let width =
        img.naturalWidth;

      let height =
        img.naturalHeight;


      if (
        width > maxSize ||
        height > maxSize
      ) {

        const scale =
          Math.min(
            maxSize / width,
            maxSize / height
          );


        width =
          Math.round(
            width * scale
          );


        height =
          Math.round(
            height * scale
          );

      }


      const canvas =
        document.createElement(
          'canvas'
        );


      canvas.width =
        width;

      canvas.height =
        height;


      const ctx =
        canvas.getContext(
          '2d'
        );


      ctx.drawImage(
        img,
        0,
        0,
        width,
        height
      );


      return canvas.toDataURL(
        'image/jpeg',
        0.82
      );

    }
    finally {

      URL.revokeObjectURL(
        sourceUrl
      );

    }

  }


  /* ----------------------------------------------------------
     カーソル位置へ画像挿入
     ---------------------------------------------------------- */

  function insertImageAtCursor(
    editor,
    dataUrl
  ) {

    editor.focus();


    const selection =
      window.getSelection();


    let range;


    if (
      selection &&
      selection.rangeCount > 0 &&
      editor.contains(
        selection.anchorNode
      )
    ) {

      range =
        selection.getRangeAt(0);

    }
    else {

      range =
        document.createRange();


      range.selectNodeContents(
        editor
      );


      range.collapse(false);

    }


    range.deleteContents();


    const img =
      document.createElement(
        'img'
      );


    img.src =
      dataUrl;


    img.alt =
      '貼り付け画像';


    img.className =
      'material-image';


    range.insertNode(
      img
    );


    const spacer =
      document.createTextNode(
        '\u00a0'
      );


    range.setStartAfter(
      img
    );


    range.collapse(true);


    range.insertNode(
      spacer
    );


    range.setStartAfter(
      spacer
    );


    range.collapse(true);


    selection.removeAllRanges();

    selection.addRange(
      range
    );

  }


  function updateMaterialPlaceholder(
    editor
  ) {

    const empty =
      editor.textContent.trim() === '' &&
      editor.querySelectorAll('img').length === 0;


    editor.classList.toggle(
      'is-empty',
      empty
    );

  }

}


/* ============================================================
   保存共通
   ============================================================ */

function saveField(field) {

  const currentValue =
    field.classList.contains(
      'material-editor'
    )
      ? field.innerHTML
      : field.value;


  if (
    currentValue ===
    field.dataset.saved
  ) {
    return;
  }


  const body = {};


  body[field.dataset.field] =
    currentValue;


  const sending =
    currentValue;


  markSaving(
    field
  );


  fetch(
    '/api/screenshots/' +
    field.dataset.shot,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body:
        JSON.stringify(body)

    }
  )
    .then(
      function (r) {

        if (!r.ok) {

          throw new Error(
            'HTTP ' + r.status
          );

        }


        return r.json();

      }
    )
    .then(
      function () {

        field.dataset.saved =
          sending;


        markSaved(
          field
        );


        setTimeout(
          function () {

            if (
              field.classList.contains(
                'saved'
              )
            ) {

              clearSaveState(
                field
              );

            }

          },
          1200
        );

      }
    )
    .catch(
      function (e) {

        markFailed(
          field
        );


        toast(
          '保存できませんでした（' +
          e.message +
          '）。もう一度入力欄から離れてください。',
          true
        );

      }
    );

}


/* ============================================================
   保存状態
   ============================================================ */

function markSaving(el) {

  el.classList.remove(
    'saving',
    'saved',
    'failed'
  );

  el.classList.add(
    'saving'
  );

}


function markSaved(el) {

  el.classList.remove(
    'saving',
    'saved',
    'failed'
  );

  el.classList.add(
    'saved'
  );


  /* 自動保存が通ったら、テキスト列の合計秒数も確実に合わせる */
  if (el.dataset.field === 'text_raw') {
    recountTextTotal();
  }

}


function markFailed(el) {

  el.classList.remove(
    'saving',
    'saved',
    'failed'
  );

  el.classList.add(
    'failed'
  );

}


function clearSaveState(el) {

  el.classList.remove(
    'saving',
    'saved',
    'failed'
  );

}


/* ============================================================
   スクショ拡大
   ============================================================ */

function initLightbox() {

  const box =
    document.getElementById(
      'lightbox'
    );


  const img =
    document.getElementById(
      'lightbox-img'
    );


  if (!box) {
    return;
  }


  document.addEventListener(
    'click',
    function (ev) {

      const t =
        ev.target;


      if (
        t.tagName === 'IMG' &&
        t.dataset.full
      ) {

        img.src =
          t.dataset.full;


        box.hidden =
          false;

      }

    }
  );


  box.addEventListener(
    'click',
    function () {

      box.hidden =
        true;


      img.src =
        '';

    }
  );


  document.addEventListener(
    'keydown',
    function (ev) {

      if (
        ev.key === 'Escape' &&
        !box.hidden
      ) {

        box.hidden =
          true;


        img.src =
          '';

      }

    }
  );

}


/* ============================================================
   処理中の進捗
   ============================================================ */

function initPolling() {

  /* 動画がまだ無い案件では見張る対象が無い。
     ここを抜けないと /api/videos//status を叩いて 404 になる。 */
  if (!root.dataset.videoId) {
    return;
  }

  if (
    root.dataset.status === 'done' ||
    root.dataset.status === 'error' ||
    root.dataset.status === 'none'
  ) {
    return;
  }


  const videoId =
    root.dataset.videoId;


  const fill =
    document.getElementById(
      'bar-fill'
    );


  const stage =
    document.getElementById(
      'stage'
    );


  let misses =
    0;


  function tick() {

    fetch(
      '/api/videos/' +
      videoId +
      '/status'
    )
      .then(
        function (r) {
          return r.json();
        }
      )
      .then(
        function (d) {

          misses = 0;


          if (fill) {

            fill.style.width =
              (d.progress || 0) +
              '%';

          }


          if (
            stage &&
            d.stage
          ) {

            stage.textContent =
              d.stage;

          }


          if (
            d.status === 'done' ||
            d.status === 'error'
          ) {

            location.reload();

            return;

          }


          setTimeout(
            tick,
            1500
          );

        }
      )
      .catch(
        function () {

          misses += 1;


          if (misses >= 10) {

            if (stage) {

              stage.textContent =
                'サーバーに接続できません。画面を再読み込みしてください。';

            }

            return;

          }


          setTimeout(
            tick,
            3000
          );

        }
      );

  }


  setTimeout(
    tick,
    1200
  );

}


/* ============================================================
   通知
   ============================================================ */

let toastTimer = null;


function toast(
  msg,
  isError
) {

  const el =
    document.getElementById(
      'toast'
    );


  if (!el) {
    return;
  }


  el.textContent =
    msg;


  el.classList.toggle(
    'error',
    !!isError
  );


  el.hidden =
    false;


  clearTimeout(
    toastTimer
  );


  toastTimer =
    setTimeout(
      function () {

        el.hidden =
          true;

      },
      5000
    );

}


/* ============================================================
   表の拡大・縮小
   ============================================================ */

(function () {

  const wrap =
    document.querySelector(
      ".table-wrap"
    );


  const sheet =
    document.querySelector(
      ".sheet"
    );


  if (!wrap || !sheet) {
    return;
  }


  let zoom =
    Number(
      localStorage.getItem(
        "videoReviewSheetZoom"
      ) || "1"
    );


  const minZoom = 0.6;
  const maxZoom = 1.5;
  const step = 0.1;


  const controls =
    document.createElement(
      "div"
    );


  controls.className =
    "sheet-zoom-controls";


  controls.innerHTML = `
    <span class="sheet-zoom-label">表示倍率</span>
    <button type="button" class="sheet-zoom-minus">−</button>
    <span class="sheet-zoom-value"></span>
    <button type="button" class="sheet-zoom-plus">＋</button>
    <button type="button" class="sheet-zoom-reset">100%</button>
  `;


  wrap.parentNode.insertBefore(
    controls,
    wrap
  );


  const value =
    controls.querySelector(
      ".sheet-zoom-value"
    );


  function applyZoom() {

    sheet.style.zoom =
      zoom;


    value.textContent =
      Math.round(
        zoom * 100
      ) + "%";


    localStorage.setItem(
      "videoReviewSheetZoom",
      String(zoom)
    );

  }


  controls
    .querySelector(
      ".sheet-zoom-minus"
    )
    .addEventListener(
      "click",
      function () {

        zoom =
          Math.max(
            minZoom,
            Math.round(
              (zoom - step) * 10
            ) / 10
          );


        applyZoom();

      }
    );


  controls
    .querySelector(
      ".sheet-zoom-plus"
    )
    .addEventListener(
      "click",
      function () {

        zoom =
          Math.min(
            maxZoom,
            Math.round(
              (zoom + step) * 10
            ) / 10
          );


        applyZoom();

      }
    );


  controls
    .querySelector(
      ".sheet-zoom-reset"
    )
    .addEventListener(
      "click",
      function () {

        zoom = 1;

        applyZoom();

      }
    );


  applyZoom();

})();


/* ============================================================
   案件一覧フィルター
   ============================================================ */

/*
   一覧の絞り込み。

   HTML 側の Notion 風ツールバー
   （検索 / ＋フィルター / 並べ替え / 条件をクリア）に接続する。

   ・検索   … 案件名・担当者・FB担当者を横断（部分一致）
   ・フィルター … バージョン と 担当者。
                  同じ項目内は OR、項目をまたぐと AND。
   ・並べ替え … 案件名 / 担当者 / FB担当者 / 初回登録 / 更新日時
   ・すべてサーバーに問い合わせず、画面上で即時に反映する。
*/

function initProjectFilters() {

  const search = document.getElementById('project-search');
  const body = document.getElementById('projects-body');

  if (!search || !body) {
    return;
  }

  const filtersBox = document.getElementById('database-filters');
  const addFilterBtn = document.getElementById('database-add-filter');
  const sortBtn = document.getElementById('database-sort-button');
  const sortPanel = document.getElementById('database-sort-panel');
  const sortField = document.getElementById('database-sort-field');
  const sortDir = document.getElementById('database-sort-direction');
  const clearBtn = document.getElementById('project-filter-clear');
  const countBox = document.getElementById('projects-count');
  const emptyBox = document.getElementById('projects-empty');

  const rows = Array.from(body.querySelectorAll('.project-row'));
  const originalOrder = rows.slice();
  const chips = Array.from(
    (filtersBox && filtersBox.querySelectorAll('.filter-chip')) || []
  );

  /* -------------------------------------------------- 絞り込み本体 */

  function checkedValues(chip) {
    return Array.from(
      chip.querySelectorAll('input[type=checkbox]')
    )
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return cb.value.trim().toLowerCase(); })
      .filter(Boolean);
  }

  function rowMatches(row, keyword, selected) {
    if (keyword) {
      const haystack = [
        row.dataset.genre,
        row.dataset.projectName,
        row.dataset.projectNo,
        row.dataset.assignee
      ].join(' ');

      if (haystack.indexOf(keyword) === -1) {
        return false;
      }
    }

    // 項目をまたぐ条件は AND
    for (const key in selected) {
      const wanted = selected[key];
      if (!wanted.length) {
        continue;
      }

      // 同じ項目内は OR
      const have = (row.dataset[key] || '')
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(Boolean);

      const hit = wanted.some(function (w) {
        return have.indexOf(w) !== -1;
      });

      if (!hit) {
        return false;
      }
    }

    return true;
  }

  function compareRows(a, b, field, dir) {
    const map = {
      genre: 'genre',
      name: 'projectName',
      project_no: 'projectNo',
      assignee: 'assignee',
      created: 'created'
    };

    const key = map[field];
    const av = (a.dataset[key] || '');
    const bv = (b.dataset[key] || '');

    const r = av.localeCompare(bv, 'ja');
    return dir === 'desc' ? -r : r;
  }

  function apply() {
    const keyword = search.value.trim().toLowerCase();

    /* 各チップが見る行の data 属性は、チップ自身の data-key で決める。
       ここを固定名にすると、項目を増やしたときに互いを上書きしてしまい、
       複数のフィルターを同時にかけられなくなる。 */
    const selected = {};
    chips.forEach(function (chip) {
      const key =
        chip.dataset.key ||
        chip.dataset.filter;

      if (!key) {
        return;
      }

      selected[key] = checkedValues(chip);
      updateChipLabel(chip, selected[key].length);
    });

    let shown = 0;
    rows.forEach(function (row) {
      const ok = rowMatches(row, keyword, selected);
      row.hidden = !ok;
      row.style.display = ok ? '' : 'none';
      if (ok) shown += 1;
    });

    // 並べ替え
    if (sortField && sortField.value) {
      const dir = sortDir ? sortDir.value : 'asc';
      const sorted = rows.slice().sort(function (a, b) {
        return compareRows(a, b, sortField.value, dir);
      });
      sorted.forEach(function (r) { body.appendChild(r); });
    } else {
      originalOrder.forEach(function (r) { body.appendChild(r); });
    }

    if (countBox) {
      countBox.textContent =
        shown === rows.length
          ? rows.length + '件'
          : shown + '件 / 全' + rows.length + '件';
    }

    if (emptyBox) {
      emptyBox.hidden = shown !== 0;
    }

    if (clearBtn) {
      clearBtn.hidden = !hasCondition(keyword, selected);
    }
  }

  function hasCondition(keyword, selected) {
    if (keyword) return true;
    for (const k in selected) {
      if (selected[k].length) return true;
    }
    return !!(sortField && sortField.value);
  }

  function updateChipLabel(chip, n) {
    const badge = chip.querySelector('.filter-chip-count');
    if (badge) {
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    }
    chip.classList.toggle('active', n > 0);
  }

  /* -------------------------------------------------- UI の開閉 */

  function closeAllPanels(except) {
    chips.forEach(function (chip) {
      const panel = chip.querySelector('.filter-panel');
      if (panel && panel !== except) panel.hidden = true;
    });
    if (sortPanel && sortPanel !== except) sortPanel.hidden = true;
  }

  chips.forEach(function (chip) {
    const btn = chip.querySelector('.filter-chip-button');
    const panel = chip.querySelector('.filter-panel');
    if (!btn || !panel) return;

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const willOpen = panel.hidden;
      closeAllPanels(panel);
      panel.hidden = !willOpen;
    });

    panel.addEventListener('click', function (ev) { ev.stopPropagation(); });
    panel.addEventListener('change', apply);
  });

  if (addFilterBtn && filtersBox) {
    addFilterBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      filtersBox.hidden = !filtersBox.hidden;
      addFilterBtn.classList.toggle('active', !filtersBox.hidden);
      if (filtersBox.hidden) closeAllPanels(null);
    });
  }

  if (sortBtn && sortPanel) {
    sortBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const willOpen = sortPanel.hidden;
      closeAllPanels(sortPanel);
      sortPanel.hidden = !willOpen;
      sortBtn.classList.toggle('active', !sortPanel.hidden);
    });
    sortPanel.addEventListener('click', function (ev) { ev.stopPropagation(); });
  }

  document.addEventListener('click', function () { closeAllPanels(null); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeAllPanels(null);
  });

  /* -------------------------------------------------- 入力の受け口 */

  search.addEventListener('input', apply);
  if (sortField) sortField.addEventListener('change', apply);
  if (sortDir) sortDir.addEventListener('change', apply);

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      search.value = '';
      chips.forEach(function (chip) {
        chip.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
          cb.checked = false;
        });
      });
      if (sortField) sortField.value = '';
      if (sortDir) sortDir.value = 'asc';
      apply();
      search.focus();
    });
  }

  apply();
}


/* ============================================================
   動画プレイヤーの大きさ調整
   ============================================================

   スライダー（20〜100%）で大きさを変え、ブラウザに覚えさせる。

   縦型（9:16）の動画は横幅を基準にすると、少し広げただけで
   画面の高さを使い切ってしまう。そこで % は「表示できる高さ」に
   割り当て、横幅は動画の縦横比にまかせる。
   こうすると縦型でも横型でもスライダー全域が意味を持つ。
   ============================================================ */

function initPlayerSize() {

  const slider =
    document.getElementById('player-size-slider');

  const label =
    document.getElementById('player-size-label');

  if (!slider) {
    return;
  }

  const KEY = 'vr.playerSize';

  /* 20% のとき 15vh、100% のとき 62vh。
     62vh より大きくすると表が狭くなりすぎる。 */
  const MIN_VH = 15;
  const MAX_VH = 62;

  function apply(value) {

    const pct =
      Math.min(
        100,
        Math.max(20, Number(value) || 65)
      );

    const vh =
      MIN_VH +
      ((pct - 20) / 80) * (MAX_VH - MIN_VH);

    document.documentElement.style.setProperty(
      '--player-size',
      vh.toFixed(2) + 'vh'
    );

    if (label) {
      label.textContent = String(pct);
    }

    slider.value = String(pct);
  }

  let saved = null;

  try {
    saved = localStorage.getItem(KEY);
  }
  catch (err) {
    /* プライベートモードなどで使えない場合は既定値のまま */
  }

  apply(saved === null ? slider.value : saved);

  slider.addEventListener(
    'input',
    function () {
      apply(slider.value);
    }
  );

  slider.addEventListener(
    'change',
    function () {
      try {
        localStorage.setItem(KEY, slider.value);
      }
      catch (err) {
        /* 保存できなくても操作は続けられる */
      }
    }
  );
}


/* ============================================================
   素材欄の画像：選んでつまみで大きさ調整
   ============================================================

   画像編集ソフトのトリミングと同じ操作にする。

     画像をクリック   → 選択され、四隅につまみが出る
     つまみをドラッグ → 大きさを変える（縦横比は保つ）
     ダブルクリック   → 全画面表示
     Esc / 余白クリック → 選択解除

   つまみは素材欄の「外」に浮かせて描く。
   素材欄は contenteditable で、その HTML がそのまま DB に保存されるため、
   中に部品を入れると保存内容が汚れてしまう。
   ============================================================ */

function initMaterialImages() {

  const MIN_W = 50;     /* 最小の幅（px） */
  const MAX_W = 1600;   /* 最大の幅（px） */

  if (!document.querySelector('.material-editor[data-shot]')) {
    return;
  }

  /* 旧実装が保存してしまった選択状態のクラスを取り除く。
     次にその欄を編集・保存したときに、データからも消える。 */
  document
    .querySelectorAll('.material-editor img.material-image-selected')
    .forEach(function (img) {
      img.classList.remove('material-image-selected');
    });

  /* ---- つまみ一式を作る（body 直下に置く） ---- */

  const ui = document.createElement('div');
  ui.className = 'img-resizer';
  ui.hidden = true;
  ui.innerHTML =
    '<span class="img-handle" data-dir="nw"></span>' +
    '<span class="img-handle" data-dir="ne"></span>' +
    '<span class="img-handle" data-dir="sw"></span>' +
    '<span class="img-handle" data-dir="se"></span>' +
    '<div class="img-resizer-tools">' +
      '<span class="img-resizer-size"></span>' +
      '<button type="button" data-act="zoom" title="全画面で見る">⤢</button>' +
      '<button type="button" data-act="reset" title="元の大きさに戻す">↺</button>' +
    '</div>';
  document.body.appendChild(ui);

  const sizeLabel = ui.querySelector('.img-resizer-size');

  let selected = null;
  let drag = null;


  /* ---- 選択 ---- */

  function select(img) {
    selected = img;
    ui.hidden = false;
    place();
  }

  function deselect() {
    selected = null;
    ui.hidden = true;
  }

  function place() {

    if (!selected) {
      return;
    }

    const r = selected.getBoundingClientRect();

    /* 表の外にスクロールで出たら隠す */
    if (r.bottom < 0 || r.top > window.innerHeight ||
        r.right < 0 || r.left > window.innerWidth) {
      ui.style.visibility = 'hidden';
      return;
    }

    ui.style.visibility = 'visible';
    ui.style.left = r.left + 'px';
    ui.style.top = r.top + 'px';
    ui.style.width = r.width + 'px';
    ui.style.height = r.height + 'px';

    sizeLabel.textContent =
      Math.round(r.width) + ' × ' + Math.round(r.height);
  }


  /* ---- クリックで選択、ダブルクリックで全画面 ---- */

  document.addEventListener(
    'click',
    function (ev) {

      const img = materialImage(ev.target);

      if (img) {
        select(img);
        return;
      }

      if (!ev.target.closest('.img-resizer')) {
        deselect();
      }
    }
  );

  document.addEventListener(
    'dblclick',
    function (ev) {

      const img = materialImage(ev.target);

      if (img) {
        ev.preventDefault();
        openLightbox(img.getAttribute('src'));
      }
    }
  );


  /* ---- つまみの操作 ---- */

  ui.addEventListener(
    'mousedown',
    function (ev) {

      const handle = ev.target.closest('.img-handle');

      if (!handle || !selected) {
        return;
      }

      ev.preventDefault();

      const r = selected.getBoundingClientRect();

      drag = {
        dir: handle.dataset.dir,
        startX: ev.clientX,
        startW: r.width,
        max: maxWidthFor(selected)
      };

      document.body.classList.add('is-resizing-image');
    }
  );

  document.addEventListener(
    'mousemove',
    function (ev) {

      if (!drag || !selected) {
        return;
      }

      /* 左側のつまみは引っ張る向きが逆になる */
      const sign = drag.dir === 'nw' || drag.dir === 'sw' ? -1 : 1;

      const width =
        Math.max(
          MIN_W,
          Math.min(
            drag.max,
            drag.startW + (ev.clientX - drag.startX) * sign
          )
        );

      const w = Math.round(width);

      selected.style.width = w + 'px';
      selected.style.height = 'auto';

      /* :has() が無いブラウザでもセルが広がるようにする */
      const editor = selected.closest('.material-editor');

      if (editor) {
        editor.style.minWidth = (w + 24) + 'px';
      }

      place();
    }
  );

  document.addEventListener(
    'mouseup',
    function () {

      if (!drag) {
        return;
      }

      drag = null;
      document.body.classList.remove('is-resizing-image');

      const editor = selected && selected.closest('.material-editor');

      if (editor) {
        saveField(editor);
      }
    }
  );


  /* ---- ボタン ---- */

  ui.addEventListener(
    'click',
    function (ev) {

      const btn = ev.target.closest('button[data-act]');

      if (!btn || !selected) {
        return;
      }

      if (btn.dataset.act === 'zoom') {
        openLightbox(selected.getAttribute('src'));
        return;
      }

      if (btn.dataset.act === 'reset') {

        /* 幅だけでなく、以前の実装が書き込んだ cursor なども掃除する */
        selected.removeAttribute('style');

        const editor = selected.closest('.material-editor');

        if (editor) {
          editor.style.minWidth = '';
          saveField(editor);
        }

        place();
      }
    }
  );


  /* ---- 位置の追従 ---- */

  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  document.addEventListener(
    'keydown',
    function (ev) {
      if (ev.key === 'Escape') {
        deselect();
      }
    }
  );


  /* ---- 補助 ---- */

  function materialImage(target) {

    if (!target || target.tagName !== 'IMG') {
      return null;
    }

    return target.closest('.material-editor') ? target : null;
  }

  function maxWidthFor(img) {

    const wrap = img.closest('.table-wrap');

    const room =
      (wrap ? wrap.clientWidth : window.innerWidth) - 80;

    /* すでに上限より大きい画像をつかんだとき、
       いきなり縮まないよう今の幅も下限に含める。 */
    const current = img.getBoundingClientRect().width;

    return Math.max(
      MIN_W,
      current,
      Math.min(MAX_W, room)
    );
  }
}


/* 拡大表示（スクショの拡大と同じモーダルを使う） */

function openLightbox(src) {

  const box = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');

  if (!box || !img || !src) {
    return;
  }

  img.src = src;
  box.hidden = false;
}


function closeLightbox() {

  const box = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');

  if (!box) {
    return;
  }

  box.hidden = true;

  if (img) {
    img.src = '';
  }
}


/* × ボタン・Esc・背景クリックで閉じる */

(function () {

  const closeBtn = document.getElementById('lightbox-close');

  if (closeBtn) {
    closeBtn.addEventListener(
      'click',
      function (ev) {
        ev.stopPropagation();
        closeLightbox();
      }
    );
  }

  document.addEventListener(
    'keydown',
    function (ev) {
      if (ev.key === 'Escape') {
        closeLightbox();
      }
    }
  );

})();


/* ============================================================
   改修1：動画プレイヤーの固定・最小化・非表示
   ============================================================

   プレイヤーは position: fixed で画面に固定してあるので、
   ページをどれだけ下にスクロールしても見えたままになる。

     float  … 通常。右上に浮かぶ
     mini   … 右下の小さな窓。バーをつかんで移動できる
     hidden … 消す。「▶ 動画を表示」で戻す

   位置と表示状態はブラウザに覚えさせ、リロードしても保つ。
   ============================================================ */

function initPlayerWindow() {

  const wrap = document.getElementById('player-wrap');
  const bar = document.getElementById('player-bar');
  const showBtn = document.getElementById('player-show');

  if (!wrap || !bar) {
    return;
  }

  const KEY_MODE = 'vr.playerMode';
  const KEY_POS = 'vr.playerPos';

  /* ---- 表示状態 ---- */

  function setMode(mode) {

    wrap.dataset.mode = mode;

    if (showBtn) {
      showBtn.hidden = mode !== 'hidden';
    }

    /* 通常表示のときだけ、上部の要素がプレイヤーに隠れないよう右を空ける */
    const reserve =
      mode === 'float'
        ? Math.round(wrap.getBoundingClientRect().width) + 32
        : 0;

    document.documentElement.style.setProperty(
      '--player-reserve',
      reserve + 'px'
    );

    store(KEY_MODE, mode);
  }

  const btnMin = document.getElementById('player-min');
  const btnHide = document.getElementById('player-hide');
  const btnRestore = document.getElementById('player-restore');

  if (btnMin) {
    btnMin.addEventListener('click', function () {
      setMode('mini');
    });
  }

  if (btnHide) {
    btnHide.addEventListener('click', function () {
      setMode('hidden');
    });
  }

  if (btnRestore) {
    btnRestore.addEventListener('click', function () {
      clearPosition();
      setMode('float');
    });
  }

  if (showBtn) {
    showBtn.addEventListener('click', function () {
      setMode('float');
    });
  }


  /* ---- バーをつかんで移動 ---- */

  let drag = null;

  bar.addEventListener(
    'mousedown',
    function (ev) {

      if (ev.target.closest('.player-bar-btn')) {
        return;   /* ボタンは移動の対象にしない */
      }

      const r = wrap.getBoundingClientRect();

      drag = {
        dx: ev.clientX - r.left,
        dy: ev.clientY - r.top,
        w: r.width,
        h: r.height
      };

      document.body.classList.add('is-moving-player');
      ev.preventDefault();
    }
  );

  document.addEventListener(
    'mousemove',
    function (ev) {

      if (!drag) {
        return;
      }

      const left =
        clamp(ev.clientX - drag.dx, 4, window.innerWidth - drag.w - 4);

      const top =
        clamp(ev.clientY - drag.dy, 4, window.innerHeight - drag.h - 4);

      applyPosition(left, top);
    }
  );

  document.addEventListener(
    'mouseup',
    function () {

      if (!drag) {
        return;
      }

      drag = null;
      document.body.classList.remove('is-moving-player');

      const r = wrap.getBoundingClientRect();

      store(
        KEY_POS,
        JSON.stringify({
          left: Math.round(r.left),
          top: Math.round(r.top)
        })
      );
    }
  );


  function applyPosition(left, top) {
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  }


  function clearPosition() {
    wrap.style.left = '';
    wrap.style.top = '';
    wrap.style.right = '';
    wrap.style.bottom = '';
    remove(KEY_POS);
  }


  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }


  /* ---- 保存と復元 ---- */

  function store(key, value) {
    try {
      localStorage.setItem(key, value);
    }
    catch (err) {
      /* 使えない環境では覚えないだけ */
    }
  }

  function read(key) {
    try {
      return localStorage.getItem(key);
    }
    catch (err) {
      return null;
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(key);
    }
    catch (err) {
      /* 何もしない */
    }
  }

  const savedMode = read(KEY_MODE);

  setMode(
    savedMode === 'mini' || savedMode === 'hidden'
      ? savedMode
      : 'float'
  );

  const savedPos = read(KEY_POS);

  if (savedPos) {
    try {
      const p = JSON.parse(savedPos);
      const r = wrap.getBoundingClientRect();

      applyPosition(
        clamp(p.left, 4, window.innerWidth - r.width - 4),
        clamp(p.top, 4, window.innerHeight - r.height - 4)
      );
    }
    catch (err) {
      remove(KEY_POS);
    }
  }

  /* 大きさを変えたら、上部の余白も測り直す */
  const slider = document.getElementById('player-size-slider');

  if (slider) {
    slider.addEventListener('change', function () {
      setMode(wrap.dataset.mode || 'float');
    });
  }

  window.addEventListener('resize', function () {
    setMode(wrap.dataset.mode || 'float');
  });
}


/* ============================================================
   行の高さを手で変える（スプレッドシートと同じ操作）
   ============================================================

     行番号の下の境目をドラッグ → その行の高さが変わる
     境目をダブルクリック       → 自動の高さに戻す

   高さは screenshots.row_height に保存するので、
   リロードしても、別の PC から開いても同じ高さになる。

   行の高さはキャプチャ画像と入力欄の背丈で決まるので、
   --row-h に合わせて両方を伸縮させる（CSS 側）。
   ============================================================ */

function initRowResize() {

  const MIN_H = 70;
  const MAX_H = 800;

  const grips =
    document.querySelectorAll('.row-grip[data-shot]');

  if (!grips.length) {
    return;
  }

  let drag = null;

  grips.forEach(function (grip) {

    grip.addEventListener(
      'mousedown',
      function (ev) {

        const row = grip.closest('tr');

        if (!row) {
          return;
        }

        ev.preventDefault();

        drag = {
          row: row,
          shot: grip.dataset.shot,
          startY: ev.clientY,
          startH: row.getBoundingClientRect().height
        };

        document.body.classList.add('is-resizing-row');
      }
    );

    /* ダブルクリックで自動の高さへ */
    grip.addEventListener(
      'dblclick',
      function (ev) {

        ev.preventDefault();

        const row = grip.closest('tr');

        if (!row) {
          return;
        }

        row.removeAttribute('data-h');
        row.style.removeProperty('--row-h');

        save(grip.dataset.shot, 0);
      }
    );

  });


  document.addEventListener(
    'mousemove',
    function (ev) {

      if (!drag) {
        return;
      }

      const h =
        Math.round(
          Math.max(
            MIN_H,
            Math.min(
              MAX_H,
              drag.startH + (ev.clientY - drag.startY)
            )
          )
        );

      drag.row.dataset.h = String(h);
      drag.row.style.setProperty('--row-h', h + 'px');
    }
  );


  document.addEventListener(
    'mouseup',
    function () {

      if (!drag) {
        return;
      }

      const shot = drag.shot;
      const h = parseInt(drag.row.dataset.h, 10) || 0;

      drag = null;
      document.body.classList.remove('is-resizing-row');

      save(shot, h);
    }
  );


  function save(shotId, height) {

    fetch(
      '/api/screenshots/' + shotId,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          row_height: height
        })
      }
    )
      .catch(function (err) {
        toast(
          '行の高さを保存できませんでした（' + err.message + '）',
          true
        );
      });
  }
}


/* ============================================================
   列幅を手で変える（スプレッドシートと同じ操作）
   ============================================================

     見出しの右端をドラッグ     → その列の幅が変わる
     見出しの右端をダブルクリック → 自動幅に戻す

   幅は projects.column_widths に JSON で保存する。
   行の高さと違って列は表全体の設定なので、案件ごとに1つ持つ。

   幅は <style> を1枚作って nth-child で当てる。
   見出しだけに指定しても、下のセルの中身が広いと列は縮まないため、
   見出しとセルの両方へ一度に効かせる必要がある。
   ============================================================ */

function initColumnResize() {

  const MIN_W = 60;
  const MAX_W = 1200;

  const root = document.querySelector('.project');
  const table = document.querySelector('table.sheet');

  if (!root || !table) {
    return;
  }

  const projectId = root.dataset.projectId;

  let widths = {};

  try {
    widths = JSON.parse(root.dataset.columnWidths || '{}') || {};
  }
  catch (err) {
    widths = {};
  }

  const sheet = document.createElement('style');
  document.head.appendChild(sheet);

  apply();


  function apply() {

    const rules = [];

    Object.keys(widths).forEach(function (index) {

      const px = parseInt(widths[index], 10);

      if (!px) {
        return;
      }

      const nth = parseInt(index, 10) + 1;

      rules.push(
        '.sheet tr > *:nth-child(' + nth + '){' +
          'width:' + px + 'px !important;' +
          'min-width:' + px + 'px !important;' +
          'max-width:' + px + 'px !important;}'
      );
    });

    sheet.textContent = rules.join(' ');
  }


  /* ---- つまみ ---- */

  let drag = null;

  table.querySelectorAll('.col-grip[data-col]').forEach(function (grip) {

    grip.addEventListener(
      'mousedown',
      function (ev) {

        const th = grip.closest('th');

        if (!th) {
          return;
        }

        ev.preventDefault();
        ev.stopPropagation();

        drag = {
          index: grip.dataset.col,
          startX: ev.clientX,
          startW: th.getBoundingClientRect().width
        };

        document.body.classList.add('is-resizing-col');
      }
    );

    grip.addEventListener(
      'dblclick',
      function (ev) {

        ev.preventDefault();
        ev.stopPropagation();

        delete widths[grip.dataset.col];

        apply();
        save();
      }
    );

  });


  document.addEventListener(
    'mousemove',
    function (ev) {

      if (!drag) {
        return;
      }

      const w =
        Math.round(
          Math.max(
            MIN_W,
            Math.min(
              MAX_W,
              drag.startW + (ev.clientX - drag.startX)
            )
          )
        );

      widths[drag.index] = w;
      apply();
    }
  );


  document.addEventListener(
    'mouseup',
    function () {

      if (!drag) {
        return;
      }

      drag = null;
      document.body.classList.remove('is-resizing-col');

      save();
    }
  );


  function save() {

    if (!projectId) {
      return;
    }

    fetch(
      '/api/projects/' + projectId + '/columns',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          widths: widths
        })
      }
    )
      .catch(function (err) {
        toast(
          '列幅を保存できませんでした（' + err.message + '）',
          true
        );
      });
  }
}


/* ============================================================
   この場面を追加（動画プレイヤーの横のボタン）

   見えているコマを canvas に写して送る。
   サーバーで動画を開き直すより速く、画面とずれない。
   ============================================================ */

function initCapture() {

  const btn = document.getElementById('capture-shot');
  const video = document.getElementById('player');
  const tbody = document.getElementById('rows');

  if (!btn || !video || !tbody) {
    return;
  }

  btn.addEventListener('click', function () {

    if (!video.videoWidth) {
      toast('動画がまだ読み込まれていません。', true);
      return;
    }

    btn.disabled = true;
    btn.classList.add('is-busy');

    /* 押した瞬間の時間。送るまでに再生が進んでもずれないよう控える */
    const at = video.currentTime;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    try {
      canvas.getContext('2d').drawImage(video, 0, 0);
    } catch (err) {
      finish();
      toast('この動画からは画像を取り出せませんでした。', true);
      return;
    }

    canvas.toBlob(
      function (blob) {

        if (!blob) {
          finish();
          toast('画像を作れませんでした。', true);
          return;
        }

        const form = new FormData();
        form.append('image', blob, 'capture.jpg');
        form.append('t', String(at));

        fetch('/api/videos/' + btn.dataset.video + '/capture', {
          method: 'POST',
          body: form,
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {

            if (!data.ok) {
              throw new Error(data.error || '追加できませんでした');
            }

            addCapturedRow(data);
            toast(
              data.time_label + ' の場面を ' + data.seq + ' 行目に入れました'
            );

          })
          .catch(function (err) {
            toast('追加できませんでした（' + err.message + '）', true);
          })
          .then(finish);
      },
      'image/jpeg',
      0.92
    );
  });

  function finish() {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }

  /** 撮ったものを表の一番下に足す */
  function addCapturedRow(data) {

    const tr = buildEmptyRow(data.id, data.seq);

    if (!tr) {
      location.reload();
      return;
    }

    tr.dataset.seek = String(data.timestamp_sec);
    tr.dataset.manual = '1';

    /* 画像 */
    const cell = tr.querySelector('.c-shot');

    if (cell) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 124;
      img.height = 220;
      img.src = data.url;
      img.alt = String(data.seq);
      img.dataset.seek = String(data.timestamp_sec);
      img.dataset.full = data.url;

      cell.innerHTML = '';
      cell.appendChild(img);
    }

    /* 秒数 */
    const time = tr.querySelector('.c-time');

    if (time) {
      const seek = document.createElement('button');
      seek.type = 'button';
      seek.className = 'seek';
      seek.dataset.seek = String(data.timestamp_sec);
      seek.textContent = data.time_label;

      time.innerHTML = '';
      time.appendChild(seek);
    }

    /* 秒数の順になる位置に差し込む（seq は 1 から数えた行番号） */
    const rows = tbody.querySelectorAll('tr[data-shot-row]');
    const at = Math.max(0, data.seq - 1);

    if (at < rows.length) {
      tbody.insertBefore(tr, rows[at]);
    } else {
      tbody.appendChild(tr);
    }

    renumberSeq();

    initAutoSave();
    initMaterialEditor();
    initRowResize();

    /* 足した行までは動かさない。見ている場所から離れてしまうため。
       追加できたことは、色の変化と画面右下の知らせで分かる。 */
    tr.classList.add('is-added');
    setTimeout(function () { tr.classList.remove('is-added'); }, 1600);
  }

  /** 途中に差し込んだので、行番号を振り直す */
  function renumberSeq() {
    tbody.querySelectorAll('tr[data-shot-row]').forEach(function (row, i) {
      const box = row.querySelector('.row-seq');
      if (box) { box.textContent = String(i + 1); }
    });
  }
}


/* ============================================================
   月間目標の設定（進捗ボード）
   ============================================================ */

function initGoalForm() {

  const form = document.getElementById('goal-form');

  if (!form) {
    return;
  }

  form.addEventListener('submit', function (e) {

    e.preventDefault();

    const data = new FormData(form);

    /* 画面では時間で入れてもらい、保存は秒にそろえる */
    const body = {
      monthly_target: Number(data.get('monthly_target') || 0),
      target_analysis: Math.round(
        Number(data.get('target_analysis_h') || 0) * 3600
      ),
      target_reuse: Math.round(
        Number(data.get('target_reuse_h') || 0) * 3600
      ),
    };

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;

    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || '保存できませんでした');
        }

        location.reload();
      })
      .catch(function (err) {
        toast(err.message, true);
        btn.disabled = false;
      });
  });
}


/* ============================================================
   ガイドライン（共通ノート）
   ============================================================ */

function initGuidelines() {

  const page = document.querySelector('.notes-page');

  if (!page) {
    return;
  }

  /* 採用 */
  page.addEventListener('click', function (e) {

    const btn = e.target.closest('.note-adopt');

    if (!btn) {
      return;
    }

    btn.disabled = true;

    fetch('/api/guidelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: btn.dataset.text,
        source: btn.dataset.text,
        seen: Number(btn.dataset.seen || 0),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || '採用できませんでした');
        }

        location.reload();
      })
      .catch(function (err) {
        toast(err.message, true);
        btn.disabled = false;
      });
  });

  /* 外す */
  page.addEventListener('click', function (e) {

    const btn = e.target.closest('.guideline-drop');

    if (!btn) {
      return;
    }

    const item = btn.closest('.guideline-item');

    if (!window.confirm('このガイドラインを外しますか？')) {
      return;
    }

    fetch('/api/guidelines/' + item.dataset.id + '/delete', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || '外せませんでした');
        }

        location.reload();
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  });

  /* AI で文章にまとめる */
  const ai = document.getElementById('ai-draft');
  const out = document.getElementById('ai-result');

  if (!ai || !out) {
    return;
  }

  ai.addEventListener('click', function () {

    const items = [].slice.call(document.querySelectorAll('.note-item'))
      .map(function (li) {
        return {
          text: li.querySelector('.note-text').textContent.trim(),
          count: parseInt(
            (li.querySelector('.note-count') || {}).textContent || '0', 10
          ),
        };
      })
      .filter(function (i) { return i.text; });

    if (!items.length) {
      toast('まとめる材料がありません。', true);
      return;
    }

    ai.disabled = true;
    ai.textContent = 'まとめています…';

    fetch('/api/guidelines/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || 'まとめられませんでした');
        }

        showDrafts(res.drafts);
      })
      .catch(function (err) {
        toast(err.message, true);
      })
      .then(function () {
        ai.disabled = false;
        ai.textContent = 'AI で文章にまとめる';
      });
  });

  function showDrafts(drafts) {

    out.hidden = false;
    out.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'ai-result-title';
    title.textContent =
      'AI がまとめた文案です。そのまま採るか、直してから採ってください。';
    out.appendChild(title);

    drafts.forEach(function (text) {

      const row = document.createElement('div');
      row.className = 'ai-draft-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = text;

      const take = document.createElement('button');
      take.type = 'button';
      take.className = 'primary';
      take.textContent = '採用';

      take.addEventListener('click', function () {

        take.disabled = true;

        fetch('/api/guidelines', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input.value.trim(), seen: 0 }),
        })
          .then(function (r) { return r.json(); })
          .then(function (res) {

            if (!res.ok) {
              throw new Error(res.error || '採用できませんでした');
            }

            row.remove();
            toast('ガイドラインに足しました');
          })
          .catch(function (err) {
            toast(err.message, true);
            take.disabled = false;
          });
      });

      row.appendChild(input);
      row.appendChild(take);
      out.appendChild(row);
    });
  }
}

initGoalForm();
initGuidelines();


/* ============================================================
   見出しをダブルクリックして、その列をまるごとコピー

   スプレッドシートにそのまま貼れるよう、行ごとに改行で並べる。
   セルの中で改行しているときは、貼り付け先で1行に収まるよう
   引用符でくくる（スプレッドシートの決まりに合わせる）。
   ============================================================ */

function initColumnCopy() {

  const table = document.querySelector('.sheet');

  if (!table) {
    return;
  }

  table.addEventListener('dblclick', function (e) {

    /* 幅を変える取っ手のダブルクリックは、幅を戻す動きなので触らない */
    if (e.target.closest('.col-grip')) {
      return;
    }

    const th = e.target.closest('thead th');

    if (!th) {
      return;
    }

    const index = [].slice.call(th.parentElement.children).indexOf(th);

    const label = (
      th.querySelector('.th-label') || th
    ).textContent.trim().split('\n')[0];

    const values = [].slice
      .call(table.querySelectorAll('tbody tr'))
      .map(function (tr) {
        return cellText(tr.children[index]);
      });

    if (!values.length) {
      toast('コピーする行がありません。', true);
      return;
    }

    copyText(values.map(quoteIfNeeded).join('\n'))
      .then(function () {
        th.classList.add('is-copied');
        setTimeout(function () { th.classList.remove('is-copied'); }, 1200);
        toast('「' + label + '」の ' + values.length + ' 行をコピーしました');
      })
      .catch(function () {
        toast('コピーできませんでした。', true);
      });
  });

  /** セルの中身を文字にする */
  function cellText(cell) {

    if (!cell) {
      return '';
    }

    const field = cell.querySelector('textarea');

    if (field) {
      return field.value.trim();
    }

    const editor = cell.querySelector('.material-editor');

    if (editor) {
      return (editor.innerText || '').trim();
    }

    const seq = cell.querySelector('.row-seq');

    if (seq) {
      return seq.textContent.trim();
    }

    const button = cell.querySelector('button');

    if (button) {
      return button.textContent.trim();
    }

    const img = cell.querySelector('img');

    if (img) {
      return '';
    }

    return (cell.innerText || '').trim();
  }

  function quoteIfNeeded(text) {

    if (text.indexOf('\n') === -1 && text.indexOf('"') === -1) {
      return text;
    }

    return '"' + text.replace(/"/g, '""') + '"';
  }

  function copyText(text) {

    /* 新しい書き込み方が断られることがある（許可の設定など）ので、
       そのときは古いやり方に切り替える。 */
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard
        .writeText(text)
        .catch(function () {
          return legacyCopyText(text);
        });
    }

    return legacyCopyText(text);
  }

  function legacyCopyText(text) {

    return new Promise(function (done, fail) {

      const box = document.createElement('textarea');
      box.value = text;
      box.style.position = 'fixed';
      box.style.opacity = '0';

      document.body.appendChild(box);
      box.select();

      let ok = false;

      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }

      box.remove();

      if (ok) {
        done();
      } else {
        fail(new Error('copy failed'));
      }
    });
  }
}


/* ============================================================
   案件の見出しの編集

   ふだんは、ジャンルや担当者を押すとその一覧へ飛ぶ。
   「編集」を押したときだけ書き換えられるようにして、
   見るための押下と、直すための押下がぶつからないようにする。
   ============================================================ */

function initInlineInfo() {

  const head = document.querySelector('.project-info-head');
  const toggle = document.getElementById('project-edit');

  if (!head || !toggle || !head.dataset.project) {
    return;
  }

  const id = head.dataset.project;

  toggle.addEventListener('click', function () {

    if (head.classList.contains('is-editing')) {

      /* 隠す前に離す。こうしないと保存の処理が走らないことがある */
      const active = head.querySelector('.meta-edit:focus');
      if (active) { active.blur(); }

      head.classList.remove('is-editing');
      toggle.textContent = '編集';
      toggle.classList.remove('is-active');
      return;
    }

    head.classList.add('is-editing');
    toggle.textContent = '保存';
    toggle.classList.add('is-active');

    const first = head.querySelector('.meta-edit[data-field="name"]');

    if (first) {
      first.focus();
      placeCaretAtEnd(first);
    }
  });

  head.querySelectorAll('.meta-edit').forEach(function (box) {

    box.dataset.saved = box.textContent.trim();

    box.addEventListener('keydown', function (e) {

      if (e.key === 'Enter') {
        e.preventDefault();
        box.blur();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        box.textContent = box.dataset.saved;
        box.blur();
      }
    });

    box.addEventListener('paste', function (e) {

      /* 書式や改行が混ざらないよう、文字だけ受け取る */
      e.preventDefault();

      const text = (e.clipboardData || window.clipboardData)
        .getData('text')
        .replace(/\s+/g, ' ')
        .trim();

      document.execCommand('insertText', false, text);
    });

    box.addEventListener('blur', function () {
      save(box);
    });
  });

  function save(box) {

    const field = box.dataset.field;
    const value = box.textContent.replace(/\s+/g, ' ').trim();

    box.textContent = value;

    if (value === box.dataset.saved) {
      mark(box, '');
      return;
    }

    if (field === 'name' && !value) {
      toast('案件名は空にできません。', true);
      box.textContent = box.dataset.saved;
      return;
    }

    const body = {};
    body[field] = value;

    mark(box, 'is-saving');

    fetch('/api/projects/' + id + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {

        if (!res.ok) {
          throw new Error(res.error || '保存できませんでした');
        }

        box.dataset.saved = value;
        box.classList.toggle('is-empty', !value);
        mark(box, 'is-saved');

        showValue(field, value);

        const stamp = document.getElementById('project-updated');
        if (stamp) { stamp.textContent = res.updated_at; }

        /* リンクが変わったらアドレス欄も合わせる */
        if (res.url && location.pathname !== res.url.split('?')[0]) {
          history.replaceState(null, '', res.url);
        }

        setTimeout(function () { mark(box, ''); }, 1200);
      })
      .catch(function (err) {
        mark(box, 'is-error');
        toast(err.message, true);
        box.textContent = box.dataset.saved;
        setTimeout(function () { mark(box, ''); }, 1600);
      });
  }

  /** 直した内容を、ふだん見えている側にも反映する */
  function showValue(field, value) {

    if (field === 'name') {
      const view = head.querySelector('.project-info-title .meta-view');
      if (view) { view.textContent = value; }
      return;
    }

    if (field === 'project_no') {
      const view = head.querySelector('.meta-view-no');
      if (view) {
        view.textContent = value;
        view.classList.toggle('is-blank', !value);
      }
      return;
    }

    const view = head.querySelector('[data-view="' + field + '"]');

    if (!view) {
      return;
    }

    const base = field === 'genre' ? '/genres/' : '/assignees/';

    if (value) {
      const link = document.createElement('a');
      link.className = 'meta-link';
      link.dataset.view = field;
      link.href = base + encodeURIComponent(value);
      link.textContent = value;
      link.title = field === 'genre'
        ? 'このジャンルの案件だけを見る'
        : 'この担当者の案件だけを見る';
      view.replaceWith(link);
    } else {
      const none = document.createElement('span');
      none.className = 'meta-none';
      none.dataset.view = field;
      none.textContent = '未設定';
      view.replaceWith(none);
    }
  }

  function mark(box, state) {
    box.classList.remove('is-saving', 'is-saved', 'is-error');
    if (state) { box.classList.add(state); }
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
