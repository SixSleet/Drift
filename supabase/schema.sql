-- ---------------------------------------------------------------------------
-- Drift: Chaos Mode — schema, row-level security and write RPCs.
--
-- Run this once against a Supabase project (SQL Editor, or `supabase db push`
-- if you keep it under supabase/migrations/). It is re-runnable: it drops and
-- rebuilds every drift_* object.
--
-- Identity without accounts
-- -------------------------
-- There is no login and no auth session. Each browser mints a 256-bit random
-- token on first visit and keeps it in localStorage. The server never stores
-- the token itself, only its SHA-256 hash, and a player "is" whoever presents
-- the token matching a drift_players row.
--
-- The token reaches Postgres two ways, deliberately:
--
--   * as an argument to the RPCs below, which are the ONLY write path, and
--   * as the `x-drift-player` request header, which PostgREST exposes as
--     `request.headers` and which the RLS policies read.
--
-- So the policies gate direct table access on room membership, and the RPCs do
-- not depend on header plumbing to work.
-- ---------------------------------------------------------------------------

drop table if exists public.drift_guesses cascade;
drop table if exists public.drift_wagers  cascade;
drop table if exists public.drift_nudges  cascade;
drop table if exists public.drift_rounds  cascade;
drop table if exists public.drift_players cascade;
drop table if exists public.drift_rooms   cascade;

drop function if exists public.drift_is_member(uuid)          cascade;
drop function if exists public.drift_round_room(uuid)         cascade;
drop function if exists public.drift_player_in_round(uuid)    cascade;
drop function if exists public.drift_create_room(int)         cascade;
drop function if exists public.drift_join_room(text)          cascade;
drop function if exists public.drift_heartbeat(uuid)          cascade;
drop function if exists public.drift_start_game(uuid)         cascade;
drop function if exists public.drift_next_round(uuid)         cascade;
drop function if exists public.drift_finish_game(uuid)        cascade;
drop function if exists public.drift_publish_truth(uuid, jsonb) cascade;
drop function if exists public.drift_lock_wager(uuid, int)    cascade;
drop function if exists public.drift_server_time()            cascade;
drop function if exists public.drift_palette(int)             cascade;
drop function if exists public.drift_nickname(int, int)       cascade;
drop function if exists public.drift_submit_guess(uuid, int, double precision, double precision) cascade;
drop function if exists public.drift_submit_nudge(uuid, int, int, double precision, double precision, double precision) cascade;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table public.drift_rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Z2-9]{4}$'),
  host_token_hash  text not null,
  status           text not null default 'lobby'
                   check (status in ('lobby', 'playing', 'finished')),
  total_rounds     int  not null default 10 check (total_rounds between 1 and 30),
  current_round    int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.drift_players (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.drift_rooms(id) on delete cascade,
  -- SHA-256 of the browser's token. The token itself is never stored.
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  seat        int  not null check (seat between 0 and 9),
  name        text not null,
  color       text not null,
  is_host     boolean not null default false,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (room_id, token_hash),
  unique (room_id, seat)
);

create index drift_players_room_idx  on public.drift_players (room_id);
create index drift_players_token_idx on public.drift_players (token_hash);

create table public.drift_rounds (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.drift_rooms(id) on delete cascade,
  round_no     int  not null check (round_no >= 1),
  -- Server-issued seed. Drives arena layout, ball spawns and launch vectors:
  -- every client rebuilds the identical round from it, so positions are never
  -- streamed.
  seed         bigint not null,
  ball_count   int  not null check (ball_count between 1 and 3),
  duration_ms  int  not null check (duration_ms between 3000 and 12000),
  blackout_ms  int  not null check (blackout_ms between 0 and 3000),
  starts_at    timestamptz not null,
  -- Authoritative ball positions at the freeze tick, published by the host, so
  -- ten browsers can never disagree about a leaderboard.
  truth        jsonb,
  created_at   timestamptz not null default now(),
  unique (room_id, round_no)
);

create index drift_rounds_room_idx on public.drift_rounds (room_id);

-- Exactly one nudge per player per round, enforced by the primary key.
create table public.drift_nudges (
  round_id    uuid not null references public.drift_rounds(id) on delete cascade,
  player_id   uuid not null references public.drift_players(id) on delete cascade,
  ball_index  int  not null check (ball_index between 0 and 2),
  apply_tick  int  not null check (apply_tick >= 0),
  dx          double precision not null,
  dy          double precision not null,
  strength    double precision not null,
  created_at  timestamptz not null default now(),
  primary key (round_id, player_id)
);

create table public.drift_wagers (
  round_id   uuid not null references public.drift_rounds(id) on delete cascade,
  player_id  uuid not null references public.drift_players(id) on delete cascade,
  wager      int  not null check (wager in (1, 2, 3)),
  locked_at  timestamptz not null default now(),
  primary key (round_id, player_id)
);

create table public.drift_guesses (
  round_id     uuid not null references public.drift_rounds(id) on delete cascade,
  player_id    uuid not null references public.drift_players(id) on delete cascade,
  ball_index   int  not null check (ball_index between 0 and 2),
  gx           double precision not null,
  gy           double precision not null,
  distance     double precision,
  base_points  int,
  wager        int,
  streak       int,
  multiplier   numeric(4,2),
  points       int,
  submitted_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

-- ── Identity helpers ───────────────────────────────────────────────────────

create or replace function public.drift_hash(p_token text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
           when p_token ~ '^[0-9a-f]{64}$'
           then encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
         end;
$$;

-- The token as presented in the `x-drift-player` request header. Used by the
-- RLS policies; the RPCs take the token as an argument instead.
create or replace function public.drift_header_hash()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select public.drift_hash(
    nullif(current_setting('request.headers', true), '')::json ->> 'x-drift-player'
  );
$$;

-- SECURITY DEFINER so the drift_players policy can call it without recursing
-- into its own RLS check.
create or replace function public.drift_is_member(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.drift_players
    where room_id = p_room and token_hash = public.drift_header_hash()
  );
$$;

create or replace function public.drift_round_room(p_round uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select room_id from public.drift_rounds where id = p_round;
$$;

-- ── RLS: read-only, all scoped to room membership ─────────────────────────

alter table public.drift_rooms   enable row level security;
alter table public.drift_players enable row level security;
alter table public.drift_rounds  enable row level security;
alter table public.drift_nudges  enable row level security;
alter table public.drift_wagers  enable row level security;
alter table public.drift_guesses enable row level security;

create policy drift_rooms_select on public.drift_rooms
  for select to anon, authenticated
  using (public.drift_is_member(id));

create policy drift_players_select on public.drift_players
  for select to anon, authenticated
  using (public.drift_is_member(room_id));

create policy drift_rounds_select on public.drift_rounds
  for select to anon, authenticated
  using (public.drift_is_member(room_id));

create policy drift_nudges_select on public.drift_nudges
  for select to anon, authenticated
  using (public.drift_is_member(public.drift_round_room(round_id)));

-- Wagers are secret until the round freezes: before that you only see your own.
-- `truth` is written at the reveal, so it doubles as the reveal flag.
create policy drift_wagers_select on public.drift_wagers
  for select to anon, authenticated
  using (
    public.drift_is_member(public.drift_round_room(round_id))
    and (
      exists (select 1 from public.drift_players p
               where p.id = drift_wagers.player_id
                 and p.token_hash = public.drift_header_hash())
      or exists (select 1 from public.drift_rounds r
                  where r.id = drift_wagers.round_id and r.truth is not null)
    )
  );

create policy drift_guesses_select on public.drift_guesses
  for select to anon, authenticated
  using (
    public.drift_is_member(public.drift_round_room(round_id))
    and (
      exists (select 1 from public.drift_players p
               where p.id = drift_guesses.player_id
                 and p.token_hash = public.drift_header_hash())
      or exists (select 1 from public.drift_rounds r
                  where r.id = drift_guesses.round_id and r.truth is not null)
    )
  );

-- ── Write RPCs ─────────────────────────────────────────────────────────────
-- There are no INSERT/UPDATE/DELETE policies on any drift_* table. These
-- SECURITY DEFINER functions are the only write path. Each one resolves the
-- caller from the token it is handed and re-checks membership, host rights and
-- the timing window before touching anything.

create or replace function public.drift_server_time()
returns timestamptz language sql stable
set search_path = public, pg_temp as $$ select now() $$;

create or replace function public.drift_palette(p_seat int)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select (array[
    '#ff5c7a','#4bd0ff','#ffd166','#7be495','#c792ea',
    '#ff9f45','#5eead4','#f472b6','#93c5fd','#fde047'
  ])[(p_seat % 10) + 1];
$$;

create or replace function public.drift_nickname(p_seat int, p_salt text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select (array[
    'Crimson','Cobalt','Amber','Jade','Violet',
    'Ember','Teal','Rose','Frost','Gold'
  ])[(p_seat % 10) + 1]
  || ' ' ||
  (array[
    'Fox','Hawk','Otter','Lynx','Moth',
    'Crow','Ray','Wolf','Ibis','Bear'
  ])[(('x' || substr(p_salt, 1, 7))::bit(28)::int % 10) + 1];
$$;

-- Resolve the caller's player row for a room, or raise.
create or replace function public.drift_player(p_token text, p_room uuid)
returns public.drift_players
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.drift_players;
begin
  select * into v_player from public.drift_players
   where room_id = p_room and token_hash = public.drift_hash(p_token);
  if not found then
    raise exception 'drift: not a member of this room' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

create or replace function public.drift_player_in_round(p_token text, p_round uuid)
returns public.drift_players
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.drift_players;
begin
  select p.* into v_player
    from public.drift_players p
    join public.drift_rounds r on r.room_id = p.room_id
   where r.id = p_round and p.token_hash = public.drift_hash(p_token);
  if not found then
    raise exception 'drift: not a member of this room' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

create or replace function public.drift_host_room(p_token text, p_room uuid)
returns public.drift_rooms
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.drift_rooms;
begin
  select * into v_room from public.drift_rooms
   where id = p_room and host_token_hash = public.drift_hash(p_token);
  if not found then
    raise exception 'drift: host only' using errcode = '42501';
  end if;
  return v_room;
end;
$$;

-- Create a room and seat the caller as host.
create or replace function public.drift_create_room(p_token text, p_total_rounds int default 10)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash  text := public.drift_hash(p_token);
  v_code  text;
  v_room  public.drift_rooms;
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try   int  := 0;
begin
  if v_hash is null then
    raise exception 'drift: a 64-character hex token is required' using errcode = '28000';
  end if;

  loop
    v_try := v_try + 1;
    v_code := '';
    for _ in 1..4 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    begin
      insert into public.drift_rooms (code, host_token_hash, total_rounds)
      values (v_code, v_hash, greatest(1, least(30, coalesce(p_total_rounds, 10))))
      returning * into v_room;
      exit;
    exception when unique_violation then
      if v_try > 40 then raise exception 'drift: could not allocate a room code'; end if;
    end;
  end loop;

  insert into public.drift_players (room_id, token_hash, seat, name, color, is_host)
  values (v_room.id, v_hash, 0, public.drift_nickname(0, v_hash), public.drift_palette(0), true);

  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code);
end;
$$;

-- Join by code. Idempotent: re-joining a room you are already in just refreshes
-- your heartbeat, which is what makes a mid-game refresh land back in your seat.
create or replace function public.drift_join_room(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := public.drift_hash(p_token);
  v_room public.drift_rooms;
  v_seat int;
begin
  if v_hash is null then
    raise exception 'drift: a 64-character hex token is required' using errcode = '28000';
  end if;

  select * into v_room from public.drift_rooms where code = upper(trim(p_code));
  if not found then
    raise exception 'drift: no such room' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.drift_players
             where room_id = v_room.id and token_hash = v_hash) then
    update public.drift_players set last_seen = now()
     where room_id = v_room.id and token_hash = v_hash;
    return jsonb_build_object('room_id', v_room.id, 'code', v_room.code);
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'drift: room already started' using errcode = 'P0003';
  end if;

  -- Lock the room so two simultaneous joins cannot claim the same seat.
  perform 1 from public.drift_rooms where id = v_room.id for update;

  select min(s.n) into v_seat
    from generate_series(0, 9) as s(n)
   where not exists (select 1 from public.drift_players p
                      where p.room_id = v_room.id and p.seat = s.n);
  if v_seat is null then
    raise exception 'drift: room is full' using errcode = 'P0004';
  end if;

  insert into public.drift_players (room_id, token_hash, seat, name, color)
  values (v_room.id, v_hash, v_seat, public.drift_nickname(v_seat, v_hash),
          public.drift_palette(v_seat));

  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code);
end;
$$;

create or replace function public.drift_heartbeat(p_token text, p_room uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.drift_players set last_seen = now()
   where room_id = p_room and token_hash = public.drift_hash(p_token);
$$;

create or replace function public.drift_start_game(p_token text, p_room uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.drift_host_room(p_token, p_room);
  if (select count(*) from public.drift_players where room_id = p_room) < 2 then
    raise exception 'drift: need at least 2 players' using errcode = 'P0005';
  end if;
  update public.drift_rooms
     set status = 'playing', current_round = 0, updated_at = now()
   where id = p_room;
end;
$$;

-- Host-only. Mints the next round: seed, ball count and both durations are
-- decided here, on the server, and are the whole of the round's input.
create or replace function public.drift_next_round(p_token text, p_room uuid)
returns public.drift_rounds
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room  public.drift_rooms := public.drift_host_room(p_token, p_room);
  v_round public.drift_rounds;
  v_no    int;
begin
  -- Idempotent: while the current round is still unsettled (no truth yet) a
  -- retry -- a double-tap, or a host reconnecting mid-round -- hands back that
  -- same round instead of minting an extra one.
  if v_room.current_round >= 1 then
    select * into v_round from public.drift_rounds
     where room_id = p_room and round_no = v_room.current_round;
    if found and v_round.truth is null then
      return v_round;
    end if;
  end if;

  v_no := v_room.current_round + 1;
  if v_no > v_room.total_rounds then
    raise exception 'drift: game is over' using errcode = 'P0006';
  end if;

  insert into public.drift_rounds
    (room_id, round_no, seed, ball_count, duration_ms, blackout_ms, starts_at)
  values (
    p_room,
    v_no,
    (random() * 9007199254740991)::bigint,
    case when v_no % 3 = 0 then 2 + floor(random() * 2)::int else 1 end,
    4000 + floor(random() * 4001)::int,   -- 4.0s - 8.0s live
    500  + floor(random() * 901)::int,    -- 0.5s - 1.4s blackout tail
    now() + interval '2500 milliseconds'  -- shared lead-in
  )
  returning * into v_round;

  update public.drift_rooms set current_round = v_no, updated_at = now() where id = p_room;
  return v_round;
end;
$$;

-- One nudge per player per round, inside the live window. The primary key does
-- the enforcing; `on conflict do nothing` turns a double-click into a no-op
-- rather than an error the client has to special-case.
create or replace function public.drift_submit_nudge(
  p_token text, p_round uuid, p_ball int, p_tick int,
  p_dx double precision, p_dy double precision, p_strength double precision
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.drift_players := public.drift_player_in_round(p_token, p_round);
  v_round  public.drift_rounds;
  v_ok     boolean := false;
begin
  select * into v_round from public.drift_rounds where id = p_round;

  if now() < v_round.starts_at - interval '2 seconds'
     or now() > v_round.starts_at
                + make_interval(secs => (v_round.duration_ms + v_round.blackout_ms) / 1000.0)
                + interval '1 second' then
    raise exception 'drift: nudge window closed' using errcode = 'P0007';
  end if;
  if p_ball < 0 or p_ball >= v_round.ball_count then
    raise exception 'drift: no such ball' using errcode = 'P0008';
  end if;

  insert into public.drift_nudges (round_id, player_id, ball_index, apply_tick, dx, dy, strength)
  values (p_round, v_player.id, p_ball, greatest(0, p_tick),
          p_dx, p_dy, least(1.0, greatest(0.0, p_strength)))
  on conflict (round_id, player_id) do nothing;

  get diagnostics v_ok = row_count;
  return v_ok;
end;
$$;

-- The wager can be re-tapped freely until the freeze; only the last one counts.
create or replace function public.drift_lock_wager(p_token text, p_round uuid, p_wager int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.drift_players := public.drift_player_in_round(p_token, p_round);
  v_round  public.drift_rounds;
begin
  select * into v_round from public.drift_rounds where id = p_round;
  if now() > v_round.starts_at
             + make_interval(secs => (v_round.duration_ms + v_round.blackout_ms) / 1000.0)
             + interval '1 second' then
    raise exception 'drift: wager window closed' using errcode = 'P0009';
  end if;
  if p_wager not in (1, 2, 3) then
    raise exception 'drift: wager must be 1, 2 or 3' using errcode = 'P0010';
  end if;

  insert into public.drift_wagers (round_id, player_id, wager)
  values (p_round, v_player.id, p_wager)
  on conflict (round_id, player_id) do update
    set wager = excluded.wager, locked_at = now();
end;
$$;

-- One guess per player per round, inside the window after the freeze. The
-- slack on both sides is there so clock skew never eats a legitimate click.
create or replace function public.drift_submit_guess(
  p_token text, p_round uuid, p_ball int, p_gx double precision, p_gy double precision
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.drift_players := public.drift_player_in_round(p_token, p_round);
  v_round  public.drift_rounds;
  v_freeze timestamptz;
  v_ok     boolean := false;
begin
  select * into v_round from public.drift_rounds where id = p_round;
  v_freeze := v_round.starts_at
              + make_interval(secs => (v_round.duration_ms + v_round.blackout_ms) / 1000.0);

  if now() < v_freeze - interval '2 seconds' then
    raise exception 'drift: too early' using errcode = 'P0011';
  end if;
  if now() > v_freeze + interval '8 seconds' then
    raise exception 'drift: guess window closed' using errcode = 'P0012';
  end if;
  if p_ball < 0 or p_ball >= v_round.ball_count then
    raise exception 'drift: no such ball' using errcode = 'P0008';
  end if;

  insert into public.drift_guesses (round_id, player_id, ball_index, gx, gy)
  values (p_round, v_player.id, p_ball, p_gx, p_gy)
  on conflict (round_id, player_id) do nothing;

  get diagnostics v_ok = row_count;
  return v_ok;
end;
$$;

-- Host-only. Publishes the authoritative freeze positions and, in the same
-- statement, scores every guess in the round. Scoring lives here rather than in
-- the client so ten browsers can never disagree about a leaderboard.
--
-- p_truth is [{"x": <number>, "y": <number>}, …] indexed by ball.
create or replace function public.drift_publish_truth(p_token text, p_round uuid, p_truth jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_round     public.drift_rounds;
  close_px    constant double precision := 55.0;   -- the "close guess" threshold
  falloff_px  constant double precision := 400.0;  -- distance that scores zero
begin
  select * into v_round from public.drift_rounds where id = p_round;
  if not found then
    raise exception 'drift: no such round' using errcode = 'P0002';
  end if;
  perform public.drift_host_room(p_token, v_round.room_id);

  if v_round.truth is not null then
    return;  -- already settled; never rescore
  end if;
  if jsonb_typeof(p_truth) <> 'array' or jsonb_array_length(p_truth) <> v_round.ball_count then
    raise exception 'drift: truth must hold one position per ball' using errcode = 'P0013';
  end if;

  update public.drift_rounds set truth = p_truth where id = p_round;

  with scored as (
    select
      g.player_id,
      sqrt(
        power(g.gx - (p_truth -> g.ball_index ->> 'x')::double precision, 2) +
        power(g.gy - (p_truth -> g.ball_index ->> 'y')::double precision, 2)
      ) as dist,
      coalesce(w.wager, 1) as wager,
      coalesce(prev.streak, 0) as prev_streak
    from public.drift_guesses g
    left join public.drift_wagers w
      on w.round_id = g.round_id and w.player_id = g.player_id
    -- The previous round's streak is all the history a streak needs: it was
    -- computed the same way when that round settled.
    left join lateral (
      select pg.streak
        from public.drift_guesses pg
        join public.drift_rounds  pr on pr.id = pg.round_id
       where pg.player_id = g.player_id
         and pr.room_id   = v_round.room_id
         and pr.round_no  = v_round.round_no - 1
       limit 1
    ) prev on true
    where g.round_id = p_round
  ), final as (
    select
      player_id, dist, wager,
      greatest(0, round(100 * (1 - dist / falloff_px)))::int as base_points,
      case when dist <= close_px then prev_streak + 1 else 0 end as streak
    from scored
  )
  update public.drift_guesses g
     set distance    = f.dist,
         wager       = f.wager,
         base_points = f.base_points,
         streak      = f.streak,
         multiplier  = m.mult,
         points      = round(f.base_points * f.wager * m.mult)::int
    from final f
    cross join lateral (
      select case
               when f.streak >= 5 then 2.00
               when f.streak =  4 then 1.75
               when f.streak =  3 then 1.50
               else 1.00
             end::numeric(4,2) as mult
    ) m
   where g.round_id = p_round and g.player_id = f.player_id;
end;
$$;

create or replace function public.drift_finish_game(p_token text, p_room uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.drift_host_room(p_token, p_room);
  update public.drift_rooms set status = 'finished', updated_at = now() where id = p_room;
end;
$$;

-- ── Read RPC ───────────────────────────────────────────────────────────────
-- Everything a client needs, in one round trip, with the same visibility rules
-- the RLS policies enforce: your own wagers and guesses always, everyone else's
-- only once the round they belong to has been revealed.
create or replace function public.drift_state(p_token text, p_room uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := public.drift_hash(p_token);
  v_me   public.drift_players;
begin
  select * into v_me from public.drift_players
   where room_id = p_room and token_hash = v_hash;
  if not found then
    raise exception 'drift: not a member of this room' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'me', to_jsonb(v_me),
    'room', (select to_jsonb(r) from public.drift_rooms r where r.id = p_room),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.seat)
        from public.drift_players p where p.room_id = p_room), '[]'::jsonb),
    'round', (
      select to_jsonb(r) from public.drift_rounds r
       where r.room_id = p_room order by r.round_no desc limit 1),
    'guesses', coalesce((
      select jsonb_agg(to_jsonb(g))
        from public.drift_guesses g
        join public.drift_rounds r on r.id = g.round_id
       where r.room_id = p_room
         and (r.truth is not null or g.player_id = v_me.id)), '[]'::jsonb),
    'wagers', coalesce((
      select jsonb_agg(to_jsonb(w))
        from public.drift_wagers w
        join public.drift_rounds r on r.id = w.round_id
       where r.room_id = p_room
         and (r.truth is not null or w.player_id = v_me.id)), '[]'::jsonb)
  );
end;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────
-- There is no auth session, so players arrive as `anon`. The helper functions
-- stay callable; everything that writes is listed here explicitly.

do $$
declare fn text;
begin
  foreach fn in array array[
    'drift_create_room(text, int)',
    'drift_join_room(text, text)',
    'drift_heartbeat(text, uuid)',
    'drift_start_game(text, uuid)',
    'drift_next_round(text, uuid)',
    'drift_finish_game(text, uuid)',
    'drift_publish_truth(text, uuid, jsonb)',
    'drift_lock_wager(text, uuid, int)',
    'drift_submit_guess(text, uuid, int, double precision, double precision)',
    'drift_submit_nudge(text, uuid, int, int, double precision, double precision, double precision)',
    'drift_state(text, uuid)',
    'drift_server_time()'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated', fn);
  end loop;
end $$;

-- drift_player / drift_player_in_round / drift_host_room take a token and would
-- otherwise let anyone probe membership directly; they exist only for the RPCs
-- above to call internally.
-- drift_is_member and drift_round_room stay executable by anon: RLS policies
-- run as the querying role, so that role needs EXECUTE on the functions they
-- call. Neither reveals anything a member could not already read.
revoke all on function public.drift_player(text, uuid)          from public, anon, authenticated;
revoke all on function public.drift_player_in_round(text, uuid) from public, anon, authenticated;
revoke all on function public.drift_host_room(text, uuid)       from public, anon, authenticated;

grant select on public.drift_rooms, public.drift_players, public.drift_rounds,
                public.drift_nudges, public.drift_wagers, public.drift_guesses
  to anon, authenticated;

-- Live signalling runs entirely over Realtime Broadcast channels, which carry
-- no request headers and so cannot evaluate the policies above. Nothing here is
-- published to postgres_changes on purpose.

-- Reconciliation read. Clients call this at the freeze to fold in any nudge the
-- broadcast channel dropped, so the frame everyone guesses against is the one
-- the host is about to publish as truth. It goes through an RPC rather than a
-- direct table read so the game never depends on request headers reaching RLS.
create or replace function public.drift_nudges_for(p_token text, p_round uuid)
returns setof public.drift_nudges
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.drift_player_in_round(p_token, p_round);
  return query select * from public.drift_nudges where round_id = p_round;
end;
$$;

revoke all on function public.drift_nudges_for(text, uuid) from public;
grant execute on function public.drift_nudges_for(text, uuid) to anon, authenticated;
