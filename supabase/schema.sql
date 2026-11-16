-- Retain database. Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Every table is locked to its owner with row level security, so a student can only ever
-- read or change their own rows, even though the browser talks to the database directly.

create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per tutor conversation or lesson (the Notebook).
create table if not exists public.history (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  at bigint not null,
  data jsonb not null,
  primary key (user_id, id)
);
create index if not exists history_user_at on public.history (user_id, at desc);

-- Tutor requests per student per day, for the daily limit.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.history enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own history" on public.history;
create policy "own history" on public.history for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Students can see their own usage but only the function below can change it.
drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage for select to authenticated
  using (user_id = auth.uid());

create or replace function public.bump_ai_usage() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.ai_usage (user_id, day, count) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into n;
  return n;
end $$;

revoke all on function public.bump_ai_usage() from public, anon;
grant execute on function public.bump_ai_usage() to authenticated;
