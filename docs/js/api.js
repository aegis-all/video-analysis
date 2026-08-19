/* ============================================================
   Supabase とのやりとり

   これまで Flask が受け持っていたデータの読み書きを、
   ブラウザから直接 Supabase に対して行う。
   誰が何を触れるかは Supabase 側の権限設定で決まっているので、
   ここでは「ログインしていること」だけを前提にしてよい。
   ============================================================ */

/* 名前を外に出さない。app.js にも toast などがあり、
   同じ名前が2つあると読み込み時に丸ごと止まってしまう。 */
(function () {

const db = window.supabase.createClient(
  window.APP_CONFIG.supabaseUrl,
  window.APP_CONFIG.supabaseAnonKey,
  { auth: { persistSession: true, autoRefreshToken: true } }
);


/* ------------------------------------------------------------
   ログイン
   ------------------------------------------------------------ */

const Auth = {

  async user() {
    const { data } = await db.auth.getUser();
    return data.user || null;
  },

  /** ログインしていなければログイン画面へ送る */
  async require() {
    const user = await this.user();

    if (!user) {
      const back = encodeURIComponent(
        location.pathname.split('/').pop() + location.search);
      location.replace('login.html?next=' + back);
      return null;
    }

    return user;
  },

  async profile(userId) {
    const { data } = await db
      .from('profiles')
      .select('id, display_name')
      .eq('id', userId)
      .maybeSingle();

    return data;
  },

  /** 画面に出す名前。表示名が空ならメールの @ より前 */
  nameOf(user, profile) {
    if (profile && profile.display_name) { return profile.display_name; }
    return (user.email || '').split('@')[0];
  },

  async signIn(email, password) {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) { throw new Error(error.message); }
  },

  async sendLink(email) {
    const { error } = await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) { throw new Error(error.message); }
  },

  async signOut() {
    await db.auth.signOut();
    location.replace('login.html');
  },
};


/* ------------------------------------------------------------
   案件
   ------------------------------------------------------------ */

const Projects = {

  /** 一覧。行数とバージョン数も一緒に取る */
  async list() {
    const { data, error } = await db
      .from('projects')
      .select('*, videos(id, version_label)')
      .order('updated_at', { ascending: false });

    if (error) { throw new Error(error.message); }

    return (data || []).map(function (p) {
      return Object.assign({}, p, {
        video_count: (p.videos || []).length,
        version_labels: (p.videos || []).map(function (v) {
          return v.version_label;
        }),
      });
    });
  },

  async byKey(key) {
    /* slug でも id でも開けるようにする */
    let query = db.from('projects').select('*');

    query = /^\d+$/.test(key)
      ? query.eq('id', Number(key))
      : query.eq('slug', key);

    const { data, error } = await query.maybeSingle();

    if (error) { throw new Error(error.message); }

    return data;
  },

  async create(fields) {
    const { data, error } = await db
      .from('projects')
      .insert(fields)
      .select()
      .single();

    if (error) { throw new Error(error.message); }

    return data;
  },

  async update(id, fields) {
    const { data, error } = await db
      .from('projects')
      .update(fields)
      .eq('id', id)
      .select()
      .single();

    if (error) { throw new Error(error.message); }

    return data;
  },

  async remove(id) {
    const { error } = await db.from('projects').delete().eq('id', id);
    if (error) { throw new Error(error.message); }
  },

  /**
   * 案件名と番号から、URL に使う短い名前を作る。
   *
   * Flask 側の make_slug と同じ考え方。
   * 日本語をローマ字に直すところだけは、辞書が要るので簡略化して
   * 「使える文字だけ残す」形にし、空になったら id を使う。
   */
  async makeSlug(name, projectNo, exceptId) {
    let base = ((name || '') + (projectNo || ''))
      .toLowerCase()
      .replace(/[\s/\\?#&%+.,:;'"<>|*[\]{}()]+/g, '')
      .slice(0, 80);

    if (!/[a-z0-9]/.test(base)) {
      base = encodeURIComponent(base).replace(/%/g, '').toLowerCase().slice(0, 60);
    }

    if (!base) { base = 'project'; }

    let slug = base;
    let n = 2;

    /* すでに同じものがあれば -2, -3 … を付ける */
    for (;;) {
      let q = db.from('projects').select('id').eq('slug', slug).limit(1);
      if (exceptId) { q = q.neq('id', exceptId); }

      const { data } = await q;

      if (!data || !data.length) { return slug; }

      slug = base + '-' + n;
      n += 1;
    }
  },
};


/* ------------------------------------------------------------
   動画と行
   ------------------------------------------------------------ */

const Videos = {

  async ofProject(projectId) {
    const { data, error } = await db
      .from('videos')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order')
      .order('id');

    if (error) { throw new Error(error.message); }

    return data || [];
  },

  async create(fields) {
    const { data, error } = await db
      .from('videos').insert(fields).select().single();

    if (error) { throw new Error(error.message); }

    return data;
  },

  async remove(id) {
    const { error } = await db.from('videos').delete().eq('id', id);
    if (error) { throw new Error(error.message); }
  },
};


const Shots = {

  async ofVideo(videoId) {
    const { data, error } = await db
      .from('screenshots')
      .select('*')
      .eq('video_id', videoId)
      .is('deleted_at', null)
      .order('seq')
      .order('id');

    if (error) { throw new Error(error.message); }

    return data || [];
  },

  async update(id, fields) {
    const { error } = await db.from('screenshots').update(fields).eq('id', id);
    if (error) { throw new Error(error.message); }
  },

  async insertMany(list) {
    const { data, error } = await db
      .from('screenshots').insert(list).select();

    if (error) { throw new Error(error.message); }

    return data || [];
  },

  /** 消したことにする（あとから戻せる） */
  async softDelete(ids) {
    const { error } = await db
      .from('screenshots')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', ids);

    if (error) { throw new Error(error.message); }
  },

  async restore(ids) {
    const { error } = await db
      .from('screenshots')
      .update({ deleted_at: null })
      .in('id', ids);

    if (error) { throw new Error(error.message); }
  },

  /** 送られてきた順に番号を振り直す */
  async reorder(ids) {
    await Promise.all(ids.map(function (id, i) {
      return db.from('screenshots').update({ seq: i + 1 }).eq('id', id);
    }));
  },
};


/* ------------------------------------------------------------
   結合したセル

   まとめた左上のセルと、そこから何行ぶん・何列ぶん広がるかを持つ。
   ------------------------------------------------------------ */

const Merges = {

  async ofVideo(videoId) {

    const { data, error } = await db
      .from('cell_merges')
      .select('shot_id, field, row_span, col_span')
      .eq('video_id', videoId);

    /* 表をまだ作っていないときでも、画面は出したい */
    if (error) { return []; }

    return data || [];
  },

  async insertMany(list) {
    const { error } = await db.from('cell_merges').insert(list);
    if (error) { throw new Error(error.message); }
  },

  async remove(videoId, shotId, field) {

    const { error } = await db
      .from('cell_merges')
      .delete()
      .eq('video_id', videoId)
      .eq('shot_id', shotId)
      .eq('field', field);

    if (error) { throw new Error(error.message); }
  },
};


/* ------------------------------------------------------------
   ファイル
   ------------------------------------------------------------ */

const Files = {

  /** しばらく有効な URL を作る。画像や動画の表示に使う */
  async url(bucket, path, seconds) {
    if (!path) { return null; }

    const { data, error } = await db.storage
      .from(bucket)
      .createSignedUrl(path, seconds || 3600);

    if (error) { return null; }

    return data.signedUrl;
  },

  async upload(bucket, path, blob, onProgress) {
    const { error } = await db.storage
      .from(bucket)
      .upload(path, blob, { upsert: true, contentType: blob.type });

    if (error) { throw new Error(error.message); }

    if (onProgress) { onProgress(1); }

    return path;
  },

  async remove(bucket, paths) {
    if (!paths || !paths.length) { return; }
    await db.storage.from(bucket).remove(paths);
  },
};


/* ------------------------------------------------------------
   作業時間・設定・ガイドライン
   ------------------------------------------------------------ */

const WorkTime = {

  /** 秒数を足しこむ。同じ日・同じ側なら1行にまとめる */
  async add(projectId, userId, side, seconds) {
    if (!seconds) { return; }

    const day = new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD

    const { data } = await db
      .from('work_time')
      .select('id, seconds')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('side', side)
      .eq('day', day)
      .maybeSingle();

    if (data) {
      await db.from('work_time')
        .update({ seconds: data.seconds + seconds, updated_at: new Date().toISOString() })
        .eq('id', data.id);
    } else {
      await db.from('work_time')
        .insert({ project_id: projectId, user_id: userId, side: side,
                  day: day, seconds: seconds });
    }
  },

  async all() {
    const { data, error } = await db.from('work_time').select('*');
    if (error) { throw new Error(error.message); }
    return data || [];
  },
};


const Settings = {

  DEFAULTS: {
    monthly_target: 20,
    target_analysis: 2 * 3600,
    target_reuse: 3 * 3600,
  },

  async all() {
    const { data } = await db.from('settings').select('key, value');

    const out = Object.assign({}, this.DEFAULTS);

    (data || []).forEach(function (row) {
      const n = Number(row.value);
      if (!Number.isNaN(n)) { out[row.key] = n; }
    });

    out.target_total = out.target_analysis + out.target_reuse;

    return out;
  },

  async save(values) {
    const rows = Object.keys(values).map(function (key) {
      return { key: key, value: String(values[key]),
               updated_at: new Date().toISOString() };
    });

    const { error } = await db.from('settings').upsert(rows);
    if (error) { throw new Error(error.message); }
  },
};


const Guidelines = {

  async list() {
    const { data, error } = await db
      .from('guidelines')
      .select('*')
      .eq('status', 'active')
      .order('sort_order')
      .order('id');

    if (error) { throw new Error(error.message); }

    return data || [];
  },

  async add(text, source, seen, userId) {
    const { error } = await db.from('guidelines').insert({
      text: text, source: source || '', seen: seen || 0, created_by: userId,
    });

    if (error) {
      throw new Error(
        error.code === '23505' ? 'すでに入っています。' : error.message);
    }
  },

  async remove(id) {
    const { error } = await db.from('guidelines').delete().eq('id', id);
    if (error) { throw new Error(error.message); }
  },
};


window.API = {
  db, Auth, Projects, Videos, Shots, Merges, Files, WorkTime, Settings, Guidelines,
};

}());
