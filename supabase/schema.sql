-- ============================================================================
-- Snapnote – Supabase schema (free plan friendly)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run.
-- All writes that need cross-user checks go through SECURITY DEFINER functions
-- (RPC); tables have no direct insert policies where that would be unsafe.
-- ============================================================================

-- ───────── profiles ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z][a-z0-9_]{2,19}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_color text not null check (char_length(avatar_color) <= 16),
  friend_code text not null unique check (friend_code ~ '^[A-Z0-9]{2,4}-[0-9]{4}$'),
  created_at timestamptz not null default now()
);
-- the Google account's profile picture (others see it as your avatar); null = show your initial
alter table public.profiles add column if not exists avatar_url text
  check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500));

-- ───────── friendships (ordered pair: user_a < user_b) ─────────
create table if not exists public.friendships (
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  requester uuid not null,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  blocked_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

-- ───────── devices ─────────
create table if not exists public.devices (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  is_display boolean not null default false,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists devices_user_idx on public.devices(user_id);

-- per-friend permission: this friend may show text on this device
create table if not exists public.device_allowed (
  device_id uuid not null references public.devices(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (device_id, friend_id)
);
create index if not exists device_allowed_friend_idx on public.device_allowed(friend_id);

-- ───────── messages ─────────
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles(id) on delete cascade,
  from_name text not null default '',
  from_device uuid,
  to_user uuid not null references public.profiles(id) on delete cascade,
  to_device uuid not null references public.devices(id) on delete cascade,
  type text not null check (type in ('text', 'clear', 'capture', 'photo')),
  body text not null default '' check (char_length(body) <= 500),
  image_data_url text not null default '' check (char_length(image_data_url) <= 760000),
  reply_to uuid,
  live boolean not null default false,
  created_at timestamptz not null default now(),
  expire_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists messages_to_device_idx on public.messages(to_device, created_at);
create index if not exists messages_expire_idx on public.messages(expire_at);
-- one reusable "show as I type" row per (sender, target device)
create unique index if not exists messages_live_uniq on public.messages(from_user, to_device) where live;

-- ───────── rooms (Meet-style: create → share link → join) ─────────
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z]{3}-[a-z]{4}-[a-z]{3}$'),
  name text not null default 'Room' check (char_length(name) between 1 and 40),
  host_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours')
);
create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members(user_id);
-- a device that a member has put "on screen" in a room (consents to receive from room members)
create table if not exists public.room_devices (
  room_id uuid not null references public.rooms(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (room_id, device_id)
);

-- waiting room: people who opened the link wait here until the host admits them
alter table public.rooms add column if not exists require_approval boolean not null default true;
create table if not exists public.room_requests (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'denied')),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_requests_user_idx on public.room_requests(user_id);

-- ============================================================================
-- helpers
-- ============================================================================
create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships
    where user_a = least(a, b) and user_b = greatest(a, b) and status = 'accepted'
  );
$$;

create or replace function public.owns_device(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices where id = d and user_id = auth.uid());
$$;

create or replace function public.in_room(r uuid, u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m join public.rooms x on x.id = m.room_id
    where m.room_id = r and m.user_id = u and x.expires_at > now()
  );
$$;

create or replace function public.share_room(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m1
    join public.room_members m2 on m2.room_id = m1.room_id
    join public.rooms x on x.id = m1.room_id
    where m1.user_id = a and m2.user_id = b and x.expires_at > now()
  );
$$;

-- is this device on screen in a room that `viewer` is also in?
create or replace function public.room_device_visible(d uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_devices rd
    where rd.device_id = d and public.in_room(rd.room_id, viewer)
  );
$$;

-- may `me` push content onto (to_user, to_device)?  owner | allowed friend | roommate with the device on screen
create or replace function public.can_target(me uuid, to_user uuid, to_device uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices d where d.id = to_device and d.user_id = to_user)
     and (
       to_user = me
       or (public.are_friends(me, to_user)
           and exists (select 1 from public.device_allowed a
                       where a.device_id = to_device and a.friend_id = me and a.owner_id = to_user))
       or (public.share_room(me, to_user)
           and exists (select 1 from public.room_devices rd
                       where rd.device_id = to_device and rd.user_id = to_user and public.in_room(rd.room_id, me)))
     );
$$;

create or replace function public.resolve_user(q text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.profiles
  where case
    when upper(trim(q)) ~ '^[A-Z0-9]{2,4}-[0-9]{4}$' then friend_code = upper(trim(q))
    else username = lower(regexp_replace(trim(q), '^@', ''))
  end
  limit 1;
$$;

-- ───────── remote-capture helpers (Realtime Broadcast + Storage) ─────────
create or replace function public.safe_uuid(t text)
returns uuid language plpgsql immutable as $$
begin return t::uuid; exception when others then return null; end $$;

-- may I (the controller) broadcast a capture request to device d?  Same rule as sending text.
create or replace function public.can_send_to_device(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices x where x.id = d and public.can_target(auth.uid(), x.user_id, x.id));
$$;

-- may I (the photographer) answer `controller`?  Only if they could have targeted one of my devices.
create or replace function public.can_reply_to_user(controller uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select controller is not null and exists (
    select 1 from public.devices m
    where m.user_id = auth.uid() and public.can_target(controller, auth.uid(), m.id)
  );
$$;

-- same, addressed by the controller's device id (for the result channel)
create or replace function public.can_reply_to_device(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.devices c where c.id = d and public.can_reply_to_user(c.user_id));
$$;

-- ───────── waiting-room helpers ─────────
create or replace function public.is_room_host(r uuid, u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms where id = r and host_id = u and expires_at > now());
$$;

-- may I see this person's profile because they are waiting to join one of MY rooms?
create or replace function public.request_visible(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_requests q join public.rooms r on r.id = q.room_id
    where q.user_id = p and r.host_id = auth.uid() and r.expires_at > now()
  );
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.devices enable row level security;
alter table public.device_allowed enable row level security;
alter table public.messages enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_devices enable row level security;
alter table public.room_requests enable row level security;

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
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships for select to authenticated using (
  auth.uid() in (user_a, user_b) and (status <> 'blocked' or blocked_by = auth.uid())
);

drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select to authenticated using (
  user_id = auth.uid()
  or (exists (select 1 from public.device_allowed a where a.device_id = devices.id and a.friend_id = auth.uid())
      and public.are_friends(auth.uid(), user_id))
  or public.room_device_visible(id, auth.uid())
);
drop policy if exists devices_insert on public.devices;
create policy devices_insert on public.devices for insert to authenticated with check (user_id = auth.uid());
drop policy if exists devices_update on public.devices;
create policy devices_update on public.devices for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists devices_delete on public.devices;
create policy devices_delete on public.devices for delete to authenticated using (user_id = auth.uid());

drop policy if exists allowed_select on public.device_allowed;
create policy allowed_select on public.device_allowed for select to authenticated
  using (owner_id = auth.uid() or friend_id = auth.uid());
drop policy if exists allowed_insert on public.device_allowed;
create policy allowed_insert on public.device_allowed for insert to authenticated with check (
  owner_id = auth.uid() and public.owns_device(device_id) and public.are_friends(owner_id, friend_id)
);
drop policy if exists allowed_delete on public.device_allowed;
create policy allowed_delete on public.device_allowed for delete to authenticated using (owner_id = auth.uid());

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (from_user = auth.uid() or to_user = auth.uid());


drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated using (public.in_room(id, auth.uid()));
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members for select to authenticated using (public.in_room(room_id, auth.uid()));
drop policy if exists room_devices_select on public.room_devices;
create policy room_devices_select on public.room_devices for select to authenticated using (public.in_room(room_id, auth.uid()));

drop policy if exists room_requests_select on public.room_requests;
create policy room_requests_select on public.room_requests for select to authenticated
  using (user_id = auth.uid() or public.is_room_host(room_id, auth.uid()));

-- table privileges: deny by default, grant only what the policies allow
revoke all on public.profiles, public.friendships, public.devices, public.device_allowed, public.messages, public.rooms, public.room_members, public.room_devices, public.room_requests from anon, authenticated;
grant select on public.profiles, public.friendships, public.devices, public.device_allowed, public.messages, public.rooms, public.room_members, public.room_devices, public.room_requests to authenticated;
grant update (display_name, avatar_color) on public.profiles to authenticated;          -- username / friend_code immutable
grant insert on public.devices to authenticated;
grant update (name, is_display) on public.devices to authenticated;
grant delete on public.devices, public.device_allowed, public.messages, public.rooms, public.room_members, public.room_devices to authenticated;
grant insert on public.device_allowed to authenticated;
grant usage on schema public to anon, authenticated;

-- ============================================================================
-- RPCs
-- ============================================================================
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(trim(p_username)));
$$;

create or replace function public.create_profile(p_username text, p_display_name text, p_color text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  u text := lower(trim(p_username));
  prefix text;
  code text;
  r public.profiles;
  i int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from public.profiles where id = me) then raise exception 'Profile already exists'; end if;
  if u !~ '^[a-z][a-z0-9_]{2,19}$' then raise exception 'Username: 3–20 chars, start with a letter, a–z 0–9 _'; end if;
  if char_length(trim(coalesce(p_display_name, ''))) = 0 then raise exception 'Enter a display name'; end if;
  if exists (select 1 from public.profiles where username = u) then raise exception 'That username is taken'; end if;
  prefix := upper(left(regexp_replace(u, '[^a-z0-9]', '', 'g'), 4));
  if char_length(prefix) < 2 then prefix := rpad(prefix, 2, 'X'); end if;
  for i in 1..10 loop
    code := prefix || '-' || lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into public.profiles (id, username, display_name, avatar_color, friend_code)
      values (me, u, left(trim(p_display_name), 40), left(coalesce(p_color, '#7c5cff'), 16), code)
      returning * into r;
      return r;
    exception when unique_violation then
      if exists (select 1 from public.profiles where username = u) then raise exception 'That username is taken'; end if;
    end;
  end loop;
  raise exception 'Could not allocate a friend code, please try again';
end $$;

create or replace function public.add_friend(q text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; f public.friendships;
begin
  if me is null then raise exception 'Not signed in'; end if;
  other := public.resolve_user(q);
  if other is null then raise exception 'No one found with that username or code'; end if;
  if other = me then raise exception 'That''s you 🙂'; end if;
  select * into f from public.friendships where user_a = least(me, other) and user_b = greatest(me, other);
  if found then
    if f.status = 'accepted' then return 'You are already friends'; end if;
    if f.status = 'blocked' then
      if f.blocked_by = me then raise exception 'You blocked this user — unblock them in Settings first'; end if;
      raise exception 'You can''t add this user';
    end if;
    if f.requester = me then return 'Request already sent'; end if;
    update public.friendships set status = 'accepted' where user_a = f.user_a and user_b = f.user_b;
    return 'You are now friends!';
  end if;
  insert into public.friendships (user_a, user_b, requester, status)
  values (least(me, other), greatest(me, other), me, 'pending');
  return 'Friend request sent';
end $$;

create or replace function public.accept_friend(other uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.friendships set status = 'accepted'
  where user_a = least(auth.uid(), other) and user_b = greatest(auth.uid(), other)
    and status = 'pending' and requester <> auth.uid();
  if not found then raise exception 'No pending request to accept'; end if;
end $$;

-- remove friend / decline / cancel request / unblock
create or replace function public.remove_friend(other uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  delete from public.device_allowed where owner_id = me and friend_id = other;
  delete from public.friendships
  where user_a = least(me, other) and user_b = greatest(me, other)
    and (status <> 'blocked' or blocked_by = me);  -- a blocked user can't lift the block
end $$;

create or replace function public.block_user(other uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if other = me then raise exception 'Nope'; end if;
  if not exists (select 1 from public.profiles where id = other) then raise exception 'Unknown user'; end if;
  delete from public.device_allowed where owner_id = me and friend_id = other;
  insert into public.friendships (user_a, user_b, requester, status, blocked_by)
  values (least(me, other), greatest(me, other), me, 'blocked', me)
  on conflict (user_a, user_b) do update set status = 'blocked', blocked_by = me;
end $$;

-- heartbeat: server clock; returns false if the device was removed elsewhere
create or replace function public.touch_device(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.devices set last_seen = now() where id = p_id and user_id = auth.uid();
  return found;
end $$;

-- text / clear / capture  (client throttle is 5/s; server enforces the same)
create or replace function public.send_message(
  p_to_user uuid, p_to_device uuid, p_from_device uuid, p_type text, p_body text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nm text; new_id uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_type not in ('text', 'clear', 'capture') then raise exception 'Bad message type'; end if;
  if char_length(coalesce(p_body, '')) > 500 then raise exception 'Message too long (max 500)'; end if;
  if not public.can_target(me, p_to_user, p_to_device) then
    raise exception 'Not allowed to send to that device';
  end if;
  if (select count(*) from public.messages where from_user = me and created_at > now() - interval '1 second') >= 5 then
    raise exception 'Slow down — max 5 messages per second';
  end if;
  select display_name into nm from public.profiles where id = me;
  insert into public.messages (from_user, from_name, from_device, to_user, to_device, type, body)
  values (me, coalesce(nm, ''), p_from_device, p_to_user, p_to_device, p_type, coalesce(p_body, ''))
  returning id into new_id;
  return new_id;
end $$;

-- "show as I type": overwrite a single row instead of creating many
create or replace function public.send_live(
  p_to_user uuid, p_to_device uuid, p_from_device uuid, p_body text
) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nm text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if char_length(coalesce(p_body, '')) > 500 then raise exception 'Message too long (max 500)'; end if;
  if not public.can_target(me, p_to_user, p_to_device) then
    raise exception 'Not allowed to send to that device';
  end if;
  select display_name into nm from public.profiles where id = me;
  insert into public.messages (from_user, from_name, from_device, to_user, to_device, type, body, live)
  values (me, coalesce(nm, ''), p_from_device, p_to_user, p_to_device, 'text', coalesce(p_body, ''), true)
  on conflict (from_user, to_device) where live
  do update set body = excluded.body, from_name = excluded.from_name, from_device = excluded.from_device,
                created_at = now(), expire_at = now() + interval '24 hours';
end $$;

-- photo goes back only as a reply to a capture request addressed to the photographer
create or replace function public.send_photo(
  p_to_user uuid, p_to_device uuid, p_from_device uuid, p_reply_to uuid, p_body text, p_image text
) returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nm text; new_id uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if p_image is null or p_image !~ '^data:image/jpeg;base64,' or char_length(p_image) > 760000 then
    raise exception 'Invalid or too large photo';
  end if;
  if not exists (
    select 1 from public.messages c
    where c.id = p_reply_to and c.type = 'capture' and c.to_user = me
      and c.from_user = p_to_user and c.from_device = p_to_device
  ) then raise exception 'No capture request to answer'; end if;
  if p_to_user <> me and not public.are_friends(me, p_to_user) and not public.share_room(me, p_to_user) then
    raise exception 'Not friends or in the same room';
  end if;
  if not exists (select 1 from public.devices where id = p_to_device and user_id = p_to_user) then
    raise exception 'Unknown device';
  end if;
  select display_name into nm from public.profiles where id = me;
  insert into public.messages (from_user, from_name, from_device, to_user, to_device, type, body, image_data_url, reply_to)
  values (me, coalesce(nm, ''), p_from_device, p_to_user, p_to_device, 'photo', left(coalesce(p_body, ''), 500), p_image, p_reply_to)
  returning id into new_id;
  return new_id;
end $$;

-- ───────── room RPCs ─────────
create or replace function public.create_room(p_name text default 'Room')
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.rooms; c text; i int;
        n text := left(trim(coalesce(nullif(trim(p_name), ''), 'Room')), 40);
begin
  if me is null then raise exception 'Not signed in'; end if;
  if (select count(*) from public.rooms where host_id = me and expires_at > now()) >= 5 then
    raise exception 'You already have 5 active rooms — end one first';
  end if;
  for i in 1..10 loop
    c := (select string_agg(chr(97 + floor(random() * 26)::int), '') from generate_series(1, 3)) || '-' ||
         (select string_agg(chr(97 + floor(random() * 26)::int), '') from generate_series(1, 4)) || '-' ||
         (select string_agg(chr(97 + floor(random() * 26)::int), '') from generate_series(1, 3));
    begin
      insert into public.rooms (code, name, host_id) values (c, n, me) returning * into r;
      insert into public.room_members (room_id, user_id) values (r.id, me);
      return r;
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'Could not create room, try again';
end $$;

-- join by code (idempotent). Returns the room id. Max 8 people.
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

-- leave; if the host leaves, the room ends for everyone
create or replace function public.leave_room(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if exists (select 1 from public.rooms where id = p_room and host_id = me) then
    delete from public.rooms where id = p_room;
  else
    delete from public.room_devices where room_id = p_room and user_id = me;
    delete from public.room_members where room_id = p_room and user_id = me;
  end if;
end $$;

-- put one of my devices on screen in a room (members may then send to it) / take it off
create or replace function public.set_room_device(p_room uuid, p_device uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not public.in_room(p_room, me) then raise exception 'You are not in this room'; end if;
  if not exists (select 1 from public.devices where id = p_device and user_id = me) then raise exception 'Not your device'; end if;
  if p_on then
    update public.devices set is_display = true where id = p_device;
    insert into public.room_devices (room_id, device_id, user_id) values (p_room, p_device, me) on conflict do nothing;
  else
    delete from public.room_devices where room_id = p_room and device_id = p_device;
  end if;
end $$;

-- ============================================================================
-- Remote capture: private Realtime Broadcast channels + private Storage bucket
--   cap:<viewerDeviceId>   controller → viewer   "take a photo now"
--   res:<controllerDevice> viewer → controller   "preview" (small) + "full" (storage path)
--   storage: captures/<viewerUid>/<controllerUid>_<captureId>.jpg
-- Skipped automatically where the realtime / storage schemas don't exist.
-- ============================================================================
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists snap_cap_receive on realtime.messages';
    execute 'drop policy if exists snap_cap_send on realtime.messages';
    execute 'drop policy if exists snap_room_receive on realtime.messages';
    execute 'drop policy if exists snap_room_send on realtime.messages';
    -- receive: only the owner of the device the topic names
    execute $p$
      create policy snap_cap_receive on realtime.messages for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and (realtime.topic() like 'cap:%' or realtime.topic() like 'res:%')
        and public.owns_device(public.safe_uuid(substr(realtime.topic(), 5)))
      )
    $p$;
    -- send: cap → anyone allowed to target that device; res → anyone the controller could have targeted
    execute $p$
      create policy snap_cap_send on realtime.messages for insert to authenticated with check (
        realtime.messages.extension = 'broadcast'
        and (
          (realtime.topic() like 'cap:%' and public.can_send_to_device(public.safe_uuid(substr(realtime.topic(), 5))))
          or (realtime.topic() like 'res:%' and public.can_reply_to_device(public.safe_uuid(substr(realtime.topic(), 5))))
        )
      )
    $p$;
    -- room:<roomId> = the call's signalling channel (WebRTC offers / answers / ICE, "camera on" flags).
    -- Every member of that (active) room may listen AND send; nobody else can even join it.
    execute $p$
      create policy snap_room_receive on realtime.messages for select to authenticated using (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() like 'room:%'
        and public.in_room(public.safe_uuid(substr(realtime.topic(), 6)), auth.uid())
      )
    $p$;
    execute $p$
      create policy snap_room_send on realtime.messages for insert to authenticated with check (
        realtime.messages.extension = 'broadcast'
        and realtime.topic() like 'room:%'
        and public.in_room(public.safe_uuid(substr(realtime.topic(), 6)), auth.uid())
      )
    $p$;
  end if;
end $$;

do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('captures', 'captures', false, 20971520, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists snap_cap_obj_insert on storage.objects';
    execute 'drop policy if exists snap_cap_obj_select on storage.objects';
    execute 'drop policy if exists snap_cap_obj_delete on storage.objects';
    -- photographer uploads into their own folder, naming a controller who may receive it
    execute $p$
      create policy snap_cap_obj_insert on storage.objects for insert to authenticated with check (
        bucket_id = 'captures'
        and (storage.foldername(name))[1] = auth.uid()::text
        and public.can_reply_to_user(public.safe_uuid(split_part(split_part(name, '/', 2), '_', 1)))
      )
    $p$;
    -- photographer and the named controller can read / delete (delete = "receipt confirmed" cleanup)
    execute $p$
      create policy snap_cap_obj_select on storage.objects for select to authenticated using (
        bucket_id = 'captures'
        and ((storage.foldername(name))[1] = auth.uid()::text
             or split_part(split_part(name, '/', 2), '_', 1) = auth.uid()::text)
      )
    $p$;
    execute $p$
      create policy snap_cap_obj_delete on storage.objects for delete to authenticated using (
        bucket_id = 'captures'
        and ((storage.foldername(name))[1] = auth.uid()::text
             or split_part(split_part(name, '/', 2), '_', 1) = auth.uid()::text)
      )
    $p$;
  end if;
end $$;

-- lets the app tell "the realtime rules were never installed" apart from other failures
create or replace function public.realtime_setup_ok()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'capture', (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('snap_cap_receive', 'snap_cap_send')),
    'room',    (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('snap_room_receive', 'snap_room_send'))
  );
$$;

-- ───────── waiting room RPCs ─────────
-- Open a room link. Returns {status: member | pending | denied, room_id (members only), name, host_name}.
-- member = you are in (host, already a member, or the room lets anyone in); pending = waiting for the host.
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

-- withdraw my own request (leaving the waiting room)
create or replace function public.cancel_join(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.room_requests
  where user_id = auth.uid() and room_id in (select id from public.rooms where code = lower(trim(p_code)));
end $$;

-- host: ask people to wait (true) or let anyone in straight away (false)
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

-- save (or clear) my profile picture URL; only https links are accepted
create or replace function public.set_avatar_url(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare u text := nullif(left(trim(coalesce(p_url, '')), 500), '');
begin
  if u is not null and u !~ '^https://' then return; end if;
  update public.profiles set avatar_url = u where id = auth.uid();
end $$;

-- RPC execute rights: signed-in users only
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $$;

-- ============================================================================
-- Realtime + 24h cleanup (TTL equivalent)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.devices; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.friendships; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.device_allowed; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_devices; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_requests; exception when duplicate_object then null; end;
  end if;
end $$;

-- delete expired messages every 15 min (needs the pg_cron extension; skipped if unavailable)
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('snapnote-cleanup', '*/15 * * * *', $job$delete from public.messages where expire_at < now(); delete from public.rooms where expires_at < now() - interval '1 day'$job$);
exception when others then
  raise notice 'pg_cron not available (%). Enable it under Database → Extensions, then re-run this script.', sqlerrm;
end $$;

-- ───── calling a friend (also available as supabase/update-calling.sql) ─────
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

-- ───── push notifications for calls (also available as supabase/update-push.sql) ─────
-- Snapnote: phone rings even when the app is closed (web push). Safe to run more than once.
-- Run this in Supabase -> SQL Editor -> New query -> paste -> Run.  (Run update-calling.sql first.)

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
grant select, delete on public.push_subscriptions to authenticated;
drop policy if exists push_own_select on public.push_subscriptions;
create policy push_own_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- this phone wants to be notified (called again whenever the browser renews the subscription)
create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'Bad subscription'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values (p_endpoint, me, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = me, p256dh = excluded.p256dh, auth = excluded.auth;
  -- keep it small: at most 5 phones/browsers per person
  delete from public.push_subscriptions where user_id = me and endpoint not in (
    select endpoint from public.push_subscriptions where user_id = me order by created_at desc limit 5);
end $$;

create or replace function public.remove_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

-- who should be notified about MY call that is ringing right now (only the caller can ask, only for the callee)
create or replace function public.call_push_targets(p_call uuid)
returns table (endpoint text, p256dh text, auth text, caller_name text, room_code text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  select s.endpoint, s.p256dh, s.auth, p.display_name, c.room_code
  from public.calls c
  join public.push_subscriptions s on s.user_id = c.callee
  join public.profiles p on p.id = c.caller
  where c.id = p_call and c.caller = auth.uid() and c.status = 'ringing' and c.created_at > now() - interval '60 seconds';
end $$;

grant execute on function public.save_push(text, text, text), public.remove_push(text), public.call_push_targets(uuid) to authenticated;

-- can I make this friend's phone ring while their app is closed? (true if they turned on call notifications on any phone)
create or replace function public.friend_can_ring(p_friend uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.are_friends(auth.uid(), p_friend) and exists (select 1 from public.push_subscriptions where user_id = p_friend);
$$;
grant execute on function public.friend_can_ring(uuid) to authenticated;

create or replace function public.push_ok() returns boolean language sql stable as $$ select true $$;
grant execute on function public.push_ok() to authenticated;
