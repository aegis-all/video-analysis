-- =============================================================
--  身内だけが中身を見られるようにする
--
--  Supabase の SQL Editor に貼り付けて実行してください。
--  何度実行しても同じ結果になるよう書いてあります。
--
--  なぜ要るか
--  ----------------------------------------------------------
--  ブラウザだけで動かす作りなので、つなぎ先の鍵（anon キー）は
--  どうしても画面の中に入る。これ自体は公開してよい鍵で、
--  誰が何を見られるかは Supabase 側の権限設定（RLS）で決める。
--
--  ところが今の設定は「ログインしていれば全部見られる」になっている。
--  そして Supabase は初期状態だと誰でも自分で登録できる。
--  つまりこのままインターネットに出すと、
--  見ず知らずの人が自分で登録して全部の案件を読めてしまう。
--
--  そこで profiles に「使ってよい人」の印を付け、
--  印のある人だけが読み書きできるようにする。
--  新しく登録した人には印が付かないので、何も見えない。
--
--  人を増やすとき
--  ----------------------------------------------------------
--  1. Authentication → Users → Invite でメールアドレスを招く
--  2. Table Editor → profiles → その人の approved に印を付ける
--
--  あわせて Authentication → Sign In / Providers の
--  「Allow new users to sign up」を切っておくと、なお良い。
-- =============================================================


-- -------------------------------------------------------------
-- 1. 「使ってよい人」の印
-- -------------------------------------------------------------

alter table public.profiles
    add column if not exists approved boolean not null default false;

-- いま使っている人には印を付ける（このファイルを初めて流すとき用）
update public.profiles set approved = true where approved = false;


-- -------------------------------------------------------------
-- 2. 印があるかを見る関数
--
--    RLS の中から profiles を読むと、その profiles にも RLS が
--    掛かって堂々巡りになる。security definer で外して見る。
-- -------------------------------------------------------------

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select approved from public.profiles where id = auth.uid()),
        false
    );
$$;


-- -------------------------------------------------------------
-- 3. 表の権限を貼り替える
-- -------------------------------------------------------------

do $$
declare
    t text;
begin
    foreach t in array array[
        'projects', 'videos', 'screenshots', 'material_images',
        'work_time', 'guidelines', 'settings'
    ]
    loop
        execute format('drop policy if exists %I on public.%I', t || '_rw', t);

        execute format(
            'create policy %I on public.%I
                 for all to authenticated
                 using (public.is_member()) with check (public.is_member())',
            t || '_rw', t);
    end loop;
end;
$$;


-- -------------------------------------------------------------
-- 4. profiles だけは少し違う
--
--    自分の行は、印が無くても読めるようにしておく。
--    そうしないとログイン直後に自分の表示名すら引けず、
--    「何が起きたのか分からない」画面になってしまう。
-- -------------------------------------------------------------

drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_write on public.profiles;
drop policy if exists profiles_rw on public.profiles;

create policy profiles_read on public.profiles
    for select to authenticated
    using (id = auth.uid() or public.is_member());

create policy profiles_write on public.profiles
    for update to authenticated
    using (public.is_member()) with check (public.is_member());


-- -------------------------------------------------------------
-- 5. 置き場（Storage）も同じにする
-- -------------------------------------------------------------

do $$
declare
    b text;
begin
    foreach b in array array['videos', 'screenshots', 'materials']
    loop
        execute format('drop policy if exists %I on storage.objects', b || '_rw');

        execute format(
            'create policy %I on storage.objects
                 for all to authenticated
                 using (bucket_id = %L and public.is_member())
                 with check (bucket_id = %L and public.is_member())',
            b || '_rw', b, b);
    end loop;
end;
$$;


-- -------------------------------------------------------------
-- 6. 確認
-- -------------------------------------------------------------

select display_name, approved from public.profiles order by created_at;
