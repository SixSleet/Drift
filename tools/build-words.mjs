// Builds the game's word data for every supported language.
//
// Two very different lists come out of this, and the difference matters:
//
//   valid-<n>.json    everything the game will ACCEPT as a guess. Big, and
//                     allowed to contain obscure words -- being refused a
//                     word you know is the most annoying thing a word game
//                     can do to you.
//   answers-<n>.json  everything the game may CHOOSE as a secret. Small, and
//                     drawn only from the most common few thousand words of
//                     the language, because being asked to guess a word you
//                     have never seen is the second most annoying thing.
//
// Sources, both installed from npm (see tools/package.json):
//   dictionary-*                  Hunspell .aff/.dic, expanded through their
//                                 affix rules so inflected forms count too.
//   most-common-words-by-language frequency-ranked top 10k per language.
//
// Accents are stripped rather than supported: the board, the letter legend
// and the scoring all assume a 26-letter alphabet, and widening that is a
// much larger change than it looks. So "café" is played and stored as CAFE,
// and the same normalisation is applied to both lists so they always agree.
// Words that do not survive it at all (German ß, which would have to become
// "ss" and change length) are dropped rather than mangled.
//
// Usage:  node tools/build-words.mjs
// Writes: data/<lang>/{valid,answers}-{4,5,6,7}.json
//         supabase/seed-words.sql

import { IterableHunspellReader } from 'hunspell-reader';
import { getWordsList } from 'most-common-words-by-language';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DICT = path.join(import.meta.dirname, 'node_modules');

const LANGS = [
  { code: 'en', dict: 'dictionary-en', freq: 'english' },
  { code: 'it', dict: 'dictionary-it', freq: 'italian' },
  { code: 'de', dict: 'dictionary-de', freq: 'german' },
  { code: 'es', dict: 'dictionary-es', freq: 'spanish' },
  { code: 'fr', dict: 'dictionary-fr', freq: 'french' },
];

const LENGTHS = [4, 5, 6, 7];

/**
 * Fold to the 26-letter alphabet the board can actually display. Returns
 * null for anything that does not survive -- ß, digits, apostrophes,
 * hyphens, and the compound forms Hunspell emits like "Bell'Abaco".
 */
function normalise(raw) {
  const w = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /^[a-z]+$/.test(w) ? w : null;
}

/**
 * Words a party game should not put on screen as an answer. Deliberately
 * small and blunt: this guards the ANSWER pool only -- the valid list stays
 * permissive, because refusing to accept a word someone typed is a different
 * (and much more irritating) thing than declining to choose it as a secret.
 *
 * Substring matching, so inflections are covered without listing them.
 */
const BLOCK = {
  en: ['fuck', 'shit', 'cunt', 'dick', 'cock', 'piss', 'slut', 'whore', 'rape',
       'nigg', 'fagg', 'wank', 'bitch', 'twat', 'penis', 'vagin', 'semen',
       'boob', 'tits', 'anus', 'arse', 'bastard', 'bollock', 'porn', 'orgasm',
       'sperm', 'incest', 'dildo', 'blowjob'],
  it: ['cazz', 'merda', 'stronz', 'troia', 'puttan', 'figa', 'coglion', 'vaffan',
       'porca', 'zoccol', 'checca', 'frocio', 'negro', 'culo', 'porno', 'sperma',
       'orgasm', 'scopat'],
  de: ['schei', 'fick', 'fotze', 'arsch', 'hure', 'wichs', 'schwanz', 'titten',
       'neger', 'schlampe', 'muschi', 'porno', 'orgasm'],
  es: ['jod', 'mierda', 'puta', 'polla', 'cabron', 'gilipoll', 'follar', 'zorra',
       'maric', 'culo', 'pinche', 'verga', 'chinga', 'porno', 'orgasm', 'esperma'],
  fr: ['merde', 'putain', 'salope', 'connard', 'connasse', 'encul', 'pute',
       'negre', 'foutre', 'porno', 'orgasm', 'sperme'],
};

/**
 * The same idea, but matched whole-word -- and, like the substrings above,
 * scoped to one language.
 *
 * Both halves have to be per-language, and the reason is the same in each
 * direction. A substring cannot be used at all when its stem is ordinary
 * vocabulary somewhere: blocking "pene" as one would take Spanish
 * "penetrar", "cul" would take "cultura", "culpa" and "culte". And a
 * whole word is only rude in the language it belongs to: English "hell"
 * and "damn" have no business removing German *hell* (bright), and
 * Spanish's junk abbreviations have none removing German *Gral*.
 */
const BLOCK_EXACT = {
  en: new Set([
    'anal', 'butt', 'crap', 'damn', 'hell', 'suck', 'sucks', 'nude', 'nudity',
    'nudist', 'orgy', 'sexy', 'milf', 'milfs', 'horny', 'busty', 'pussy',
    'balls', 'erotic', 'erotica', 'escort', 'escorts', 'nipple', 'nipples',
    'breasts', 'panties', 'topless', 'bondage', 'twinks', 'voyeur', 'playboy',
    'sexual', 'turd', 'prick', 'queer',
    // Not words, just things a web-scraped frequency list is full of.
    'blvd', 'dept', 'dist', 'incl', 'misc', 'univ', 'corp', 'approx', 'viii',
    'chem', 'biol', 'phys', 'multi', 'ebay', 'ipod', 'itunes', 'meetup',
    'inline', 'plugin', 'plugins', 'runtime', 'sitemap', 'boolean',
  ]),
  it: new Set(['cagare', 'cagata', 'cagna', 'culi', 'pene', 'peni', 'tette',
               'sesso', 'sexy']),
  de: new Set(['sex', 'sexy', 'pissen', 'bastard']),
  es: new Set(['cagar', 'cago', 'caga', 'cagada', 'mear', 'meo', 'pedo', 'pedos',
               'pene', 'penes', 'puto', 'putos', 'putas', 'teta', 'tetas',
               'sexo', 'sexy', 'sexual',
               // coño, folded to the 26-letter alphabet like everything else.
               'cono', 'conos',
               'srta', 'depto', 'gral']),
  fr: new Set(['sexe', 'sexy', 'bite', 'bites', 'chatte', 'chattes', 'couilles',
               'baiser', 'baise']),
};

/**
 * Blocked in every language. Two kinds of thing end up here: strings that
 * are not words anywhere, and the Latin anatomy that survives into all five
 * dictionaries unchanged -- which a per-language list would otherwise have
 * to repeat five times over.
 */
const JUNK = new Set([
  'http', 'https', 'www',
  'penis', 'penes', 'pene', 'peni', 'vagina', 'vagin', 'vagine', 'vaginas',
]);

const blocked = (w, lang) => JUNK.has(w)
  || BLOCK_EXACT[lang].has(w)
  || BLOCK[lang].some((bad) => w.includes(bad));

/**
 * How many expanded forms the affix pass will look at before giving up, per
 * language -- about 90 seconds on the one dictionary that ever reaches it.
 * See readDictionary.
 *
 * Counted rather than timed, so two runs of this script on the same
 * dictionary produce the same word list. A wall-clock budget was simpler and
 * quietly made the output depend on how busy the machine was -- Italian
 * gained and lost a few dozen inflections between runs, which is a horrible
 * property for a file that gets committed and diffed.
 */
const EXPAND_LIMIT = 20_000_000;

/**
 * Every form the Hunspell dictionary knows, folded and length-filtered.
 *
 * Two passes, because one is not enough:
 *
 *   roots   every stem in the .dic. Fast, complete, and guarantees the base
 *           forms (infinitives, singulars) are all present.
 *   affixes the stems run through the .aff rules, which is where plurals and
 *           conjugations come from -- the forms players actually type.
 *
 * The affix pass is capped rather than run to completion because some
 * dictionaries do not terminate in any useful sense: Italian's compounding
 * rules yield 28 MILLION forms without finishing, the vast majority of them
 * apostrophe compounds ("Coll'Abaco") that get thrown away here anyway.
 * French, by contrast, finishes well inside the cap. Taking the union with
 * the roots means a truncated affix pass costs some inflections, never a
 * whole vocabulary.
 */
async function readDictionary(pkg) {
  const base = path.join(DICT, pkg, 'index');
  const reader = await IterableHunspellReader.createFromFiles(`${base}.aff`, `${base}.dic`);
  const out = new Set();
  const capitalised = new Set();

  // Hunspell keeps proper nouns capitalised; a word game does not want them
  // -- nobody can be expected to guess a surname. The capitalised forms are
  // still collected, folded, so `properOnly` below can name them.
  const take = (raw) => {
    if (!raw || raw.includes("'")) return;
    const w = normalise(raw);
    if (!w || w.length < 4 || w.length > 7) return;
    if (raw[0] !== raw[0].toLowerCase()) capitalised.add(w);
    else out.add(w);
  };

  for (const raw of reader.seqRootWords()) take(raw);
  const rootsOnly = out.size;

  let truncated = false;
  let seen = 0;
  for (const raw of reader.iterateWords()) {
    if (++seen > EXPAND_LIMIT) { truncated = true; break; }
    take(raw);
  }

  /**
   * Words the dictionary only ever knows capitalised -- so, names.
   *
   * Compared against the WHOLE lowercase expansion rather than the roots,
   * which matters: "acts" and "jobs" are not lowercase roots (the roots are
   * "act" and "job"), but "Acts" and "Jobs" are capitalised ones, so a
   * roots-only comparison calls both of them proper nouns and quietly drops
   * two ordinary words.
   *
   * This is deliberately not applied to the VALID list. Being refused
   * "paris" when you typed it is a different, worse thing than never being
   * asked to guess it.
   */
  const properOnly = new Set([...capitalised].filter((w) => !out.has(w)));
  return { words: out, properOnly, rootsOnly, truncated };
}

/** The frequency list, folded, in rank order, deduped. */
function readFrequency(name) {
  const seen = new Set();
  const out = [];
  for (const raw of getWordsList(name, 10000)) {
    const w = normalise(raw);
    if (!w || w.length < 4 || w.length > 7) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * The English lists that predate this script, from data/*.json.
 *
 * Both are kept and merged rather than replaced. The curated answer set is
 * good, and the old valid list is substantially LARGER than what
 * dictionary-en expands to (73k against 28k) -- regenerating from scratch
 * would have quietly made the game reject thousands of words it used to
 * accept, which is exactly the failure this whole file exists to avoid.
 */
async function existingEnglish(kind) {
  const out = new Set();
  for (const n of LENGTHS) {
    const p = path.join(import.meta.dirname, 'legacy-en', `${kind}-${n}.json`);
    if (!existsSync(p)) continue;
    for (const w of JSON.parse(await readFile(p, 'utf8'))) {
      const norm = normalise(w);
      if (norm && norm.length >= 4 && norm.length <= 7) out.add(norm);
    }
  }
  return out;
}

const sqlQuote = (s) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  const seedParts = [];
  const summary = [];

  for (const lang of LANGS) {
    process.stdout.write(`${lang.code}: expanding dictionary… `);
    const { words: dict, properOnly, rootsOnly, truncated } = await readDictionary(lang.dict);
    process.stdout.write(`${dict.size} forms (${rootsOnly} roots${truncated ? ', affix pass truncated' : ''}); `);

    // English never consults the frequency list (see below), so it does not
    // pay for reading one either.
    const freq = lang.code === 'en' ? [] : readFrequency(lang.freq);

    // An answer has to be common (in the frequency list), real (in the
    // dictionary) and printable in a family setting.
    // English is the exception: its frequency list is scraped from web text
    // and full of things no one wants as a secret word -- porn, brand names
    // ("ebay", "itunes"), and abbreviations that only look like words
    // ("dept", "blvd", "viii"). The curated legacy list is better than
    // anything filtering could rescue from it, so English simply keeps that.
    const answers = new Set();
    if (lang.code !== 'en') {
      for (const w of freq) {
        if (!dict.has(w)) continue;
        if (blocked(w, lang.code)) continue;
        answers.add(w);
      }
    }
    // German capitalises every noun, so "only ever seen capitalised" could
    // in principle mean "is a noun" there and gut the pool. Measured before
    // trusting it: with the comparison made against the full expansion, all
    // four non-English languages lose nothing at all to this, and English
    // loses 143 first names, cities and brand names -- alan, emma, paris,
    // linux, honda -- that were never fair to be asked to guess.
    for (const w of properOnly) answers.delete(w);
    const valid = new Set(dict);
    if (lang.code === 'en') {
      for (const w of await existingEnglish('answers')) {
        if (!blocked(w, lang.code) && !properOnly.has(w)) answers.add(w);
      }
      for (const w of await existingEnglish('valid')) valid.add(w);
    }

    // Anything choosable as an answer must also be accepted as a guess --
    // otherwise the game can pick a word it will not let you type.
    for (const w of answers) valid.add(w);

    const dir = path.join(ROOT, 'data', lang.code);
    await mkdir(dir, { recursive: true });

    const counts = { lang: lang.code };
    for (const n of LENGTHS) {
      const v = [...valid].filter((w) => w.length === n).sort();
      const a = [...answers].filter((w) => w.length === n).sort();
      await writeFile(path.join(dir, `valid-${n}.json`), JSON.stringify(v));
      await writeFile(path.join(dir, `answers-${n}.json`), JSON.stringify(a));
      counts[`v${n}`] = v.length;
      counts[`a${n}`] = a.length;

      // One statement per (language, length). The words go in as a single
      // comma-delimited string rather than 1,600 separately quoted literals:
      // same rows, about a quarter less text, and the whole seed file stays
      // something you can open without regretting it.
      if (a.length) {
        seedParts.push(
          `insert into public.wf_words (word, length, lang)\n` +
          `  select w, ${n}, ${sqlQuote(lang.code)}\n` +
          `    from unnest(string_to_array(${sqlQuote(a.join(','))}, ',')) as w\n` +
          `  on conflict (word, lang) do nothing;`);
      }
    }
    summary.push(counts);
    console.log(`answers ${LENGTHS.reduce((s, n) => s + counts[`a${n}`], 0)}, valid ${LENGTHS.reduce((s, n) => s + counts[`v${n}`], 0)}`);
  }

  const header = `-- Seeded answer pools, one row per (word, language).
--
-- GENERATED by tools/build-words.mjs -- do not edit by hand. Sources are the
-- Hunspell dictionaries and the frequency lists named in that file; a word
-- only lands here if it is common enough to be fair to guess.
--
-- Applied on top of schema.sql, which creates wf_words. Re-runnable: every
-- statement is ON CONFLICT DO NOTHING.

`;
  await writeFile(path.join(ROOT, 'supabase', 'seed-words.sql'), header + seedParts.join('\n') + '\n');

  console.table(summary);
}

await main();
