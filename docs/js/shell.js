/* ============================================================
   どの画面にも共通の枠（ヘッダー・ナビ・知らせ）

   Flask の base.html が受け持っていたところ。
   ============================================================ */

const NAV = [
  ['index.html', '案件'],
  ['board.html', '進捗ボード'],
  ['report.html', '作業時間'],
  ['notes.html', '共通ノート'],
];

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'"
  + "%3E%3Crect width='32' height='32' rx='7' fill='%230b1220'/%3E"
  + "%3Cpath d='M8.5 8v11l9-5.5z' fill='%2322d3ee'/%3E"
  + "%3Ccircle cx='20' cy='20' r='6' fill='none' stroke='%233b82f6' stroke-width='2.6'/%3E"
  + "%3Cpath d='M24.4 24.4l3.1 3.1' stroke='%233b82f6' stroke-width='2.6' stroke-linecap='round'/%3E"
  + '%3C/svg%3E';


/**
 * ヘッダーを組み立てて、ログイン中のユーザーを返す。
 * ログインしていなければログイン画面へ送る（戻り値は null）。
 *
 * @param {string} current  いまの画面のファイル名
 * @param {Node|string} middle  ブランドの右に置くもの（案件ページの見出しなど）
 */
async function mountShell(current, middle) {

  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = FAVICON;
  document.head.appendChild(icon);

  const user = await API.Auth.require();

  if (!user) { return null; }

  const profile = await API.Auth.profile(user.id);
  const name = API.Auth.nameOf(user, profile);

  const header = document.createElement('header');
  header.className = 'topbar';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = 'index.html';
  brand.innerHTML =
    '<img class="brand-mark" src="logo-mark.svg" alt="" width="30" height="30">'
    + '<span class="brand-text">'
    + '<span class="brand-name">動画分析</span>'
    + '<span class="brand-sub">VIDEO ANALYSIS</span>'
    + '</span>';
  header.appendChild(brand);

  if (middle) {
    if (typeof middle === 'string') {
      const box = document.createElement('div');
      box.innerHTML = middle;
      header.appendChild(box.firstElementChild || box);
    } else {
      header.appendChild(middle);
    }
  } else {
    const nav = document.createElement('nav');
    nav.className = 'mainnav';

    NAV.forEach(function (item) {
      const a = document.createElement('a');
      a.href = item[0];
      a.textContent = item[1];
      if (item[0] === current) { a.className = 'is-active'; }
      nav.appendChild(a);
    });

    header.appendChild(nav);
  }

  const account = document.createElement('div');
  account.className = 'account';
  account.innerHTML =
    '<span class="account-avatar" aria-hidden="true">'
    + escapeHtml(name.slice(0, 1).toUpperCase()) + '</span>'
    + '<span class="account-name" title="' + escapeHtml(user.email) + '">'
    + escapeHtml(name) + '</span>'
    + '<span class="account-links">'
    + '<a href="users.html">ユーザー</a>'
    + '<a href="#" data-logout>ログアウト</a>'
    + '</span>';

  account.querySelector('[data-logout]').addEventListener('click', function (e) {
    e.preventDefault();
    API.Auth.signOut();
  });

  header.appendChild(account);
  document.body.insertBefore(header, document.body.firstChild);

  return { user: user, profile: profile, name: name };
}


/* ------------------------------------------------------------
   画面右下の知らせ
   ------------------------------------------------------------ */

let toastTimer = null;

function toast(message, bad) {

  let box = document.getElementById('toast');

  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.className = 'toast';
    document.body.appendChild(box);
  }

  box.textContent = message;
  box.classList.toggle('is-bad', !!bad);
  box.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { box.hidden = true; }, bad ? 6000 : 3000);
}


/* ------------------------------------------------------------
   小物
   ------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/** 秒を 00:00 の形に */
function mmss(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) { return '--:--'; }
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}


/** 秒を「1時間20分」の形に */
function hhmm(sec) {
  const n = Math.trunc(Number(sec) || 0);
  if (n <= 0) { return '—'; }
  if (n < 60) { return '1分未満'; }
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (h && m) { return h + '時間' + m + '分'; }
  if (h) { return h + '時間'; }
  return m + '分';
}


/** 日時を「2026-08-18 12:34:56」の形に（DBは UTC で持っている） */
function stamp(value) {
  if (!value) { return ''; }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) { return String(value); }
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}


/**
 * 値ごとに色を割り当てる。
 *
 * 出てきた順に決める。ハッシュだと別々の言葉が同じ色になることがあり、
 * 実際に「テスト」と「給付金」がぶつかった。
 */
function colorMap(values, offset) {
  const map = {};
  let i = offset || 0;

  values.forEach(function (v) {
    const key = (v || '').trim();
    if (key && !(key in map)) {
      map[key] = i % 12;
      i += 1;
    }
  });

  return map;
}


window.Shell = {
  mountShell, toast, escapeHtml, mmss, hhmm, stamp, colorMap,
};
