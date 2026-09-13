-- ============================================================================
-- Snapnote: WAITING ROOM + PROFILE PICTURES  (small update – safe to run more than once)
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- Run supabase/video-update.sql first if you haven't (video & voice).
-- Without this update the app keeps working: rooms just let anyone with the link straight in, and avatars show initials.
-- ============================================================================

-- profile pictures (the Google account photo) ---------------------------------
alter table public.profiles add column if not exists avatar_url text
  check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500));

create or replace function public.set_avatar_url(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare u text := nullif(left(trim(coalesce(p_url, '')), 500), '');
begin
  if u is not null and u !~ '^https://' then return; end if;
  update public.profiles set avatar_url = u where id = auth.uid();
end $$;

-- waiting room ----------------------------------------------------------------
alter table public.rooms add column if not exists require_approval boolean not null default true;

create table if not exists public.room_requests (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'denied')),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_requests_user_idx on public.room_requests(user_id);

create or replace function public.is_room_host(r uuid, u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms where id = r and host_id = u and expires_at > now());
$$;

create or replace function public.request_visible(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_requests q join public.rooms r on r.id = q.room_id
    where q.user_id = p and r.host_id = auth.uid() and r.expires_at > now()
  );
$$;

alter table public.room_requests enable row level security;

drop policy if exists room_requests_select on public.room_requests;
create policy room_requests_select on public.room_requests for select to authenticated
  using (user_id = auth.uid() or public.is_room_host(room_id, auth.uid()));

-- the host can read the profile of whoever is waiting for their room
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid()
  or exists (
    select 1 from public.friendships f
    where f.user_a = least(auth.uid(), profiles.id) and f.user_b = greatest(auth.uid(), profiles.id)
      and (f.status <> 'blocked' or f.blocked_by = auth.uid())
  )
  or public.share_room(auth.uid(), id)
  or public.request_visible(id)
);

revoke all on public.room_requests from anon, authenticated;
grant select on public.room_requests to authenticated;

-- "join_room" can no longer be used to skip the waiting room
create or replace function public.join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.rooms;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select * into r from public.rooms where code = lower(trim(p_code)) and expires_at > now();
  if not found then raise exception 'Room not found or it has ended'; end if;
  if not exists (select 1 from public.room_members where room_id = r.id and user_id = me) then
    if r.require_approval and r.host_id <> me then raise exception 'This room asks the host to let people in — use the waiting room'; end if;
    if (select count(*) from public.room_members where room_id = r.id) >= 8 then
      raise exception 'This room is full (8 people)';
    end if;
    insert into public.room_members (room_id, user_id) values (r.id, me);
  end if;
  return r.id;
end $$;

create or replace function public.enter_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.rooms; q public.room_requests; hname text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select * into r from public.rooms where code = lower(trim(p_code)) and expires_at > now();
  if not found then raise exception 'Room not found or it has ended'; end if;
  select display_name into hname from public.profiles where id = r.host_id;

  if exists (select 1 from public.room_members where room_id = r.id and user_id = me) then
    return jsonb_build_object('status', 'member', 'room_id', r.id, 'name', r.name, 'host_name', hname);
  end if;

  if r.host_id = me or not r.require_approval then
    if (select count(*) from public.room_members where room_id = r.id) >= 8 then raise exception 'This room is full (8 people)'; end if;
    insert into public.room_members (room_id, user_id) values (r.id, me) on conflict do nothing;
    delete from public.room_requests where room_id = r.id and user_id = me;
    return jsonb_build_object('status', 'member', 'room_id', r.id, 'name', r.name, 'host_name', hname);
  end if;

  select * into q from public.room_requests where room_id = r.id and user_id = me;
  if found then
    return jsonb_build_object('status', q.status, 'name', r.name, 'host_name', hname);
  end if;
  insert into public.room_requests (room_id, user_id) values (r.id, me);
  return jsonb_build_object('status', 'pending', 'name', r.name, 'host_name', hname);
end $$;

create or replace function public.admit_request(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_room_host(p_room, auth.uid()) then raise exception 'Only the host can do that'; end if;
  if not exists (select 1 from public.room_requests where room_id = p_room and user_id = p_user and status = 'pending') then
    raise exception 'No waiting request from that person';
  end if;
  if (select count(*) from public.room_members where room_id = p_room) >= 8 then raise exception 'This room is full (8 people)'; end if;
  insert into public.room_members (room_id, user_id) values (p_room, p_user) on conflict do nothing;
  delete from public.room_requests where room_id = p_room and user_id = p_user;
end $$;

create or replace function public.deny_request(p_room uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_room_host(p_room, auth.uid()) then raise exception 'Only the host can do that'; end if;
  update public.room_requests set status = 'denied' where room_id = p_room and user_id = p_user and status = 'pending';
end $$;

create or replace function public.cancel_join(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.room_requests
  where user_id = auth.uid() and room_id in (select id from public.rooms where code = lower(trim(p_code)));
end $$;

create or replace function public.set_room_approval(p_room uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_room_host(p_room, auth.uid()) then raise exception 'Only the host can do that'; end if;
  update public.rooms set require_approval = p_on where id = p_room;
  if not p_on then
    -- everyone already waiting is let in
    insert into public.room_members (room_id, user_id)
      select room_id, user_id from public.room_requests
      where room_id = p_room and status = 'pending'
        and (select count(*) from public.room_members where room_id = p_room) < 8
      limit greatest(0, 8 - (select count(*) from public.room_members where room_id = p_room))
    on conflict do nothing;
    delete from public.room_requests where room_id = p_room and status = 'pending'
      and user_id in (select user_id from public.room_members where room_id = p_room);
  end if;
end $$;

-- who may call what: signed-in users only
revoke all on function
  public.set_avatar_url(text), public.is_room_host(uuid, uuid), public.request_visible(uuid), public.join_room(text),
  public.enter_room(text), public.admit_request(uuid, uuid), public.deny_request(uuid, uuid),
  public.cancel_join(text), public.set_room_approval(uuid, boolean)
  from public, anon;
grant execute on function
  public.set_avatar_url(text), public.is_room_host(uuid, uuid), public.request_visible(uuid), public.join_room(text),
  public.enter_room(text), public.admit_request(uuid, uuid), public.deny_request(uuid, uuid),
  public.cancel_join(text), public.set_room_approval(uuid, boolean)
  to authenticated;

-- live updates for the host's "X wants to join" list
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.room_requests; exception when duplicate_object then null; end;
  end if;
end $$;

-- result: what is now installed
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'avatar_url') as avatar_column,
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'room_requests') as waiting_room_table,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('enter_room', 'admit_request', 'deny_request', 'cancel_join', 'set_room_approval', 'set_avatar_url')) as functions_installed_of_6;
