-- =============================================================
--  修正版とセルの結合
--
--  Supabase の SQL Editor に貼り付けて実行してください。
--  何度実行しても同じ結果になるよう書いてあります。
--
--  ・修正版でだけ使う「修正後フィードバックメモ」の欄を足す
--  ・結合したセルを覚えておく表を足す
-- =============================================================


-- -------------------------------------------------------------
-- 1. 修正後フィードバックメモ
--
--    初稿には出さず、修正版の表にだけ右端の列として出る。
-- -------------------------------------------------------------

alter table public.screenshots
    add column if not exists revised_feedback text not null default '';


-- -------------------------------------------------------------
-- 2. 結合したセル
--
--    まとめた左上のセル（shot_id と field）を覚えておき、
--    そこから何行ぶん・何列ぶん広がるかを持つ。
--
--    画面には全部のセルを出したうえで、覆われたセルを隠して見せている。
--    こうしておくと、行を足したり並べ替えたりしても組み直せる。
-- -------------------------------------------------------------

create table if not exists public.cell_merges (
    id         bigint generated always as identity primary key,

    video_id   bigint not null references public.videos(id) on delete cascade,
    shot_id    bigint not null references public.screenshots(id) on delete cascade,

    field      text    not null,
    row_span   integer not null default 1,
    col_span   integer not null default 1,

    created_at timestamptz not null default now()
);

create index if not exists cell_merges_video_idx
    on public.cell_merges (video_id);

create unique index if not exists cell_merges_cell_key
    on public.cell_merges (shot_id, field);


-- -------------------------------------------------------------
-- 3. 権限
--
--    003_members_only.sql を流していれば、そちらと同じ
--    「承認された人だけ」に合わせる。
--    まだなら、ほかの表と同じ「ログインしていれば読み書きできる」にする。
-- -------------------------------------------------------------

alter table public.cell_merges enable row level security;

drop policy if exists cell_merges_rw on public.cell_merges;

do $$
begin
    if exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'is_member'
    ) then

        execute 'create policy cell_merges_rw on public.cell_merges
                     for all to authenticated
                     using (public.is_member()) with check (public.is_member())';

    else

        execute 'create policy cell_merges_rw on public.cell_merges
                     for all to authenticated
                     using (true) with check (true)';

    end if;
end;
$$;


-- -------------------------------------------------------------
-- 4. 確認
-- -------------------------------------------------------------

select
    (select count(*) from information_schema.columns
      where table_name = 'screenshots' and column_name = 'revised_feedback')
        as 修正後フィードバックの列,
    (select count(*) from information_schema.tables
      where table_name = 'cell_merges') as 結合の表;
