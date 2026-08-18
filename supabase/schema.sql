-- =============================================================
--  動画分析（VIDEO ANALYSIS）の Supabase 用スキーマ
--
--  Supabase の SQL Editor に貼り付けて実行してください。
--  何度実行しても同じ結果になるよう書いてあります。
--
--  いまの SQLite からの主な変更点
--   ・id は bigint の自動採番
--   ・日時は text ではなく timestamptz
--   ・ユーザーは Supabase Auth（auth.users）を使う
--   ・0/1 で持っていた真偽値は boolean
-- =============================================================


-- -------------------------------------------------------------
-- 1. プロフィール（表示名）
--
--    Supabase Auth はメールアドレスしか持たないので、
--    案件の担当者欄に入れる表示名をここに持つ。
-- -------------------------------------------------------------

create table if not exists public.profiles (
    id            uuid primary key references auth.users(id) on delete cascade,
    display_name  text not null default '',
    created_at    timestamptz not null default now()
);

-- ユーザーが増えたら自動でプロフィールも作る
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, display_name)
    values (
        new.id,
        coalesce(
            new.raw_user_meta_data ->> 'display_name',
            split_part(new.email, '@', 1)
        )
    )
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();


-- -------------------------------------------------------------
-- 2. 案件
-- -------------------------------------------------------------

create table if not exists public.projects (
    id             bigint generated always as identity primary key,

    genre          text not null default '',
    name           text not null,
    project_no     text not null default '',
    slug           text not null default '',
    assignee       text not null default '',

    column_widths  jsonb not null default '{}'::jsonb,

    -- 進捗ボード：todo / doing / waiting / done
    status         text not null default 'todo'
                   check (status in ('todo', 'doing', 'waiting', 'done')),
    status_at      timestamptz,
    board_order    integer not null default 0,

    -- メンバー別の集計に使う担当ユーザー
    owner_id       uuid references auth.users(id) on delete set null,

    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

create unique index if not exists projects_slug_key
    on public.projects (slug) where slug <> '';

create index if not exists projects_status_idx
    on public.projects (status, board_order);


-- -------------------------------------------------------------
-- 3. 動画
-- -------------------------------------------------------------

create table if not exists public.videos (
    id             bigint generated always as identity primary key,
    project_id     bigint not null references public.projects(id) on delete cascade,

    version_label  text not null default '初稿',
    original_name  text not null default '',

    -- Storage の中の置き場所（バケット videos からの相対）
    storage_path   text not null default '',
    source_url     text not null default '',

    duration_sec   double precision,

    -- none / queued / running / done / error
    status         text not null default 'none',
    progress       integer not null default 0,
    stage          text not null default '',
    error_message  text,

    sort_order     integer not null default 0,
    created_at     timestamptz not null default now()
);

create index if not exists videos_project_idx
    on public.videos (project_id, sort_order);


-- -------------------------------------------------------------
-- 4. スクリーンショット（表の1行）
-- -------------------------------------------------------------

create table if not exists public.screenshots (
    id                  bigint generated always as identity primary key,
    video_id            bigint not null references public.videos(id) on delete cascade,

    seq                 integer not null,
    storage_path        text not null default '',
    timestamp_sec       double precision not null default 0,

    row_height          integer not null default 0,

    -- 動画プレイヤーの「この場面を追加」で撮った行
    is_manual           boolean not null default false,

    -- 表の左側（分析）
    reference_role      text not null default '',
    material_feature    text not null default '',
    improvement_note    text not null default '',
    reference_feedback  text not null default '',

    -- 表の右側（転用）
    text_raw            text not null default '',
    material            text not null default '',
    role                text not null default '',
    scene_feeling       text not null default '',
    feedback            text not null default '',

    -- 消した行は残しておき、あとから戻せるようにする
    deleted_at          timestamptz,

    updated_at          timestamptz not null default now()
);

create index if not exists screenshots_video_idx
    on public.screenshots (video_id, seq);

create index if not exists screenshots_live_idx
    on public.screenshots (video_id, seq) where deleted_at is null;


-- -------------------------------------------------------------
-- 5. 素材画像（1行にぶら下がる画像）
-- -------------------------------------------------------------

create table if not exists public.material_images (
    id             bigint generated always as identity primary key,
    shot_id        bigint not null references public.screenshots(id) on delete cascade,

    storage_path   text not null default '',
    original_name  text not null default '',
    created_at     timestamptz not null default now()
);

create index if not exists material_images_shot_idx
    on public.material_images (shot_id);


-- -------------------------------------------------------------
-- 6. 作業時間
--
--    画面を触っている秒数を、分析／転用に振り分けて貯める。
--    案件×人×側×日 で1行にまとめる。
-- -------------------------------------------------------------

create table if not exists public.work_time (
    id          bigint generated always as identity primary key,
    project_id  bigint not null references public.projects(id) on delete cascade,
    user_id     uuid not null references auth.users(id) on delete cascade,

    side        text not null check (side in ('analysis', 'reuse', 'other')),
    day         date not null,
    seconds     integer not null default 0,

    updated_at  timestamptz not null default now(),

    unique (project_id, user_id, side, day)
);

create index if not exists work_time_day_idx
    on public.work_time (day);


-- -------------------------------------------------------------
-- 7. ガイドライン
-- -------------------------------------------------------------

create table if not exists public.guidelines (
    id          bigint generated always as identity primary key,

    text        text not null,
    source      text not null default '',
    seen        integer not null default 0,

    status      text not null default 'active'
                check (status in ('active', 'dropped')),

    sort_order  integer not null default 0,
    created_by  uuid references auth.users(id) on delete set null,
    created_at  timestamptz not null default now()
);

create unique index if not exists guidelines_text_key
    on public.guidelines (text) where status = 'active';


-- -------------------------------------------------------------
-- 8. 設定（目標値など）
-- -------------------------------------------------------------

create table if not exists public.settings (
    key         text primary key,
    value       text not null default '',
    updated_at  timestamptz not null default now()
);


-- -------------------------------------------------------------
-- 9. 更新日時を自動で入れる
-- -------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
    for each row execute function public.touch_updated_at();

drop trigger if exists screenshots_touch on public.screenshots;
create trigger screenshots_touch before update on public.screenshots
    for each row execute function public.touch_updated_at();


-- 行を直したら、その案件の更新日時も動かす
create or replace function public.touch_project_from_shot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.projects p
    set updated_at = now()
    from public.videos v
    where v.id = coalesce(new.video_id, old.video_id)
      and p.id = v.project_id;

    return coalesce(new, old);
end;
$$;

drop trigger if exists screenshots_touch_project on public.screenshots;
create trigger screenshots_touch_project
    after insert or update or delete on public.screenshots
    for each row execute function public.touch_project_from_shot();


-- -------------------------------------------------------------
-- 10. 誰が見られるか（Row Level Security）
--
--     数人のチームで、全員が全案件を見て直す運用なので、
--     「ログインしていれば読み書きできる」とする。
--     ログインしていない人は一切触れない。
-- -------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.projects       enable row level security;
alter table public.videos         enable row level security;
alter table public.screenshots    enable row level security;
alter table public.material_images enable row level security;
alter table public.work_time      enable row level security;
alter table public.guidelines     enable row level security;
alter table public.settings       enable row level security;

do $$
declare
    t text;
begin
    foreach t in array array[
        'profiles', 'projects', 'videos', 'screenshots',
        'material_images', 'work_time', 'guidelines', 'settings'
    ]
    loop
        execute format('drop policy if exists %I on public.%I',
                       t || '_rw', t);

        execute format(
            'create policy %I on public.%I
                 for all to authenticated
                 using (true) with check (true)',
            t || '_rw', t);
    end loop;
end;
$$;


-- -------------------------------------------------------------
-- 11. ファイルの置き場（Storage）
-- -------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('videos', 'videos', false),
       ('screenshots', 'screenshots', false),
       ('materials', 'materials', false)
on conflict (id) do nothing;

do $$
declare
    b text;
begin
    foreach b in array array['videos', 'screenshots', 'materials']
    loop
        execute format('drop policy if exists %I on storage.objects',
                       b || '_rw');

        execute format(
            'create policy %I on storage.objects
                 for all to authenticated
                 using (bucket_id = %L) with check (bucket_id = %L)',
            b || '_rw', b, b);
    end loop;
end;
$$;
