# Wordforge

A 1–10 player browser word game. Same idea as that word game you already know
— guess the secret word, get colour-coded feedback — with a few twists that
keep it from being a five-letter clone: you pick the word length before the
lobby exists (4, 5, 6, 7, or Mixed), most rounds have to start with the last
letter of the previous round's word, a round can roll a modifier that changes
the stakes — and a *second* one can strike partway through, when you're not
expecting it.

Around all of that the room gets on with its own life: a cat walks across the
desk in front of your screen, a moth settles on the board and blurs a letter
you'd already earned, the phone buzzes, the light stutters, and a
thunderstorm rolls in — every strike knocks the lamp out and flashes the
whole room. The whole thing is staged inside a
room built in real CSS 3D — a desk, a warm lamp, someone in a chair with their
back to you — and the puzzle runs on the monitor they're sitting at.

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
size the monitor would end up smaller than the text on it. Nothing is cut in
that fallback: the two rails either side of the board turn into compact
horizontal strips above and below it, so the readout still fits without
squeezing the board.

**Play: <https://sixsleet.github.io/Drift/>**

Vanilla JS, no framework and no build step. Supabase for the database, RLS,
and realtime signalling. GitHub Pages for hosting. The one dependency
(`supabase-js`) is vendored under `vendor/`, so the page has no runtime CDN.

---

## The round

| Phase | What happens |
| --- | --- |
| Countdown | 5s. Everyone's clock lines up on the server's `starts_at`. The chain-letter badge shows here if this round is constrained. If this round rolled a start-of-round event, a full-screen card takes over for the whole 5 seconds — emoji, name, and what it does — so nobody starts guessing before they've actually read what changed. |
| Live | A clock (5 minutes normally, 90s on a Blitz round), ticking down in the HUD — red and pulsing under 30s, pulsing faster and ticking audibly (rising pitch) in the final 10s. There's no on-screen keyboard — type guesses on your own physical keyboard, watching the monitor the way the character in the room does. Each letter pops as you type it, tiles flip in as each guess is scored (hit / present / miss), and a guess that lands zero hits gets its own shake and sting. Any letter you've used that isn't in the word greys out in the compact legend below the board so you don't waste a guess retyping it — unless this round is Blackout (see below). Partway through, a round may also spring a global mid-round modifier, and your own room may interrupt you at any time — see below. |
| Settling | Brief. Any client — not just the host — can ask the server "is this round actually over," and the server independently re-checks before agreeing. |
| Reveal | ~4.5s. The secret word, and (in PvP) what your opponent actually guessed, plus who won the round. |
| Board | ~5.5s. Running standings, then the next round. The recap line names the word and who got it in how many; each row carries a bar filled to its share of the leader's score, and a form line — rounds solved, average guesses when solved — so a total that came from two lucky rounds reads differently from a steady one. |

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

**Word length.** Chosen on the title screen before the room is created, stored
on the room, and fixed for the whole match — joiners inherit it and never get a
say. 4, 5, 6 or 7 (the dictionary is seeded for all four), or Mixed, which
re-rolls 4-or-5 each round and is still the default. Longer words mean a bigger
guess budget and more board rows, so the tiles size themselves down to fit the
panel; a 7-letter Co-op round is 10 rows.

**Guess budgets.** `word length + 2` in Solo and PvP — a solo run is exactly
as hard as your half of a duel. `word length + 3` in Co-op, since that pool
is shared across the whole team rather than per player. Jackpot adds one
more guess on top of that, for the round.

**The rails.** The board is about 200px wide inside an 830px panel, so most
of the screen used to be empty. Two read-only columns fill it with things the
render loop already knew and never showed:

- **Left, in every mode:** a dot per round of the match with the current one
  lit, the number of guesses left as a large figure (red and pulsing on the
  last one) with a pip per attempt, and an "In play" block naming whatever
  modifiers are currently active — including one that landed mid-round.
- **Right, by mode:** in Co-op, the team, each with their colour and how many
  of the shared guesses they personally spent this round; in PvP, the rival
  and the ghost bar (a count of their burned guesses — never their letters);
  in Solo, your running score.

Both rails contain nothing focusable and nothing clickable, which is the
property that matters: there's no on-screen keyboard, so a rail that could
take focus would silently eat the next letter you typed. `wf-rails-test.mjs`
clicks a rail and then types, to prove the board still gets it.

**Who played which row.** In Co-op every guess is somebody's, and two
teammates' rows used to look identical — the ownership stripe was a 4px
inset shadow that read as nothing. It's now a colour tab hanging off the
left edge of the row, outside the grid so it costs the board no width, with
a white ring on the ones that are yours.

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

**Mid-round modifiers.** A *second*, independent global roll made in the same
`wf_next_round` call picks a modifier that lands partway through live play
instead of being announced up front — a surprise, not a warning. Whatever the
round already opened with is excluded from that pool, so a round never
announces Blitz and then "surprises" you with Blitz again. `mid_modifier_at_ms`
lands 40-60 seconds in, always leaving at least 30 seconds of clock to react.

| Modifier | What happens mid-round |
| --- | --- |
| 💰 Double Points | Points doubled. Scoring counts it the same as a round-start Double Points, and only doubles once however many landed. |
| ⚡ Blitz | Whatever clock is *left* is halved (never below 15s) — a flat 90s reset could otherwise *extend* a round that had less than that remaining. |
| 🙈 Blackout | The legend goes dark from here on. Pure client-side rule. |
| 🔀 Letter Swap | **Co-op only.** Two different players' guesses, picked at random, trade feedback — never a winning guess, so it can never fake a solve. |
| *(none)* | 55% of rounds. |

These are **global**: server-decided, shared by everyone in the room, and
applied by whichever client's clock crosses the mark first via
`wf_apply_mid_modifier` / `wf_trigger_letter_swap`. Both are idempotent on
`mid_modifier_fired`, so racing players can never double-apply a bonus. A
banner announces it across the top of the screen rather than the countdown's
full-screen card — play is already in progress, so it must not cover the board.

**Room events.** Everything that happens *around* the monitor is the opposite:
rolled on each client, seen by nobody else, and it mutates no game state at
all. Your cat is your cat — two people in the same duel get different
distractions at different moments, and neither can see the other's.

| Event | What it does |
| --- | --- |
| 🐈 Cat | Jumps up, crosses the desk and **sits down in front of the monitor**, covering the bottom rows of the board until you move it. Then it washes a paw, because it is not in a hurry. Drawn front-on: a profile cat is carried entirely by its outline and getting any of it slightly wrong makes it read as a generic quadruped, which is what happened to the first one. |
| 🦋 Moth | Comes in past the lamp and settles on the board, sitting over one already-revealed letter and blurring it out. The only room event that actually costs you something — swat it to get the letter back. |
| 📱 Phone | Buzzes face-up on the desk, screen lit. Click to silence it. |
| ✈️ Paper plane | Sails across the front of the room on an arc. The only room event with a window on it: catch it in flight, or it glides on and lands off-screen. |
| 🕷 Spider | Comes down on a thread from above the monitor and hangs in front of the screen. The only event that moves *vertically*, which is most of why it registers — everything else in this room travels sideways. Click it and it climbs back up. |
| 🐦 Bird | Lands on the sill outside, hops about, and goes. Purely ambient: it is across the room, behind glass, and there is nothing to click. |
| 🔊 Neighbour | Someone through the wall puts music on, and the soundtrack swaps to a muffled four-on-the-floor with the top end gone — what actually makes it through plasterboard. Bang on the wall to stop it. One bang is rude, not effective; the second one works. |
| 💡 Lamp flicker | The desk lamp stutters and the warm half of the room drops out with it. |
| 🔌 Power flicker | The monitor, not the lamp: the board dims and stutters for a beat. The most intrusive thing in here, so also the shortest and the rarest — and never dark enough to actually hide a letter, because room events do not carry penalties. |
| 🔌 Power cut | One strike per storm trips the breaker — see below. |
| ⛈ Thunderstorm | Rain streaks the window, and every few seconds lightning strikes: the room flashes white, the lamp cuts out with it, and for a beat the monitor is the only light left. Thunder trails the flash the way it does outdoors. |

**Every one of them has to cost something.** The first version of the cat
walked past below the screen and could be ignored completely, and so could
the mouse that followed it; both are gone in that form. The moth works
because it takes a letter away from you, so the cat — a much bigger animal —
takes several rows, and the mouse was cut rather than kept as a smaller,
more ignorable version of the same idea.

There is no bonus attached to any of them, and that is deliberate: a
client-rolled *bonus* would be trivially cheatable, whereas a client-rolled
*distraction* has nothing worth cheating at. The cost is the interruption
itself; clicking one clears it early. All of it lives in
`js/room-events.js`, and the models stand in the same 3D stage as the desk, so
they sit in real perspective rather than floating flat over the scene.

**Sound is synthesised, and the shape of the synthesis is the point.** There
are no audio files anywhere in the repo — every cue in `js/sfx.js` is a few
oscillators and an envelope, and the soundtrack in `js/music.js` is
generated a note at a time. Which means each one has to be built out of
whatever the real thing actually *is*, not out of a pitch that vaguely
gestures at it:

- The **meow** is a formant sweep — a sawtooth gliding through a resonant
  bandpass that tracks the pitch, with a 22Hz vibrato. The wobble is most of
  what separates "cat" from "synth".
- The **moth** is discrete wingbeats. Modulating a continuous band of noise
  with a 14Hz LFO is amplitude-modulated hiss; it read as static. A wingbeat
  is a ~14ms papery tap, so the taps are scheduled individually, jittered in
  spacing, level and brightness — because a moth stalls and surges rather
  than beating like a metronome — under a swell that carries it past the
  lamp and away.
- The **phone** is two things at once: the motor, a 68Hz body gated by its
  own ~29Hz rotation, and the case chattering on the wood, a thin band of
  noise riding the same gate. As two square blips it just sounded like a
  bass note.
- The **UI cues** all sit on one C-major pentatonic set with rounded attacks
  and a lowpass, so nothing in the game can produce a dissonant interval
  against anything else.

## The soundtrack

`js/music.js`. Generative, not a loop — there is a scheduler and a THEME
describing what to build: a tempo, a scale, a chord progression, and which
of pad / bass / arp / percussion are switched on.

Generative rather than a written loop because of what this has to do. The
track sits under someone concentrating on a word for five minutes at a
stretch, and a short loop announces itself the third time round. A
progression walking through its chords with a little controlled randomness
in the arp stops being something you notice and turns into room tone, which
is the entire job.

**Sixteen themes, and the game picks between them.**

| Theme | When | What it is |
| --- | --- | --- |
| `title` / `lobby` | Menus | Slow, open, almost still |
| `live` | Playing | The one that has to disappear — **no arp at all**, because a moving line is exactly what pulls attention off a word |
| `blitz` | ⚡ | 138bpm, minor, hats closed up |
| `double_points` | 💰 | Warm major with a bell arp |
| `blackout` | 🙈 | Everything shuts down to a low murmur, the way the legend has |
| `jackpot` | 🎰 | The only theme allowed to be loud |
| `letter_swap` | 🔀 | Whole-tone: nothing resolves, which is the joke |
| `storm` | ⛈ | Locrian at 128bpm with the most jittered arp of any theme — a storm about to take your lights out is not moody, it is chaotic |
| `outage` | 🔌 | The lights are out. A drone and a heartbeat, and nothing else |
| `neighbour` | 🔊 | Player-sided, so only you hear it |
| `arcade` | Minigames | Brighter and busier than the menus it sits between |
| `victory` / `defeat` | Match over | Win and lose end differently — the match used to finish on the same fanfare either way, which made losing feel like nothing had happened |
| `reveal` / `standings` | Between rounds | Held and resolved, out of the way of the reveal cue |

`game.js` has a single `musicTheme()` rather than a `music.set()` at every
transition. The answer depends on three things at once — the phase, the
round's opening event, and any modifier that landed mid-round — and working
that out in each caller is how they drift apart.

Two things worth knowing before touching this:

- **Scheduling uses the lookahead pattern.** A `setInterval` wakes every
  25ms and queues every note falling in the next 140ms, at sample-accurate
  times, on the audio clock. Note timing never touches `setTimeout`, so a
  board full of flipping tiles cannot make the music stutter.
- **Themes have two levels.** `base` is the game: shared, server-driven.
  `override` is a room event, which is player-sided and has to be able to
  borrow the music and hand it straight back — a storm ending mid-round
  cannot be allowed to clobber whatever the round was playing. A theme
  change waits for the top of a bar and ducks across the seam; cutting
  mid-bar is audible as a mistake. The scheduler's own clock never stops,
  which is why moving between phases sounds continuous rather than like a
  playlist skipping tracks.

**Volume.** `js/audio.js` owns the one AudioContext and splits it into two
buses, so music and effects carry independent volumes — the bed plays
continuously and the cues land on top of it, and "quieter music, keep the
tile flips" is not something one slider can say. Mute is a third control
over the top and does not destroy either setting. All three persist.

The settings panel is the only form control in the app, which is a real
hazard here: guesses are typed on a physical keyboard with no on-screen
alternative, and a focused `input[type=range]` eats arrow keys *and* would
let a letter through to the board at the same time. So the panel stops
keydown propagation while it is open, closing it returns focus to whatever
opened it, and both key listeners ignore anything aimed at a form control.

## The arcade

Waiting in a lobby for someone to join is the deadest moment in the app, and
the title screen is not far behind. Both get something to do — reachable
from the lobby and the title screen, and interrupted automatically the
moment a round starts.

- **Word Hunt.** Six letters; find every 4- and 5-letter word hiding in
  them. Fours score 1, fives score 3, `Tab` rerolls for 5 seconds off the
  clock. Racks are drawn best-of-eight by solution count, because the
  shipped word list is a broad one and a rack picked at random can clear a
  minimum while every word in it is obscure — a rack you cannot get into is
  the one thing that makes this feel unfair. (A straight "unscramble this
  word" version was tried first and is a bad game on this dictionary for
  exactly that reason.)
- **Chain.** The main game's own chain-letter rule on its own: you get a
  letter, you type a word starting with it, and that word's last letter is
  what the next one has to start with. The closest thing here to an actual
  warm-up — it is exactly the constraint that catches people out mid-match,
  when a round demands a word starting with the previous round's last letter
  and the opening guess they always use is suddenly illegal. Only `x` is
  genuinely thin in the shipped list (18 words against 2,007 for `s`), so a
  pass costs 5 seconds rather than being forbidden.
- **Moth Swat.** Reflex rather than vocabulary. They arrive faster as you
  go; three get past you and it's over.

**These award nothing.** No points, no bonuses, no effect on any round —
the only thing kept is a personal best in `localStorage`. That is the same
reasoning as the room events: a client-side thing that hands out a reward is
a client-side thing worth cheating at, and a leaderboard nobody else can see
is not a leaderboard. It is something to do while you wait.

## The power cut

The one thing in here allowed to be genuinely disruptive.

There is a consumer unit on the wall to your right with two indicator
lights. Green, and completely inert, for as long as nothing is wrong with
it — clicking scenery should do nothing. One lightning strike per storm
trips it, and then the room goes: the desk, the monitor, the board, all of
it, opaque and above the app overlay, because a breaker that only dimmed
things would not be a breaker. What is left is the red light.

Throw it back on and the round carries on where it was. Leave it ten
seconds and a bat fills the screen, after which the power comes back by
itself — the bat is the punishment, not being stuck in the dark.

Three things make this safe rather than a trap:

- **The way out is findable.** With the power off the box has nothing
  lighting it either, so it goes almost black and its own red LED picks out
  the shape. The whole box is the click target, not the small switch.
- **It is bounded either way.** Ten seconds, then the bat, then the lights.
  There is no state in which you are left in the dark.
- **Nothing survives the round.** `stopRoomEvents()` restores power, clears
  the blackout and removes the bat, so a round that ends mid-outage cannot
  leave the next one dark.

Like the rest of the room events it is player-sided and touches no game
state. The round clock keeps running, which *is* the cost — the same deal as
the cat sitting on your board. The server never knows it happened.

Exactly one strike per storm trips it, and never the first: tripping on
every strike would make a storm four blackouts in a row, and tripping on the
first gives no warning that a storm is even what is happening.

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
the full-screen event takeover — renders on that monitor's screen. Not
*inside* the 3D stage, though: the monitor stands at z = -900, so
perspective scales it to about 67%, and a downscaled layer is rasterised at
its layout size and then shrunk. Text does not survive that; every letter on
the monitor came out soft. So `#monitor-screen` is left as a bare measuring
rectangle, and `js/screen-fit.js` pins a flat, unscaled `#app-overlay` to
that rectangle's exact on-screen pixels, rounded outward so no seam of bezel
shows through. The app is ordinary 1:1 DOM — crisp, selectable, accessible —
that merely happens to sit where the screen is.

That gives three stacked layers, and the order is load-bearing:

| z | Layer | What's in it |
| --- | --- | --- |
| 1 | `.room#room-scene` | The 3D stage: floor, walls, desk, monitor, the player |
| 2 | `#app-overlay` | The flat app, pinned to the screen rectangle, plus the glass |
| 3 | `.room#room-front` | A second 3D stage sharing the same perspective, holding `#room-3d-fx` |
| 4 | `.screen-fx` | A flat viewport layer, for things that land on a specific tile |

Layer 3 exists so a room event that should pass *in front of* the monitor
(the cat) still draws over the app, even though the app is now above the
room. It shares layer 1's `perspective` and `perspective-origin`, so a rig
placed in it lands in the same 3D space the desk does.

Two things worth knowing before touching this:

- **`.room-stage` sets `pointer-events: none` and `.monitor-screen` sets it
  back to `auto`.** The stage's own box fills the viewport at z = 0, which
  puts it nearer the camera than everything it contains — so without that
  pair it silently swallows every click aimed at the monitor, and the UI
  looks perfect while being completely dead to the mouse.
  `wf-room-scene-test.mjs` hit-tests real controls to catch exactly this.
- **Tiles size themselves from the row count.** `--rows` (set by
  `renderGrid`) and `--panel-h` (published by `screen-fit.js`) drive a
  `min(46px, …)` calc, so a 10-row 7-letter Co-op board shrinks to fit
  rather than running off the bottom.
- **`renderGrid` splits structural rebuilds from typing.** A rebuild throws
  away every tile and so restarts every animation on the board. Folding the
  in-progress word into the rebuild signature therefore made the entire
  board re-play its flip on *every keystroke*. Structure changes rebuild;
  typing updates the active row in place, and leaves tiles whose letter
  hasn't changed completely alone.

Lighting is baked per surface rather than computed: one warm source (the
desk lamp, on the left) and one cool one (the monitor itself), with matching
pools on the desk and floor, contact shadows where objects meet the wood,
and a cool rim on the back of the player's head where the screen's light
wraps around them. That warm/cool disagreement is most of what reads as
"cozy" rather than "dark UI".

- **`#room-3d-fx` needs `position: absolute; inset: 0`.** `transform-style:
  preserve-3d` makes an element a containing block for its absolutely
  positioned descendants. Left as a zero-height static div, every rig's
  `top: 50%` resolved against nothing and the cat floated at the ceiling.

Room events split across layers 3 and 4 by what they have to line up with.
The cat, the phone and the storm are room objects, so they go in the 3D
stage and inherit its perspective. The moth has to land on one specific
tile, and converting a tile's screen rectangle back into stage coordinates
would be guesswork — so it lives in the flat layer and works in viewport
pixels.

It's all hand-drawn CSS and inline SVG: gradients, clip-paths, and curves
where a shape has to actually read as a thing (the cat). No image assets, no
build step, same as everything else here.

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
index.html          the flat app overlay first, then the 3D room behind
                    it, then the front stage and fx layers over it — the
                    order is the z-stack (see The room); guesses go in on
                    the player's own physical keyboard, nothing to tap
css/app.css          two coordinate systems: the 3D room, and the flat
                    panel pinned onto it (see The room)
js/config.js         connection details and every tunable
js/net.js            token identity, clock sync, RPCs, realtime channel
js/words.js           client-side "is this a real word" check (UX only)
js/audio.js           the one AudioContext, split into music/effects buses
js/sfx.js             synthesised WebAudio cues; no audio files
js/music.js           the generative soundtrack, one theme per situation
js/arcade.js          Word Hunt, Chain and Moth Swat, for the dead time
js/screen-fit.js      pins the flat overlay to the monitor's measured rect
js/room-events.js     the player-sided room: cat, moth, plane, spider, bird,
                      phone, lamp, neighbour, storm, and the power cut
js/game.js            phase clock, round settlement, input, scoring display
js/ui.js               DOM rendering: tile grid, legend, rails, standings
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
