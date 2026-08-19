/* ============================================================
   共通ノート

   すべての案件のフィードバックを1行ずつに割って、
   複数の案件で出てくるものを並べる。

   「コピーを作成」で増えた案件は中身が同じなので、
   そのまま数えると1件の指摘が何件にも水増しされてしまう。
   コピーどうしは1件として数える。
   ============================================================ */

(async function () {

  const me = await Shell.mountShell('notes.html');

  if (!me) { return; }

  const FIELDS = [
    ['reference_feedback', 'フィードバックメモ（分析）'],
    ['feedback', 'フィードバックメモ（転用）'],
    ['improvement_note', '備考・改善案'],
  ];

  const page = document.getElementById('page');
  const esc = Shell.escapeHtml;

  const params = new URLSearchParams(location.search);

  const selected = params.getAll('field').length
    ? params.getAll('field').filter(function (f) {
      return FIELDS.some(function (x) { return x[0] === f; });
    })
    : FIELDS.map(function (f) { return f[0]; });

  const threshold = Math.max(2, Number(params.get('n')) || 2);

  /**
   * 行とその案件を読む。
   *
   * copied_from はあとから足した列なので、まだ無い場合もある。
   * そのときは列を外して読み直す（コピーの判定はできないが表示はできる）。
   */
  async function loadRows() {

    const columns = 'id, reference_feedback, feedback, improvement_note,'
      + ' videos(project_id, projects(id, name, slug, project_no%EXTRA%))';

    for (const extra of [', copied_from', '']) {

      const r = await API.db.from('screenshots')
        .select(columns.replace('%EXTRA%', extra))
        .is('deleted_at', null);

      if (!r.error) { return r.data || []; }

      if (extra === '') {
        Shell.toast('読み込めませんでした（' + r.error.message + '）', true);
        return [];
      }
    }

    return [];
  }

  const [rows, guidelines] = await Promise.all([
    loadRows(),
    API.Guidelines.list(),
  ]);


  /* ------------------------------------------------------------
     集計
     ------------------------------------------------------------ */

  /** 集計用に文字をそろえる（表記ゆれを少しだけ吸収する） */
  function normalize(line) {
    return line
      .normalize('NFKC')
      .trim()
      .replace(/^[・\-*—–ー\s\t]+/, '')
      .replace(/[。.、,！!？?\s\t]+$/, '')
      .toLowerCase();
  }

  const found = new Map();
  const families = new Set();

  rows.forEach(function (row) {

    const project = row.videos && row.videos.projects;

    if (!project) { return; }

    /* コピーは元と同じ「家族」として扱う */
    const family = project.copied_from || project.id;
    families.add(family);

    selected.forEach(function (field) {

      const value = row[field] || '';

      value.split('\n').forEach(function (line) {

        const key = normalize(line);

        if (key.length < 3) { return; }

        const entry = found.get(key) || {
          text: line.trim(), count: 0,
          projects: new Map(), families: new Set(), fields: new Set(),
        };

        entry.count += 1;
        entry.fields.add(field);
        entry.families.add(family);
        entry.projects.set(project.id, project);

        found.set(key, entry);
      });
    });
  });

  const already = new Set(guidelines.map(function (g) { return g.text; }));

  const items = [...found.values()]
    .filter(function (v) { return v.families.size >= threshold; })
    .map(function (v) {
      return {
        text: v.text,
        count: v.count,
        familyCount: v.families.size,
        copyCount: v.projects.size - v.families.size,
        projects: [...v.projects.values()],
        fields: [...v.fields],
      };
    })
    .sort(function (a, b) {
      return (b.familyCount - a.familyCount) || (b.count - a.count)
        || a.text.localeCompare(b.text, 'ja');
    });

  const label = Object.fromEntries(FIELDS);


  /* ------------------------------------------------------------
     描画
     ------------------------------------------------------------ */

  page.innerHTML =

    '<section class="card guideline-card">'
    + '<div class="guideline-head"><div>'
    + '<h2>ガイドライン</h2>'
    + '<p class="new-project-lead">'
    + '下の共通フィードバックから「毎回これは守る」と決めたものです。</p>'
    + '</div></div>'
    + (guidelines.length
      ? '<ol class="guideline-list">' + guidelines.map(function (g) {
        return '<li class="guideline-item" data-id="' + g.id + '">'
          + '<span class="guideline-text">' + esc(g.text) + '</span>'
          + (g.seen ? '<span class="guideline-seen">' + g.seen + '件から</span>' : '')
          + '<button type="button" class="guideline-drop" title="外す">×</button>'
          + '</li>';
      }).join('') + '</ol>'
      : '<p class="guideline-empty">まだありません。'
        + '下の一覧で「採用」を押すと、ここに積み上がります。</p>')
    + '</section>'

    + '<section class="card">'
    + '<h2>共通ノート</h2>'
    + '<p class="new-project-lead">'
    + '担当者やジャンルに関係なく、すべての案件のフィードバックを集めて、'
    + '<b>複数の案件で同じことを書かれているもの</b>だけを並べています。'
    + '案件をまたいで繰り返し出てくる指摘＝毎回気をつけるべきことです。<br>'
    + '<b>「コピーを作成」で増えた案件は、元と同じ1件として数えています。</b>'
    + '中身が同じなので、別々に数えると水増しになるためです。</p>'

    + '<form class="notes-filter" method="get">'
    + '<div class="notes-filter-group">'
    + '<span class="notes-filter-label">集める欄</span>'
    + FIELDS.map(function (f) {
      return '<label class="notes-check">'
        + '<input type="checkbox" name="field" value="' + f[0] + '"'
        + (selected.includes(f[0]) ? ' checked' : '') + '>'
        + '<span>' + f[1] + '</span></label>';
    }).join('')
    + '</div>'
    + '<div class="notes-filter-group">'
    + '<label class="notes-check" for="n">'
    + '<span class="notes-filter-label">何件以上に出てきたら</span></label>'
    + '<select name="n" id="n">'
    + [2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (i) {
      return '<option value="' + i + '"' + (threshold === i ? ' selected' : '')
        + '>' + i + '件以上</option>';
    }).join('')
    + '</select>'
    + '<button type="submit" class="primary notes-apply">この条件で見る</button>'
    + '</div></form>'

    + '<p class="notes-meta">入力のある案件は全部で ' + families.size + ' 件'
    + '（コピーで増えたものは元と同じ1件として数えています）。'
    + 'そのうち ' + threshold + ' 件以上に出てくるものが <b>' + items.length
    + '</b> 件見つかりました。</p>'
    + '</section>'

    + (items.length
      ? '<section class="card"><ol class="notes-list">'
        + items.map(function (item) {
          return '<li class="note-item">'
            + '<div class="note-head">'
            + '<span class="note-count"'
            + (item.copyCount
              ? ' title="コピーで増えた ' + item.copyCount + ' 件は数えていません"' : '')
            + '>' + item.familyCount + '件</span>'
            + '<p class="note-text">' + esc(item.text) + '</p>'
            + (already.has(item.text)
              ? '<span class="note-adopted">採用済み</span>'
              : '<button type="button" class="note-adopt" data-text="'
                + esc(item.text) + '" data-seen="' + item.familyCount
                + '">採用</button>')
            + '</div>'
            + '<div class="note-foot">'
            + item.fields.map(function (f) {
              return '<span class="note-field">' + esc(label[f]) + '</span>';
            }).join('')
            + '<span class="note-projects">'
            + item.projects.map(function (p) {
              return '<a href="project.html?p='
                + encodeURIComponent(p.slug || p.id) + '">'
                + esc(p.name + (p.project_no || '')) + '</a>';
            }).join('')
            + '</span></div></li>';
        }).join('')
        + '</ol></section>'

      : '<section class="card"><div class="database-no-projects">'
        + '<div class="database-no-projects-title">'
        + 'まだ共通するものが見つかりません</div>'
        + '<div class="muted">同じ言い回しが ' + threshold
        + ' 件以上の案件で使われると、ここに出ます。<br>'
        + '件数を減らすか、集める欄を増やしてみてください。</div>'
        + '</div></section>');


  /* ------------------------------------------------------------
     採用・取り消し
     ------------------------------------------------------------ */

  page.addEventListener('click', async function (e) {

    const adopt = e.target.closest('.note-adopt');

    if (adopt) {
      adopt.disabled = true;

      try {
        await API.Guidelines.add(adopt.dataset.text, adopt.dataset.text,
          Number(adopt.dataset.seen), me.user.id);
        location.reload();
      } catch (err) {
        Shell.toast(err.message, true);
        adopt.disabled = false;
      }

      return;
    }

    const drop = e.target.closest('.guideline-drop');

    if (drop) {
      if (!window.confirm('このガイドラインを外しますか？')) { return; }

      try {
        await API.Guidelines.remove(Number(drop.closest('.guideline-item').dataset.id));
        location.reload();
      } catch (err) {
        Shell.toast(err.message, true);
      }
    }
  });

}());
