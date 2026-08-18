/* ============================================================
   つなぎ先の設定

   ここに書く anon キーは「公開してよい鍵」。
   誰が何を見られるかは Supabase 側の権限設定（RLS）で決めており、
   ログインしていない人はこの鍵を持っていても何も読めない。
   秘密の鍵（service_role）は絶対にここへ書かないこと。
   ============================================================ */

window.APP_CONFIG = {
  supabaseUrl: 'https://czjdbrljxaesqhlpljjf.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6amRicmxqeGFlc3FobHBsampmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMjczNTQsImV4cCI6MjEwMjYwMzM1NH0.5Yn8LncChKGUtwXjnFEtJaXIGlc9DlvlWmut0452Rxo',
};
