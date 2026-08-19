-- =============================================================
--  コピーで増えた案件を1件として数えるための追加
--
--  Supabase の SQL Editor に貼り付けて実行してください。
--  何度実行しても同じ結果になります。
--
--  共通ノートは「複数の案件で同じことを言われている」ものを探す機能です。
--  「コピーを作成」で増えた案件は中身が同じなので、そのまま数えると
--  1件の指摘が何件にも水増しされてしまいます。
--  元をたどれるようにして、コピーどうしは1件として扱います。
-- =============================================================

alter table public.projects
    add column if not exists copied_from bigint
    references public.projects(id) on delete set null;


-- いまある案件のうち、コピーで作られたものに元を記録する

update public.projects c
set copied_from = r.id
from public.projects r
where c.slug = 'seappu2' and r.slug = 'seappu1';

update public.projects c
set copied_from = r.id
from public.projects r
where c.slug = 'seappu3' and r.slug = 'seappu1';


-- 確認用
select id, name, slug, copied_from from public.projects order by id;
