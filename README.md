# Drift: Chaos Mode

A 2–10 player browser party game. A ball ricochets through a bumper arena,
everyone gets exactly one nudge, then the ball goes dark — and you have three
seconds to click where you think it ended up.

No login, no typing, no chat. A room code and a mouse.

**Play:** _(live URL goes here once GitHub Pages is enabled)_

Vanilla JS and `<canvas>`, Matter.js for physics, Supabase for realtime and
persistence, GitHub Pages for hosting. No build step and no runtime CDN: the two
dependencies are vendored under `vendor/`.

---

## The round

| Phase | Length | What happens |
| --- | --- | --- |
| Countdown | 2.5s | Everyone's clock lines up on the server's `starts_at`. |
| Live | 4–8s, random | Balls fly. One click each: it shoves the nearest ball away from where you clicked, harder the closer you clicked. Tap **1**, **2** or **3** to set your secret wager. |
| Blackout | 0.5–1.4s, random | The balls vanish but keep moving. All you have left is the trail from the moment they went dark. |
| Freeze | — | Everything stops. |
| Guess | 3s | Click where you think your ball is. Every 3rd round runs 2–3 balls at once, so you also pick which one you're calling. |
| Reveal | ~5s | True positions, everyone's guesses, everyone's points. |
| Leaderboard | ~6.5s | Running totals, then the next round. |

Ten rounds by default; the host can pick 6, 10 or 15.

**Scoring.** `points = base × wager × streak multiplier`, where `base` falls off
linearly from 100 at a perfect click to 0 at 400px. A guess within 55px counts
as *close*; three close guesses in a row earns ×1.5, four earns ×1.75, five or
more earns ×2. One miss resets the streak.

## How the simulation stays in sync

Ball positions are never sent over the wire. Instead:

1. The server mints a round with a **seed**, a ball count and both durations
   (`drift_next_round`). That row is the entire input to the round.
2. Every client rebuilds the identical arena from the seed — obstacle layout,
   ball spawns, launch vectors — and steps Matter.js on a fixed 60Hz timestep.
3. The only live input is nudges. Each nudge carries the **tick** it applies on,
   so applying the same set of nudges to the same seed necessarily produces the
   same round in every browser.
4. Nudges travel over a Supabase **Broadcast** channel, flushed on a 10Hz tick
   and resent a few times to ride out packet loss. The matching row in
   `drift_nudges` is what makes them durable.
5. A nudge that arrives after its tick has already been stepped past triggers a
   replay from tick zero. A whole round is only ~500 ticks, so that costs about
   8ms — cheap enough to do inside a frame.
6. At the freeze every client re-reads the round's nudges and folds in anything
   the broadcast missed, so the frame you are guessing against is the one the
   host is about to publish.

The host then writes the authoritative freeze positions to `drift_rounds.truth`,
and the database scores every guess in the same statement. Ten browsers can
disagree about a pixel; they can never disagree about a leaderboard.

> Matter.js leans on `Math.sin`/`Math.cos` when it builds body vertices, and
> those are not bit-identical across JS engines. In practice the drift over a
> few hundred ticks is invisible, and because scoring is measured against the
> host's published truth rather than each client's own copy, it cannot affect
> the result either way.

Round and room changes ride a `poke` broadcast carrying the new rows inline, so
they land instantly; a 1.5s poll of `drift_state` is the backstop that keeps a
client that missed one — or joined late, or was backgrounded — from getting
stuck.

## Identity without accounts

There is no login and no auth session. Each browser mints a 256-bit random token
on first visit and keeps it in `localStorage`. The server never stores the token,
only its SHA-256 hash, and a player *is* whoever presents the token matching a
`drift_players` row. Holding on to that token is what lets a mid-game refresh
drop you back into your own seat.

The token reaches Postgres two ways, deliberately:

- as an argument to the RPCs, which are the only write path, and
- as the `x-drift-player` request header, which PostgREST exposes as
  `request.headers` and which the RLS policies read.

So the policies genuinely gate direct table access on room membership, and the
game does not depend on header plumbing in order to work.

## Data model

Six tables, all with row-level security scoped to room membership. See
[`supabase/schema.sql`](supabase/schema.sql).

| Table | Holds |
| --- | --- |
| `drift_rooms` | code, host, status, round count |
| `drift_players` | seat, generated name and colour, token hash, per room |
| `drift_rounds` | seed, ball count, durations, `starts_at`, `truth` |
| `drift_nudges` | one row per player per round (enforced by the primary key) |
| `drift_wagers` | secret until the round is revealed |
| `drift_guesses` | the click, plus the server-computed distance, streak and points |

**There are no INSERT or UPDATE policies on any of these tables.** Every write
goes through a `SECURITY DEFINER` function that resolves the caller from the
token it was handed and re-checks membership, host rights, and the timing
window. A player cannot nudge twice, guess before the freeze, guess after the
window closes, guess on a ball that does not exist in the round, see anyone
else's wager before the reveal, publish a round's truth unless they are the
host, or touch a room they never joined.

## Setting it up

**1. Database.** Create a Supabase project and run
[`supabase/schema.sql`](supabase/schema.sql) in the SQL editor. It is
re-runnable — it drops and rebuilds every `drift_*` object. No auth providers
need enabling; the game only ever talks as the `anon` role.

**2. Keys.** Put your project URL and publishable key in
[`js/config.js`](js/config.js). Committing them is fine and intended: the
publishable key is the browser key, it grants nothing on its own, and every
route into the data is gated by the policies above.

**3. Hosting.** Push to `main`. The workflow in
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the
playable files to GitHub Pages. Pages has to be switched on once by hand first:
**Settings → Pages → Source: GitHub Actions**. (The workflow token is not
permitted to create the Pages site itself, and Pages needs the repo to be public
unless you are on a paid plan.)

## Running it locally

Any static file server will do — there is nothing to build.

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

A local tab and a deployed tab can share a room, since both talk to the same
Supabase project.

## Layout

```
index.html          screens; every control is a button
css/app.css
js/config.js        connection details and every tunable
js/rng.js           seeded PRNG (mulberry32) — integer ops only
js/sim.js           arena generation + the deterministic simulation
js/render.js        canvas drawing
js/net.js           token identity, clock sync, RPCs, realtime channel
js/game.js          phase clock, host duties, input, scoring display
js/main.js          wires the buttons up
vendor/             matter-js 0.20.0, supabase-js 2.58.0 (unmodified)
supabase/schema.sql tables, RLS policies and every RPC
```

## Known limits

- **The host drives the round loop.** If the host closes their tab mid-game the
  room stops advancing and everyone else sits on "waiting for the host". Moving
  that loop into a scheduled edge function would fix it.
- **Joining is lobby-only.** Once a game starts the room is closed to new
  players. Refreshing your own tab is fine.
- **The token is a bearer secret.** Anyone who copies it out of your
  `localStorage` can act as you in your rooms — the same trade-off any session
  cookie makes, and the price of having no login at all.
- **Private browsing loses your seat.** If `localStorage` is unavailable the
  token lives in memory only, so a reload creates a new identity.

## Licence

MIT — see [LICENSE](LICENSE).
