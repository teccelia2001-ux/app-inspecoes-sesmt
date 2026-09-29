-- Adiciona o campo opcional "número da obra", usado pelas equipes
-- DCMD C&M e DCMD LINHA VIVA. Rode no SQL Editor do Supabase.

alter table sesmt_inspecoes
  add column if not exists numero_obra text;
