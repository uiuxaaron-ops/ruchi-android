-- =====================================================================
-- Ruchi backend schema (Supabase / Postgres)
-- One table holds every app document, keyed by (collection, id), which
-- mirrors the app's existing data layer:
--   spots/{id}          a pinned place              (owner = who posted it)
--   reviews/{userId}    all reviews by one user     (id must be the user)
--   confirms/{userId}   "still open?" confirmations (id must be the user)
--   profiles/{userId}   nickname, avatar, home area (id must be the user)
--   experiments/{userId} A/B data                    (private to the user)
-- Photos live in the public "photos" storage bucket, never inside rows.
-- Safe to run more than once.
-- =====================================================================

create table if not exists public.docs (
  collection  text        not null check (collection in ('spots','reviews','confirms','profiles','experiments')),
  id          text        not null check (char_length(id) between 1 and 80),
  owner       uuid        default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb check (octet_length(data::text) < 200000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_owner_idx on public.docs (owner);
create index if not exists docs_updated_idx on public.docs (collection, updated_at desc);

create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.owner := old.owner; new.created_at := old.created_at; end if; -- owner can't be changed
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

alter table public.docs enable row level security;

drop policy if exists "docs read"   on public.docs;
drop policy if exists "docs insert" on public.docs;
drop policy if exists "docs update" on public.docs;
drop policy if exists "docs delete" on public.docs;

-- Everyone using the app can read the map; experiments stay private.
create policy "docs read" on public.docs for select to anon, authenticated
  using (collection <> 'experiments' or owner = auth.uid());

-- Signed-in users write only their own documents.
create policy "docs insert" on public.docs for insert to authenticated
  with check (
    owner = auth.uid()
    and (
      (collection = 'spots' and data->>'by' = auth.uid()::text)
      or (collection <> 'spots' and id = auth.uid()::text)
    )
  );
create policy "docs update" on public.docs for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid() and (collection <> 'spots' or data->>'by' = auth.uid()::text));
create policy "docs delete" on public.docs for delete to authenticated
  using (owner = auth.uid());

-- Live updates to every phone.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- ---------------- photo storage ----------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "photos upload own"  on storage.objects;
drop policy if exists "photos delete own"  on storage.objects;
-- Files go in a folder named after the uploader: photos/<userId>/<file>.jpg
create policy "photos upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and owner = auth.uid());
