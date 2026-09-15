-- Page Setup for the Dokumen layout editor — paper size and the four margins,
-- same idea as Word's Page Setup dialog. Margins are whole millimetres (an
-- `integer`, not `numeric`) specifically to dodge the numeric-as-string
-- quirks this codebase has seen between postgres-js and PGlite; sub-mm
-- precision buys nothing for a document like this anyway.
alter table documents
  add column if not exists page_size text not null default 'a4'
    check (page_size in ('a4', 'letter', 'legal', 'f4')),
  add column if not exists margin_top_mm integer not null default 25,
  add column if not exists margin_right_mm integer not null default 25,
  add column if not exists margin_bottom_mm integer not null default 25,
  add column if not exists margin_left_mm integer not null default 25;
