/* ============================================================
   進捗ボード

   月間目標、タスク数、4つの列。
   カードを動かす仕掛けは app.js の initBoard がやる。
   ============================================================ */

(async function () {

  const me = await Shell.mountShell('board.html');

  if (!me) { return; }

  const STATUSES = [
    ['todo', '取組前'],
    ['doing', 'いまやってる中'],
    ['waiting', 'FB待ち'],
    ['done', '完全にdone'],
  ];

  const page = document.getElementById('page');

  const [projects, work, settings] = await Promise.all([
    API.Projects.list(),
    API.WorkTime.all(),
    API.Settings.all(),
  ]);

  /* 案件ごとの作業時間 */
  const times = {};

  work.forEach(function (w) {
    const t = times[w.project_id]
      || (times[w.project_id] = { analysis: 0, reuse: 0, other: 0, total: 0 });
    if (t[w.side] !== undefined) { t[w.side] += w.seconds; }
    t.total += w.seconds;
  });

  const measured = Object.values(times).filter(function (t) { return t.total > 0; });

  const avg = function (list, key) {
    if (!list.length) { return 0; }
    return Math.trunc(list.reduce(function (s, t) { return s + t[key]; }, 0) / list.length);
  };

  const doneMeasured = projects
    .filter(function (p) { return p.status === 'done' && times[p.id]; })
    .map(function (p) { return times[p.id]; });

  /* 今月 done に入れた数 */
  const month = new Date().toISOString().slice(0, 7);

  const doneThisMonth = projects.filter(function (p) {
    return p.status === 'done' && (p.status_at || '').slice(0, 7) === month;
  }).length;

  const target = settings.monthly_target || 0;
  const rate = target ? Math.min(100, Math.trunc(doneThisMonth * 100 / target)) : 0;

  const count = function (key) {
    return projects.filter(function (p) { return (p.status || 'todo') === key; }).length;
  };

  const open = projects.length - count('done');

  const genreColor = Shell.colorMap(projects.map(function (p) { return p.genre; }), 0);
  const assigneeColor = Shell.colorMap(projects.map(function (p) { return p.assignee; }), 6);

  page.innerHTML =
    '<section class="card goal-card">'
    + '<div class="goal-head"><div>'
    + '<h2>月間目標</h2>'
    + '<p class="new-project-lead">' + month.slice(0, 4) + '年' + month.slice(5, 7)
    + '月に「完全にdone」へ入れた件数です。</p></div>'
    + '<details class="goal-edit"><summary>目標を変える</summary>'
    + '<form class="goal-form" id="goal-form">'
    + '<label><span>1か月の完成目標</span>'
    + '<input type="number" name="monthly_target" min="0" max="999" value="'
    + settings.monthly_target + '"> 件</label>'
    + '<label><span>分析の目標時間</span>'
    + '<input type="number" name="target_analysis_h" min="0" max="99" step="0.1" value="'
    + (settings.target_analysis / 3600).toFixed(1) + '"> 時間</label>'
    + '<label><span>転用の目標時間</span>'
    + '<input type="number" name="target_reuse_h" min="0" max="99" step="0.1" value="'
    + (settings.target_reuse / 3600).toFixed(1) + '"> 時間</label>'
    + '<button type="submit" class="primary">保存する</button>'
    + '</form></details></div>'

    + '<div class="goal-bar-row">'
    + '<div class="goal-figure"><b>' + doneThisMonth + '</b> / ' + target + ' 件'
    + '<span class="goal-rate">' + rate + '%</span></div>'
    + '<div class="goal-bar"><span class="goal-fill" style="width:' + rate + '%"></span></div>'
    + '<div class="goal-left">'
    + (target - doneThisMonth > 0 ? 'あと ' + (target - doneThisMonth) + ' 件' : '達成 ✓')
    + '</div></div>'

    + '<div class="stat-row">'
    + stat('案件の数', String(projects.length), 'うち手つかず ' + count('todo') + ' 件')
    + stat('かかえている数', String(open),
      '進行中 ' + count('doing') + ' ／ FB待ち ' + count('waiting'))
    + stat('1案件あたりの平均', Shell.hhmm(avg(measured, 'total')),
      '分析 ' + Shell.hhmm(avg(measured, 'analysis'))
      + ' ／ 転用 ' + Shell.hhmm(avg(measured, 'reuse')))
    + stat('done になった案件の平均', Shell.hhmm(avg(doneMeasured, 'total')),
      doneMeasured.length + ' 件の平均')
    + '</div></section>'

    + '<div class="board-title"><h2>タスクボード</h2>'
    + '<span class="muted">カードをつかんで別の列に落とすと、状態が変わります。</span></div>'

    + '<div class="board" id="board">'
    + STATUSES.map(function (pair) {
      const cards = projects
        .filter(function (p) { return (p.status || 'todo') === pair[0]; })
        .sort(function (a, b) { return (a.board_order || 0) - (b.board_order || 0); });

      return '<section class="board-col" data-status="' + pair[0] + '">'
        + '<header class="board-col-head">'
        + '<span class="board-col-title">' + pair[1] + '</span>'
        + '<span class="board-col-count">' + cards.length + '</span></header>'
        + '<div class="board-drop" data-drop>'
        + cards.map(card).join('')
        + '<p class="board-empty">ここにドラッグ</p>'
        + '</div></section>';
    }).join('')
    + '</div>';

  function stat(label, value, note) {
    return '<div class="stat"><div class="stat-label">' + label + '</div>'
      + '<div class="stat-value">' + value + '</div>'
      + '<div class="stat-note">' + note + '</div></div>';
  }

  function card(p) {
    const t = times[p.id] || { analysis: 0, reuse: 0 };

    const pill = function (v, colors) {
      if (!v) { return ''; }
      return '<span class="database-pill pill-c' + (colors[v] || 0) + '">'
        + Shell.escapeHtml(v) + '</span>';
    };

    return '<article class="board-card" draggable="true" data-id="' + p.id + '">'
      + '<div class="board-card-top">' + pill(p.genre, genreColor)
      + pill(p.assignee, assigneeColor) + '</div>'
      + '<a class="board-card-name" href="project.html?p='
      + encodeURIComponent(p.slug || p.id) + '">' + Shell.escapeHtml(p.name)
      + (p.project_no
        ? '<span class="board-card-no">' + Shell.escapeHtml(p.project_no) + '</span>' : '')
      + '</a>'
      + '<div class="board-card-times">'
      + '<span class="board-time board-time-analysis">分析 ' + Shell.hhmm(t.analysis) + '</span>'
      + '<span class="board-time board-time-reuse">転用 ' + Shell.hhmm(t.reuse) + '</span>'
      + '</div></article>';
  }

  /* 組み上がってから、これまでの動き（ドラッグ・目標の保存）を読み込む */
  const script = document.createElement('script');
  script.src = 'js/app.js';
  document.body.appendChild(script);

}());
