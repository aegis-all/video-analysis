/* ============================================================
   ユーザー

   一覧と表示名の変更まで。
   追加・削除は、秘密の鍵が要るのでここからはできない。
   （鍵をブラウザに置くと、誰でも管理操作ができてしまう）
   ============================================================ */

(async function () {

  const me = await Shell.mountShell('users.html');

  if (!me) { return; }

  const page = document.getElementById('page');
  const esc = Shell.escapeHtml;

  await render();


  async function render() {

    /* approved はあとから足す列なので、まだ無いこともある。
       そのときは列を外して読み直す */
    let data = null;
    let error = null;
    let hasApproved = true;

    for (const extra of [', approved', '']) {

      const r = await API.db
        .from('profiles')
        .select('id, display_name, created_at' + extra)
        .order('created_at');

      if (!r.error) { data = r.data; hasApproved = !!extra; break; }

      error = r.error;
      if (!extra) { break; }
    }

    if (!data) {
      page.innerHTML = '<section class="card"><p>'
        + esc(error ? error.message : '読み込めませんでした。') + '</p></section>';
      return;
    }

    const users = data;

    page.innerHTML =

      '<section class="card">'
      + '<h2>ユーザー</h2>'
      + '<p class="new-project-lead">'
      + '表示名は、案件の担当者欄の初期値と、作業時間のメンバー別に使われます。'
      + '自分の名前はここで変えられます。</p>'
      + '<div class="projects-table-wrap">'
      + '<table class="projects-table users-table">'
      + '<thead><tr><th>表示名</th><th>登録日</th><th>操作</th></tr></thead>'
      + '<tbody>'
      + users.map(function (u) {
        const mine = u.id === me.user.id;
        return '<tr>'
          + '<td><span class="member">'
          + '<span class="member-avatar">'
          + esc((u.display_name || '?').slice(0, 1).toUpperCase()) + '</span>'
          + '<strong>' + esc(u.display_name || '未設定') + '</strong>'
          + (mine ? ' <span class="database-pill pill-c7">自分</span>' : '')
          + (hasApproved && !u.approved
            ? ' <span class="database-pill pill-c3">未承認</span>' : '')
          + '</span></td>'
          + '<td class="database-date">' + Shell.stamp(u.created_at) + '</td>'
          + '<td class="users-actions">'
          + '<span class="users-inline">'
          + '<input type="text" class="users-name" maxlength="40" value="'
          + esc(u.display_name || '') + '" data-id="' + u.id + '"'
          + ' aria-label="表示名">'
          + '<button type="button" data-save="' + u.id + '">変更</button>'
          + '</span></td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>'
      + '</section>'

      + '<section class="card">'
      + '<h2>ユーザーを増やす・減らす</h2>'
      + '<p class="new-project-lead">'
      + '追加と削除は、この画面からはできません。'
      + '管理用の鍵が必要で、それをブラウザに置くと'
      + '<b>誰でも管理操作ができてしまう</b>ためです。<br>'
      + 'Supabase の管理画面（Authentication → Users → Invite）から'
      + 'メールアドレスを入れて招待してください。'
      + '招待された人は、届いたメールのリンクからパスワードを決めて入れます。</p>'
      + '<p class="note-hint">'
      + 'ログインできなくなった場合も、同じ画面からパスワードの再設定ができます。'
      + '</p>'
      + '<p class="note-hint">'
      + '招いた人は、はじめは<b>未承認</b>で、案件が何も見えません。'
      + 'Table Editor → profiles → その人の approved に印を付けると使えるようになります。'
      + '（知らない人が勝手に登録しても中身を見られないようにするための仕組みです）'
      + '</p>'
      + '</section>';

    page.querySelectorAll('[data-save]').forEach(function (btn) {
      btn.addEventListener('click', function () { save(btn); });
    });
  }


  async function save(btn) {

    const id = btn.dataset.save;
    const input = page.querySelector('.users-name[data-id="' + id + '"]');
    const name = input.value.trim();

    if (!name) {
      Shell.toast('表示名を入力してください。', true);
      return;
    }

    btn.disabled = true;

    const { error } = await API.db
      .from('profiles').update({ display_name: name }).eq('id', id);

    btn.disabled = false;

    if (error) {
      Shell.toast('変えられませんでした（' + error.message + '）', true);
      return;
    }

    Shell.toast('表示名を「' + name + '」にしました');

    await render();
  }

}());
