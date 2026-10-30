-- Snapnote: call a friend directly (rings on their phone). Safe to run more than once.
-- Run this in Supabase -> SQL Editor -> New query -> paste -> Run.

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  caller uuid not null references public.profiles(id) on delete cascade,
  callee uuid not null references public.profiles(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_code text not null,
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists calls_callee_idx on public.calls (callee, created_at desc);
create index if not exists calls_caller_idx on public.calls (caller, created_at desc);

alter table public.calls enable row level security;
grant select on public.calls to authenticated;
drop policy if exists calls_select on public.calls;
create policy calls_select on public.calls for select to authenticated
  using (caller = auth.uid() or callee = auth.uid());

-- ring a friend: creates a room, puts me in it, and makes their phone ring
create or replace function public.start_call(p_friend uuid)
returns public.calls language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.rooms; c public.calls;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_friend = me then raise exception 'You cannot call yourself'; end if;
  if not public.are_friends(me, p_friend) then raise exception 'You can only call friends'; end if;
  if exists (select 1 from public.calls where caller = me and callee = p_friend and status = 'ringing' and created_at > now() - interval '45 seconds') then
    raise exception 'Already ringing them';
  end if;
  update public.calls set status = 'cancelled' where caller = me and status = 'ringing';
  select * into r from public.create_room('Call');
  insert into public.calls (caller, callee, room_id, room_code) values (me, p_friend, r.id, r.code) returning * into c;
  return c;
end $$;

-- answer: I join the caller's room and get its code
create or replace function public.accept_call(p_call uuid)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); c public.calls;
begin
  select * into c from public.calls where id = p_call and callee = me;
  if not found then raise exception 'Call not found'; end if;
  if c.status = 'cancelled' or c.created_at < now() - interval '60 seconds' then raise exception 'They stopped calling'; end if;
  if not exists (select 1 from public.rooms where id = c.room_id and expires_at > now()) then raise exception 'The call has ended'; end if;
  insert into public.room_members (room_id, user_id) values (c.room_id, me) on conflict do nothing;
  update public.calls set status = 'accepted' where id = c.id;
  return c.room_code;
end $$;

create or replace function public.decline_call(p_call uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.calls set status = 'declined' where id = p_call and callee = auth.uid() and status = 'ringing';
end $$;

create or replace function public.cancel_call(p_call uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.calls set status = 'cancelled' where id = p_call and caller = auth.uid() and status = 'ringing';
end $$;

grant execute on function public.start_call(uuid), public.accept_call(uuid), public.decline_call(uuid), public.cancel_call(uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.calls; exception when duplicate_object then null; end;
  end if;
end $$;

-- tell the app this update is installed
create or replace function public.calling_ok() returns boolean language sql stable as $$ select true $$;
grant execute on function public.calling_ok() to authenticated;
