# Wordforge

A 1–10 player browser word game. Same idea as that word game you already know
— guess the secret word, get colour-coded feedback — with a few twists that
keep it from being a five-letter clone: the word length shifts every round
(4 or 5 letters — longer proved too hard to be fun), most rounds have to
start with the last letter of the previous round's word, a round can roll a
start-of-round event that changes the stakes, and — partway through, when
you're not expecting it — something can happen mid-round instead: a cat
wanders into the room and is worth chasing down, or (Co-op) two guesses
suddenly swap tiles. The whole thing is staged inside a room built in real
CSS 3D — a desk, a warm lamp, someone in a chair with their back to you —
and the puzzle runs on the monitor they're sitting at.

Three modes:

- **Solo** — no lobby, no code. Hit "Play solo" and you're straight into a
  match, same guess budget as a duel, chasing your own score.
- **PvP Duel** — two players race the same secret at the same time. You only
  ever see your own board; your opponent shows up as a live "ghost" bar —
  how many guesses they've burned, nothing more. Whoever solves it first
  wins the round, however many guesses it took.
- **Co-op** — up to ten players share one board and one guess budget
  (`word length + 3`, fixed no matter how many people join, so a bigger team
  has to coordinate rather than just brute-force it). Anyone can drop the
  next guess at any time.

No login, no chat needed to join a room — the code and keypad can be tapped.
Guesses, though, are physical-keyboard only: there's no on-screen keyboard to
tap, since the whole point of the room is that you're watching someone type
at a monitor, not poking a touchscreen.

Built for a desktop screen. Below about 1080px wide the 3D room is dropped
and the game falls back to a plain (still warm) flat layout, because at that
size the monitor would end up smaller than the text on it.

**Play: <https://sixsleet.github.io/Drift/>**

Vanilla JS, no framework and no build step. Supabase for the database, RLS,
and realtime signalling. GitHub Pages for hosting. The one dependency
(`supabase-js`) is vendored under `vendor/`, so the page has no runtime CDN.

---

## The round

| Phase | What happens |
| --- | --- |
| Countdown | 5s. Everyone's clock lines up on the server's `starts_at`. The chain-letter badge shows here if this round is constrained. If this round rolled a start-of-round event, a full-screen card takes over for the whole 5 seconds — emoji, name, and what it does — so nobody starts guessing before they've actually read what changed. |
| Live | A clock (5 minutes normally, 90s on a Blitz round), ticking down in the HUD — red and pulsing under 30s, pulsing faster and ticking audibly (rising pitch) in the final 10s. There's no on-screen keyboard — type guesses on your own physical keyboard, watching the monitor the way the character in the room does. Each letter pops as you type it, tiles flip in as each guess is scored (hit / present / miss), and a guess that lands zero hits gets its own shake and sting. Any letter you've used that isn't in the word greys out in the compact legend below the board so you don't waste a guess retyping it — unless this round is Blackout (see below). Partway through, about half of all rounds also spring a mid-round event — see below. |
| Settling | Brief. Any client — not just the host — can ask the server "is this round actually over," and the server independently re-checks before agreeing. |
| Reveal | ~4.5s. The secret word, and (in PvP) what your opponent actually guessed, plus who won the round. |
| Board | ~5.5s. Running standings, then the next round. |

Matches run 4, 6, 8 or 12 rounds. Points build across the whole match — most
points (or, in Co-op, most rounds solved) wins after the last one.

**The clock.** Every round has one, from `starts_at`, enforced server-side —
`wf_submit_guess` rejects a guess submitted after it expires, and
`wf_check_settle` treats time running out as a completion condition in every
mode. Run out with the word unsolved and the round ends there, secret
revealed, same as running out of guesses. It's normally 5 minutes, but a
round's actual duration lives in `wf_rounds.time_limit_ms` — a Blitz event
shortens it to 90s.

**Scoring.** `points = max(0, max_guesses − guesses_used + 1) × 10`, plus a
speed bonus in Solo and PvP (+20 for a near-instant solve, +10 for a
reasonably fast one), doubled if the round rolled Double Points. Co-op scores
the same base formula off the shared attempt count, split identically across
the whole team, with no speed bonus (still doubled by Double Points).

**Guess budgets.** `word length + 2` in Solo and PvP — a solo run is exactly
as hard as your half of a duel. `word length + 3` in Co-op, since that pool
is shared across the whole team rather than per player. Jackpot adds one
more guess on top of that, for the round.

**Winning a PvP round.** First to solve it wins — not fewest guesses. The
round ends the instant either player gets it, so there's no reason to wait
for your rival to finish; a wrong guess against the clock can cost you the
race even if you'd have gotten there eventually.

**The chain constraint.** From round 2 on, the secret usually has to start
with the last letter of the previous round's secret — so you can't lean on
one memorised opening guess all match. If no word of the right length starts
with that letter, the constraint quietly drops for that round (`chain_broken`)
rather than the round ever failing to start.

**Round-start events.** Every round has a 65% chance of rolling one, decided
server-side the instant the round is minted (`wf_next_round`, one shared
`random()` roll compared against cumulative odds — not one draw per
outcome, which would silently skew them) and — where it has a *numeric*
effect at all — baked straight into that round's `max_guesses` /
`time_limit_ms`, so there's nothing for the client to derive there:

| Event | Odds | Effect |
| --- | --- | --- |
| 💰 Double Points | 20% | Score doubled. |
| ⚡ Blitz | 20% | Clock cut to 90 seconds. |
| 🙈 Blackout | 20% | The legend stops greying out letters you already know — no more free memory aid. |
| 🎰 **Jackpot** | 5% | Extra guess **and** double points, at once — the rare one worth stopping for. |
| *(none)* | 35% | A normal round. |

Every event gets a full-screen card for the whole 5-second countdown (so
there's no missing what just changed), plus a HUD pill for the rest of the
round, and a distinct WebAudio stinger. Blitz strobes the screen and shakes
it; Double Points and Jackpot rain confetti; Jackpot piles on a gold
spinning pill and a slot-machine fanfare on top of everything else.
Blackout is a pure client-side rule change — same secret, same scoring,
just a harder way to find it — so it carries no `max_guesses`/`time_limit_ms`
effect at all.

**Mid-round events.** A second, independent roll (also decided at mint time,
in the same `wf_next_round` call) picks something that happens *partway
through* live play instead of being announced up front — a surprise, not a
warning. `mid_event_at_ms` lands 45-60 seconds into the round (always
leaving at least 30 seconds of clock to react), and the event only actually
resolves once a client calls the matching RPC after that point:

| Event | Odds | What happens |
| --- | --- | --- |
| 🐈 Cat | up to ~25%, ~17% in Co-op | A cat wanders across the room (never onto the monitor screen — see below). Click it within 4 seconds for 20 bonus seconds on the clock (`wf_catch_cat`); miss it and it just wanders off, no penalty. |
| 📱 Phone | up to ~25%, ~17% in Co-op | The phone rings on the desk, stationary and shaking rather than walking. Answer it within 4 seconds for one extra guess this round (`wf_answer_phone`, capped at the table's own 12-guess ceiling); miss it and it just stops ringing. |
| 🔀 Letter Swap | ~17%, **Co-op only** | Two players' most recent guesses (never a winning one) suddenly swap tiles with each other (`wf_trigger_letter_swap`) — the words stay put, but the colours briefly tell the wrong story. PvP/Solo never roll this: PvP guesses are invisible to the other player until settle, so a swap there would either leak a guess or land silently invisible. |
| *(none)* | 50% | Nothing happens. |

Letter Swap only ever touches guesses that aren't the actual solve — the
server excludes any all-hit guess from the swap pool, so this can never
accidentally hand a team a false win. All three RPCs are idempotent
(`mid_event_fired`): whichever client's call reaches the server first wins,
everyone else's just quietly does nothing, so racing Co-op teammates or a
flaky connection can't double-apply an event or hand out two bonuses.

## The room

The game isn't a page with a room drawn behind it — it's a room, and the
page is what's on the monitor inside it.

The scene is real CSS 3D: one `perspective` on the container, one
`preserve-3d` stage, and floor, ceiling, three walls, a desk and the monitor
all placed with `translate3d`/`rotate` in shared 3D units. The walls
converge because they're genuinely angled away from the camera, not because
a gradient fakes it. The camera sits behind the chair, so what you see is
that one point of view: the back of someone's head, their desk, and the
screen they're working on.

Every screen in the app — title, lobby, code entry, the board, standings,
the full-screen event takeover — renders on that monitor's panel, a fixed
1100x740 surface standing at z = -900. Because it's ordinary DOM inside the
3D scene rather than a texture, the tiles and text stay crisp, selectable
and accessible. The trade is that perspective scales the panel to about
67%, so type inside it is authored proportionally larger, and nothing in
there uses `vw`/`vh` — the panel is a fixed box, not the viewport.

Two things worth knowing before touching this:

- **`.room-stage` sets `pointer-events: none` and `.monitor-screen` sets it
  back to `auto`.** The stage's own box fills the viewport at z = 0, which
  puts it nearer the camera than everything it contains — so without that
  pair it silently swallows every click aimed at the monitor, and the UI
  looks perfect while being completely dead to the mouse.
  `wf-room-scene-test.mjs` hit-tests real controls to catch exactly this.
- **Tiles size themselves from the row count.** The panel's height is fixed,
  so `--rows` (set by `renderGrid`) drives a `min(60px, …)` calc. A Co-op
  5-letter round is 8 rows and answering the phone buys a 9th; without this
  the board runs off the bottom of the screen.

Lighting is baked per surface rather than computed: one warm source (the
desk lamp, on the left) and one cool one (the monitor itself), with matching
pools on the desk and floor, contact shadows where objects meet the wood,
and a cool rim on the back of the player's head where the screen's light
wraps around them. That warm/cool disagreement is most of what reads as
"cozy" rather than "dark UI".

Mid-round distractions (the cat, the phone) live in `#room-fx`, a flat layer
over the room rather than inside the 3D stage — a sprite placed in the stage
would inherit the perspective scaling of whatever plane it sat on. They show
up out in the room, never over the screen.

It's all hand-drawn CSS: gradients, clip-paths and a couple of emoji. No
image assets, no build step, same as everything else here.

## Keeping the secret secret

The actual answer for a round is never sent to a client before it's safe to
know. It lives in `wf_round_secrets`, a table with row-level security enabled
and **zero policies** — completely unreachable from the API directly, no
matter the request, reachable only from inside the `SECURITY DEFINER`
functions that need it. The answer pool to draw from (`wf_words`) is locked
the exact same way, so the client can't even ask "what words are possible at
length 6."

Once a round settles, `wf_rounds.revealed_secret` — a normal, always-visible
column — gets filled in. It is genuinely `NULL` until then, so there's no
column-masking trick: the same read that was always allowed just starts
returning a value once the round is over.

Guess visibility is mode-aware, in one RLS policy: in Co-op every guess is
visible to the room the moment it lands; in PvP and Solo you only ever see
your own until the round settles, at which point the board opens up for the
reveal screen. Solo needs no special case here at all — a room of one only
ever has its own guesses to see anyway.

Settling a round is deliberately **not** host-only, unlike advancing to the
next one — it independently re-derives "is this actually finished" from the
guesses table before agreeing, so it's safe for any player to trigger,
repeatedly, without the game stalling if the host's tab dies.

## Identity without accounts

There is no login and no auth session. Each browser mints a 256-bit random
token on first visit and keeps it in `localStorage`. The server never stores
the token itself, only its SHA-256 hash, and a player *is* whoever presents
the token matching a `wf_players` row. Holding on to that token is what lets
a mid-game refresh drop you back into your own seat.

The token reaches Postgres two ways, deliberately:

- as an argument to the RPCs, which are the only write path, and
- as the `x-wf-player` request header, which PostgREST exposes as
  `request.headers` and which the RLS policies read.

So the policies genuinely gate direct table access on room membership, and
the game does not depend on header plumbing in order to work.

## Data model

Seven tables, all with row-level security. See
[`supabase/schema.sql`](supabase/schema.sql).

| Table | Holds |
| --- | --- |
| `wf_rooms` | code, mode, status, round count |
| `wf_players` | seat, generated name and colour, token hash, per room |
| `wf_words` | the curated answer pool — **RLS-locked, no policies** |
| `wf_rounds` | word length, guess budget, chain letter, start/mid-round events, timing, `revealed_secret` |
| `wf_round_secrets` | the live secret for a round — **RLS-locked, no policies** |
| `wf_guesses` | word, per-letter feedback, attempt number; visibility is mode-aware |
| `wf_results` | settled points, per player per round, which is what the leaderboard sums |

**There are no INSERT or UPDATE policies on any of these tables.** Every
write goes through a `SECURITY DEFINER` function that resolves the caller
from the token it was handed and re-checks membership, host rights, and
round state. A player cannot guess after their budget is spent, guess after
the round's 5-minute clock has run out, guess in a round that hasn't started
or has already settled, settle a round that isn't actually finished, see an
opponent's PvP guesses before the reveal, or touch a room they never joined.

The server does not validate that a guess is a real dictionary word — only
its length and that it's alphabetic. Dictionary checking (`js/words.js`,
`data/valid-*.json`) is client-side UX only, to catch a typo before it burns
a guess; a modified client could submit anything, but it would only ever
spend that client's own guess (or, in Co-op, the team's shared one).

## Realtime

Live updates ride Supabase Broadcast, not `postgres_changes` — a replication
stream carries no request headers, so it can't evaluate the RLS policies
above. Two payload shapes, both content-free about the one thing that
matters:

- `poke` — "something changed, refetch `wf_state`." Sent after every guess
  and every room/round transition. Carries nothing else, so the same signal
  works for a Co-op teammate's guess and a PvP round advancing, without
  duplicating any access logic here.
- `ghost` — PvP only, and always an aggregate: `{attempts, hits, present,
  solved}` describing the sender's own progress. No word, no per-letter
  feedback, ever. The receiver renders it as "my opponent's progress."

A 1.5s poll of `wf_state` is the backstop that keeps a client which missed a
broadcast — or joined late, or was backgrounded — from getting stuck.

## Setting it up

**1. Database.** Create a Supabase project and run
[`supabase/schema.sql`](supabase/schema.sql) in the SQL editor. It is
re-runnable — it drops and rebuilds every `wf_*` object, including the seeded
word list. No auth providers need enabling; the game only ever talks as the
`anon` role.

**2. Keys.** Put your project URL and publishable key in
[`js/config.js`](js/config.js). Committing them is fine and intended: the
publishable key is the browser key, it grants nothing on its own, and every
route into the data is gated by the policies above.

**3. Hosting.** Push to `main`. The workflow in
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the
playable files to GitHub Pages — `index.html`, `css/`, `js/`, `vendor/`, and
only the `valid-*.json` dictionaries out of `data/` (never `answers-*.json`;
see **Known limits** below). Pages has to be switched on once by hand first
(**Settings → Pages → Source: GitHub Actions**), since the workflow token is
not permitted to create the Pages site itself, and Pages needs the repo to be
public unless you are on a paid plan.

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
index.html          the 3D room, with every app screen nested inside the
                    monitor's panel; guesses go in on the player's own
                    physical keyboard, nothing on screen to tap
css/app.css          two coordinate systems: the 3D room, then the flat
                    panel standing in it (see The room)
js/config.js         connection details and every tunable
js/net.js            token identity, clock sync, RPCs, realtime channel
js/words.js           client-side "is this a real word" check (UX only)
js/sfx.js             synthesised WebAudio sound; no audio files
js/game.js            phase clock, round settlement, input, scoring display
js/ui.js               DOM rendering: tile grid, letter legend, boards
js/main.js            wires the buttons up and listens for physical keydown
vendor/               supabase-js 2.58.0, unmodified
data/answers-*.json    the exact seed for wf_words — dev/repo only, never
                       deployed (see Known limits)
data/valid-*.json      the broader guess-validation dictionary — deployed
supabase/schema.sql    tables, RLS policies and every RPC
```

## Known limits

- **The repo is public, and so is the answer key.** `data/answers-*.json`
  and the seed section at the bottom of `schema.sql` both list every word
  the game can ever pick as a secret, in plain text, in a public repo. The
  Pages deploy deliberately excludes `answers-*.json` and the RLS lock keeps
  the *running app* from ever handing a client the pool — that stops casual
  peeking during a live game — but it is not a defense against someone who
  goes and reads the open-source code. Same trust model as most party games
  built this way: enough friction for the people you're actually playing
  with.
- **The host drives round advancement.** If the host closes their tab
  mid-game, the room stops minting new rounds and everyone else sits on
  "waiting for the host." Settling an in-progress round still works for
  everyone, since that part deliberately isn't host-gated — see **Keeping
  the secret secret** above. Moving round advancement into a scheduled edge
  function would remove this limit entirely.
- **Joining is lobby-only.** Once a game starts the room is closed to new
  players. Refreshing your own tab is fine. A Solo room can never be joined
  by anyone else, at any point — it auto-starts the instant it's created,
  so there's no lobby window for a second player to land in even in theory.
- **The token is a bearer secret.** Anyone who copies it out of your
  `localStorage` can act as you in your rooms — the same trade-off any
  session cookie makes, and the price of having no login at all.
- **Private browsing loses your seat.** If `localStorage` is unavailable the
  token lives in memory only, so a reload creates a new identity.

## Licence

MIT — see [LICENSE](LICENSE).
