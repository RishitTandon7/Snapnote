import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

// Real Postgres (WASM) + a minimal stub of Supabase's `auth` schema, then the real schema.sql.
const db = new PGlite()
const U = {
  alice: '00000000-0000-4000-8000-00000000000a',
  bob: '00000000-0000-4000-8000-00000000000b',
  carol: '00000000-0000-4000-8000-00000000000c',
}
const DEV = {
  alice: '10000000-0000-4000-8000-00000000000a',
  bob: '10000000-0000-4000-8000-00000000000b',
  carol: '10000000-0000-4000-8000-00000000000c',
}
const JPEG = 'data:image/jpeg;base64,AAAA'

/** run a statement as an authenticated Supabase user (RLS + grants apply) */
async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`)
  try {
    return (await db.query<T>(sql, params)).rows
  } finally {
    await db.exec('reset role')
  }
}
const fails = async (uid: string, sql: string, params: unknown[] = [], re?: RegExp) => {
  let err: unknown
  try { await as(uid, sql, params) } catch (e) { err = e }
  expect(err, `expected failure: ${sql}`).toBeDefined()
  if (re) expect(String((err as Error).message)).toMatch(re)
}

const send = (uid: string, toUser: string, toDev: string, fromDev: string, type: string, body = '') =>
  as<{ send_message: string }>(uid, 'select send_message($1,$2,$3,$4,$5)', [toUser, toDev, fromDev, type, body])

async function reset() {
  await db.exec('truncate public.messages, public.device_allowed, public.devices, public.friendships, public.profiles, auth.users cascade;')
  for (const [n, id] of Object.entries(U)) await db.query('insert into auth.users(id) values ($1)', [id]).then(async () => {
    await as(id, 'select create_profile($1,$2,$3)', [n, n.toUpperCase(), '#7c5cff'])
  })
  for (const n of ['alice', 'bob', 'carol'] as const) {
    await as(U[n], 'insert into devices(id,user_id,name,is_display) values ($1,$2,$3,true)', [DEV[n], U[n], `${n} phone`])
  }
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create publication supabase_realtime;

    -- stand-ins for Supabase's realtime + storage schemas (so the capture policies get created and tested)
    create schema realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, payload jsonb);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as
      $$ select nullif(current_setting('realtime.topic', true), '') $$;
    grant usage on schema realtime to authenticated;
    grant select, insert on realtime.messages to authenticated;
    grant usage on sequence realtime.messages_id_seq to authenticated;

    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as
      $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema storage to authenticated;
    grant select, insert, delete on storage.objects to authenticated;
  `)
  await db.exec(readFileSync('supabase/schema.sql', 'utf8'))
  await db.exec('grant usage on schema auth to authenticated; grant select on auth.users to authenticated;')
})

describe('profiles', () => {
  beforeAll(reset)
  it('creates a profile with a friend code derived from the username', async () => {
    const [p] = await as<{ friend_code: string }>(U.alice, 'select friend_code from profiles where id = $1', [U.alice])
    expect(p.friend_code).toMatch(/^ALIC-\d{4}$/)
  })
  it('usernames are unique and validated', async () => {
    await db.query('insert into auth.users(id) values ($1)', ['00000000-0000-4000-8000-0000000000dd'])
    await fails('00000000-0000-4000-8000-0000000000dd', "select create_profile('alice','x','#fff')", [], /taken/)
    await fails('00000000-0000-4000-8000-0000000000dd', "select create_profile('1bad','x','#fff')", [], /Username/)
    expect((await as<{ username_available: boolean }>(U.bob, "select username_available('zed')"))[0].username_available).toBe(true)
    expect((await as<{ username_available: boolean }>(U.bob, "select username_available('alice')"))[0].username_available).toBe(false)
  })
  it('username/friend_code are immutable; others\' profiles are not writable or listable', async () => {
    await fails(U.alice, "update profiles set username='hax' where id=$1", [U.alice], /permission denied/)
    await fails(U.alice, "update profiles set friend_code='AAAA-0000' where id=$1", [U.alice], /permission denied/)
    await as(U.alice, "update profiles set display_name='Al' where id=$1", [U.alice])
    expect(await as(U.alice, "update profiles set display_name='hax' where id=$1 returning id", [U.bob])).toHaveLength(0)
    expect(await as(U.alice, 'select id from profiles')).toHaveLength(1) // strangers invisible
    await fails(U.alice, "insert into profiles(id,username,display_name,avatar_color,friend_code) values ($1,'xx1','x','#f','XX-1111')", [U.carol], /permission denied/)
  })
})

describe('friendships', () => {
  beforeAll(reset)
  it('find by username and by friend code; request → accept', async () => {
    expect((await as<{ add_friend: string }>(U.alice, "select add_friend('@Bob')"))[0].add_friend).toBe('Friend request sent')
    expect((await as<{ add_friend: string }>(U.alice, "select add_friend('bob')"))[0].add_friend).toBe('Request already sent')
    await fails(U.alice, 'select accept_friend($1)', [U.bob], /No pending/) // requester can't accept own request
    const [bob] = await as<{ friend_code: string }>(U.alice, 'select friend_code from profiles where id=$1', [U.bob]) // visible: pending
    expect(bob.friend_code).toMatch(/^BOB/)
    await as(U.bob, 'select accept_friend($1)', [U.alice])
    expect((await as<{ add_friend: string }>(U.bob, "select add_friend('alice')"))[0].add_friend).toBe('You are already friends')
  })
  it('errors: unknown user, self', async () => {
    await fails(U.alice, "select add_friend('nobody')", [], /No one found/)
    await fails(U.alice, "select add_friend('alice')", [], /you/)
  })
  it('strangers cannot see each other\'s friendships; no direct writes', async () => {
    expect(await as(U.carol, 'select * from friendships')).toHaveLength(0)
    await fails(U.carol, "insert into friendships(user_a,user_b,requester,status) values ($1,$2,$1,'accepted')", [U.alice, U.carol], /permission denied/)
    await fails(U.alice, "update friendships set status='accepted'", [], /permission denied/)
  })
  it('a blocked user cannot lift the block or re-add', async () => {
    await as(U.alice, 'select block_user($1)', [U.bob])
    await as(U.bob, 'select remove_friend($1)', [U.alice]) // no-op
    expect(await as(U.alice, "select 1 from friendships where status='blocked'")).toHaveLength(1)
    await fails(U.bob, "select add_friend('alice')", [], /can't add/)
    expect(await as(U.bob, 'select * from profiles where id=$1', [U.alice])).toHaveLength(0) // blocker hidden from blocked
    await as(U.alice, 'select remove_friend($1)', [U.bob]) // unblock
    expect(await as(U.alice, 'select 1 from friendships')).toHaveLength(0)
  })
})

describe('devices & permissions', () => {
  beforeAll(async () => {
    await reset()
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
  })
  it('owner-only device writes; friends see a device only after being allowed', async () => {
    expect(await as(U.alice, 'select * from devices where id=$1', [DEV.bob])).toHaveLength(0)
    expect(await as(U.alice, "update devices set name='hax' where id=$1 returning id", [DEV.bob])).toHaveLength(0)
    await fails(U.alice, "insert into devices(id,user_id,name) values (gen_random_uuid(),$1,'x')", [U.bob], /row-level security/)
    await as(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.bob, U.bob, U.alice])
    expect(await as(U.alice, 'select * from devices where id=$1', [DEV.bob])).toHaveLength(1)
    expect(await as(U.alice, 'select * from device_allowed where friend_id=$1', [U.alice])).toHaveLength(1)
  })
  it('permission can only be granted by the owner, for own devices, to accepted friends', async () => {
    await fails(U.alice, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.bob, U.bob, U.alice], /row-level security/)
    await fails(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.bob, U.bob, U.carol], /row-level security/) // not friends
    await fails(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.alice, U.bob, U.alice], /row-level security/) // not his device
  })
  it('heartbeat works for own device and reports removed devices', async () => {
    expect((await as<{ touch_device: boolean }>(U.bob, 'select touch_device($1)', [DEV.bob]))[0].touch_device).toBe(true)
    expect((await as<{ touch_device: boolean }>(U.alice, 'select touch_device($1)', [DEV.bob]))[0].touch_device).toBe(false)
  })
  it('un-friending revokes permission', async () => {
    await as(U.bob, 'select remove_friend($1)', [U.alice])
    expect(await as(U.alice, 'select * from devices where id=$1', [DEV.bob])).toHaveLength(0)
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
    await fails(U.alice, "select send_message($1,$2,$3,'text','hi')", [U.bob, DEV.bob, DEV.alice], /Not allowed/)
  })
})

describe('messages', () => {
  beforeAll(async () => {
    await reset()
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
  })
  const allow = () => as(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3) on conflict do nothing', [DEV.bob, U.bob, U.alice])

  it('denied without permission; allowed with it; sender name set server-side', async () => {
    await fails(U.alice, "select send_message($1,$2,$3,'text','hi')", [U.bob, DEV.bob, DEV.alice], /Not allowed/)
    await allow()
    await send(U.alice, U.bob, DEV.bob, DEV.alice, 'text', 'hello')
    const [m] = await as<{ from_name: string; body: string }>(U.bob, 'select * from messages where to_device=$1', [DEV.bob])
    expect(m.from_name).toBe('ALICE')
    expect(m.body).toBe('hello')
  })
  it('validates type, length; no direct inserts', async () => {
    await fails(U.alice, "select send_message($1,$2,$3,'photo','x')", [U.bob, DEV.bob, DEV.alice], /Bad message type/)
    await fails(U.alice, "select send_message($1,$2,$3,'text',repeat('x',501))", [U.bob, DEV.bob, DEV.alice], /too long/)
    await as(U.alice, "select send_message($1,$2,$3,'text',repeat('x',500))", [U.bob, DEV.bob, DEV.alice]).catch(() => undefined)
    await fails(U.alice, "insert into messages(from_user,to_user,to_device,type) values ($1,$2,$3,'text')", [U.alice, U.bob, DEV.bob], /permission denied/)
  })
  it('rate limit: max 5 per second', async () => {
    await db.exec('truncate public.messages')
    for (let i = 0; i < 5; i++) await send(U.alice, U.bob, DEV.bob, DEV.alice, 'text', String(i))
    await fails(U.alice, "select send_message($1,$2,$3,'text','6')", [U.bob, DEV.bob, DEV.alice], /Slow down/)
  })
  it('only sender and recipient can read; recipient can delete', async () => {
    await db.exec('truncate public.messages')
    const [{ send_message: id }] = await send(U.alice, U.bob, DEV.bob, DEV.alice, 'text', 'secret')
    expect(await as(U.carol, 'select * from messages')).toHaveLength(0)
    expect(await as(U.bob, 'select * from messages where id=$1', [id])).toHaveLength(1)
    expect(await as(U.alice, 'select * from messages where id=$1', [id])).toHaveLength(1)
    expect(await as(U.carol, 'delete from messages where id=$1 returning id', [id])).toHaveLength(0)
    expect(await as(U.bob, 'delete from messages where id=$1 returning id', [id])).toHaveLength(1)
  })
  it('live typing keeps a single row', async () => {
    await db.exec('truncate public.messages')
    for (const t of ['h', 'he', 'hey']) await as(U.alice, 'select send_live($1,$2,$3,$4)', [U.bob, DEV.bob, DEV.alice, t])
    const rows = await as<{ body: string; live: boolean }>(U.bob, 'select * from messages')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ body: 'hey', live: true })
    await fails(U.carol, 'select send_live($1,$2,$3,$4)', [U.bob, DEV.bob, DEV.carol, 'x'], /Not allowed/)
  })
  it('owner can message own devices (My devices)', async () => {
    const dev2 = '10000000-0000-4000-8000-0000000000a2'
    await as(U.alice, "insert into devices(id,user_id,name,is_display) values ($1,$2,'laptop',true)", [dev2, U.alice])
    await send(U.alice, U.alice, dev2, DEV.alice, 'text', 'to myself')
    await fails(U.alice, "select send_message($1,$2,$3,'text','x')", [U.alice, DEV.bob, DEV.alice], /Not allowed/) // not her device
  })
  it('photo flows back only as a reply to a capture request', async () => {
    await db.exec('truncate public.messages')
    await allow()
    // unsolicited
    await fails(U.bob, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.alice, DEV.alice, DEV.bob, '20000000-0000-4000-8000-000000000000', '', JPEG], /No capture request/)
    const [{ send_message: cap }] = await send(U.alice, U.bob, DEV.bob, DEV.alice, 'capture')
    // wrong photographer / wrong target
    await fails(U.carol, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.alice, DEV.alice, DEV.carol, cap, '', JPEG], /No capture request/)
    await fails(U.bob, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.carol, DEV.carol, DEV.bob, cap, '', JPEG], /No capture request/)
    // bad / oversize payloads
    await fails(U.bob, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.alice, DEV.alice, DEV.bob, cap, '', 'http://evil'], /Invalid/)
    await fails(U.bob, "select send_photo($1,$2,$3,$4,$5,'data:image/jpeg;base64,'||repeat('A',800000))", [U.alice, DEV.alice, DEV.bob, cap, ''], /Invalid/)
    // happy path
    await as(U.bob, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.alice, DEV.alice, DEV.bob, cap, 'hi there', JPEG])
    const [p] = await as<{ type: string; body: string }>(U.alice, "select * from messages where type='photo' and to_device=$1", [DEV.alice])
    expect(p).toMatchObject({ type: 'photo', body: 'hi there' })
    expect(await as(U.carol, "select * from messages where type='photo'")).toHaveLength(0)
  })
  it('blocking stops delivery', async () => {
    await as(U.bob, 'select block_user($1)', [U.alice])
    await fails(U.alice, "select send_message($1,$2,$3,'text','hi')", [U.bob, DEV.bob, DEV.alice], /Not allowed/)
  })
})

describe('rooms (Meet-style)', () => {
  let code = ''
  let roomId = ''
  beforeAll(async () => {
    await reset() // alice, bob, carol are NOT friends here
    const [r] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('Movie night')")
    code = r.code
    roomId = r.id
    await as(U.alice, 'select set_room_approval($1, false)', [roomId]) // these tests are about open rooms
  })

  it('create_room returns a meet-style code and makes the host a member', async () => {
    expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    expect(await as(U.alice, 'select * from room_members where room_id=$1', [roomId])).toHaveLength(1)
  })
  it('strangers cannot see a room until they join (and can only join with the code)', async () => {
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(0)
    await fails(U.bob, "select join_room('zzz-zzzz-zzz')", [], /not found/)
    await as(U.bob, 'select join_room($1)', [code.toUpperCase()]) // case-insensitive
    await as(U.bob, 'select join_room($1)', [code]) // idempotent
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(1)
    expect(await as(U.bob, 'select * from room_members where room_id=$1', [roomId])).toHaveLength(2)
    expect(await as(U.carol, 'select * from room_members')).toHaveLength(0)
  })
  it('roommates can see each other\'s profile, but non-members cannot', async () => {
    expect(await as(U.bob, 'select * from profiles where id=$1', [U.alice])).toHaveLength(1)
    expect(await as(U.carol, 'select * from profiles where id=$1', [U.alice])).toHaveLength(0)
  })
  it('no sending to a roommate\'s device until they put it on screen', async () => {
    await fails(U.bob, "select send_message($1,$2,$3,'text','hi')", [U.alice, DEV.alice, DEV.bob], /Not allowed/)
    expect(await as(U.bob, 'select * from devices where id=$1', [DEV.alice])).toHaveLength(0)
    await as(U.alice, 'select set_room_device($1,$2,true)', [roomId, DEV.alice])
    expect(await as(U.bob, 'select * from devices where id=$1', [DEV.alice])).toHaveLength(1)
    await as(U.bob, "select send_message($1,$2,$3,'text','hi from bob')", [U.alice, DEV.alice, DEV.bob])
    expect(await as(U.alice, "select body from messages where to_device=$1", [DEV.alice])).toHaveLength(1)
  })
  it('only members can put devices on screen, and only their own', async () => {
    await fails(U.carol, 'select set_room_device($1,$2,true)', [roomId, DEV.carol], /not in this room/)
    await fails(U.bob, 'select set_room_device($1,$2,true)', [roomId, DEV.alice], /Not your device/)
  })
  it('non-members cannot send into the room', async () => {
    await fails(U.carol, "select send_message($1,$2,$3,'text','x')", [U.alice, DEV.alice, DEV.carol], /Not allowed/)
  })
  it('photo can come back to a roommate who asked for it', async () => {
    const [{ send_message: cap }] = await send(U.bob, U.alice, DEV.alice, DEV.bob, 'capture')
    await as(U.alice, 'select send_photo($1,$2,$3,$4,$5,$6)', [U.bob, DEV.bob, DEV.alice, cap, '', JPEG])
    expect(await as(U.bob, "select * from messages where type='photo'")).toHaveLength(1)
  })
  it('room is capped at 8 people', async () => {
    for (let i = 0; i < 6; i++) {
      const id = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
      await db.query('insert into auth.users(id) values ($1)', [id])
      await as(id, 'select create_profile($1,$2,$3)', [`extra${i}`, 'E', '#fff'])
      await as(id, 'select join_room($1)', [code])
    }
    await fails(U.carol, 'select join_room($1)', [code], /full/)
  })
  it('leaving removes access; the host leaving ends the room for everyone', async () => {
    await as(U.bob, 'select leave_room($1)', [roomId])
    await fails(U.bob, "select send_message($1,$2,$3,'text','x')", [U.alice, DEV.alice, DEV.bob], /Not allowed/)
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(0)
    await as(U.alice, 'select leave_room($1)', [roomId])
    expect(await as(U.alice, 'select * from rooms')).toHaveLength(0)
  })
  it('expired rooms stop working', async () => {
    const [r] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('Short')")
    await db.query("update rooms set expires_at = now() - interval '1 minute' where id=$1", [r.id])
    await fails(U.bob, 'select join_room($1)', [r.code], /not found|ended/)
    expect(await as(U.alice, 'select * from rooms where id=$1', [r.id])).toHaveLength(0)
  })
})

describe('remote capture: private broadcast channels + storage bucket', () => {
  // Alice = controller, Bob = viewer (his device allows Alice), Carol = stranger
  const asTopic = async <T = Record<string, unknown>>(uid: string, topic: string, sql: string, params: unknown[] = []) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('realtime.topic', '${topic}', false);`)
    try { return (await db.query<T>(sql, params)).rows } finally { await db.exec('reset role') }
  }
  const sendOn = (uid: string, topic: string) =>
    asTopic(uid, topic, "insert into realtime.messages(topic, extension, payload) values (current_setting('realtime.topic'), 'broadcast', '{}')")
  const failsOn = async (uid: string, topic: string) => {
    let err: unknown
    try { await sendOn(uid, topic) } catch (e) { err = e }
    expect(err, `${uid} should NOT be able to send on ${topic}`).toBeDefined()
  }
  const CAP = `cap:${DEV.bob}`          // viewer's inbox
  const RES = `res:${DEV.alice}`        // controller's result channel

  beforeAll(async () => {
    await reset()
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
    await as(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.bob, U.bob, U.alice])
  })

  it('the bucket is private with a size + type limit', async () => {
    const [b] = (await db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>("select * from storage.buckets where id='captures'")).rows
    expect(b.public).toBe(false)
    expect(Number(b.file_size_limit)).toBeGreaterThan(5_000_000)
    expect(b.allowed_mime_types).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  })

  it('capture trigger: only a controller allowed on the device may broadcast to it', async () => {
    await sendOn(U.alice, CAP)
    await failsOn(U.carol, CAP)
    await failsOn(U.bob, `cap:${DEV.alice}`) // bob is not allowed on alice's device
    await failsOn(U.alice, 'cap:not-a-uuid')
  })
  it('capture trigger: only the viewer (device owner) can listen on the inbox', async () => {
    await db.exec("truncate realtime.messages; insert into realtime.messages(topic, extension, payload) values ('" + CAP + "', 'broadcast', '{}')")
    expect(await asTopic(U.bob, CAP, 'select * from realtime.messages')).toHaveLength(1)
    expect(await asTopic(U.alice, CAP, 'select * from realtime.messages')).toHaveLength(0)
    expect(await asTopic(U.carol, CAP, 'select * from realtime.messages')).toHaveLength(0)
  })
  it('result channel: viewer may answer the controller; strangers may not; only the controller listens', async () => {
    await sendOn(U.bob, RES)
    await failsOn(U.carol, RES)
    await db.exec("truncate realtime.messages; insert into realtime.messages(topic, extension, payload) values ('" + RES + "', 'broadcast', '{}')")
    expect(await asTopic(U.alice, RES, 'select * from realtime.messages')).toHaveLength(1)
    expect(await asTopic(U.bob, RES, 'select * from realtime.messages')).toHaveLength(0)
  })
  it('revoking permission cuts off new capture requests', async () => {
    await as(U.bob, 'delete from device_allowed where device_id=$1', [DEV.bob])
    await failsOn(U.alice, CAP)
    await as(U.bob, 'insert into device_allowed(device_id,owner_id,friend_id) values ($1,$2,$3)', [DEV.bob, U.bob, U.alice])
    await sendOn(U.alice, CAP)
  })

  it('room call channel: members may listen and send, outsiders may not', async () => {
    const [r] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('Call')")
    await as(U.alice, 'select set_room_approval($1, false)', [r.id])
    await as(U.bob, 'select join_room($1)', [r.code])
    const T = `room:${r.id}`
    await sendOn(U.alice, T)
    await sendOn(U.bob, T)
    await failsOn(U.carol, T) // not in the room
    await db.exec("truncate realtime.messages; insert into realtime.messages(topic, extension, payload) values ('" + T + "', 'broadcast', '{}')")
    expect(await asTopic(U.bob, T, 'select * from realtime.messages')).toHaveLength(1)
    expect(await asTopic(U.alice, T, 'select * from realtime.messages')).toHaveLength(1)
    expect(await asTopic(U.carol, T, 'select * from realtime.messages')).toHaveLength(0)
    await as(U.bob, 'select leave_room($1)', [r.id]) // leaving closes the door
    await failsOn(U.bob, T)
    expect(await asTopic(U.bob, T, 'select * from realtime.messages')).toHaveLength(0)
  })

  it('realtime_setup_ok tells the app whether the channel rules are installed', async () => {
    const [r] = await as<{ realtime_setup_ok: { capture: boolean; room: boolean } }>(U.alice, 'select realtime_setup_ok()')
    expect(r.realtime_setup_ok).toEqual({ capture: true, room: true })
    await db.exec('drop policy snap_room_send on realtime.messages')
    const [r2] = await as<{ realtime_setup_ok: { capture: boolean; room: boolean } }>(U.alice, 'select realtime_setup_ok()')
    expect(r2.realtime_setup_ok).toEqual({ capture: true, room: false })
    await db.exec("create policy snap_room_send on realtime.messages for insert to authenticated with check (realtime.messages.extension = 'broadcast' and realtime.topic() like 'room:%' and public.in_room(public.safe_uuid(substr(realtime.topic(), 6)), auth.uid()))")
  })

  it('video-update.sql alone installs the room-call rules (for a database missing them)', async () => {
    await db.exec('drop policy if exists snap_room_receive on realtime.messages; drop policy if exists snap_room_send on realtime.messages; drop function if exists public.realtime_setup_ok()')
    const [none] = (await db.query<{ n: number }>("select count(*)::int as n from pg_policies where schemaname='realtime' and policyname like 'snap_room_%'")).rows
    expect(none.n).toBe(0)
    await db.exec(readFileSync('supabase/video-update.sql', 'utf8'))
    const [r] = await as<{ realtime_setup_ok: { room: boolean } }>(U.alice, 'select realtime_setup_ok()')
    expect(r.realtime_setup_ok.room).toBe(true)
    // …and the rules actually work: members in, outsiders out
    const [room] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('Update test')")
    const T = `room:${room.id}`
    await sendOn(U.alice, T)
    await failsOn(U.carol, T)
  })

  const path = (viewer: string, controller: string, id = '30000000-0000-4000-8000-000000000001') => `${viewer}/${controller}_${id}.jpg`
  const put = (uid: string, name: string) => as(uid, "insert into storage.objects(bucket_id, name) values ('captures', $1)", [name])

  it('storage: viewer uploads into own folder for an allowed controller only', async () => {
    await put(U.bob, path(U.bob, U.alice))
    await fails(U.bob, "insert into storage.objects(bucket_id, name) values ('captures', $1)", [path(U.bob, U.carol)], /row-level security/) // carol can't target bob
    await fails(U.carol, "insert into storage.objects(bucket_id, name) values ('captures', $1)", [path(U.bob, U.alice)], /row-level security/) // wrong folder
    await fails(U.carol, "insert into storage.objects(bucket_id, name) values ('captures', $1)", [path(U.carol, U.alice)], /row-level security/) // alice isn't allowed on carol's devices
    await fails(U.bob, "insert into storage.objects(bucket_id, name) values ('other-bucket', $1)", [path(U.bob, U.alice)], /row-level security/) // only the captures bucket
  })
  it('storage: only the viewer and the named controller can read; delete = receipt cleanup', async () => {
    const n = path(U.bob, U.alice, '30000000-0000-4000-8000-000000000002')
    await put(U.bob, n)
    expect((await as(U.alice, 'select name from storage.objects where name=$1', [n]))).toHaveLength(1)
    expect((await as(U.bob, 'select name from storage.objects where name=$1', [n]))).toHaveLength(1)
    expect((await as(U.carol, 'select name from storage.objects where name=$1', [n]))).toHaveLength(0)
    expect(await as(U.carol, 'delete from storage.objects where name=$1 returning name', [n])).toHaveLength(0)
    expect(await as(U.alice, 'delete from storage.objects where name=$1 returning name', [n])).toHaveLength(1)
  })
  it('storage: viewer can clean up own old files', async () => {
    const n = path(U.bob, U.alice, '30000000-0000-4000-8000-000000000003')
    await put(U.bob, n)
    expect(await as(U.bob, 'delete from storage.objects where name=$1 returning name', [n])).toHaveLength(1)
  })
})

describe('profile picture', () => {
  beforeAll(reset)
  it('can be set to an https link, is visible to a friend, and rejects anything else', async () => {
    await as(U.alice, "select set_avatar_url('https://lh3.googleusercontent.com/a/photo=s96-c')")
    expect((await as<{ avatar_url: string }>(U.alice, 'select avatar_url from profiles where id=$1', [U.alice]))[0].avatar_url).toContain('googleusercontent')
    await as(U.alice, "select set_avatar_url('javascript:alert(1)')")
    await as(U.alice, "select set_avatar_url('http://insecure.example/x.png')")
    expect((await as<{ avatar_url: string }>(U.alice, 'select avatar_url from profiles where id=$1', [U.alice]))[0].avatar_url).toContain('https://lh3')
    await as(U.alice, "select set_avatar_url('')")
    expect((await as<{ avatar_url: string | null }>(U.alice, 'select avatar_url from profiles where id=$1', [U.alice]))[0].avatar_url).toBeNull()
  })
  it('nobody can write a picture directly (only through set_avatar_url)', async () => {
    await fails(U.bob, "update profiles set avatar_url = 'https://x.example/y.png' where id = $1", [U.bob], /permission denied/)
  })
})

describe('update-waiting-room-avatars.sql', () => {
  it('runs cleanly (twice) on top of the schema and the waiting room still behaves', async () => {
    const sql = readFileSync('supabase/update-waiting-room-avatars.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql) // idempotent
    await reset()
    const [r] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('After update')")
    const e = (await as<{ e: { status: string } }>(U.bob, 'select enter_room($1) as e', [r.code]))[0].e
    expect(e.status).toBe('pending')
    await fails(U.bob, 'select join_room($1)', [r.code], /waiting room/)
    await as(U.alice, 'select admit_request($1, $2)', [r.id, U.bob])
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(1)
    await as(U.bob, "select set_avatar_url('https://lh3.googleusercontent.com/x')")
  })
})

describe('waiting room', () => {
  let code = ''
  let roomId = ''
  const enter = async (uid: string, c = code) => (await as<{ e: { status: string; room_id?: string; name: string; host_name: string } }>(uid, 'select enter_room($1) as e', [c]))[0].e

  beforeAll(async () => {
    await reset()
    const [r] = await as<{ id: string; code: string }>(U.alice, "select * from create_room('Lobby')")
    code = r.code
    roomId = r.id
  })

  it('approval is on by default: a stranger waits instead of joining', async () => {
    const e = await enter(U.bob)
    expect(e).toMatchObject({ status: 'pending', name: 'Lobby', host_name: 'ALICE' })
    expect(e.room_id).toBeUndefined() // a waiting person learns nothing about the room's insides
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(0)
    expect(await as(U.bob, 'select * from room_members')).toHaveLength(0)
  })
  it('the old direct-join door is shut for approval rooms', async () => {
    await fails(U.bob, 'select join_room($1)', [code], /waiting room/)
    await fails(U.carol, 'select join_room($1)', [code], /waiting room/)
  })
  it('asking again just keeps waiting (no duplicates)', async () => {
    expect((await enter(U.bob)).status).toBe('pending')
    expect(await as(U.alice, 'select * from room_requests')).toHaveLength(1)
  })
  it('the host sees who is waiting and can read their profile; strangers cannot see requests', async () => {
    const rows = await as<{ user_id: string }>(U.alice, "select * from room_requests where status = 'pending'")
    expect(rows.map((r) => r.user_id)).toEqual([U.bob])
    expect(await as(U.alice, 'select display_name from profiles where id = $1', [U.bob])).toHaveLength(1)
    expect(await as(U.carol, 'select * from room_requests')).toHaveLength(0)
    expect(await as(U.carol, 'select * from profiles where id = $1', [U.bob])).toHaveLength(0)
    expect(await as(U.bob, 'select * from room_requests')).toHaveLength(1) // their own
  })
  it('only the host can admit, deny or change the setting', async () => {
    await fails(U.bob, 'select admit_request($1, $2)', [roomId, U.bob], /host/)
    await fails(U.carol, 'select deny_request($1, $2)', [roomId, U.bob], /host/)
    await fails(U.bob, 'select set_room_approval($1, false)', [roomId], /host/)
  })
  it('admit lets them in; entering again says member', async () => {
    await as(U.alice, 'select admit_request($1, $2)', [roomId, U.bob])
    const e = await enter(U.bob)
    expect(e.status).toBe('member')
    expect(e.room_id).toBe(roomId)
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(1)
    expect(await as(U.alice, 'select * from room_requests')).toHaveLength(0)
    await fails(U.alice, 'select admit_request($1, $2)', [roomId, U.bob], /No waiting request/)
  })
  it('deny is final: they stay out and cannot ask again', async () => {
    expect((await enter(U.carol)).status).toBe('pending')
    await as(U.alice, 'select deny_request($1, $2)', [roomId, U.carol])
    expect((await enter(U.carol)).status).toBe('denied')
    expect(await as(U.carol, 'select * from room_members')).toHaveLength(0)
    await fails(U.alice, 'select admit_request($1, $2)', [roomId, U.carol], /No waiting request/)
  })
  it('a waiting person can withdraw', async () => {
    const dev = '00000000-0000-4000-8000-0000000000e1'
    await db.query('insert into auth.users(id) values ($1)', [dev])
    await as(dev, 'select create_profile($1,$2,$3)', ['dave', 'Dave', '#fff'])
    expect((await enter(dev)).status).toBe('pending')
    await as(dev, 'select cancel_join($1)', [code])
    expect(await as(dev, 'select * from room_requests')).toHaveLength(0)
  })
  it('turning approval off lets the waiting in and later visitors straight in', async () => {
    const e1 = '00000000-0000-4000-8000-0000000000e2'
    await db.query('insert into auth.users(id) values ($1)', [e1])
    await as(e1, 'select create_profile($1,$2,$3)', ['erin', 'Erin', '#fff'])
    expect((await enter(e1)).status).toBe('pending')
    await as(U.alice, 'select set_room_approval($1, false)', [roomId])
    expect(await as(e1, 'select * from room_members where user_id = $1', [e1])).toHaveLength(1) // waiting person was let in
    expect(await as(U.alice, "select * from room_requests where status = 'pending'")).toHaveLength(0)
    const late = '00000000-0000-4000-8000-0000000000e3'
    await db.query('insert into auth.users(id) values ($1)', [late])
    await as(late, 'select create_profile($1,$2,$3)', ['finn', 'Finn', '#fff'])
    expect((await enter(late)).status).toBe('member')                          // later visitors walk in
    await as(U.alice, 'select set_room_approval($1, true)', [roomId])          // and it can be switched back on
    const later = '00000000-0000-4000-8000-0000000000e4'
    await db.query('insert into auth.users(id) values ($1)', [later])
    await as(later, 'select create_profile($1,$2,$3)', ['gina', 'Gina', '#fff'])
    expect((await enter(later)).status).toBe('pending')
  })
  it('the 8-person cap is enforced when admitting', async () => {
    await as(U.alice, 'select set_room_approval($1, true)', [roomId])
    for (let i = 0; i < 8; i++) {
      const id = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`
      await db.query('insert into auth.users(id) values ($1)', [id])
      await as(id, 'select create_profile($1,$2,$3)', [`cap${i}`, 'C', '#fff'])
      await enter(id)
    }
    let admitted = 0
    let blocked = false
    for (let i = 0; i < 8; i++) {
      const id = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`
      try { await as(U.alice, 'select admit_request($1, $2)', [roomId, id]); admitted++ } catch (e) { if (/full/.test(String(e))) blocked = true }
    }
    expect(blocked).toBe(true)
    const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from room_members where room_id = $1', [roomId]).then((r) => r.rows)
    expect(n).toBe(8)
    expect(admitted).toBeGreaterThan(0)
  })
})

describe('calling a friend', () => {
  it('rings, accepts, declines, and only works between friends', async () => {
    await db.exec(readFileSync('supabase/update-calling.sql', 'utf8'))
    await db.exec(readFileSync('supabase/update-calling.sql', 'utf8')) // idempotent
    await reset()
    await fails(U.alice, 'select start_call($1)', [U.bob], /only call friends/)
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
    const [c] = await as<{ id: string; room_code: string; status: string }>(U.alice, 'select * from start_call($1)', [U.bob])
    expect(c.status).toBe('ringing')
    expect(await as(U.bob, 'select * from calls')).toHaveLength(1)          // the callee sees it ring
    expect(await as(U.carol, 'select * from calls')).toHaveLength(0)        // nobody else does
    await fails(U.alice, 'select start_call($1)', [U.bob], /Already ringing/)
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(0)          // not in the room yet
    const code = (await as<{ accept_call: string }>(U.bob, 'select accept_call($1)', [c.id]))[0].accept_call
    expect(code).toBe(c.room_code)
    expect(await as(U.bob, 'select * from rooms')).toHaveLength(1)          // now they can see and join it
    await fails(U.carol, 'select accept_call($1)', [c.id], /not found/)
    // decline + cancel
    const [d] = await as<{ id: string }>(U.bob, 'select * from start_call($1)', [U.alice])
    await as(U.alice, 'select decline_call($1)', [d.id])
    expect((await as<{ status: string }>(U.bob, 'select status from calls where id = $1', [d.id]))[0].status).toBe('declined')
  })
})

describe('push notifications for calls', () => {
  it('stores my phone, and only the caller can look up the callee\'s phones for a ringing call', async () => {
    await db.exec(readFileSync('supabase/update-push.sql', 'utf8'))
    await db.exec(readFileSync('supabase/update-push.sql', 'utf8')) // idempotent
    await reset()
    await as(U.alice, "select add_friend('bob')")
    await as(U.bob, 'select accept_friend($1)', [U.alice])
    await as(U.bob, "select save_push('https://push.example/bob1', 'p256-key', 'auth-key')")
    expect(await as(U.alice, 'select * from push_subscriptions')).toHaveLength(0)   // nobody sees anyone else's subscription
    expect(await as(U.bob, 'select * from push_subscriptions')).toHaveLength(1)
    const [c] = await as<{ id: string }>(U.alice, 'select * from start_call($1)', [U.bob])
    const rows = await as<{ endpoint: string; caller_name: string }>(U.alice, 'select * from call_push_targets($1)', [c.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].endpoint).toBe('https://push.example/bob1')
    expect(await as(U.bob, 'select * from call_push_targets($1)', [c.id])).toHaveLength(0)    // the callee can't ask
    expect(await as(U.carol, 'select * from call_push_targets($1)', [c.id])).toHaveLength(0)   // neither can a stranger
    await as(U.alice, 'select cancel_call($1)', [c.id])
    expect(await as(U.alice, 'select * from call_push_targets($1)', [c.id])).toHaveLength(0)   // no push once it stopped ringing
    expect((await as<{ friend_can_ring: boolean }>(U.alice, 'select friend_can_ring($1)', [U.bob]))[0].friend_can_ring).toBe(true)
    expect((await as<{ friend_can_ring: boolean }>(U.alice, 'select friend_can_ring($1)', [U.carol]))[0].friend_can_ring).toBe(false) // not a friend
    await as(U.bob, "select remove_push('https://push.example/bob1')")
    expect((await as<{ friend_can_ring: boolean }>(U.alice, 'select friend_can_ring($1)', [U.bob]))[0].friend_can_ring).toBe(false)
    expect(await as(U.bob, 'select * from push_subscriptions')).toHaveLength(0)
  })
})
