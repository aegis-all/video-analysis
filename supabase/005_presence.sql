-- =============================================================
--  いま誰がどのセルを見ているか
--
--  Supabase の SQL Editor に貼り付けて実行してください。
--  何度実行しても同じ結果になるよう書いてあります。
--
--  数秒おきに書き換えられる、その場かぎりの情報です。
--  古くなった行は読むときに捨てるので、貯まりません。
-- =============================================================

create table if not exists public.presence (
    id         bigint generated always as identity primary key,

    video_id   bigint not null references public.videos(id) on delete cascade,
    user_id    uuid   not null references auth.users(id) on delete cascade,

    -- どの行のどの欄にいるか。0 と空文字は「まだどこでもない」
    -- screenshots への参照は付けない。行が消えた拍子に
    -- 書き込みが失敗すると、画面まで止まってしまうため。
    shot_id    bigint not null default 0,
    field      text   not null default '',

    name       text   not null default '',
    updated_at timestamptz not null default now()
);

create unique index if not exists presence_who
    on public.presence (video_id, user_id);

create index if not exists presence_fresh
    on public.presence (video_id, updated_at);


-- -------------------------------------------------------------
-- 権限
--
-- 003_members_only.sql を流していれば「承認された人だけ」に、
-- まだなら「ログインしていれば読み書きできる」に合わせる。
-- -------------------------------------------------------------

alter table public.presence enable row level security;

drop policy if exists presence_rw on public.presence;

do $$
begin
    if exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'is_member'
    ) then

        execute 'create policy presence_rw on public.presence
                     for all to authenticated
                     using (public.is_member()) with check (public.is_member())';

    else

        execute 'create policy presence_rw on public.presence
                     for all to authenticated
                     using (true) with check (true)';

    end if;
end;
$$;


select count(*) as いま見ている人 from public.presence;
