# Wordforge

A browser word game for 1–10 players. Guess the hidden word before your
guesses — or the clock — run out. Play alone, race a rival head to head, or
share one board with your whole team.

**Play: <https://sixsleet.github.io/Drift/>**

Built for a desktop screen. Guesses are typed on your own keyboard; there is
nothing on screen to click.

<p align="center">
  <img src="assets/screenshots/01-menu.jpg" width="49%" alt="The main menu, in the room the whole game is staged in.">
  <img src="assets/screenshots/04-gameplay.jpg" width="49%" alt="A round in progress.">
  <img src="assets/screenshots/03-lobby.jpg" width="49%" alt="Waiting in a Co-op lobby, room code up.">
  <img src="assets/screenshots/07-arcade.jpg" width="49%" alt="Moth Swat, one of the three minigames.">
  <img src="assets/screenshots/08-standings.jpg" width="49%" alt="Standings between rounds.">
  <img src="assets/screenshots/09-victory.jpg" width="49%" alt="A completed run.">
</p>
<p align="center">
  <img src="assets/screenshots/02-jukebox.jpg" width="49%" alt="The soundtrack picker, playable from the main menu.">
</p>

---

## The basics

You get a hidden word and a budget of guesses. Type a real word of the right
length and press Enter. Each letter comes back as one of three things:

| Tile | Meaning |
| --- | --- |
| 🟩 **Hit** | Right letter, right place |
| 🟨 **Present** | Right letter, wrong place |
| ⬛ **Miss** | Not in the word |

A guess that lands nothing at all gets its own shake and sting. Every letter
you have ruled out greys out in the legend under the board, so you never
waste a guess retyping one.

Every round has a **5-minute clock**. Run out and the round ends there, word
revealed, unsolved.

## Modes

- **Solo** — just you and the clock. Same rules and the same guess budget as
  your half of a duel.
- **PvP Duel** — you and a rival race the same word at the same time. You
  only ever see your own board; a bar shows how many guesses your rival has
  burned and nothing else. **First to solve it wins the round**, however many
  guesses it took — so there is no reason to wait.
- **Co-op** — the whole room shares one board and one guess pool. Anyone can
  play the next guess. Coordinate, or waste attempts.

## Setting up a match

Pick the **word length** before you create the room: 4, 5, 6, 7, or Mixed
(4 or 5, re-rolled each round). It is fixed for the whole match, and anyone
who joins inherits it.

Then pick the number of **rounds** — 4, 6, 8 or 12. Points build across all
of them, and whoever has the most at the end wins.

**Guess budgets** are word length + 2 in Solo and PvP, and word length + 3 in
Co-op — no bigger a pool just because you invited more people.

## Scoring

```
points = max(0, guesses allowed − guesses used + 1) × 10
```

Plus a speed bonus in Solo and PvP (+20 for a near-instant solve, +10 for a
quick one), and doubled if the round rolled Double Points. Co-op scores the
same way off the shared attempt count and splits it across the team.

## The chain

From round 2 on, the secret usually has to **start with the last letter of
the previous round's word** — so you cannot lean on one memorised opening
guess all match. Watch the badge in the HUD. If no word of the right length
starts with that letter, the constraint quietly drops for that round.

## Round events

About one round in two rolls one, announced full-screen for the whole
5-second countdown so nobody misses it.

| Event | Odds | What it does |
| --- | --- | --- |
| 💰 Double Points | 15% | The round pays double |
| ⚡ Blitz | 15% | The clock is cut to 90 seconds |
| 🙈 Blackout | 15% | The legend stops greying out letters you have ruled out |
| 🎰 **Jackpot** | 5% | An extra guess **and** double points |
| *(none)* | 50% | An ordinary round |

## Mid-round modifiers

A round can also spring a **second** modifier on you partway through, rather
than announcing it up front. Double points from here on, the remaining clock
halved, the legend going dark, or — in Co-op only — a 🔀 **Letter Swap**,
which makes two players' guesses trade tiles.

These are global: everyone in the room gets the same one at the same moment,
and it is announced to all of you.

## Your room

Meanwhile the room you are sitting in carries on without you.

| | |
| --- | --- |
| 🐈 **Cat** | Climbs onto the desk and sits down in front of the monitor, covering the bottom of the board. Click to move it |
| 🦋 **Moth** | Settles on a letter you have already earned and blurs it out. Swat it to get the letter back |
| 🕷 **Spider** | Comes down on a thread in front of the screen. Click and it climbs back up |
| 📱 **Phone** | Buzzes on the desk. Click to silence it |
| ✈️ **Paper plane** | Sails across the room. Catch it in flight, or it lands off screen |
| 🔊 **Neighbour** | Music through the wall, and the soundtrack changes with it. Bang on the wall twice to stop it |
| 💡 **Lamp** | The desk lamp stutters |
| 🐦 **Bird** | Lands on the sill outside. Nothing to do; it is just there |
| ⛈ **Thunderstorm** | Rain, lightning, and the lights going with it |

**These are yours alone.** Nobody else sees them, they change nothing about
the game, and the only cost is that they are in your way. Most can be cleared
with a click.

## The power cut

One lightning strike per storm trips the breaker on the wall. The room goes
dark — all of it — and the only thing left is the red light on the fuse box.

**Click it to put the power back on.** Leave it ten seconds and something
comes out of the dark. The lights come back on their own after that.

The round clock keeps running the whole time.

## Minigames

Waiting in a lobby is the dullest part of any game, so there are three
things to do while you wait. They are worth nothing — no points, no bonuses,
no effect on any match — beyond a personal best kept in your own browser.

- **Word Hunt** — six letters; find every 4- and 5-letter word hiding in
  them. Fours score 1, fives score 3. `Tab` for new letters, at the cost of
  5 seconds.
- **Chain** — each word must start with the last letter of the one before,
  which is the rule that catches people out mid-match. `Tab` to pass.
- **Moth Swat** — they come faster as you go. Three get past you and it is
  over.

## Sound

Everything you hear is generated as you play — there are no audio files.

**Each mode has its own soundtrack.** Solo is a quiet bed with nothing moving
over it, on purpose — anything with a tune in it pulls your eye off the word.
PvP is fast and driving, because somebody is racing you. Co-op is the calm one
and swings, which is what stops it being Solo in a different key.

**And each minigame has its own**, as does everything that happens to you: the
blitz clock, a blackout, a jackpot, a letter swap, the storm, the power going
out, the neighbour's stereo, the standings between rounds, and winning or
losing. Twenty-one pieces of music in all, none of them the same as another.

**Play any of it from the main menu** — "Soundtrack" lists every track in
the game and plays whichever you pick. It hands the music straight back the
moment you leave the menu, so a lobby and a match sound like they should.

Music and effects have **separate volume sliders**, under the ⚙ in the HUD or
"Sound settings" on the title screen, and both are remembered.

## Joining, renaming and leaving

Create a room and share the four-character code, or the link — anyone
opening it drops straight into the code screen. Solo needs no room at all.

You get a name when you join. **Change it in the lobby** with "Change your
name" — up to 14 characters, and everyone else in the room sees it straight
away. It is fixed once the match starts, since by then it is attached to
guesses other people have already read.

**Leave** from the lobby, or with the ⏻ button in the HUD mid-match. What
happens to everyone else depends on when:

- **From the lobby**, your seat goes back into the pool for someone else.
- **Mid-match**, you keep your place in the standings — you earned those
  points — but you are marked as having left.
- **If you were the host**, the room is handed to whoever has been there
  longest, so it can still be started and advanced.
- **In a duel**, the remaining player is taken to the final standings rather
  than left waiting for a rival who is not coming back.
- **In Co-op**, the match carries on with whoever is left.

## Licence

See `LICENSE`.
