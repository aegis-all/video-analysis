/* ============================================================
   案件ページ

   データを読んで表を組み立て、そのあとで app.js を読み込む。
   app.js は「表がすでに画面にある」前提で動くので、順番が要る。
   ============================================================ */

(async function () {

  const key = new URLSearchParams(location.search).get('p');

  if (!key) { location.replace('index.html'); return; }

  const project = await load();

  if (!project) { return; }


  async function load() {

    const found = await API.Projects.byKey(key);

    if (!found) {
      document.getElementById('project-root').innerHTML =
        '<section class="card"><h2>案件が見つかりません</h2>'
        + '<p class="muted"><a href="index.html">案件一覧へ戻る</a></p></section>';
      await Shell.mountShell('');
      return null;
    }

    document.title = found.name + ' — 動画分析';

    return found;
  }


  /* ------------------------------------------------------------
     ヘッダー（案件名・番号・リンクのコピー）
     ------------------------------------------------------------ */

  const bar = document.createElement('div');
  bar.className = 'project-topbar';
  bar.innerHTML =
    '<a class="back-link" href="index.html">← 案件一覧</a>'
    + '<span class="project-name">' + Shell.escapeHtml(project.name) + '</span>'
    + '<button type="button" class="permalink-button" id="permalink-button"'
    + ' data-url="' + Shell.escapeHtml(
      location.origin + location.pathname + '?p='
      + encodeURIComponent(project.slug || project.id)) + '"'
    + ' data-label="' + Shell.escapeHtml(
      project.name + (project.project_no || '')) + '"'
    + ' title="この案件へのリンクをコピーします">🔗 '
    + Shell.escapeHtml(project.name + (project.project_no || '')) + '</button>';

  const me = await Shell.mountShell('', bar);

  if (!me) { return; }


  /* ------------------------------------------------------------
     案件情報
     ------------------------------------------------------------ */

  const info = document.getElementById('info-card');
  info.hidden = false;

  const editable = function (field, value, extra, placeholder) {
    return '<span class="meta-edit edit-field ' + extra
      + (value ? '' : ' is-empty') + '" data-field="' + field + '"'
      + (placeholder ? ' data-placeholder="' + placeholder + '"' : '')
      + ' contenteditable="plaintext-only" spellcheck="false">'
      + Shell.escapeHtml(value || '') + '</span>';
  };

  const jump = function (field, value, page) {
    if (!value) {
      return '<span class="meta-none" data-view="' + field + '">未設定</span>';
    }
    return '<a class="meta-link" data-view="' + field + '" href="' + page
      + '.html?v=' + encodeURIComponent(value) + '">'
      + Shell.escapeHtml(value) + '</a>';
  };

  info.innerHTML =
    '<div class="project-info-head" data-project="' + project.id + '">'
    + '<div class="project-info-main">'

    + '<div class="project-info-title">'
    + '<span class="meta-view">' + Shell.escapeHtml(project.name) + '</span>'
    + editable('name', project.name, 'edit-name')
    + '<span class="meta-view meta-view-no' + (project.project_no ? '' : ' is-blank')
    + '">' + Shell.escapeHtml(project.project_no || '') + '</span>'
    + editable('project_no', project.project_no, 'edit-no', '番号')
    + '<span class="project-info-actions">'
    + '<button type="button" class="project-edit" id="project-edit">編集</button>'
    + '<button type="button" class="project-copy" id="project-copy">コピーを作成</button>'
    + '</span>'
    + '</div>'

    + '<div class="project-info-meta">'
    + metaItem('ジャンル', jump('genre', project.genre, 'genre'),
      editable('genre', project.genre, 'edit-tag', '未設定'))
    + metaItem('担当者', jump('assignee', project.assignee, 'assignee'),
      editable('assignee', project.assignee, 'edit-tag', '未設定'))
    + '<span class="meta-item"><span class="meta-label">初回登録</span>'
    + '<span class="meta-time">' + Shell.stamp(project.created_at) + '</span></span>'
    + '<span class="meta-item"><span class="meta-label">最終更新</span>'
    + '<span class="meta-time" id="project-updated">'
    + Shell.stamp(project.updated_at) + '</span></span>'
    + '</div>'

    + '</div></div>';

  function metaItem(label, view, edit) {
    return '<span class="meta-item"><span class="meta-label">' + label + '</span>'
      + '<span class="meta-view">' + view + '</span>' + edit + '</span>';
  }


  /* ------------------------------------------------------------
     動画と行
     ------------------------------------------------------------ */

  const videos = await API.Videos.ofProject(project.id);

  const wanted = Number(new URLSearchParams(location.search).get('v'));
  const current = videos.find(function (v) { return v.id === wanted; })
    || videos[0] || null;

  const root = document.getElementById('project-root');
  root.dataset.projectId = project.id;
  root.dataset.columnWidths = JSON.stringify(project.column_widths || {});
  root.dataset.videoId = current ? current.id : '';
  root.dataset.status = current ? current.status : 'none';

  if (videos.length > 1) {
    const wrap = document.getElementById('version-wrap');
    const nav = document.getElementById('version-steps');
    wrap.hidden = false;

    nav.innerHTML = videos.map(function (v) {
      const on = current && v.id === current.id;
      return '<a class="version-step' + (on ? ' is-current' : '')
        + (v.status === 'error' ? ' is-error'
          : (v.status !== 'done' && v.status !== 'none' ? ' is-working' : '')) + '"'
        + ' href="project.html?p=' + encodeURIComponent(project.slug || project.id)
        + '&v=' + v.id + '"' + (on ? ' aria-current="true"' : '') + '>'
        + '<span class="version-step-label">' + Shell.escapeHtml(v.version_label)
        + '</span>'
        + '<span class="version-step-date">' + Shell.stamp(v.created_at) + '</span>'
        + '</a>';
    }).join('');
  }

  if (!current || current.status === 'none') {
    document.getElementById('no-video').hidden = false;
  }


  /* ------------------------------------------------------------
     処理中・失敗の知らせ

     動画の切り出しは、この画面を開いている間に進む。
     進み具合は app.js が videos の行を見に来て、バーに映す。
     ------------------------------------------------------------ */

  if (current && current.status === 'error') { showError(current); }

  if (current && (current.status === 'queued' || current.status === 'running')) {
    showProcessing();
    startDetection(current);
  }

  function panelBefore(html) {
    const box = document.createElement('div');
    box.innerHTML = html;
    const node = box.firstElementChild;
    root.insertBefore(node, document.getElementById('player-wrap'));
    return node;
  }

  function showProcessing() {
    panelBefore(
      '<div class="panel processing" id="processing">'
      + '<h3>動画を処理しています</h3>'
      + '<p>スクリーンショットを生成しています。しばらくお待ちください。'
      + '<br><span class="muted">この画面を開いたままにしてください。'
      + '閉じると途中で止まります。</span></p>'
      + '<div class="bar"><div class="bar-fill" id="bar-fill" style="width:0%"></div></div>'
      + '<p class="muted" id="stage">準備しています</p>'
      + '</div>');
  }

  function showError(video) {

    const node = panelBefore(
      '<div class="panel error">'
      + '<h3>動画処理に失敗しました</h3>'
      + '<pre>' + Shell.escapeHtml(video.error_message || '') + '</pre>'
      + '<div class="row">'
      + '<button type="button" class="primary" id="video-retry">もう一度実行</button>'
      + '<button type="button" class="danger" id="video-delete">この動画を削除</button>'
      + '</div></div>');

    node.querySelector('#video-retry').addEventListener('click', async function (e) {
      e.currentTarget.disabled = true;
      await API.db.from('videos')
        .update({ status: 'queued', progress: 0, stage: '', error_message: null })
        .eq('id', video.id);
      location.reload();
    });

    node.querySelector('#video-delete').addEventListener('click', async function (e) {

      if (!window.confirm('この動画と、そこから作った行をすべて削除します。')) { return; }

      e.currentTarget.disabled = true;

      const shotRows = await API.Shots.ofVideo(video.id);

      const paths = shotRows.map(function (s) { return s.storage_path; }).filter(Boolean);

      if (paths.length) { await API.Files.remove('screenshots', paths); }

      /* 同じファイルを見ている案件（コピー）が残っていないときだけ消す */
      if (video.storage_path) {

        const { data: sharing } = await API.db.from('videos')
          .select('id').eq('storage_path', video.storage_path).neq('id', video.id);

        if (!sharing || !sharing.length) {
          await API.Files.remove('videos', [video.storage_path]);
        }
      }

      await API.Videos.remove(video.id);
      await Detection.drop(video.id);

      location.href = 'project.html?p=' + encodeURIComponent(project.slug || project.id);
    });
  }

  function startDetection(video) {
    Detection.run(video).catch(function (err) {
      Shell.toast('動画を処理できませんでした（' + err.message + '）', true);
    });
  }


  /* ------------------------------------------------------------
     あとから動画を足す

     すでに空の器（動画なしで作った30行）があれば、そこへ入れる。
     新しく足すと、書いておいた下書きが取り残されてしまう。
     ------------------------------------------------------------ */

  const addForm = document.getElementById('add-video-form');

  if (addForm) {
    addForm.addEventListener('submit', async function (e) {

      e.preventDefault();

      const submit = document.getElementById('add-video-submit');
      const note = document.getElementById('add-video-note');

      const file = document.getElementById('video').files[0];
      const url = (document.getElementById('video_url').value || '').trim();

      if (!file && !url) {
        Shell.toast('動画ファイルを選ぶか、動画のリンクを入力してください。', true);
        return;
      }

      submit.disabled = true;

      try {

        const fields = { status: 'queued', progress: 0, stage: '準備しています' };

        if (file) {

          note.textContent = '動画を送っています…（'
            + (file.size / 1048576).toFixed(0) + 'MB）';

          const path = project.id + '/' + Date.now() + '-'
            + (file.name || 'video').replace(/[^\w.\-]+/g, '_').slice(-80);

          await API.Files.upload('videos', path, file);

          fields.original_name = file.name;
          fields.storage_path = path;
          fields.source_url = '';

        } else {

          fields.original_name = url.split('/').pop() || 'video.mp4';
          fields.storage_path = '';
          fields.source_url = url;
        }

        /* 空の器があればそこへ入れる */
        const empty = videos.find(function (v) { return v.status === 'none'; });

        let target;

        if (empty) {
          await API.db.from('videos').update(fields).eq('id', empty.id);
          target = empty.id;
        } else {
          fields.project_id = project.id;
          fields.version_label = '初稿';
          fields.sort_order = videos.length;
          target = (await API.Videos.create(fields)).id;
        }

        if (file) { await Detection.keep(target, file); }

        location.href = 'project.html?p='
          + encodeURIComponent(project.slug || project.id) + '&v=' + target;

      } catch (err) {
        Shell.toast('追加できませんでした（' + err.message + '）', true);
        note.textContent = '';
        submit.disabled = false;
      }
    });
  }

  /* 動画の URL は署名付き。しばらく経つと切れるので長めに取る */
  if (current && (current.storage_path || current.source_url)) {

    const src = current.storage_path
      ? await API.Files.url('videos', current.storage_path, 6 * 3600)
      : current.source_url;

    if (src) {
      const wrap = document.getElementById('player-wrap');
      wrap.hidden = false;
      document.getElementById('player').src = src;
      document.getElementById('player-bar-title').textContent = current.version_label;
      document.getElementById('player-file').textContent = current.original_name || '';
      document.getElementById('capture-shot').dataset.video = current.id;
    }
  }

  const shots = current ? await API.Shots.ofVideo(current.id) : [];

  const tbody = document.getElementById('rows');
  tbody.dataset.video = current ? current.id : '';

  document.getElementById('row-add').dataset.video = current ? current.id : '';

  /* 画像の URL をまとめて作る（1枚ずつだと待ち時間が積み上がる） */
  const paths = shots.map(function (s) { return s.storage_path; }).filter(Boolean);
  const urls = {};

  if (paths.length) {
    const { data } = await API.db.storage
      .from('screenshots').createSignedUrls(paths, 6 * 3600);

    (data || []).forEach(function (item) {
      if (item.signedUrl) { urls[item.path] = item.signedUrl; }
    });
  }

  tbody.innerHTML = shots.map(function (s) { return rowHtml(s, urls); }).join('');

  document.getElementById('no-rows').hidden =
    !(current && current.status === 'done' && !shots.length);


  function rowHtml(s, urls) {

    const url = s.storage_path ? urls[s.storage_path] : null;

    const cell = function (field, placeholder, extra) {
      return '<td' + (extra ? ' class="' + extra + '"' : '') + '>'
        + '<textarea data-shot="' + s.id + '" data-field="' + field + '"'
        + ' rows="3" placeholder="' + placeholder + '">'
        + Shell.escapeHtml(s[field] || '') + '</textarea></td>';
    };

    return '<tr data-seek="' + s.timestamp_sec + '" data-shot-row="' + s.id + '"'
      + (s.is_manual ? ' data-manual="1"' : '') + ' draggable="true"'
      + (s.row_height ? ' data-h="' + s.row_height
        + '" style="--row-h: ' + s.row_height + 'px"' : '') + '>'

      + '<td class="c-num">'
      + '<input type="checkbox" class="row-select" data-shot="' + s.id + '"'
      + ' title="選択して削除できます" aria-label="' + s.seq + ' 行目を選択">'
      + '<span class="row-seq">' + s.seq + '</span>'
      + '<span class="row-move" title="ドラッグで行を動かせます" aria-label="行を動かす">⠿</span>'
      + '<span class="row-grip" data-shot="' + s.id + '"'
      + ' title="ドラッグで行の高さを変える（ダブルクリックで自動に戻す）"></span>'
      + '<button type="button" class="row-insert" data-shot="' + s.id + '"'
      + ' title="ここに行を足す" aria-label="ここに行を足す">＋</button>'
      + '</td>'

      + '<td class="c-shot">'
      + (url
        ? '<img loading="lazy" decoding="async" width="124" height="220" src="'
          + Shell.escapeHtml(url) + '" alt="' + s.seq + '" data-seek="'
          + s.timestamp_sec + '" data-full="' + Shell.escapeHtml(url) + '">'
        : '<span class="shot-empty" aria-hidden="true"></span>')
      + '</td>'

      + '<td class="c-time">'
      + '<button type="button" class="seek" data-seek="' + s.timestamp_sec + '">'
      + Shell.mmss(s.timestamp_sec) + '</button></td>'

      + cell('reference_role', '参考動画での役割')
      + cell('material_feature', '素材の特徴')
      + cell('improvement_note', '備考・改善案')
      + cell('reference_feedback', 'フィードバックメモ')
      /* テキストだけを別の行へ移せるよう、つかむところを付ける */
      + '<td class="result-start c-text">'
      + '<textarea data-shot="' + s.id + '" data-field="text_raw" rows="3"'
      + ' placeholder="テキスト">' + Shell.escapeHtml(s.text_raw || '') + '</textarea>'
      + '<span class="text-move" title="つかんで動かすと、テキストだけが行を移ります"'
      + ' aria-label="テキストを別の行へ移す">⠿</span>'
      + '</td>'

      + '<td class="material-cell">'
      + '<div class="material-editor" contenteditable="true" data-shot="' + s.id + '"'
      + ' data-field="material" data-placeholder="素材を入力。画像を貼り付けできます"'
      + ' role="textbox" aria-label="素材">' + (s.material || '') + '</div></td>'

      + cell('role', '役割')
      + cell('scene_feeling', 'シーン後の気持ち')
      + cell('feedback', 'フィードバックメモ')

      + '</tr>';
  }


  /* ------------------------------------------------------------
     コピーを作成
     ------------------------------------------------------------ */

  document.getElementById('project-copy').addEventListener('click', async function (e) {

    const btn = e.currentTarget;

    if (!window.confirm(
      'この案件のコピーを作ります。\n'
      + '参考動画・スクショ・分析の入力はそのまま、転用の入力だけ空になります。')) {
      return;
    }

    btn.disabled = true;
    btn.textContent = '作成中…';

    try {
      const name = project.name + 'のコピー';

      const fields = {
        genre: project.genre, name: name, project_no: '',
        slug: await API.Projects.makeSlug(name, ''),
        assignee: project.assignee, owner_id: me.user.id,
        /* どの案件から分かれたものかを覚えておく。
           共通ノートで、コピーどうしを1件として数えるために使う。
           コピーのコピーも、いちばん元の案件を指す */
        copied_from: project.copied_from || project.id,
      };

      let made;

      try {
        made = await API.Projects.create(fields);
      } catch (err) {
        /* copied_from はあとから足した列なので、まだ無いこともある */
        if (!/copied_from/.test(err.message)) { throw err; }
        delete fields.copied_from;
        made = await API.Projects.create(fields);
      }

      for (const v of videos) {

        const newVideo = await API.Videos.create({
          project_id: made.id,
          version_label: v.version_label,
          original_name: v.original_name,
          /* ファイルは複製せず、同じものを見る */
          storage_path: v.storage_path,
          source_url: v.source_url,
          duration_sec: v.duration_sec,
          status: v.status,
          sort_order: v.sort_order,
        });

        const list = await API.Shots.ofVideo(v.id);

        if (list.length) {
          await API.Shots.insertMany(list.map(function (s) {
            return {
              video_id: newVideo.id, seq: s.seq,
              storage_path: s.storage_path,
              timestamp_sec: s.timestamp_sec,
              row_height: s.row_height, is_manual: s.is_manual,
              /* 分析はそのまま、転用は空 */
              reference_role: s.reference_role,
              material_feature: s.material_feature,
              improvement_note: s.improvement_note,
              reference_feedback: s.reference_feedback,
            };
          }));
        }
      }

      location.href = 'project.html?p=' + encodeURIComponent(made.slug || made.id);

    } catch (err) {
      Shell.toast('コピーできませんでした（' + err.message + '）', true);
      btn.disabled = false;
      btn.textContent = 'コピーを作成';
    }
  });


  /* ------------------------------------------------------------
     ここまで組み上がってから、これまでの画面の動きを読み込む
     ------------------------------------------------------------ */

  const script = document.createElement('script');
  script.src = 'js/app.js';
  document.body.appendChild(script);

}());
