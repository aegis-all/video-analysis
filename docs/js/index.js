/* ============================================================
   案件一覧

   ・案件の追加
   ・検索、ジャンル／担当者での絞り込み、並べ替え
   ============================================================ */

(async function () {

  const me = await Shell.mountShell('index.html');

  if (!me) { return; }

  const body = document.getElementById('projects-body');
  const count = document.getElementById('projects-count');
  const empty = document.getElementById('projects-empty');
  const none = document.getElementById('no-projects');

  let projects = [];
  let genreColor = {};
  let assigneeColor = {};

  const selected = { genre: new Set(), assignee: new Set() };

  await load();

  /* 担当者は自分の名前を最初から入れておく（消して直せる） */
  document.getElementById('assignee').value = me.name;


  /* ------------------------------------------------------------
     読み込みと描画
     ------------------------------------------------------------ */

  async function load() {
    try {
      projects = await API.Projects.list();
    } catch (err) {
      Shell.toast('案件を読み込めませんでした（' + err.message + '）', true);
      return;
    }

    genreColor = Shell.colorMap(projects.map(function (p) { return p.genre; }), 0);
    assigneeColor = Shell.colorMap(projects.map(function (p) { return p.assignee; }), 6);

    fillDatalist();
    fillFilterOptions();
    render();
  }

  function fillDatalist() {
    const list = document.getElementById('genre-list');
    const seen = [...new Set(projects.map(function (p) { return p.genre; })
      .filter(Boolean))].sort();

    list.innerHTML = seen.map(function (g) {
      return '<option value="' + Shell.escapeHtml(g) + '">';
    }).join('');
  }

  function fillFilterOptions() {
    [['genre', 'まだジャンルがありません'],
     ['assignee', 'まだ担当者がいません']].forEach(function (pair) {

      const key = pair[0];
      const panel = document.querySelector('[data-options="' + key + '"]');
      const values = [...new Set(projects.map(function (p) { return p[key]; })
        .filter(Boolean))].sort();

      if (!values.length) {
        panel.innerHTML = '<p class="filter-empty">' + pair[1] + '</p>';
        return;
      }

      panel.innerHTML = values.map(function (v) {
        return '<label class="filter-option">'
          + '<input type="checkbox" value="' + Shell.escapeHtml(v) + '">'
          + '<span>' + Shell.escapeHtml(v) + '</span></label>';
      }).join('');

      panel.querySelectorAll('input').forEach(function (input) {
        input.addEventListener('change', function () {
          if (input.checked) { selected[key].add(input.value); }
          else { selected[key].delete(input.value); }
          render();
        });
      });
    });
  }

  function render() {

    const term = (document.getElementById('project-search').value || '')
      .trim().toLowerCase();

    let list = projects.filter(function (p) {

      if (selected.genre.size && !selected.genre.has(p.genre)) { return false; }
      if (selected.assignee.size && !selected.assignee.has(p.assignee)) { return false; }

      if (!term) { return true; }

      return [p.genre, p.name, p.assignee, p.project_no]
        .some(function (v) { return (v || '').toLowerCase().includes(term); });
    });

    list = sortList(list);

    body.innerHTML = list.map(row).join('');

    count.textContent = list.length + '件';
    empty.hidden = list.length > 0 || projects.length === 0;
    none.hidden = projects.length > 0;

    /* 絞り込みの数を出す */
    ['genre', 'assignee'].forEach(function (key) {
      const chip = document.querySelector('.filter-chip[data-key="' + key + '"]');
      const badge = chip.querySelector('.filter-chip-count');
      badge.textContent = selected[key].size ? String(selected[key].size) : '';
      chip.classList.toggle('is-on', selected[key].size > 0);
    });
  }

  function sortList(list) {

    const field = document.getElementById('database-sort-field').value;

    if (!field) { return list; }

    const dir = document.getElementById('database-sort-direction').value === 'desc'
      ? -1 : 1;

    const pick = function (p) {
      if (field === 'created') { return p.created_at || ''; }
      return (p[field] || '').toLowerCase();
    };

    /* 日本語の並びは単純な比較だと不自然になるので、
       これまでと同じく localeCompare を使う */
    return list.slice().sort(function (a, b) {
      return pick(a).localeCompare(pick(b), 'ja') * dir;
    });
  }

  function row(p) {

    const key = p.slug || p.id;

    const pill = function (value, colors, page) {
      if (!value) { return '<span class="muted">—</span>'; }
      return '<a class="database-pill pill-c' + (colors[value] || 0) + ' is-link"'
        + ' href="' + page + '.html?v=' + encodeURIComponent(value) + '">'
        + Shell.escapeHtml(value) + '</a>';
    };

    return '<tr class="project-row">'
      + '<td>' + pill(p.genre, genreColor, 'genre') + '</td>'
      + '<td class="project-name-cell">'
      + '<a class="project-link" href="project.html?p=' + encodeURIComponent(key) + '">'
      + Shell.escapeHtml(p.name) + '</a>'
      + (p.project_no
        ? '<span class="project-no">' + Shell.escapeHtml(p.project_no) + '</span>' : '')
      + '</td>'
      + '<td>' + pill(p.assignee, assigneeColor, 'assignee') + '</td>'
      + '<td class="database-number">' + p.video_count + '</td>'
      + '<td class="database-date">' + Shell.stamp(p.created_at) + '</td>'
      + '</tr>';
  }


  /* ------------------------------------------------------------
     検索・絞り込み・並べ替えの操作
     ------------------------------------------------------------ */

  document.getElementById('project-search').addEventListener('input', render);
  document.getElementById('database-sort-field').addEventListener('change', render);
  document.getElementById('database-sort-direction').addEventListener('change', render);

  document.getElementById('database-add-filter').addEventListener('click', function () {
    const box = document.getElementById('database-filters');
    box.hidden = !box.hidden;
  });

  document.getElementById('database-sort-button').addEventListener('click', function () {
    const box = document.getElementById('database-sort-panel');
    box.hidden = !box.hidden;
  });

  document.querySelectorAll('.filter-chip-button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const panel = btn.parentElement.querySelector('.filter-panel');
      /* 他のパネルは閉じる */
      document.querySelectorAll('.filter-panel').forEach(function (other) {
        if (other !== panel) { other.hidden = true; }
      });
      panel.hidden = !panel.hidden;
    });
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.filter-chip')) {
      document.querySelectorAll('.filter-panel').forEach(function (p) {
        p.hidden = true;
      });
    }
  });

  document.getElementById('project-filter-clear').addEventListener('click', function () {
    selected.genre.clear();
    selected.assignee.clear();
    document.querySelectorAll('.filter-panel input').forEach(function (i) {
      i.checked = false;
    });
    document.getElementById('project-search').value = '';
    document.getElementById('database-sort-field').value = '';
    render();
  });


  /* ------------------------------------------------------------
     ファイル / リンクの切り替え
     ------------------------------------------------------------ */

  document.querySelectorAll('.source-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {

      document.querySelectorAll('.source-tab').forEach(function (t) {
        t.classList.toggle('is-active', t === tab);
      });

      document.querySelectorAll('.source-panel').forEach(function (panel) {
        panel.classList.toggle('is-hidden',
          panel.dataset.panel !== tab.dataset.source);
      });
    });
  });


  /* ------------------------------------------------------------
     案件を作る
     ------------------------------------------------------------ */

  document.getElementById('create-form').addEventListener('submit', async function (e) {

    e.preventDefault();

    const submit = document.getElementById('submit');
    const note = document.getElementById('create-note');

    const name = document.getElementById('name').value.trim();

    if (!name) {
      Shell.toast('案件名を入力してください。', true);
      return;
    }

    const projectNo = document.getElementById('project_no').value.trim();
    const file = document.getElementById('video').files[0];
    const url = document.getElementById('video_url').value.trim();

    const useFile = !document.querySelector('[data-panel="file"]')
      .classList.contains('is-hidden');

    submit.disabled = true;

    try {
      note.textContent = '案件を作っています…';

      const project = await API.Projects.create({
        genre: document.getElementById('genre').value.trim(),
        name: name,
        project_no: projectNo,
        slug: await API.Projects.makeSlug(name, projectNo),
        assignee: document.getElementById('assignee').value.trim(),
        owner_id: me.user.id,
      });

      if (useFile && file) {

        note.textContent = '動画を送っています…（' +
          (file.size / 1048576).toFixed(0) + 'MB）';

        const path = project.id + '/' + Date.now() + '-' + safeName(file.name);
        await API.Files.upload('videos', path, file);

        await API.Videos.create({
          project_id: project.id,
          original_name: file.name,
          storage_path: path,
          status: 'queued',
        });

      } else if (!useFile && url) {

        await API.Videos.create({
          project_id: project.id,
          original_name: url.split('/').pop() || 'video',
          source_url: url,
          status: 'queued',
        });

      } else {

        /* 動画なしのときは、空の行を30行つくる */
        const video = await API.Videos.create({
          project_id: project.id,
          version_label: '初稿',
          status: 'none',
        });

        const blanks = [];
        for (let i = 1; i <= 30; i += 1) {
          blanks.push({ video_id: video.id, seq: i, timestamp_sec: 0 });
        }
        await API.Shots.insertMany(blanks);
      }

      location.href = 'project.html?p='
        + encodeURIComponent(project.slug || project.id);

    } catch (err) {
      Shell.toast('作成できませんでした（' + err.message + '）', true);
      note.textContent = '';
      submit.disabled = false;
    }
  });

  /** 置き場所に使えない文字を落とす */
  function safeName(name) {
    return (name || 'video')
      .replace(/[^\w.\-]+/g, '_')
      .slice(-80);
  }

}());
