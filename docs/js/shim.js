/* ============================================================
   Flask のときの API を、Supabase への呼び出しに置き換える

   画面の動き（列の固定・拡大縮小・行の操作・自動保存など）は
   これまでの app.js をそのまま使いたい。
   あちらは /api/… を fetch しているので、ここで横取りして
   Supabase へつなぎ替える。返す形も当時と同じにしてある。

   こうすることで app.js に一切手を入れずに済み、
   作り込んだ挙動を壊さずに移せる。
   ============================================================ */

(function () {

  const original = window.fetch.bind(window);

  /** 当時と同じ形の返事を作る */
  function reply(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const routes = [

    /* ---------------- 案件の見出しの編集 ---------------- */
    {
      test: /^\/api\/projects\/(\d+)\/info$/,
      async run(m, body) {
        const id = Number(m[1]);

        const before = await API.Projects.byKey(String(id));

        if (!before) { return reply({ ok: false, error: '案件がありません。' }, 404); }

        const fields = {};

        ['genre', 'name', 'project_no', 'assignee'].forEach(function (key) {
          if (key in body) { fields[key] = String(body[key] || '').trim(); }
        });

        if ('name' in fields && !fields.name) {
          return reply({ ok: false, error: '案件名は空にできません。' }, 400);
        }

        if ('name' in fields || 'project_no' in fields) {
          fields.slug = await API.Projects.makeSlug(
            fields.name !== undefined ? fields.name : before.name,
            fields.project_no !== undefined ? fields.project_no : before.project_no,
            id);
        }

        const after = await API.Projects.update(id, fields);

        return reply({
          ok: true,
          url: 'project.html?p=' + encodeURIComponent(after.slug || after.id),
          updated_at: Shell.stamp(after.updated_at),
          slug: after.slug,
        });
      },
    },

    /* ---------------- 進捗ボード ---------------- */
    {
      test: /^\/api\/projects\/(\d+)\/status$/,
      async run(m, body) {
        await API.Projects.update(Number(m[1]), {
          status: body.status,
          status_at: new Date().toISOString(),
          board_order: Number.isInteger(body.order) ? body.order : 0,
        });
        return reply({ ok: true, status: body.status });
      },
    },
    {
      test: /^\/api\/board\/order$/,
      async run(m, body) {
        await Promise.all((body.ids || []).map(function (id, i) {
          return API.db.from('projects').update({ board_order: i }).eq('id', id);
        }));
        return reply({ ok: true });
      },
    },

    /* ---------------- 作業時間 ---------------- */
    {
      test: /^\/api\/worktime$/,
      async run(m, body) {
        const user = await API.Auth.user();

        if (!user || !body.project_id) { return reply({ ok: true, saved: 0 }); }

        let saved = 0;

        for (const side of ['analysis', 'reuse', 'other']) {
          const sec = Math.min(Math.trunc(body[side] || 0), 600);
          if (sec > 0) {
            await API.WorkTime.add(body.project_id, user.id, side, sec);
            saved += sec;
          }
        }

        return reply({ ok: true, saved: saved });
      },
    },

    /* ---------------- 目標値 ---------------- */
    {
      test: /^\/api\/settings$/,
      async run(m, body) {
        const keep = {};

        Object.keys(API.Settings.DEFAULTS).forEach(function (key) {
          if (key in body) {
            const n = Number(body[key]);
            if (!Number.isNaN(n)) { keep[key] = Math.max(0, Math.trunc(n)); }
          }
        });

        await API.Settings.save(keep);

        return reply({ ok: true, saved: keep });
      },
    },

    /* ---------------- 表の自動保存 ---------------- */
    {
      test: /^\/api\/screenshots\/(\d+)$/,
      async run(m, body) {
        const allowed = ['reference_role', 'material_feature', 'improvement_note',
          'reference_feedback', 'text_raw', 'material', 'role',
          'scene_feeling', 'feedback', 'row_height'];

        const fields = {};

        allowed.forEach(function (key) {
          if (key in body) {
            fields[key] = key === 'row_height'
              ? Math.trunc(Number(body[key]) || 0)
              : String(body[key] === null ? '' : body[key]);
          }
        });

        if (!Object.keys(fields).length) { return reply({ ok: true }); }

        await API.Shots.update(Number(m[1]), fields);

        return reply({ ok: true });
      },
    },

    /* ---------------- 行を消す・戻す ---------------- */
    {
      test: /^\/api\/screenshots\/delete$/,
      async run(m, body) {
        const ids = (body.ids || []).map(Number).filter(Boolean);

        if (!ids.length) { return reply({ ok: false, error: '対象がありません。' }, 400); }

        const { data } = await API.db
          .from('screenshots').select('video_id').eq('id', ids[0]).maybeSingle();

        await API.Shots.softDelete(ids);

        const left = data ? await renumber(data.video_id) : 0;

        return reply({ ok: true, removed: ids, count: left });
      },
    },
    {
      test: /^\/api\/screenshots\/restore$/,
      async run(m, body) {
        const ids = (body.ids || []).map(Number).filter(Boolean);

        if (!ids.length) { return reply({ ok: false, error: '対象がありません。' }, 400); }

        const { data } = await API.db
          .from('screenshots').select('video_id').eq('id', ids[0]).maybeSingle();

        await API.Shots.restore(ids);

        if (data) { await renumber(data.video_id); }

        return reply({ ok: true, restored: ids.length });
      },
    },

    /* ---------------- 行を足す ---------------- */
    {
      test: /^\/api\/screenshots\/(\d+)\/insert-after$/,
      async run(m) {
        const id = Number(m[1]);

        const { data: here } = await API.db
          .from('screenshots').select('video_id, seq').eq('id', id).maybeSingle();

        if (!here) { return reply({ ok: false, error: '行が見つかりません。' }, 404); }

        const seq = here.seq + 1;

        await shiftDown(here.video_id, seq);

        const made = await API.Shots.insertMany([{
          video_id: here.video_id, seq: seq, timestamp_sec: 0, is_manual: true,
        }]);

        return reply({ ok: true, id: made[0].id, seq: seq });
      },
    },
    {
      test: /^\/api\/videos\/(\d+)\/rows$/,
      async run(m) {
        const videoId = Number(m[1]);

        const { data } = await API.db
          .from('screenshots').select('seq')
          .eq('video_id', videoId).is('deleted_at', null)
          .order('seq', { ascending: false }).limit(1);

        const seq = (data && data.length ? data[0].seq : 0) + 1;

        const made = await API.Shots.insertMany([{
          video_id: videoId, seq: seq, timestamp_sec: 0,
        }]);

        return reply({ ok: true, id: made[0].id, seq: seq });
      },
    },

    /* ---------------- 行の並べ替え ---------------- */
    {
      test: /^\/api\/videos\/(\d+)\/reorder$/,
      async run(m, body) {
        const ids = (body.ids || []).map(Number);

        if (!ids.length) { return reply({ ok: false, error: '並び順がありません。' }, 400); }

        await API.Shots.reorder(ids);

        return reply({ ok: true, count: ids.length });
      },
    },

    /* ---------------- この場面を追加 ---------------- */
    {
      test: /^\/api\/videos\/(\d+)\/capture$/,
      async run(m, body) {
        const videoId = Number(m[1]);

        const blob = body.get('image');
        const at = Math.max(0, Number(body.get('t')) || 0);

        if (!blob) { return reply({ ok: false, error: '画像がありません。' }, 400); }

        const seq = await insertPosition(videoId, at);

        await shiftDown(videoId, seq);

        const path = videoId + '/m' + seq + '-' + Date.now() + '.jpg';
        await API.Files.upload('screenshots', path, blob);

        const made = await API.Shots.insertMany([{
          video_id: videoId, seq: seq, storage_path: path,
          timestamp_sec: at, is_manual: true,
        }]);

        return reply({
          ok: true,
          id: made[0].id,
          seq: seq,
          timestamp_sec: at,
          time_label: Shell.mmss(at),
          url: await API.Files.url('screenshots', path, 21600),
        });
      },
    },

    /* ---------------- ガイドライン ---------------- */
    {
      test: /^\/api\/guidelines$/,
      async run(m, body) {
        const user = await API.Auth.user();
        const text = String(body.text || '').trim();

        if (!text) { return reply({ ok: false, error: '内容がありません。' }, 400); }

        try {
          await API.Guidelines.add(text, body.source, body.seen, user && user.id);
        } catch (err) {
          return reply({ ok: false, error: err.message },
            err.message.includes('すでに') ? 409 : 400);
        }

        return reply({ ok: true });
      },
    },
    {
      test: /^\/api\/guidelines\/(\d+)\/delete$/,
      async run(m) {
        await API.Guidelines.remove(Number(m[1]));
        return reply({ ok: true });
      },
    },
    {
      test: /^\/api\/guidelines\/draft$/,
      async run() {
        return reply({
          ok: false,
          error: 'AI での文章化は、いまの作りでは使えません。'
            + '（鍵をブラウザに置けないため）',
        }, 400);
      },
    },

    /* ---------------- 進み具合の問い合わせ ---------------- */
    {
      test: /^\/api\/videos\/(\d+)\/status$/,
      async run(m) {
        const { data } = await API.db
          .from('videos').select('status, progress, stage, error_message')
          .eq('id', Number(m[1])).maybeSingle();

        return reply(data || { status: 'none', progress: 0 });
      },
    },
  ];


  /* ---------------- 補助 ---------------- */

  /** 番号を 1 から振り直して、残った行数を返す */
  async function renumber(videoId) {
    const rows = await API.Shots.ofVideo(videoId);
    await API.Shots.reorder(rows.map(function (r) { return r.id; }));
    return rows.length;
  }

  /** 差し込む場所から下を1つずつ後ろへずらす */
  async function shiftDown(videoId, fromSeq) {
    const rows = await API.Shots.ofVideo(videoId);

    const move = rows.filter(function (r) { return r.seq >= fromSeq; });

    /* 後ろから動かさないと番号がぶつかる */
    for (let i = move.length - 1; i >= 0; i -= 1) {
      await API.db.from('screenshots')
        .update({ seq: move[i].seq + 1 }).eq('id', move[i].id);
    }
  }

  /** 撮った秒数から、何行目に入れるかを決める */
  async function insertPosition(videoId, at) {
    const rows = await API.Shots.ofVideo(videoId);

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      /* 秒数の入っていない行（空の行）は目印にしない */
      if (!r.storage_path && !r.timestamp_sec) { continue; }
      if ((r.timestamp_sec || 0) > at) { return i + 1; }
    }

    return rows.length + 1;
  }


  /* ---------------- 横取り ---------------- */

  window.fetch = async function (input, init) {

    const url = typeof input === 'string' ? input : (input && input.url) || '';

    if (!url.startsWith('/api/')) {
      return original(input, init);
    }

    const path = url.split('?')[0];

    for (const route of routes) {
      const m = path.match(route.test);

      if (!m) { continue; }

      let body = {};

      if (init && init.body) {
        body = (init.body instanceof FormData)
          ? init.body
          : JSON.parse(init.body);
      }

      try {
        return await route.run(m, body);
      } catch (err) {
        return reply({ ok: false, error: err.message }, 500);
      }
    }

    return reply({ ok: false, error: '知らない呼び出しです: ' + path }, 404);
  };

}());
