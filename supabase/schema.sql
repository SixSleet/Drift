-- ---------------------------------------------------------------------------
-- Wordforge — schema, row-level security and write RPCs.
--
-- Run this once against a Supabase project (SQL Editor, or `supabase db push`
-- if you keep it under supabase/migrations/). It is re-runnable: it drops and
-- rebuilds every wf_* object, including the seeded word list at the bottom.
--
-- The game
-- --------
-- Same shape as that word-guessing game everyone knows, with twists that
-- keep it from just being a five-letter clone:
--
--   * Word length varies round to round (4 or 5 letters — longer proved too
--     hard to be fun) instead of always five.
--   * Most rounds must start with the last letter of the previous round's
--     word (see `chain_letter` / `chain_broken` below) — you can't lean on
--     one memorised opening guess for the whole match.
--   * Every round has a hard clock from `starts_at` (`time_limit_ms`,
--     5 minutes normally), enforced server-side in both wf_submit_guess
--     (rejects a late guess) and wf_check_settle (time running out is
--     itself a completion condition, in every mode) — not just a
--     client-side display.
--   * wf_next_round also rolls a random party-game `event` for the round
--     (40% none, 15% each of double_points, extra_guess, blitz — which
--     shortens time_limit_ms to 90s — and sudden_death, which drops
--     max_guesses by one), baked into that round's guess budget and time
--     limit at mint time so every client just reads the consequences off
--     the round row rather than re-deriving them.
--
-- Three modes share this schema:
--
--   * Solo — a room of exactly one, auto-started the instant it's created.
--     Same individual guess budget as PvP; needs no special-casing in RLS
--     or scoring, since both already key off "your own guesses."
--   * PvP  — two players race the same secret at the same time. Each only
--     ever sees their own guesses; the opponent is a live aggregate ("ghost")
--     sent over Realtime Broadcast, never through a table read. The round
--     ends the instant either player solves it — first to the word wins,
--     however many guesses it took — rather than waiting for both to finish.
--   * Coop — up to ten players share one board and one guess budget
--     (word_length + 3, fixed regardless of headcount, so a bigger team has
--     to coordinate rather than out-brute-force a small one). Anyone can
--     submit the next guess at any time.
--
-- Identity without accounts
-- -------------------------
-- There is no login and no auth session. Each browser mints a 256-bit random
-- token on first visit and keeps it in localStorage. The server never stores
-- the token itself, only its SHA-256 hash, and a player "is" whoever presents
-- the token matching a wf_players row.
--
-- The token reaches Postgres two ways, deliberately:
--
--   * as an argument to the RPCs below, which are the ONLY write path, and
--   * as the `x-wf-player` request header, which PostgREST exposes as
--     `request.headers` and which the RLS policies read.
--
-- So the policies gate direct table access on room membership, and the RPCs do
-- not depend on header plumbing to work.
--
-- Keeping the secret secret
-- --------------------------
-- The actual answer for a round lives in wf_round_secrets, a table with RLS
-- enabled and *zero* policies — completely unreachable from anon/authenticated
-- directly, reachable only from inside SECURITY DEFINER functions, which
-- bypass RLS. wf_words (the answer pool to draw from) is locked the same way,
-- so the client can never fetch "what words are even possible at length 6".
--
-- Once a round settles, wf_rounds.revealed_secret — a plain, normally-visible
-- column — gets filled in. It is genuinely NULL until then, so no
-- column-masking trickery is needed: the same SELECT that was always allowed
-- simply starts returning a value once the round is safe to reveal.
--
-- Guess visibility is mode-aware in a single policy (wf_guesses_select):
-- in Coop everyone sees every guess live; in PvP you only ever see your own
-- until the round settles, at which point both boards open up for review.
--
-- Settling a round (wf_check_settle) is deliberately NOT host-only, unlike
-- round advancement. It independently re-validates the real completion
-- condition server-side, so it's safe for any room member to call, repeatedly,
-- without depending on the host's tab staying open.
-- ---------------------------------------------------------------------------

-- Supabase ships pgcrypto in the `extensions` schema on every project; this is
-- here so the file also stands up on a plain Postgres that does not.
create extension if not exists pgcrypto with schema extensions;

-- Dropping the tables cascades onto everything that depends on them —
-- policies, indexes, and every RPC below, whatever its current signature —
-- which is what makes this file safe to re-run after a signature changes.
drop table if exists public.wf_results       cascade;
drop table if exists public.wf_guesses       cascade;
drop table if exists public.wf_round_secrets cascade;
drop table if exists public.wf_rounds        cascade;
drop table if exists public.wf_players       cascade;
drop table if exists public.wf_words         cascade;
drop table if exists public.wf_rooms         cascade;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table public.wf_rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Z2-9]{4}$'),
  host_token_hash  text not null,
  mode             text not null check (mode in ('pvp', 'coop', 'solo')),
  status           text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  total_rounds     int  not null default 6 check (total_rounds between 1 and 20),
  current_round    int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.wf_players (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.wf_rooms(id) on delete cascade,
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  seat        int  not null check (seat between 0 and 9),
  name        text not null,
  color       text not null,
  is_host     boolean not null default false,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  unique (room_id, seat),
  unique (room_id, token_hash)
);

-- The answer pool. RLS-locked with no policies at all (see header) — only
-- SECURITY DEFINER functions (wf_next_round) can ever read from it.
create table public.wf_words (
  word    text primary key,
  length  int  not null check (length between 4 and 7)
);
alter table public.wf_words enable row level security;

create table public.wf_rounds (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references public.wf_rooms(id) on delete cascade,
  round_no           int  not null check (round_no >= 1),
  word_length        int  not null check (word_length between 4 and 5),
  max_guesses        int  not null check (max_guesses between 4 and 12),
  chain_letter       char(1),
  chain_broken       boolean not null default false,
  starts_at          timestamptz not null,
  status             text not null default 'active' check (status in ('active', 'settled')),
  settled_at         timestamptz,
  revealed_secret    text,          -- genuinely NULL until settle; see header
  winner_player_id   uuid references public.wf_players(id),   -- pvp only
  team_solved        boolean,                                  -- coop only
  pool_used          int  not null default 0,                  -- coop only
  event              text not null default 'none'
                       check (event in ('none', 'double_points', 'extra_guess', 'blitz', 'sudden_death')),
  time_limit_ms      int  not null default 300000 check (time_limit_ms > 0), -- blitz shortens this
  created_at         timestamptz not null default now(),
  unique (room_id, round_no)
);

-- The live secret for a round. RLS-locked with no policies (see header) —
-- only SECURITY DEFINER functions ever read or write it.
create table public.wf_round_secrets (
  round_id  uuid primary key references public.wf_rounds(id) on delete cascade,
  secret    text not null
);
alter table public.wf_round_secrets enable row level security;

create table public.wf_guesses (
  round_id     uuid not null references public.wf_rounds(id) on delete cascade,
  player_id    uuid not null references public.wf_players(id) on delete cascade,
  attempt_no   int  not null check (attempt_no >= 1),
  word         text not null,
  feedback     text[] not null,   -- one of 'hit' | 'present' | 'miss' per letter
  created_at   timestamptz not null default now(),
  primary key (round_id, player_id, attempt_no)
);

create table public.wf_results (
  round_id      uuid not null references public.wf_rounds(id) on delete cascade,
  player_id     uuid not null references public.wf_players(id) on delete cascade,
  solved        boolean not null,
  guesses_used  int  not null,
  elapsed_ms    int,               -- pvp only
  points        int  not null default 0,
  primary key (round_id, player_id)
);

alter table public.wf_rooms   enable row level security;
alter table public.wf_players enable row level security;
alter table public.wf_rounds  enable row level security;
alter table public.wf_guesses enable row level security;
alter table public.wf_results enable row level security;

-- ── Identity & membership helpers ───────────────────────────────────────────

create or replace function public.wf_hash(p_token text)
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

create or replace function public.wf_header_hash()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select public.wf_hash(
    nullif(current_setting('request.headers', true), '')::json ->> 'x-wf-player'
  );
$$;

create or replace function public.wf_is_member(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.wf_players
    where room_id = p_room and token_hash = public.wf_header_hash()
  );
$$;

create or replace function public.wf_round_room(p_round uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select room_id from public.wf_rounds where id = p_round;
$$;

create or replace function public.wf_round_mode(p_round uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.mode from public.wf_rounds r join public.wf_rooms m on m.id = r.room_id
   where r.id = p_round;
$$;

create or replace function public.wf_nickname(p_seat integer, p_salt text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
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

create or replace function public.wf_palette(p_seat integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select (array[
    '#ff5c7a','#4bd0ff','#ffd166','#7be495','#c792ea',
    '#ff9f45','#5eead4','#f472b6','#93c5fd','#fde047'
  ])[(p_seat % 10) + 1];
$$;

create or replace function public.wf_server_time()
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$ select now() $$;

-- ── RLS policies ─────────────────────────────────────────────────────────
-- wf_words and wf_round_secrets are intentionally excluded: RLS is enabled
-- on both above, and neither gets a single policy, which makes them
-- unreadable to anon/authenticated no matter what — see header.

create policy wf_rooms_select on public.wf_rooms
  for select to anon, authenticated
  using (public.wf_is_member(id));

create policy wf_players_select on public.wf_players
  for select to anon, authenticated
  using (public.wf_is_member(room_id));

create policy wf_rounds_select on public.wf_rounds
  for select to anon, authenticated
  using (public.wf_is_member(room_id));

-- Coop: every guess is visible to the whole room as soon as it lands.
-- PvP: only your own guesses, until the round settles — then both boards
-- open up so the reveal/board screens can show what happened.
create policy wf_guesses_select on public.wf_guesses
  for select to anon, authenticated
  using (
    public.wf_is_member(public.wf_round_room(round_id))
    and (
      public.wf_round_mode(round_id) = 'coop'
      or exists (
        select 1 from public.wf_players p
         where p.id = wf_guesses.player_id and p.token_hash = public.wf_header_hash()
      )
      or exists (
        select 1 from public.wf_rounds r
         where r.id = wf_guesses.round_id and r.status = 'settled'
      )
    )
  );

create policy wf_results_select on public.wf_results
  for select to anon, authenticated
  using (public.wf_is_member(public.wf_round_room(round_id)));

-- ── Internal-only helpers ────────────────────────────────────────────────
-- These take a token and would otherwise let anyone probe membership
-- directly; they exist only for the RPCs below to call internally, and are
-- revoked from anon/authenticated in the grants block.

create or replace function public.wf_player(p_token text, p_room uuid)
returns public.wf_players
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_player public.wf_players;
begin
  select * into v_player from public.wf_players
   where room_id = p_room and token_hash = public.wf_hash(p_token);
  if not found then
    raise exception 'wordforge: not a member of this room' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

create or replace function public.wf_player_in_round(p_token text, p_round uuid)
returns public.wf_players
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_player public.wf_players;
begin
  select p.* into v_player
    from public.wf_players p
    join public.wf_rounds r on r.room_id = p.room_id
   where r.id = p_round and p.token_hash = public.wf_hash(p_token);
  if not found then
    raise exception 'wordforge: not a member of this room' using errcode = '42501';
  end if;
  return v_player;
end;
$$;

create or replace function public.wf_host_room(p_token text, p_room uuid)
returns public.wf_rooms
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_room public.wf_rooms;
begin
  select * into v_room from public.wf_rooms
   where id = p_room and host_token_hash = public.wf_hash(p_token);
  if not found then
    raise exception 'wordforge: host only' using errcode = '42501';
  end if;
  return v_room;
end;
$$;

-- ── Scoring ──────────────────────────────────────────────────────────────
-- Standard two-pass Wordle scoring: hits first (and removed from the pool of
-- letters still available to match), then presents against what's left, so a
-- guess with a repeated letter never scores more "present"s than the secret
-- actually contains copies of that letter.

create or replace function public.wf_score_guess(p_guess text, p_secret text)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  n int := length(p_secret);
  feedback text[] := array_fill('miss'::text, array[n]);
  secret_chars text[] := regexp_split_to_array(p_secret, '');
  guess_chars  text[] := regexp_split_to_array(p_guess, '');
  remaining int[] := array_fill(0, array[26]);
  idx int;
begin
  if length(p_guess) <> n then
    raise exception 'wordforge: guess/secret length mismatch';
  end if;

  for i in 1..n loop
    if guess_chars[i] = secret_chars[i] then
      feedback[i] := 'hit';
    else
      idx := ascii(secret_chars[i]) - ascii('a') + 1;
      if idx between 1 and 26 then remaining[idx] := remaining[idx] + 1; end if;
    end if;
  end loop;

  for i in 1..n loop
    if feedback[i] <> 'hit' then
      idx := ascii(guess_chars[i]) - ascii('a') + 1;
      if idx between 1 and 26 and remaining[idx] > 0 then
        feedback[i] := 'present';
        remaining[idx] := remaining[idx] - 1;
      end if;
    end if;
  end loop;

  return feedback;
end;
$$;

-- ── Room lifecycle ───────────────────────────────────────────────────────

create or replace function public.wf_create_room(p_token text, p_mode text, p_total_rounds integer default 6)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash  text := public.wf_hash(p_token);
  v_code  text;
  v_room  public.wf_rooms;
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try   int  := 0;
begin
  if v_hash is null then
    raise exception 'wordforge: a 64-character hex token is required' using errcode = '28000';
  end if;
  if p_mode not in ('pvp', 'coop', 'solo') then
    raise exception 'wordforge: mode must be pvp, coop or solo' using errcode = 'P0001';
  end if;

  loop
    v_try := v_try + 1;
    v_code := '';
    for _ in 1..4 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    begin
      insert into public.wf_rooms (code, host_token_hash, mode, total_rounds)
      values (v_code, v_hash, p_mode, greatest(1, least(20, coalesce(p_total_rounds, 6))))
      returning * into v_room;
      exit;
    exception when unique_violation then
      if v_try > 40 then raise exception 'wordforge: could not allocate a room code'; end if;
    end;
  end loop;

  insert into public.wf_players (room_id, token_hash, seat, name, color, is_host)
  values (v_room.id, v_hash, 0, public.wf_nickname(0, v_hash), public.wf_palette(0), true);

  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'mode', v_room.mode);
end;
$$;

create or replace function public.wf_join_room(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := public.wf_hash(p_token);
  v_room public.wf_rooms;
  v_seat int;
  v_cap  int;
begin
  if v_hash is null then
    raise exception 'wordforge: a 64-character hex token is required' using errcode = '28000';
  end if;

  select * into v_room from public.wf_rooms where code = upper(trim(p_code));
  if not found then
    raise exception 'wordforge: no such room' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.wf_players
             where room_id = v_room.id and token_hash = v_hash) then
    update public.wf_players set last_seen = now()
     where room_id = v_room.id and token_hash = v_hash;
    return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'mode', v_room.mode);
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'wordforge: room already started' using errcode = 'P0003';
  end if;

  perform 1 from public.wf_rooms where id = v_room.id for update;

  -- seats 0..cap; solo has none to spare beyond the host who created it
  v_cap := case when v_room.mode = 'pvp' then 1
                when v_room.mode = 'solo' then 0
                else 9 end;
  select min(s.n) into v_seat
    from generate_series(0, v_cap) as s(n)
   where not exists (select 1 from public.wf_players p
                      where p.room_id = v_room.id and p.seat = s.n);
  if v_seat is null then
    raise exception 'wordforge: room is full' using errcode = 'P0004';
  end if;

  insert into public.wf_players (room_id, token_hash, seat, name, color)
  values (v_room.id, v_hash, v_seat, public.wf_nickname(v_seat, v_hash),
          public.wf_palette(v_seat));

  return jsonb_build_object('room_id', v_room.id, 'code', v_room.code, 'mode', v_room.mode);
end;
$$;

create or replace function public.wf_heartbeat(p_token text, p_room uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.wf_players set last_seen = now()
   where room_id = p_room and token_hash = public.wf_hash(p_token);
$$;

create or replace function public.wf_start_game(p_token text, p_room uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.wf_rooms := public.wf_host_room(p_token, p_room);
begin
  if v_room.mode <> 'solo' and (select count(*) from public.wf_players where room_id = p_room) < 2 then
    raise exception 'wordforge: need at least 2 players' using errcode = 'P0005';
  end if;
  update public.wf_rooms
     set status = 'playing', current_round = 0, updated_at = now()
   where id = p_room;
end;
$$;

create or replace function public.wf_finish_game(p_token text, p_room uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.wf_host_room(p_token, p_room);
  update public.wf_rooms set status = 'finished', updated_at = now() where id = p_room;
end;
$$;

-- ── Rounds ───────────────────────────────────────────────────────────────
-- Host-only, unlike settlement (see header). Picks a random word length
-- (4-5 — longer proved too hard to be fun), tries to honour the
-- chain-letter constraint against the answer pool, and falls back to an
-- unconstrained pick — recording chain_broken — rather than ever failing a
-- round outright. Also rolls this round's random event (see header).

create or replace function public.wf_next_round(p_token text, p_room uuid)
returns public.wf_rounds
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room  public.wf_rooms := public.wf_host_room(p_token, p_room);
  v_round public.wf_rounds;
  v_no    int;
  v_len   int;
  v_prev_secret text;
  v_chain_letter char(1);
  v_chain_broken boolean := false;
  v_secret text;
  v_max_guesses int;
  v_event text;
  v_time_limit_ms int;
begin
  if v_room.current_round >= 1 then
    select * into v_round from public.wf_rounds
     where room_id = p_room and round_no = v_room.current_round;
    if found and v_round.status = 'active' then
      return v_round;
    end if;
  end if;

  v_no := v_room.current_round + 1;
  if v_no > v_room.total_rounds then
    raise exception 'wordforge: game is over' using errcode = 'P0006';
  end if;

  v_len := 4 + floor(random() * 2)::int; -- 4 or 5 only

  if v_no > 1 then
    select revealed_secret into v_prev_secret
      from public.wf_rounds where room_id = p_room and round_no = v_no - 1;
    if v_prev_secret is not null then
      v_chain_letter := lower(right(v_prev_secret, 1));
    end if;
  end if;

  select word into v_secret from public.wf_words
   where length = v_len
     and (v_chain_letter is null or left(word, 1) = v_chain_letter)
     and word not in (
       select rs.secret from public.wf_round_secrets rs
        join public.wf_rounds r2 on r2.id = rs.round_id
       where r2.room_id = p_room)
   order by random() limit 1;

  if v_secret is null and v_chain_letter is not null then
    v_chain_broken := true;
    select word into v_secret from public.wf_words
     where length = v_len
       and word not in (
         select rs.secret from public.wf_round_secrets rs
          join public.wf_rounds r2 on r2.id = rs.round_id
         where r2.room_id = p_room)
     order by random() limit 1;
  end if;

  if v_secret is null then
    raise exception 'wordforge: no words left for this length' using errcode = 'P0014';
  end if;

  -- coop's shared pool gets extra room for a team to coordinate; pvp and
  -- solo both get the same individual budget, so a solo run is exactly as
  -- hard as your half of a duel.
  v_max_guesses := v_len + case when v_room.mode = 'coop' then 3 else 2 end;
  v_time_limit_ms := 300000;

  -- A party-game random event, same odds every round: 40% nothing, 15%
  -- each of the four spice-it-up events.
  v_event := case
    when random() < 0.40 then 'none'
    when random() < 0.55 then 'double_points'
    when random() < 0.70 then 'extra_guess'
    when random() < 0.85 then 'blitz'
    else 'sudden_death'
  end;

  if v_event = 'extra_guess' then
    v_max_guesses := v_max_guesses + 1;
  elsif v_event = 'sudden_death' then
    v_max_guesses := greatest(v_len, v_max_guesses - 1);
  elsif v_event = 'blitz' then
    v_time_limit_ms := 90000;
  end if;

  insert into public.wf_rounds
    (room_id, round_no, word_length, max_guesses, chain_letter, chain_broken, starts_at,
     event, time_limit_ms)
  values (
    p_room, v_no, v_len, v_max_guesses,
    case when v_chain_broken then null else v_chain_letter end,
    v_chain_broken,
    now() + interval '3 seconds',
    v_event, v_time_limit_ms
  )
  returning * into v_round;

  insert into public.wf_round_secrets (round_id, secret) values (v_round.id, v_secret);

  update public.wf_rooms set current_round = v_no, updated_at = now() where id = p_room;
  return v_round;
end;
$$;

create or replace function public.wf_submit_guess(p_token text, p_round uuid, p_word text)
returns public.wf_guesses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.wf_players := public.wf_player_in_round(p_token, p_round);
  v_round  public.wf_rounds;
  v_mode   text;
  v_secret text;
  v_word   text := lower(p_word);
  v_attempt int;
  v_feedback text[];
  v_all_hit text[];
  v_row public.wf_guesses;
begin
  select * into v_round from public.wf_rounds where id = p_round for update;
  select mode into v_mode from public.wf_rooms where id = v_round.room_id;

  if v_round.status <> 'active' then
    raise exception 'wordforge: round is over' using errcode = 'P0015';
  end if;
  if now() < v_round.starts_at then
    raise exception 'wordforge: round has not started yet' using errcode = 'P0016';
  end if;
  if now() >= v_round.starts_at + make_interval(secs => v_round.time_limit_ms / 1000.0) then
    raise exception 'wordforge: time is up for this round' using errcode = 'P0021';
  end if;
  if length(v_word) <> v_round.word_length or v_word !~ '^[a-z]+$' then
    raise exception 'wordforge: guess must be a % letter word', v_round.word_length using errcode = 'P0017';
  end if;

  v_all_hit := array_fill('hit'::text, array[v_round.word_length]);

  if v_mode = 'coop' then
    if exists (select 1 from public.wf_guesses where round_id = p_round and feedback = v_all_hit) then
      raise exception 'wordforge: already solved' using errcode = 'P0019';
    end if;
    if v_round.pool_used >= v_round.max_guesses then
      raise exception 'wordforge: the shared guess pool is empty' using errcode = 'P0018';
    end if;
    v_attempt := v_round.pool_used + 1;
    update public.wf_rounds set pool_used = v_attempt where id = p_round;
  else
    if exists (select 1 from public.wf_guesses
                where round_id = p_round and player_id = v_player.id and feedback = v_all_hit) then
      raise exception 'wordforge: already solved' using errcode = 'P0019';
    end if;
    select coalesce(max(attempt_no), 0) + 1 into v_attempt
      from public.wf_guesses where round_id = p_round and player_id = v_player.id;
    if v_attempt > v_round.max_guesses then
      raise exception 'wordforge: no guesses left' using errcode = 'P0018';
    end if;
  end if;

  select secret into v_secret from public.wf_round_secrets where round_id = p_round;
  v_feedback := public.wf_score_guess(v_word, v_secret);

  insert into public.wf_guesses (round_id, player_id, attempt_no, word, feedback)
  values (p_round, v_player.id, v_attempt, v_word, v_feedback)
  returning * into v_row;

  return v_row;
end;
$$;

-- Anyone-callable and idempotent (see header): re-derives "is this round
-- actually finished" from the guesses table itself rather than trusting the
-- caller, so it's safe for every client to poll during the 'settling' phase.
create or replace function public.wf_check_settle(p_token text, p_round uuid)
returns public.wf_rounds
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.wf_players := public.wf_player_in_round(p_token, p_round);
  v_round  public.wf_rounds;
  v_mode   text;
  v_secret text;
  v_all_hit text[];
  v_time_up boolean;
  v_any_solved boolean;
  v_all_exhausted boolean;
  v_done boolean;
  v_solved boolean;
  v_used int;
  v_pts int;
  v_elapsed_ms int;
  v_base int;
  v_bonus int;
  v_winner uuid;
  v_best_time timestamptz := null;
  v_mult int;
  rec record;
begin
  select * into v_round from public.wf_rounds where id = p_round for update;
  select mode into v_mode from public.wf_rooms where id = v_round.room_id;

  if v_round.status = 'settled' then
    return v_round;
  end if;

  v_all_hit := array_fill('hit'::text, array[v_round.word_length]);
  v_time_up := now() >= v_round.starts_at + make_interval(secs => v_round.time_limit_ms / 1000.0);
  v_mult := case when v_round.event = 'double_points' then 2 else 1 end;

  if v_mode = 'coop' then
    v_done := v_time_up
              or v_round.pool_used >= v_round.max_guesses
              or exists (select 1 from public.wf_guesses where round_id = p_round and feedback = v_all_hit);
  else
    -- PvP and Solo: the round ends the instant anyone solves it (first to
    -- the word wins the round), once everyone still playing has run out of
    -- guesses, or when time runs out — whichever comes first.
    select bool_or(
      exists (select 1 from public.wf_guesses g
               where g.round_id = p_round and g.player_id = p.id and g.feedback = v_all_hit)
    ) into v_any_solved
    from public.wf_players p where p.room_id = v_round.room_id;

    select bool_and(
      (select count(*) from public.wf_guesses g2
        where g2.round_id = p_round and g2.player_id = p.id) >= v_round.max_guesses
    ) into v_all_exhausted
    from public.wf_players p where p.room_id = v_round.room_id;

    v_done := v_time_up or coalesce(v_any_solved, false) or coalesce(v_all_exhausted, false);
  end if;

  if not v_done then
    raise exception 'wordforge: round is not finished yet' using errcode = 'P0020';
  end if;

  select secret into v_secret from public.wf_round_secrets where round_id = p_round;
  update public.wf_rounds set status = 'settled', settled_at = now(), revealed_secret = v_secret
   where id = p_round;

  if v_mode = 'coop' then
    select exists (select 1 from public.wf_guesses where round_id = p_round and feedback = v_all_hit) into v_solved;
    select count(*) into v_used from public.wf_guesses where round_id = p_round;
    v_pts := case when v_solved then greatest(0, v_round.max_guesses - v_used + 1) * 10 * v_mult else 0 end;
    update public.wf_rounds set team_solved = v_solved where id = p_round;
    insert into public.wf_results (round_id, player_id, solved, guesses_used, points)
      select p_round, p.id, v_solved, v_used, v_pts from public.wf_players p where p.room_id = v_round.room_id;
  else
    for rec in
      select p.id as player_id,
             exists(select 1 from public.wf_guesses g where g.round_id = p_round and g.player_id = p.id
                     and g.feedback = v_all_hit) as solved,
             (select count(*) from public.wf_guesses g2
               where g2.round_id = p_round and g2.player_id = p.id) as used,
             (select min(g3.created_at) from public.wf_guesses g3
               where g3.round_id = p_round and g3.player_id = p.id and g3.feedback = v_all_hit) as solved_at
        from public.wf_players p where p.room_id = v_round.room_id
    loop
      if rec.solved then
        v_elapsed_ms := extract(epoch from (rec.solved_at - v_round.starts_at)) * 1000;
        v_base := greatest(0, v_round.max_guesses - rec.used + 1) * 10;
        v_bonus := case when v_elapsed_ms <= v_round.word_length * 4000 then 20
                        when v_elapsed_ms <= v_round.word_length * 7000 then 10
                        else 0 end;
        v_pts := (v_base + v_bonus) * v_mult;
      else
        v_elapsed_ms := null;
        v_pts := 0;
      end if;

      insert into public.wf_results (round_id, player_id, solved, guesses_used, elapsed_ms, points)
      values (p_round, rec.player_id, rec.solved, rec.used, v_elapsed_ms, v_pts);

      -- First to solve wins the round, full stop — not fewest guesses.
      if rec.solved and (v_best_time is null or rec.solved_at < v_best_time) then
        v_best_time := rec.solved_at;
        v_winner := rec.player_id;
      end if;
    end loop;

    update public.wf_rounds set winner_player_id = v_winner where id = p_round;
  end if;

  select * into v_round from public.wf_rounds where id = p_round;
  return v_round;
end;
$$;

-- Single read RPC the whole client polls/refetches on every `poke`. Bundles
-- room, membership, players, the latest round, visibility-filtered guesses,
-- settled results and a derived leaderboard into one jsonb payload so the
-- client never has to reason about RLS itself.
create or replace function public.wf_state(p_token text, p_room uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text := public.wf_hash(p_token);
  v_me   public.wf_players;
begin
  select * into v_me from public.wf_players where room_id = p_room and token_hash = v_hash;
  if not found then
    raise exception 'wordforge: not a member of this room' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'me', to_jsonb(v_me),
    'room', (select to_jsonb(r) from public.wf_rooms r where r.id = p_room),
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.seat)
        from public.wf_players p where p.room_id = p_room), '[]'::jsonb),
    'round', (select to_jsonb(r) from public.wf_rounds r
               where r.room_id = p_room order by r.round_no desc limit 1),
    'guesses', coalesce((
      select jsonb_agg(to_jsonb(g) order by g.round_id, g.attempt_no)
        from public.wf_guesses g
        join public.wf_rounds r on r.id = g.round_id
        join public.wf_rooms  m on m.id = r.room_id
       where r.room_id = p_room
         and (m.mode = 'coop' or g.player_id = v_me.id or r.status = 'settled')
    ), '[]'::jsonb),
    -- wf_results rows only ever exist for fully-settled, publicly-visible
    -- rounds -- no secrecy gate needed, unlike guesses.
    'results', coalesce((
      select jsonb_agg(to_jsonb(res))
        from public.wf_results res
        join public.wf_rounds rr on rr.id = res.round_id
       where rr.room_id = p_room
    ), '[]'::jsonb),
    'leaderboard', coalesce((
      select jsonb_agg(jsonb_build_object('player_id', x.player_id, 'total', x.total) order by x.total desc)
      from (
        select res.player_id, sum(res.points) as total
          from public.wf_results res
          join public.wf_rounds rr on rr.id = res.round_id
         where rr.room_id = p_room
         group by res.player_id
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────
-- There is no auth session, so players arrive as `anon`. The helper functions
-- that RLS policies call stay callable; everything that writes is listed
-- here explicitly.

do $$
declare fn text;
begin
  foreach fn in array array[
    'wf_create_room(text, text, integer)',
    'wf_join_room(text, text)',
    'wf_heartbeat(text, uuid)',
    'wf_start_game(text, uuid)',
    'wf_finish_game(text, uuid)',
    'wf_next_round(text, uuid)',
    'wf_submit_guess(text, uuid, text)',
    'wf_check_settle(text, uuid)',
    'wf_state(text, uuid)',
    'wf_server_time()'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    execute format('grant execute on function public.%s to anon, authenticated', fn);
  end loop;
end $$;

-- wf_player / wf_player_in_round / wf_host_room take a token and would
-- otherwise let anyone probe membership directly; they exist only for the
-- RPCs above to call internally.
-- wf_score_guess is an internal scoring primitive with no reason to be
-- called directly by a client.
-- wf_is_member, wf_round_room and wf_round_mode stay executable by anon: RLS
-- policies run as the querying role, so that role needs EXECUTE on the
-- functions they call. None of the three reveals anything a member could not
-- already read.
revoke all on function public.wf_player(text, uuid)          from public, anon, authenticated;
revoke all on function public.wf_player_in_round(text, uuid) from public, anon, authenticated;
revoke all on function public.wf_host_room(text, uuid)       from public, anon, authenticated;
revoke all on function public.wf_score_guess(text, text)     from public, anon, authenticated;

grant select on public.wf_rooms, public.wf_players, public.wf_rounds,
                public.wf_guesses, public.wf_results
  to anon, authenticated;

-- Live signalling runs entirely over Realtime Broadcast channels, which carry
-- no request headers and so cannot evaluate the policies above. Nothing here
-- is published to postgres_changes on purpose. The two payload shapes:
--
--   poke  — content-free "something changed, refetch wf_state" signal.
--   ghost — PvP only, always an aggregate {attempts, hits, present, solved}
--           describing the sender's own progress. No word, no per-letter
--           feedback ever crosses the wire this way.

-- ── Seed word list ───────────────────────────────────────────────────────
-- 4704 curated answers across lengths 4-7, drawn from a common-English
-- frequency corpus and passed through a profanity blocklist. This is the
-- only source wf_next_round ever draws a secret from; wf_words itself is
-- never readable by a client (see header).

insert into public.wf_words (word, length)
  select w, 4 from unnest(array['able','acer','acid','acne','acre','acts','adds','aged','ages','aids','aims','alan','also','alto','anna','anti','apps','aqua','arch','area','arms','army','arts','asks','atom','auto','away','axis','babe','baby','back','bags','bald','ball','band','bang','bank','bare','barn','bars','base','bass','bath','beam','bean','bear','beat','beds','beef','been','beer','bell','belt','bend','bent','best','beta','beth','bias','bids','bike','bill','bind','bios','bird','bits','blah','blog','blow','blue','boat','body','bold','bolt','bomb','bond','bone','book','bool','boom','boot','born','boss','both','bowl','boys','brad','bras','buck','bugs','bulk','bull','burn','bush','busy','buys','buzz','byte','cafe','cage','cake','call','calm','came','camp','cams','cant','cape','caps','carb','card','care','carl','cars','cart','casa','case','cash','cast','cats','cave','cell','cent','chad','char','chat','chef','chip','ciao','cite','city','clan','clay','clip','club','coal','coat','code','coin','cold','cole','come','comm','comp','conf','cons','cook','cool','cope','copy','cord','core','cork','corn','cost','cove','crew','crop','cube','cult','cups','cure','cute','cuts','dale','dame','dans','dare','dark','dash','data','date','dawn','days','dead','deaf','deal','dean','dear','debt','deck','deep','deer','dell','demo','deny','desk','dial','dice','died','dies','diet','diff','dirt','disc','dish','disk','dive','dock','docs','does','dogs','doll','dome','done','doom','door','dose','down','drag','draw','drew','drop','drug','drum','dual','duck','dude','duke','dumb','dump','dust','duty','each','earl','earn','ears','ease','east','easy','echo','edge','edit','eggs','else','emma','ends','epic','eric','euro','even','ever','evil','exam','exec','exit','expo','eyed','eyes','face','fact','fail','fair','fake','fall','fame','fans','fare','farm','fast','fate','fear','feat','feed','feel','fees','feet','fell','felt','file','fill','film','find','fine','fire','firm','fish','fist','fits','five','flag','flat','flex','flip','flow','flux','foam','fold','folk','font','food','fool','foot','ford','fork','form','fort','foul','four','free','frog','from','fuel','fuji','full','fund','funk','gage','gain','gale','game','gang','gaps','gate','gave','gays','gear','geek','gene','gets','gift','girl','give','glad','glen','glow','goal','goat','gods','goes','gold','golf','gone','good','gore','grab','grad','gray','grew','grey','grid','grip','grow','gulf','guns','guru','guys','hack','hair','half','hall','halo','hand','hang','hard','harm','hart','hash','hate','hats','have','hawk','head','hear','heat','heel','held','help','herb','here','hero','hide','high','hill','hint','hire','hist','hits','hold','hole','holy','home','hong','hood','hook','hope','horn','hose','host','hour','huge','hull','hung','hunt','hurt','icon','idea','idle','idol','inch','info','inns','into','iron','isle','item','jack','jade','jail','jake','jane','java','jazz','jean','jeep','jeff','jets','jews','jill','jobs','john','join','joke','josh','judy','jump','junk','jury','just','keen','keep','keno','kent','kept','keys','kick','kids','kill','kind','king','kirk','kiss','kits','knee','knew','knit','know','kyle','labs','lace','lack','lady','laid','lake','lamb','lamp','land','lane','lang','last','late','lawn','laws','lazy','lead','leaf','lean','left','legs','lens','less','lets','levy','libs','lies','life','lift','like','lime','line','link','lion','lips','list','lite','live','load','loan','lock','logo','logs','lone','long','look','loop','lord','lose','loss','lost','lots','loud','love','lows','luck','luke','lung','made','mail','main','make','male','mali','mall','many','maps','marc','mark','mars','mart','mary','mask','mass','mate','math','mats','matt','meal','mean','meat','meet','mega','memo','ment','menu','mere','mesa','mesh','mess','meta','mice','midi','mike','mild','mile','milk','mill','mime','mind','mine','mini','mint','miss','mode','mods','mold','moms','mono','mood','moon','more','moss','most','move','much','must','myth','nail','name','navy','near','neck','need','neon','nest','news','next','nice','nick','nine','node','none','noon','norm','nose','note','nova','nuke','null','nuts','oaks','odds','oils','okay','once','ones','only','onto','oops','open','oral','ours','oval','oven','over','owns','pace','pack','pads','page','paid','pain','pair','pale','palm','para','park','part','pass','past','path','paul','pays','peak','peas','peer','pens','pest','pets','pick','pics','pike','pill','pine','ping','pink','pins','pipe','plan','play','plot','plug','plus','poem','poet','pole','poll','polo','poly','pond','pool','poor','pope','pork','port','pose','post','pour','pray','prep','pros','pubs','pull','pump','punk','pure','push','puts','quad','quit','quiz','race','rack','rage','raid','rail','rain','rand','rank','rare','rate','rats','rays','read','real','rear','reed','reef','reel','rely','rent','rest','rice','rich','rick','ride','ring','ripe','rise','risk','road','rock','role','roll','roof','room','root','rope','rose','rows','ruby','rugs','rule','runs','rush','ruth','safe','sage','said','sail','sake','sale','salt','same','sand','sans','save','says','scan','seal','sean','seas','seat','seed','seek','seem','seen','sees','self','sell','semi','send','sent','sept','sets','shaw','shed','ship','shoe','shop','shot','show','shut','sick','side','sign','silk','sims','sing','sink','site','size','skin','skip','slim','slip','slot','slow','snap','snow','soap','sofa','soft','soil','sold','sole','solo','soma','some','song','sons','soon','sort','soul','soup','spam','span','spas','spec','spin','spot','star','stat','stay','stem','step','stop','stud','such','suit','sure','surf','swap','swim','sync','tabs','tags','tail','take','tale','talk','tall','tank','tape','task','taxi','team','tear','tech','teen','tell','temp','tend','tent','term','test','text','than','that','thee','them','then','they','thin','this','thou','thru','thus','tide','tied','tier','ties','tile','till','time','tiny','tips','tire','told','toll','tone','tons','tony','took','tool','tops','tour','town','toys','trap','tray','tree','trek','trim','trip','troy','true','tube','tune','turn','twin','type','ugly','undo','unit','unto','upon','urge','used','user','uses','vary','vast','very','vice','vids','view','visa','void','voip','volt','vote','wage','wait','wake','walk','wall','want','ward','ware','warm','wars','wash','watt','wave','ways','weak','wear','weed','week','well','went','were','west','what','when','whom','wide','wife','wiki','wild','will','wind','wine','wing','wins','wire','wise','wish','with','wolf','wood','wool','word','work','worm','worn','wrap','yale','yang','yard','yarn','yeah','year','yoga','york','your','zero','zinc','zone','zoom']) as w;

insert into public.wf_words (word, length)
  select w, 5 from unnest(array['about','above','abuse','acids','acres','actor','acute','added','admin','admit','adobe','adopt','adult','after','again','agent','aging','agree','ahead','aimed','alarm','album','alert','alias','alien','align','alike','alive','allow','alloy','alone','along','alpha','alter','amber','amend','amino','among','angel','anger','angle','angry','anime','annex','apart','apple','apply','arbor','areas','arena','argue','arise','armed','armor','array','arrow','aside','asked','asset','atlas','audio','audit','autos','avoid','award','aware','awful','babes','bacon','badge','badly','baker','bands','banks','barry','based','bases','basic','basin','basis','batch','baths','beach','beads','beans','bears','beast','beats','began','begin','begun','being','belle','belly','below','belts','bench','berry','betty','bible','bikes','bills','billy','bingo','birds','birth','black','blade','blame','blank','blast','blend','bless','blind','blink','block','blogs','blond','blood','bloom','blues','board','boats','bobby','bonds','bones','bonus','books','boost','booth','boots','booty','bored','bound','boxed','boxes','brain','brake','brand','brass','brave','bread','break','breed','brick','bride','brief','bring','broad','broke','brook','brown','brush','bucks','buddy','build','built','bunch','bunny','burke','burns','burst','buses','butts','buyer','bytes','cabin','cable','cache','cakes','calls','camel','camps','canal','candy','canon','cards','cargo','carol','carry','cases','catch','cause','cedar','cells','cents','chain','chair','chaos','charm','chart','chase','cheap','cheat','check','chess','chest','chevy','chick','chief','child','chile','china','chips','choir','chose','chuck','cisco','cited','civic','civil','claim','class','clean','clear','clerk','click','cliff','climb','clips','clock','clone','close','cloth','cloud','clubs','coach','coast','codes','cohen','coins','colin','colon','color','combo','comes','comic','condo','congo','coral','corps','costa','costs','could','count','court','cover','crack','craft','craig','crash','crazy','cream','creek','crest','crime','crops','cross','crowd','crown','crude','cubic','curve','cyber','cycle','daddy','daily','dairy','daisy','dance','danny','dated','dates','deals','dealt','death','debug','debut','decor','delay','delta','dense','depot','depth','derby','devel','devil','devon','diane','diary','diffs','digit','dirty','disco','discs','disks','dodge','doing','dolls','donna','donor','doors','doubt','dover','dozen','draft','drain','drama','drawn','draws','dream','dress','dried','drill','drink','drive','drops','drove','drugs','drums','drunk','dryer','dutch','dying','eagle','early','earth','ebony','ebook','edges','eight','elder','elect','elite','emacs','email','empty','ended','enemy','enjoy','enter','entry','equal','error','essay','euros','event','every','exact','exams','excel','exist','extra','faced','faces','facts','fails','fairy','faith','falls','false','fancy','fares','farms','fatal','fatty','fault','favor','fears','feeds','feels','fence','ferry','fever','fewer','fiber','fibre','field','fifth','fifty','fight','filed','files','films','final','finds','fired','fires','firms','first','fixed','fixes','flags','flame','flash','fleet','flesh','float','flood','floor','flour','flows','fluid','flush','flyer','focal','focus','folks','fonts','foods','force','forge','forms','forth','forty','forum','found','frame','frank','fraud','fresh','front','frost','fruit','fully','funds','funky','funny','fuzzy','gains','games','gamma','gates','gauge','genes','genre','ghost','giant','gifts','girls','given','gives','glass','globe','glory','gnome','goals','going','gonna','goods','gotta','grace','grade','grain','grams','grand','grant','graph','grass','grave','great','greek','green','grill','gross','group','grove','grown','grows','guard','guess','guest','guide','guild','hairy','hands','handy','happy','harry','haven','heads','heard','heart','heath','heavy','hello','helps','hence','henry','herbs','highs','hills','hints','hired','hobby','holds','holes','holly','homes','honda','honey','honor','hoped','hopes','horse','hosts','hotel','hours','house','human','humor','icons','ideal','ideas','image','inbox','index','india','indie','inner','input','intel','inter','intro','issue','items','ivory','james','japan','jeans','jenny','jerry','jesse','jesus','jewel','jimmy','johns','joins','joint','jokes','jones','judge','juice','karma','keeps','kelly','kerry','kills','kinda','kinds','kings','kitty','knife','knock','known','knows','label','labor','laden','lakes','lamps','lance','lands','lanes','large','laser','later','latex','laugh','laura','layer','leads','learn','lease','least','leave','legal','lemon','leone','level','lewis','light','liked','likes','limit','lined','lines','links','linux','lions','lists','lived','liver','lives','loads','loans','lobby','local','locks','lodge','logan','logic','login','logos','looks','loops','loose','lotus','louis','loved','lover','loves','lower','lucky','lunch','lying','lyric','macro','magic','mails','major','maker','makes','males','mambo','manga','manor','maple','march','maria','marks','marsh','mason','match','maybe','mayor','meals','means','meant','medal','media','meets','menus','mercy','merge','merit','merry','metal','meter','metro','micro','might','miles','mills','minds','mines','minor','minus','mixed','mixer','model','modem','modes','money','monte','month','moral','moses','motel','motor','mount','mouse','mouth','moved','moves','movie','music','nails','naked','named','names','nancy','nasty','naval','needs','nerve','never','newer','newly','niger','night','noble','nodes','noise','north','noted','notes','novel','nurse','nylon','oasis','occur','ocean','offer','often','older','olive','omega','onion','opens','opera','orbit','order','organ','oscar','other','ought','outer','owned','owner','oxide','ozone','packs','pages','paint','pairs','panel','panic','pants','paper','paris','parks','parts','party','pasta','paste','patch','paths','patio','peace','pearl','peers','penny','perry','peter','phase','phone','photo','piano','picks','piece','pills','pilot','pipes','pitch','pixel','pizza','place','plain','plane','plans','plant','plate','plays','plaza','plots','poems','point','poker','polar','polls','pools','ports','posts','pound','power','press','price','pride','prime','print','prior','prize','probe','promo','proof','proud','prove','proxy','pulse','pumps','punch','puppy','purse','queen','query','quest','queue','quick','quiet','quilt','quite','quote','races','racks','radar','radio','raise','rally','ralph','ranch','randy','range','ranks','rapid','rated','rates','ratio','reach','reads','ready','realm','rebel','refer','rehab','relax','relay','remix','renew','reply','reset','retro','rider','rides','ridge','right','rings','risks','river','roads','robin','robot','rocks','rocky','roger','roles','rolls','roman','rooms','roots','roses','rouge','rough','round','route','rover','royal','rugby','ruled','rules','rural','safer','saint','salad','sales','sally','salon','samba','sandy','satin','sauce','saved','saver','saves','scale','scary','scene','scoop','scope','score','scout','scuba','seats','seeds','seeks','seems','sells','sends','sense','serum','serve','setup','seven','shade','shaft','shake','shall','shame','shape','share','shark','sharp','sheep','sheer','sheet','shelf','shell','shift','shine','ships','shirt','shock','shoes','shoot','shops','shore','short','shots','shown','shows','sides','sight','sigma','signs','silly','since','sites','sixth','sized','sizes','skill','skins','skirt','slave','sleep','slide','slope','slots','small','smart','smell','smile','smith','smoke','snake','socks','solar','solid','solve','songs','sonic','sorry','sorts','souls','sound','south','space','spain','spank','spare','speak','specs','speed','spell','spend','spent','sperm','spice','spies','spine','split','spoke','sport','spots','spray','squad','stack','staff','stage','stamp','stand','stars','start','state','stats','stays','steal','steam','steel','steps','stick','still','stock','stone','stood','stops','store','storm','story','strap','strip','stuck','study','stuff','style','sugar','suite','suits','sunny','super','surge','sweet','swift','swing','swiss','sword','table','taken','takes','tales','talks','tanks','tapes','tasks','taste','taxes','teach','teams','tears','teddy','teens','teeth','tells','terms','terry','tests','texas','texts','thank','theft','their','theme','there','these','theta','thick','thing','think','third','thong','those','three','throw','thumb','tiger','tight','tiles','timer','times','tired','tires','title','today','token','tommy','toner','tones','tools','tooth','topic','total','touch','tough','tours','tower','towns','toxic','trace','track','tract','trade','trail','train','trans','trash','treat','trees','trend','trial','tribe','trick','tried','tries','trips','trout','truck','truly','trunk','trust','truth','tubes','tumor','tuner','tunes','turbo','turns','twice','twins','twist','tyler','types','ultra','uncle','under','union','units','unity','until','upper','upset','urban','usage','users','using','usual','valid','value','valve','vault','vegas','venue','verse','video','views','villa','vinyl','viral','virus','visit','vista','vital','vocal','voice','voted','votes','wages','wagon','wales','walks','walls','wanna','wants','waste','watch','water','watts','waves','weeks','weird','wells','welsh','whale','whats','wheat','wheel','where','which','while','white','whole','whose','wider','width','winds','wines','wings','wired','wires','witch','wives','woman','women','woods','words','works','world','worry','worse','worst','worth','would','wound','wrist','write','wrong','wrote','xerox','yacht','yahoo','yards','years','yeast','yield','young','yours','youth','zones']) as w;

insert into public.wf_words (word, length)
  select w, 6 from unnest(array['abroad','absent','accent','accept','access','across','acting','action','active','actors','actual','adding','adjust','adults','advert','advice','advise','adware','aerial','affair','affect','afford','afraid','agency','agenda','agents','agreed','agrees','alaska','albert','albums','alerts','allied','allows','almost','alpine','alumni','always','amazon','amount','analog','anchor','angels','angola','animal','annual','answer','anyone','anyway','apache','apollo','appeal','appear','arabic','arcade','arctic','argued','around','arrest','arrive','artist','asking','aspect','assess','assets','assign','assist','assume','assure','asthma','asylum','atomic','attach','attack','attend','auburn','august','aurora','author','autumn','avatar','avenue','awards','babies','backed','backup','bailey','baking','ballet','ballot','banana','banned','banner','barbie','barely','barrel','basics','basket','batman','battle','beauty','beaver','became','become','before','begins','behalf','behind','beings','belief','belong','berlin','beside','better','beyond','bidder','bigger','bikini','binary','bishop','blacks','blades','blocks','blonde','boards','bodies','border','boring','boston','bother','bottle','bottom','bought','boxing','brakes','branch','brands','brazil','breach','breaks','breast','breath','breeds','bridal','bridge','briefs','bright','brings','broken','broker','bronze','brooks','browse','brutal','bubble','budget','buffer','builds','bullet','bumper','bundle','burden','bureau','buried','burner','burton','butler','butter','button','buyers','buying','cables','cached','called','camera','campus','canada','cancel','cancer','candle','cannon','canvas','canyon','carbon','career','caring','carmen','carpet','carter','casino','castle','casual','cattle','caught','caused','causes','cayman','celebs','cement','census','center','centre','chains','chairs','chance','change','chapel','charge','charms','charts','cheats','checks','cheers','cheese','cheque','cherry','chicks','choice','choose','chorus','chosen','chrome','chubby','church','cinema','circle','circus','cities','claims','clause','clicks','client','clinic','clocks','closed','closer','closes','clouds','cloudy','coated','coding','coffee','collar','colony','colors','colour','column','combat','comedy','comics','coming','commit','common','comply','condos','cooked','cookie','cooler','cooper','copied','copies','copper','corner','corpus','cotton','counts','county','couple','coupon','course','courts','covers','cowboy','cradle','crafts','create','credit','crimes','crisis','cruise','cursor','curves','custom','cycles','cyprus','damage','danger','danish','dating','deadly','dealer','deaths','debate','decade','decent','decide','deemed','deeper','deeply','defeat','defend','define','degree','delays','delete','deluxe','demand','denial','denied','dental','depend','deputy','desert','design','desire','detail','detect','device','dialog','diesel','differ','digest','dining','dinner','direct','dishes','divide','divine','diving','doctor','dollar','domain','donate','donors','dosage','double','dozens','dragon','dreams','drinks','driven','driver','drives','during','duties','eagles','earned','easier','easily','easter','eating','ebooks','edited','editor','effect','effort','either','eleven','emails','empire','employ','enable','ending','energy','engage','engine','enough','ensure','enters','entire','entity','enzyme','equity','errors','escape','essays','estate','ethics','ethnic','events','exceed','except','excess','excuse','exempt','exists','exotic','expand','expect','expert','export','extend','extent','extras','fabric','facial','facing','factor','failed','fairly','fallen','family','famous','farmer','faster','father','favors','favour','fellow','female','fetish','fields','figure','filing','filled','filter','finals','finder','finest','finger','finish','finite','fiscal','fisher','fitted','flavor','fleece','flight','floors','floppy','floral','flower','flying','folder','follow','forced','forces','forest','forget','forgot','formal','format','formed','former','forums','fossil','foster','fought','fourth','framed','frames','freely','freeze','french','fridge','friend','frozen','fruits','funded','fusion','future','gained','galaxy','gaming','garage','garden','garlic','gather','gender','geneva','genius','genome','genres','gentle','gently','german','giants','gibson','giving','glance','global','gloves','golden','google','gospel','gossip','gothic','gotten','grades','graham','grande','granny','grants','graphs','gratis','greece','groove','ground','groups','growth','guards','guests','guided','guides','guilty','guinea','guitar','habits','hacker','hammer','handed','handle','happen','harbor','harder','hardly','harper','having','hazard','headed','header','health','hearts','heated','heater','heaven','height','helmet','helped','herald','herbal','hereby','herein','heroes','hidden','higher','highly','hiking','hiring','hockey','holder','hollow','honest','honors','hoping','horror','horses','hosted','hostel','hotels','hourly','houses','humans','hunger','hungry','hunter','hybrid','ignore','images','immune','impact','import','impose','inches','income','indeed','indoor','infant','inform','injury','inkjet','inputs','insert','inside','intake','intend','intent','invest','invite','island','issued','issues','italic','itself','jacket','jaguar','jersey','johnny','joined','jordan','joseph','judges','jungle','junior','kernel','kidney','killed','killer','kinase','knight','knives','labels','labour','ladder','ladies','lambda','laptop','larger','lately','latest','latina','latino','latter','launch','lawyer','layers','layout','leader','league','leaves','legacy','legend','lender','length','lenses','lesser','lesson','letter','levels','liable','lights','likely','limits','linear','linked','liquid','listed','listen','little','living','loaded','locale','locate','locked','logged','lonely','longer','looked','lookup','losing','losses','lounge','lovely','lovers','loving','lowest','luxury','lyrics','magnet','maiden','mailed','mainly','makers','makeup','making','manage','manner','manual','marble','margin','marina','marine','marked','marker','market','martin','marvel','master','mating','matrix','matter','mature','median','medium','member','memory','mental','mentor','merely','merger','metals','meters','method','metres','metric','middle','mighty','miller','mining','minute','mirror','missed','mixing','mobile','models','modems','modern','modify','module','moment','monkey','months','morgan','morris','mostly','motels','mother','motion','motors','mounts','movers','movies','moving','murder','murphy','murray','muscle','museum','mutual','myrtle','myself','namely','narrow','nation','native','nature','nearby','nearly','needed','needle','nelson','nested','neural','newbie','newest','newton','nickel','nights','nobody','normal','norman','notice','notify','notion','novels','number','nurses','object','obtain','occurs','offers','office','offset','oldest','oliver','online','opened','optics','option','oracle','orange','orders','origin','others','outlet','output','owners','oxford','oxygen','packed','packet','palace','palmer','panama','panels','papers','parade','parcel','parent','parish','parker','partly','passed','passes','pastor','patent','patrol','payday','paying','peeing','pencil','people','pepper','period','permit','person','petite','phases','phones','photos','phrase','picked','pickup','picnic','pieces','pierce','pillow','pixels','placed','places','plains','planes','planet','plants','plasma','plates','played','player','please','pledge','plenty','pocket','poetry','points','poison','police','policy','polish','portal','porter','posing','postal','posted','poster','potato','potter','pounds','powder','powers','praise','prayer','prefer','prefix','pretty','priced','prices','priest','prince','prints','prison','prizes','profit','prompt','proper','proved','proven','public','pulled','pupils','purple','pursue','pushed','puzzle','python','quebec','queens','quoted','quotes','rabbit','racial','racing','radios','radius','raised','raises','random','ranger','ranges','ranked','rapids','rarely','rather','rating','ratios','reader','really','realty','reason','rebate','recall','recent','recipe','record','redeem','reduce','refers','refine','reform','refund','refuse','regard','reggae','regime','region','reject','relate','relief','reload','remain','remark','remedy','remind','remote','remove','render','rental','repair','repeat','report','rescue','resist','resort','result','resume','retail','retain','return','reveal','review','reward','rhythm','ribbon','riders','riding','rights','rising','rivers','robots','robust','rocket','rogers','rolled','roller','roster','rotary','rounds','router','routes','rubber','ruling','runner','russia','sacred','safari','safely','safety','saints','salary','salmon','sample','savage','saving','saying','scales','scared','scenes','scenic','schema','scheme','school','scored','scores','scotia','screen','script','scroll','sealed','search','season','second','secret','sector','secure','seeing','seeker','seemed','select','seller','senate','sender','senior','sensor','serial','series','served','server','serves','settle','severe','sewing','shades','shadow','shaped','shapes','shared','shares','sharon','shaved','sheets','shield','shirts','shorts','should','showed','shower','sierra','signal','signed','silent','silver','simple','simply','singer','single','sister','skiing','skills','skirts','sleeps','sleeve','slides','slight','slowly','smooth','soccer','social','socket','sodium','solely','solved','sorted','sought','sounds','source','soviet','spaces','speaks','spears','speech','speeds','sphere','spider','spirit','spoken','sports','spouse','spread','spring','sprint','square','squirt','stable','stages','stamps','stands','starts','stated','states','static','status','stayed','steady','stereo','steven','sticks','sticky','stocks','stolen','stones','stored','stores','strain','strand','stream','street','stress','strict','strike','string','strips','stroke','strong','struck','studio','stupid','styles','stylus','submit','subtle','sudden','suffer','suited','suites','summer','summit','sunset','superb','supply','surely','surrey','survey','switch','symbol','syntax','system','tables','tablet','tackle','tagged','taking','talent','talked','target','tariff','tattoo','taught','techno','temple','tenant','tender','tennis','terror','tested','thanks','themes','theory','thesis','things','thinks','thirty','thongs','though','thread','threat','throat','thrown','throws','thumbs','ticket','tigers','timber','timely','timing','tissue','titans','titled','titles','toilet','tomato','tongue','topics','totals','toward','towers','tracks','trader','trades','trails','trains','trance','trauma','travel','travis','treaty','trends','trials','tribal','tribes','tricks','triple','trivia','troops','trucks','trusts','trying','tuning','tunnel','turkey','turned','turner','turtle','twelve','twenty','typing','unable','unions','unique','united','unless','unlike','unlock','unwrap','update','upload','urgent','useful','vacuum','valium','valley','valued','values','valves','varied','varies','vector','velvet','vendor','venues','verbal','verify','versus','vertex','vessel','victim','victor','videos','vienna','viewed','viewer','viking','villas','violin','virgin','virtue','vision','visits','visual','vocals','voices','volume','voters','voting','waiver','walked','walker','wallet','walnut','wanted','warned','warner','warren','washer','waters','wealth','weapon','webcam','weblog','weekly','weight','wheels','whilst','wicked','widely','willow','window','winner','winter','wiring','wisdom','wishes','within','wizard','wonder','wooden','worked','worker','worlds','worthy','wright','writer','writes','yearly','yellow','yields','zoning']) as w;

insert into public.wf_words (word, length)
  select w, 7 from unnest(array['ability','absence','academy','accepts','account','accused','achieve','acquire','acrobat','acrylic','actions','actress','adapted','adapter','adaptor','address','adopted','advance','adverse','advised','advisor','affairs','affects','against','airfare','airline','airport','alcohol','algebra','alleged','allergy','allowed','already','altered','amateur','amazing','ambient','amended','amongst','amounts','analyst','analyze','anatomy','ancient','animals','another','answers','antenna','antique','anxiety','anybody','anymore','anytime','apparel','appeals','appears','applied','applies','approve','aquatic','archive','arising','arrange','arrival','arrived','arrives','article','artists','artwork','aspects','assault','assists','assumed','assumes','assured','attacks','attempt','attract','auction','auditor','authors','average','awarded','awesome','backing','balance','balloon','bangkok','banking','banners','baptist','bargain','barrier','baskets','battery','beaches','bearing','because','becomes','bedding','bedroom','beliefs','believe','belongs','beneath','benefit','besides','betting','between','bicycle','bidding','biggest','billing','billion','binding','biology','bizarre','blanket','blessed','blocked','blogger','blowing','boating','bolivia','booking','borders','borough','bottles','boulder','bouquet','bowling','bracket','bridges','briefly','bristol','broader','brokers','brother','brought','browser','budgets','buffalo','builder','burning','buttons','cabinet','calcium','calling','cameras','camping','candles','capable','capital','capitol','captain','capture','cardiac','careers','careful','carried','carrier','carries','cartoon','casinos','casting','catalog','causing','caution','ceiling','centers','central','centres','century','ceramic','certain','chamber','chances','changed','changes','channel','chapter','charged','charger','charges','charity','charlie','charter','chassis','cheaper','checked','chicken','chinese','choices','chronic','circles','circuit','citizen','claimed','clarity','classes','classic','cleaner','cleanup','cleared','clearly','clients','climate','clinics','closely','closest','closing','closure','clothes','cluster','coaches','coastal','coating','collect','college','collins','cologne','colored','colours','columns','combine','comfort','command','comment','commons','compact','company','compare','compete','compile','complex','compute','concept','concern','concert','concord','conduct','confirm','connect','consent','consist','console','consult','contact','contain','content','contest','context','control','convert','cookies','cooking','cooling','copying','corners','correct','costume','cottage','council','counsel','counted','counter','country','coupled','couples','coupons','courage','courier','courses','covered','created','creates','creator','credits','cricket','critics','crucial','cruises','crystal','cuisine','culture','curious','current','custody','customs','cutting','cycling','damaged','damages','dancing','dealers','dealing','decades','decided','decimal','declare','decline','default','defects','defence','defense','deficit','defined','defines','degrees','delayed','deleted','delight','deliver','demands','density','depends','deposit','derived','deserve','designs','desired','desktop','despite','destiny','destroy','details','develop','deviant','devices','devoted','diagram','diamond','dietary','digital','diploma','disable','discuss','disease','display','dispute','distant','diverse','divided','divorce','doctors','dollars','domains','donated','drawing','dressed','dresses','drivers','driving','dropped','durable','dynamic','earlier','earning','eastern','eclipse','ecology','economy','editing','edition','editors','effects','efforts','elderly','elected','electro','elegant','element','embassy','emerald','emperor','enabled','enables','endless','enemies','engaged','engines','english','enhance','enjoyed','enlarge','enquiry','ensures','entered','entries','episode','equally','essence','estates','eternal','ethical','evening','evident','exactly','examine','example','excerpt','excited','exclude','execute','exhaust','exhibit','existed','expects','expense','experts','expired','expires','explain','explore','exports','exposed','express','extends','extract','extreme','fabrics','factors','factory','faculty','failing','failure','falling','fantasy','farmers','farming','fashion','fastest','fathers','feature','federal','feeding','feeling','females','fiction','fifteen','fighter','figured','figures','filling','filters','finally','finance','finding','fingers','fishing','fitness','fitting','flights','florist','flowers','focused','focuses','folders','folding','follows','footage','foreign','forests','forever','formats','forming','formula','fortune','forward','founded','founder','framing','freedom','freight','friends','funding','funeral','further','futures','gadgets','gallery','garbage','gardens','gateway','gazette','general','generic','genesis','genetic','genuine','geology','getting','gilbert','glasses','glucose','gourmet','grammar','granted','graphic','gravity','greater','greatly','griffin','grocery','grounds','growing','guitars','habitat','hamburg','handled','handles','hanging','happens','harbour','harmful','harmony','harvest','hazards','headers','heading','headset','healing','healthy','hearing','heather','heating','heavily','heights','helpful','helping','herself','highest','highway','himself','history','hitting','hobbies','holders','holding','holiday','holland','horizon','hormone','hostels','hosting','hottest','housing','however','hundred','hunting','husband','hygiene','ignored','illegal','illness','imagine','imaging','impacts','implied','implies','imports','imposed','improve','include','indexed','indexes','indices','induced','infants','initial','injured','inquire','inquiry','insects','insider','insight','install','instant','instead','insulin','insured','integer','intense','interim','invalid','invited','invoice','involve','islands','jackets','jewelry','johnson','joining','journal','journey','jumping','justice','justify','karaoke','keeping','keyword','killing','kingdom','kissing','kitchen','knights','knowing','labeled','landing','laptops','largely','largest','lasting','latinas','laundry','lawsuit','lawyers','leaders','leading','learned','leasing','leather','leaving','lecture','legally','legends','leisure','lenders','lending','lesbian','lessons','letters','letting','liberal','liberty','library','licence','license','licking','lighter','limited','linking','listing','loading','locally','located','locator','locking','lodging','logging','logical','longest','looking','lottery','luggage','machine','madison','madness','madonna','magical','mailing','mailman','managed','manager','mandate','manuals','mapping','markers','markets','marking','married','martial','massage','massive','masters','matched','matches','matters','maximum','meaning','measure','medical','meeting','members','mention','mercury','message','methods','michael','mileage','million','mineral','minimal','minimum','minutes','miracle','mirrors','missile','missing','mission','mistake','mixture','mobiles','modular','modules','moments','monitor','monster','monthly','morning','morocco','mothers','mounted','muscles','museums','musical','mustang','myspace','mystery','nations','natural','naughty','nearest','neither','nervous','network','neutral','nirvana','nothing','noticed','notices','novelty','nowhere','nuclear','numbers','numeric','nursery','nursing','obesity','objects','observe','obvious','offense','offered','officer','offices','offline','ongoing','opening','operate','opinion','opposed','optical','optimal','optimum','options','ordered','organic','origins','orleans','outcome','outdoor','outlets','outline','outlook','outputs','outside','overall','pacific','package','packets','packing','painful','painted','parents','parking','partial','parties','partner','passage','passing','passion','passive','patches','patents','patient','patrick','pattern','payable','payment','payroll','penalty','pendant','pending','penguin','pension','peoples','percent','perfect','perform','perfume','perhaps','periods','permits','persons','phantom','phoenix','phrases','physics','picking','picture','pioneer','pirates','placing','planets','planned','planner','plastic','players','playing','pleased','pockets','podcast','pointed','pointer','polymer','popular','portion','possess','postage','posters','posting','pottery','poultry','poverty','powered','prairie','prayers','precise','predict','prefers','premier','premium','prepaid','prepare','present','pressed','prevent','preview','pricing','primary','printed','printer','privacy','private','problem','proceed','process','produce','product','profile','profits','program','project','promise','promote','prophet','propose','protect','protein','protest','proudly','provide','publish','pulling','purpose','pursuit','pushing','putting','puzzles','qualify','quality','quantum','quarter','queries','quickly','quizzes','radical','railway','rainbow','raising','rangers','ranging','ranking','rapidly','ratings','reached','reaches','readers','readily','reading','reality','realize','realtor','reasons','rebates','rebound','receipt','receive','recipes','records','recover','redhead','reduced','reduces','refined','reflect','reforms','refresh','refused','regards','regions','regular','related','relates','release','relying','remains','remarks','removal','removed','renewal','rentals','repairs','replace','replica','replied','replies','reports','reprint','request','require','reserve','resolve','resorts','respect','respond','restore','results','resumes','retired','retreat','returns','reunion','reveals','revenge','revenue','reverse','reviews','revised','rewards','rolling','romance','roughly','routers','routine','routing','royalty','running','sailing','samples','satisfy','savings','scanned','scanner','schemes','scholar','schools','science','scoring','scratch','screens','scripts','seafood','seasons','seating','seconds','secrets','section','sectors','secured','seekers','seeking','segment','sellers','selling','seminar','senator','sending','seniors','sensors','serious','servers','service','serving','session','setting','settled','seventh','several','shadows','sharing','shelter','sheriff','shipped','shopper','shorter','shortly','showers','showing','shuttle','siemens','signals','signing','silence','silicon','similar','singing','singles','sisters','sitting','skating','skilled','smaller','smoking','society','soldier','solving','somehow','someone','soonest','sources','spatial','speaker','special','species','specify','spencer','spirits','sponsor','springs','spyware','stadium','started','starter','startup','stating','station','statute','staying','stevens','sticker','stomach','stopped','storage','stories','strange','streams','streets','stretch','strikes','strings','stripes','student','studied','studies','studios','stuffed','stylish','subject','sublime','succeed','success','sucking','suggest','summary','sunrise','support','suppose','supreme','surface','surfing','surgeon','surgery','surname','surplus','surveys','survive','suspect','symbols','systems','tablets','tactics','talking','targets','teacher','teaches','teenage','telecom','telling','tension','terrace','terrain','testing','textile','texture','theater','theatre','theorem','therapy','thereby','thereof','thermal','thought','threads','threats','through','thunder','tickets','tiffany','timothy','tobacco','toddler','tonight','toolbar','toolbox','toolkit','torture','totally','touched','touring','tourism','tourist','towards','tracked','tracker','tractor','trading','traffic','tragedy','trailer','trained','trainer','transit','travels','treated','tribune','tribute','trigger','trinity','triumph','trouble','trusted','trustee','tsunami','tuition','turning','twisted','typical','unified','uniform','unknown','unusual','updated','updates','upgrade','usually','utility','utilize','vaccine','vampire','vanilla','variety','various','varying','vehicle','vendors','venture','version','vessels','veteran','victims','victory','viewers','viewing','village','vintage','violent','virtual','viruses','visible','visited','visitor','vitamin','voltage','volumes','waiting','walking','wanting','warming','warning','warrant','warrior','washing','watched','watches','weapons','wearing','weather','webcams','webcast','weblogs','webpage','website','webster','wedding','weekend','weights','welcome','welding','welfare','western','whereas','whether','william','willing','windows','winners','winning','wishing','without','witness','workers','working','workout','worried','worship','wrapped','writers','writing','written','younger']) as w;

