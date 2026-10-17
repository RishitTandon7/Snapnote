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
