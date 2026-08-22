# Wordforge

A 2–10 player browser word game. Same idea as that word game you already know
— guess the secret word, get colour-coded feedback — with two twists that
keep it from being a five-letter clone: the word length shifts every round
(4–7 letters), and most rounds have to start with the last letter of the
previous round's word.

Two modes:

- **PvP Duel** — two players race the same secret at the same time. You only
  ever see your own board; your opponent shows up as a live "ghost" bar —
  how many guesses they've burned, nothing more. Fewer guesses wins the
  round, ties break on speed.
- **Co-op** — up to ten players share one board and one guess budget
  (`word length + 3`, fixed no matter how many people join, so a bigger team
  has to coordinate rather than just brute-force it). Anyone can drop the
  next guess at any time.

No login, no chat, and no typing required to join a room — though the room
code and every guess can be typed on a physical keyboard as well as tapped.

**Play: <https://sixsleet.github.io/Drift/>**

Vanilla JS, no framework and no build step. Supabase for the database, RLS,
and realtime signalling. GitHub Pages for hosting. The one dependency
(`supabase-js`) is vendored under `vendor/`, so the page has no runtime CDN.

---

## The round

| Phase | What happens |
| --- | --- |
| Countdown | 3s. Everyone's clock lines up on the server's `starts_at`. The chain-letter badge shows here if this round is constrained. |
| Live | Type guesses on the on-screen keyboard or your own. Each submitted guess is scored server-side and its tiles flip in: hit (right letter, right spot), present (right letter, wrong spot), miss. |
| Settling | Brief. Any client — not just the host — can ask the server "is this round actually over," and the server independently re-checks before agreeing. |
| Reveal | ~4.5s. The secret word, and (in PvP) what your opponent actually guessed. |
| Board | ~5.5s. Running standings, then the next round. |

Matches run 4, 6, 8 or 12 rounds. Points build across the whole match — most
points (or, in Co-op, most rounds solved) wins after the last one.

**Scoring.** `points = max(0, max_guesses − guesses_used + 1) × 10`, plus a
PvP-only speed bonus (+20 for a near-instant solve, +10 for a reasonably
fast one). Co-op scores the same way off the shared attempt count, split
identically across the whole team.

**The chain constraint.** From round 2 on, the secret usually has to start
with the last letter of the previous round's secret — so you can't lean on
one memorised opening guess all match. If no word of the right length starts
with that letter, the constraint quietly drops for that round (`chain_broken`)
rather than the round ever failing to start.

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
visible to the room the moment it lands; in PvP you only ever see your own
until the round settles, at which point both boards open up for the reveal
screen.

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
| `wf_rounds` | word length, guess budget, chain letter, timing, `revealed_secret` |
| `wf_round_secrets` | the live secret for a round — **RLS-locked, no policies** |
| `wf_guesses` | word, per-letter feedback, attempt number; visibility is mode-aware |
| `wf_results` | settled points, per player per round, which is what the leaderboard sums |

**There are no INSERT or UPDATE policies on any of these tables.** Every
write goes through a `SECURITY DEFINER` function that resolves the caller
from the token it was handed and re-checks membership, host rights, and
round state. A player cannot guess after their budget is spent, guess in a
round that hasn't started or has already settled, settle a round that isn't
actually finished, see an opponent's PvP guesses before the reveal, or touch
a room they never joined.

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
index.html          screens; guesses go in on the on-screen keyboard or a
                    physical one
css/app.css
js/config.js         connection details and every tunable
js/net.js            token identity, clock sync, RPCs, realtime channel
js/words.js           client-side "is this a real word" check (UX only)
js/sfx.js             synthesised WebAudio sound; no audio files
js/game.js            phase clock, round settlement, input, scoring display
js/ui.js               DOM rendering: tile grid, on-screen keyboard, boards
js/main.js            wires the buttons (and the keyboard) up
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
  players. Refreshing your own tab is fine.
- **The token is a bearer secret.** Anyone who copies it out of your
  `localStorage` can act as you in your rooms — the same trade-off any
  session cookie makes, and the price of having no login at all.
- **Private browsing loses your seat.** If `localStorage` is unavailable the
  token lives in memory only, so a reload creates a new identity.

## Licence

MIT — see [LICENSE](LICENSE).
