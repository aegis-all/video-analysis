/* ============================================================
   作業時間

   合計・日ごと・目標との比較・ボトルネック・メンバー別・指摘の多さ。
   ============================================================ */

(async function () {

  const me = await Shell.mountShell('report.html');

  if (!me) { return; }

  const page = document.getElementById('page');
  const esc = Shell.escapeHtml;
  const hhmm = Shell.hhmm;

  const [projects, work, settings, profiles, shots] = await Promise.all([
    API.Projects.list(),
    API.WorkTime.all(),
    API.Settings.all(),
    API.db.from('profiles').select('id, display_name')
      .then(function (r) { return r.data || []; }),
    API.db.from('screenshots')
      .select('id, reference_feedback, feedback, improvement_note, videos(project_id)')
      .is('deleted_at', null)
      .then(function (r) { return r.data || []; }),
  ]);

  const nameOf = {};
  profiles.forEach(function (p) { nameOf[p.id] = p.display_name || '未設定'; });


  /* ---- 案件ごとの時間 ---- */

  const times = {};

  work.forEach(function (w) {
    const t = times[w.project_id]
      || (times[w.project_id] = { analysis: 0, reuse: 0, other: 0, total: 0 });
    if (t[w.side] !== undefined) { t[w.side] += w.seconds; }
    t.total += w.seconds;
  });

  const rows = projects
    .filter(function (p) { return times[p.id] && times[p.id].total; })
    .map(function (p) { return Object.assign({ row: p }, times[p.id]); })
    .sort(function (a, b) { return b.total - a.total; });

  const total = { analysis: 0, reuse: 0, other: 0, total: 0 };

  rows.forEach(function (r) {
    total.analysis += r.analysis;
    total.reuse += r.reuse;
    total.other += r.other;
    total.total += r.total;
  });

  const count = rows.length || 1;

  const average = {
    analysis: Math.trunc(total.analysis / count),
    reuse: Math.trunc(total.reuse / count),
    total: Math.trunc(total.total / count),
  };


  /* ---- 日ごと ---- */

  const byDay = {};

  work.forEach(function (w) {
    const d = byDay[w.day]
      || (byDay[w.day] = { analysis: 0, reuse: 0, other: 0, total: 0 });
    if (d[w.side] !== undefined) { d[w.side] += w.seconds; }
    d.total += w.seconds;
  });

  const days = Object.keys(byDay).sort().reverse().slice(0, 14)
    .map(function (k) { return [k, byDay[k]]; });

  const dayMax = Math.max(1, ...days.map(function (d) { return d[1].total; }));


  /* ---- メンバー別 ---- */

  const owners = {};
  projects.forEach(function (p) { owners[p.id] = p.owner_id || null; });

  /* 担当が決まっていない案件は、いちばん長く作業した人のものとみなす */
  const worked = {};

  work.forEach(function (w) {
    const k = w.project_id + '|' + w.user_id;
    worked[k] = (worked[k] || 0) + w.seconds;
  });

  Object.keys(worked)
    .sort(function (a, b) { return worked[b] - worked[a]; })
    .forEach(function (k) {
      const parts = k.split('|');
      if (!owners[parts[0]]) { owners[parts[0]] = parts[1]; }
    });

  const perUser = {};

  projects.forEach(function (p) {
    const uid = owners[p.id] || 'none';

    const e = perUser[uid] || (perUser[uid] = {
      name: nameOf[uid] || '未割当',
      done: 0, all: 0, analysis: 0, reuse: 0, measured: 0,
    });

    e.all += 1;
    if (p.status === 'done') { e.done += 1; }

    const t = times[p.id];

    if (t && t.total) {
      e.analysis += t.analysis;
      e.reuse += t.reuse;
      e.measured += 1;
    }
  });

  const members = Object.values(perUser).map(function (e) {
    const m = e.measured || 1;
    return Object.assign({}, e, {
      avgA: Math.trunc(e.analysis / m),
      avgR: Math.trunc(e.reuse / m),
      avgT: Math.trunc((e.analysis + e.reuse) / m),
    });
  }).sort(function (a, b) { return b.done - a.done; });

  const memberMax = Math.max(1, ...members.map(function (m) {
    return Math.max(m.avgA, m.avgR);
  }));

  const mean = function (key) {
    if (!members.length) { return 0; }
    return Math.trunc(members.reduce(function (s, m) {
      return s + m[key];
    }, 0) / members.length);
  };

  const team = {
    done: members.reduce(function (s, m) { return s + m.done; }, 0),
    avgA: mean('avgA'), avgR: mean('avgR'), avgT: mean('avgT'),
  };


  /* ---- 指摘の多さ ---- */

  const load = {};

  shots.forEach(function (s) {
    const pid = s.videos && s.videos.project_id;

    if (!pid) { return; }

    const e = load[pid] || (load[pid] = { total: 0, noted: 0 });
    e.total += 1;

    if ((s.reference_feedback || '').trim() || (s.feedback || '').trim()
        || (s.improvement_note || '').trim()) {
      e.noted += 1;
    }
  });

  const loads = projects
    .filter(function (p) { return load[p.id] && load[p.id].total; })
    .map(function (p) {
      const e = load[p.id];
      return {
        row: p, total: e.total, noted: e.noted,
        rate: Math.round(e.noted * 1000 / e.total) / 10,
      };
    })
    .sort(function (a, b) { return b.noted - a.noted; });


  /* ---- ボトルネック ---- */

  const slower = average.reuse >= average.analysis ? 'reuse' : 'analysis';

  const bottleneck = {
    label: slower === 'reuse' ? '転用' : '分析',
    seconds: average[slower],
    share: average.total ? Math.trunc(average[slower] * 100 / average.total) : 0,
    target: settings['target_' + slower],
    over: average[slower] - settings['target_' + slower],
  };

  const goals = [
    ['分析', settings.target_analysis, average.analysis],
    ['転用', settings.target_reuse, average.reuse],
    ['合計', settings.target_total, average.total],
  ];

  const genreColor = Shell.colorMap(projects.map(function (p) { return p.genre; }), 0);
  const assigneeColor = Shell.colorMap(projects.map(function (p) { return p.assignee; }), 6);

  const pct = function (a, b) { return b ? Math.trunc(a * 100 / b) : 0; };


  /* ------------------------------------------------------------
     描画
     ------------------------------------------------------------ */

  const parts = [];

  parts.push('<section class="card"><h2>作業時間</h2>'
    + '<p class="new-project-lead">'
    + '案件ページを開いているあいだ、<b>入力・カーソルの移動・スクロール</b>'
    + 'のいずれかが続いている時間を数えています。'
    + '30秒以上なにもしないと止まり、別のタブを見ているあいだや、'
    + '別のアプリを触っているあいだも数えません。<br>'
    + '表の左側（参考動画キャプチャ〜フィードバックメモ）を触っていた時間を '
    + '<b class="stat-analysis">分析</b>、右側（テキスト〜フィードバックメモ）を'
    + '触っていた時間を <b class="stat-reuse">転用</b> としています。</p>'
    + '<div class="stat-row">'
    + stat('合計', hhmm(total.total), rows.length + ' 件ぶん'
      + (total.other ? ' ／ どちらとも言えない ' + hhmm(total.other) : ''))
    + stat('分析', hhmm(total.analysis),
      total.total ? '全体の ' + pct(total.analysis, total.total) + '%' : '—',
      'stat-analysis')
    + stat('転用', hhmm(total.reuse),
      total.total ? '全体の ' + pct(total.reuse, total.total) + '%' : '—',
      'stat-reuse')
    + stat('1案件あたりの平均', hhmm(average.total),
      '分析 ' + hhmm(average.analysis) + ' / 転用 ' + hhmm(average.reuse))
    + '</div></section>');

  if (days.length) {
    parts.push('<section class="card"><h2>日ごとの内訳</h2><div class="daybars">'
      + days.map(function (d) {
        const v = d[1];
        return '<div class="daybar"><div class="daybar-label">'
          + d[0].slice(5) + '</div><div class="daybar-track">'
          + bar('daybar-analysis', v.analysis, '分析')
          + bar('daybar-reuse', v.reuse, '転用')
          + bar('daybar-other', v.other, 'どちらとも言えない')
          + '</div><div class="daybar-total">' + hhmm(v.total) + '</div></div>';
      }).join('')
      + '</div><p class="legend">'
      + '<span class="legend-key legend-analysis"></span>分析'
      + '<span class="legend-key legend-reuse"></span>転用'
      + '<span class="legend-key legend-other"></span>どちらとも言えない'
      + '</p></section>');
  }

  parts.push('<section class="card"><h2>目標との比較</h2>'
    + '<p class="new-project-lead">1案件あたりの平均と、'
    + '<a href="board.html">進捗ボード</a>で決めた目標時間をならべています。</p>'
    + '<div class="goals">'
    + goals.map(function (g) {
      const diff = g[2] - g[1];
      return '<div class="goal-line' + (diff > 0 ? ' is-over' : '') + '">'
        + '<div class="goal-line-label">' + g[0] + '</div>'
        + '<div class="goal-line-bar"><span class="goal-line-fill" style="width:'
        + Math.min(100, pct(g[2], g[1])) + '%"></span></div>'
        + '<div class="goal-line-num">' + hhmm(g[2])
        + ' <span class="muted">/ 目標 ' + hhmm(g[1]) + '</span></div>'
        + '<div class="goal-line-diff">'
        + (diff > 0 ? '+' + hhmm(diff) + ' 超過'
          : (diff < 0 ? hhmm(-diff) + ' 短い ✓' : '—'))
        + '</div></div>';
    }).join('')
    + '</div></section>');

  if (average.total) {
    parts.push('<section class="card"><h2>ボトルネック</h2>'
      + '<div class="bottleneck"><div class="bottleneck-mark">⚠</div><div>'
      + '<p class="bottleneck-text"><b>' + bottleneck.label + '</b>に <b>'
      + hhmm(bottleneck.seconds) + '</b>かかっていて、いちばん時間を使っています'
      + '（全体の ' + bottleneck.share + '%）。</p>'
      + '<p class="bottleneck-sub">'
      + (bottleneck.over > 0
        ? '目標より ' + hhmm(bottleneck.over) + ' 超えています。'
        : '目標の ' + hhmm(bottleneck.target) + ' には収まっています。')
      + '</p></div></div>'
      + '<p class="note-hint">ここに出るのは「どこに時間がかかっているか」という'
      + '計測結果までです。打ち手そのものは、共通ノートの指摘とあわせて'
      + '決めてください。</p></section>');
  }

  if (members.length) {
    parts.push('<section class="card"><h2>メンバー別</h2>'
      + '<p class="new-project-lead">完成数は案件の担当ユーザー、'
      + '時間はその人が実際に画面を触っていた長さです。'
      + '担当が決まっていない案件は、いちばん長く作業した人のものとして'
      + '数えています。</p>'
      + '<div class="projects-table-wrap"><table class="projects-table report-table">'
      + '<thead><tr><th>メンバー</th><th class="report-num">完成数</th>'
      + '<th class="report-num">かかえている数</th>'
      + '<th class="report-num">分析平均</th><th class="report-num">転用平均</th>'
      + '<th class="report-num">全体平均</th></tr></thead><tbody>'
      + members.map(function (m) {
        return '<tr><td><span class="member"><span class="member-avatar">'
          + esc(m.name.slice(0, 1).toUpperCase()) + '</span>'
          + esc(m.name) + '</span></td>'
          + '<td class="report-num">' + m.done + '</td>'
          + '<td class="report-num">' + (m.all - m.done) + '</td>'
          + '<td class="report-num">' + hhmm(m.avgA) + '</td>'
          + '<td class="report-num">' + hhmm(m.avgR) + '</td>'
          + '<td class="report-num"><b>' + hhmm(m.avgT) + '</b></td></tr>';
      }).join('')
      + '<tr class="report-total"><td>チーム平均</td>'
      + '<td class="report-num">' + team.done + '</td>'
      + '<td class="report-num">—</td>'
      + '<td class="report-num">' + hhmm(team.avgA) + '</td>'
      + '<td class="report-num">' + hhmm(team.avgR) + '</td>'
      + '<td class="report-num"><b>' + hhmm(team.avgT) + '</b></td></tr>'
      + '</tbody></table></div>'
      + '<div class="member-charts">'
      + [['avgA', '分析平均', 'is-analysis'], ['avgR', '転用平均', 'is-reuse']]
        .map(function (c) {
          return '<div class="member-chart">'
            + '<div class="member-chart-title">' + c[1] + '</div>'
            + '<div class="member-bars">'
            + members.map(function (m) {
              return '<div class="member-bar"><div class="member-bar-track">'
                + '<span class="member-bar-fill ' + c[2] + '" style="height:'
                + (m[c[0]] * 100 / memberMax).toFixed(1) + '%" title="'
                + hhmm(m[c[0]]) + '"></span></div>'
                + '<div class="member-bar-name">' + esc(m.name.slice(0, 6))
                + '</div></div>';
            }).join('')
            + '</div></div>';
        }).join('')
      + '</div></section>');
  }

  if (loads.length) {
    parts.push('<section class="card"><h2>指摘の多さ</h2>'
      + '<p class="new-project-lead">修正の回数そのものは記録していないので、'
      + '<b>フィードバックが書かれた行の数</b>を目安にしています。'
      + '割合が下がってきていれば、手戻りが減っているということです。</p>'
      + '<div class="projects-table-wrap"><table class="projects-table report-table">'
      + '<thead><tr><th>案件名</th><th class="report-num">指摘のある行</th>'
      + '<th class="report-num">全行</th><th class="report-ratio">割合</th>'
      + '</tr></thead><tbody>'
      + loads.map(function (l) {
        return '<tr>' + nameCell(l.row)
          + '<td class="report-num">' + l.noted + '</td>'
          + '<td class="report-num">' + l.total + '</td>'
          + '<td class="report-ratio"><span class="ratio">'
          + '<span class="ratio-analysis" style="width:' + l.rate + '%"></span>'
          + '</span><span class="ratio-num">' + l.rate + '%</span></td></tr>';
      }).join('')
      + '</tbody></table></div></section>');
  }

  parts.push('<section class="card"><h2>案件ごと</h2>'
    + (rows.length
      ? '<div class="projects-table-wrap"><table class="projects-table report-table">'
        + '<thead><tr><th>ジャンル</th><th>案件名</th><th>担当者</th>'
        + '<th class="report-num">分析</th><th class="report-num">転用</th>'
        + '<th class="report-num">合計</th><th class="report-ratio">割合</th>'
        + '</tr></thead><tbody>'
        + rows.map(function (r) {
          return '<tr><td>' + pill(r.row.genre, genreColor) + '</td>'
            + nameCell(r.row)
            + '<td>' + pill(r.row.assignee, assigneeColor) + '</td>'
            + '<td class="report-num">' + hhmm(r.analysis) + '</td>'
            + '<td class="report-num">' + hhmm(r.reuse) + '</td>'
            + '<td class="report-num"><b>' + hhmm(r.total) + '</b></td>'
            + '<td class="report-ratio"><span class="ratio">'
            + '<span class="ratio-analysis" style="width:'
            + (r.analysis * 100 / r.total).toFixed(1) + '%"></span>'
            + '<span class="ratio-reuse" style="width:'
            + (r.reuse * 100 / r.total).toFixed(1) + '%"></span></span></td></tr>';
        }).join('')
        + '</tbody></table></div>'
      : '<div class="database-no-projects">'
        + '<div class="database-no-projects-title">まだ記録がありません</div>'
        + '<div class="muted">案件ページを開いて入力すると、'
        + 'そこから時間を数えはじめます。</div></div>')
    + '</section>');

  page.innerHTML = parts.join('');


  /* ---- 小物 ---- */

  function stat(label, value, note, cls) {
    return '<div class="stat"><div class="stat-label">' + label + '</div>'
      + '<div class="stat-value' + (cls ? ' ' + cls : '') + '">' + value + '</div>'
      + '<div class="stat-note">' + note + '</div></div>';
  }

  function bar(cls, value, title) {
    return '<span class="daybar-fill ' + cls + '" style="width:'
      + (value * 100 / dayMax).toFixed(1) + '%" title="' + title + ' '
      + hhmm(value) + '"></span>';
  }

  function pill(value, colors) {
    if (!value) { return '<span class="muted">—</span>'; }
    return '<span class="database-pill pill-c' + (colors[value] || 0) + '">'
      + esc(value) + '</span>';
  }

  function nameCell(p) {
    return '<td class="project-name-cell">'
      + '<a class="project-link" href="project.html?p='
      + encodeURIComponent(p.slug || p.id) + '">' + esc(p.name) + '</a>'
      + (p.project_no
        ? '<span class="project-no">' + esc(p.project_no) + '</span>' : '')
      + '</td>';
  }

}());
