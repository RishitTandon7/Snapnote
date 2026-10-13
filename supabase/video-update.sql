-- ============================================================================
-- Snapnote: VIDEO & VOICE in rooms  (small update – safe to run more than once)
-- Supabase Dashboard → SQL Editor → New query → paste this whole file → Run.
-- At the end it lists the rules it installed: you should see snap_room_receive and snap_room_send.
-- ============================================================================

-- helpers the rules use
create or replace function public.safe_uuid(t text)
returns uuid language plpgsql immutable as $$
begin return t::uuid; exception when others then return null; end $$;

create or replace function public.in_room(r uuid, u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.room_members m join public.rooms x on x.id = m.room_id
    where m.room_id = r and m.user_id = u and x.expires_at > now()
  );
$$;

-- who may use a room's call channel (room:<roomId>): members of that room, to listen and to send
drop policy if exists snap_room_receive on realtime.messages;
create policy snap_room_receive on realtime.messages for select to authenticated using (
  realtime.messages.extension = 'broadcast'
  and realtime.topic() like 'room:%'
  and public.in_room(public.safe_uuid(substr(realtime.topic(), 6)), auth.uid())
);

drop policy if exists snap_room_send on realtime.messages;
create policy snap_room_send on realtime.messages for insert to authenticated with check (
  realtime.messages.extension = 'broadcast'
  and realtime.topic() like 'room:%'
  and public.in_room(public.safe_uuid(substr(realtime.topic(), 6)), auth.uid())
);

-- lets the app tell whether the rules are installed
create or replace function public.realtime_setup_ok()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'capture', (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('snap_cap_receive', 'snap_cap_send')),
    'room',    (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname in ('snap_room_receive', 'snap_room_send'))
  );
$$;

-- signed-in users may call them (the app does); nobody else
revoke all on function public.safe_uuid(text), public.in_room(uuid, uuid), public.realtime_setup_ok() from public, anon;
grant execute on function public.safe_uuid(text), public.in_room(uuid, uuid), public.realtime_setup_ok() to authenticated;

-- result: the realtime rules now installed
select policyname, cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages' order by 1;
