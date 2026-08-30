# Instrument samples

Recorded notes, not synthesis. Eight instruments, ten to thirteen notes
each, four semitones apart — about 1.5MB in total. `js/instruments.js`
picks the nearest recorded note and pitch-shifts it, so the gaps cost a
couple of semitones of shift at most.

| folder | instrument | used for |
| --- | --- | --- |
| `nylon` | nylon-string acoustic guitar | plucked comps, the solo lines |
| `rhodes` | electric piano | keys and leads in the calm themes |
| `upright` | acoustic double bass | bass in everything unhurried |
| `ebass` | fingered electric bass | bass in everything that drives |
| `vibes` | vibraphone | the bell parts |
| `strings` | string ensemble | pads |
| `flute` | flute | counter-lines and solos over the top |
| `brass` | brass section | stabs, and the victory fanfare |

## Where they came from

The MusyngKite set from the [MIDI.js Soundfonts
collection](https://github.com/gleitz/midi-js-soundfonts), taken from the
npm package `web-music-score-samples`, which redistributes them under the
MIT licence.

Only the notes the game's range actually reaches were kept. The full set is
128 instruments at 20 notes each and runs to about 50MB; this is the eight
instruments and the four octaves the themes use.
