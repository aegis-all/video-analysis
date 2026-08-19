/* ============================================================
   ジャンル別・担当者別の一覧

   一覧でジャンル名や担当者名を押したときに開く画面。
   その値の案件だけを並べ、さらに絞り込める。
   ============================================================ */

window.FilteredList = async function (kind) {

  const conf = kind === 'genre'
    ? { field: 'genre', label: 'ジャンル', page: 'genre.html', other: 'assignee',
        otherLabel: '担当者', otherPage: 'assignee.html' }
    : { field: 'assignee', label: '担当者', page: 'assignee.html', other: 'genre',
        otherLabel: 'ジャンル', otherPage: 'genre.html' };

  const me = await Shell.mountShell(conf.page);

  if (!me) { return; }

  const page = document.getElementById('page');
  const esc = Shell.escapeHtml;

  const value = new URLSearchParams(location.search).get('v') || '';

  document.title = (value || conf.label) + ' — 動画分析';

  const all = await API.Projects.list();

  const genreColor = Shell.colorMap(all.map(function (p) { return p.genre; }), 0);
  const assigneeColor = Shell.colorMap(all.map(function (p) { return p.assignee; }), 6);

  const list = all.filter(function (p) { return (p[conf.field] || '') === value; });

  const others = [...new Set(list.map(function (p) { return p[conf.other]; })
    .filter(Boolean))].sort();

  const selected = new Set();

  page.innerHTML =

    '<section class="card">'
    + '<div class="database-header"><div>'
    + '<h2><span class="database-pill pill-c'
    + ((conf.field === 'genre' ? genreColor : assigneeColor)[value] || 0) + '">'
    + esc(value || '未設定') + '</span> の案件</h2>'
    + '<div class="database-count" id="count">' + list.length + '件</div>'
    + '</div>'
    + '<a class="database-clear" href="index.html">← 案件一覧へ</a>'
    + '</div>'

    + '<div class="database-toolbar">'
    + '<div class="database-search">'
    + '<span class="database-search-icon" aria-hidden="true">⌕</span>'
    + '<input type="search" id="search" placeholder="案件名、案件番号で絞り込む"'
    + ' autocomplete="off">'
    + '</div></div>'

    + (others.length > 1
      ? '<div class="database-filters" id="chips">'
        + '<div class="filter-chip" data-key="' + conf.other + '">'
        + '<button type="button" class="filter-chip-button">'
        + '<span>' + conf.otherLabel + '</span>'
        + '<span class="filter-chip-count"></span>'
        + '<span class="filter-chip-caret">▾</span></button>'
        + '<div class="filter-panel" hidden>'
        + others.map(function (v) {
          return '<label class="filter-option">'
            + '<input type="checkbox" value="' + esc(v) + '">'
            + '<span>' + esc(v) + '</span></label>';
        }).join('')
        + '</div></div></div>'
      : '')

    + '<div class="projects-table-wrap">'
    + '<table class="projects-table">'
    + '<thead><tr><th>ジャンル</th><th>案件名</th><th>担当者</th>'
    + '<th>バージョン</th><th>初回登録</th></tr></thead>'
    + '<tbody id="body"></tbody></table></div>'

    + '<div id="empty" class="projects-empty" hidden>'
    + '条件に一致する案件がありません。</div>'
    + '</section>';

  const body = document.getElementById('body');
  const count = document.getElementById('count');
  const empty = document.getElementById('empty');

  render();

  document.getElementById('search').addEventListener('input', render);

  const chipButton = page.querySelector('.filter-chip-button');

  if (chipButton) {
    chipButton.addEventListener('click', function () {
      const panel = page.querySelector('.filter-panel');
      panel.hidden = !panel.hidden;
    });

    page.querySelectorAll('.filter-panel input').forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.checked) { selected.add(input.value); }
        else { selected.delete(input.value); }
        render();
      });
    });
  }

  function render() {

    const term = (document.getElementById('search').value || '')
      .trim().toLowerCase();

    const shown = list.filter(function (p) {

      if (selected.size && !selected.has(p[conf.other])) { return false; }

      if (!term) { return true; }

      return [p.name, p.project_no]
        .some(function (v) { return (v || '').toLowerCase().includes(term); });
    });

    const pill = function (v, colors, target) {
      if (!v) { return '<span class="muted">—</span>'; }
      return '<a class="database-pill pill-c' + (colors[v] || 0) + ' is-link"'
        + ' href="' + target + '?v=' + encodeURIComponent(v) + '">'
        + esc(v) + '</a>';
    };

    body.innerHTML = shown.map(function (p) {
      return '<tr class="project-row">'
        + '<td>' + pill(p.genre, genreColor, 'genre.html') + '</td>'
        + '<td class="project-name-cell">'
        + '<a class="project-link" href="project.html?p='
        + encodeURIComponent(p.slug || p.id) + '">' + esc(p.name) + '</a>'
        + (p.project_no
          ? '<span class="project-no">' + esc(p.project_no) + '</span>' : '')
        + '</td>'
        + '<td>' + pill(p.assignee, assigneeColor, 'assignee.html') + '</td>'
        + '<td class="database-number">' + p.video_count + '</td>'
        + '<td class="database-date">' + Shell.stamp(p.created_at) + '</td>'
        + '</tr>';
    }).join('');

    count.textContent = shown.length + '件';
    empty.hidden = shown.length > 0;

    const badge = page.querySelector('.filter-chip-count');

    if (badge) {
      badge.textContent = selected.size ? String(selected.size) : '';
    }
  }
};
