/**
 * TASK-S0 — input loader: setpack JSON -> normalized.json + unknown-terms.json.
 *
 * Read section-by-section against docs/social-package-spec.md before editing.
 * Key decisions worth knowing before you touch this file:
 *
 * - Validation is hand-written, not schema-engine-driven. schema/*.json are
 *   the documented contract; no schema-validator package was added to
 *   package.json (S0 may only change one existing line, an Express route —
 *   see the task brief — so no new dependency is in scope here).
 * - meta.songCount vs songs.length mismatches are a warning, never a throw;
 *   songs.length is authoritative (see spec section 3).
 * - seasonMoment is promoted to set-level only when every song's value is
 *   identical; otherwise it stays untouched per-song. Do not "fix" a mixed
 *   set by promoting the majority value — that silently drops information
 *   S1 needs.
 * - coverage.nouns is deliberately scoped to nouns.json matches only (a
 *   timewords.json hit doesn't count toward it either way). This keeps
 *   "swap nouns.json for an empty file" a clean, dependency-free way to prove
 *   the Korean text isn't hardcoded in this module. See lexicon.js's
 *   computeSourceCoverage for the mechanics.
 * - TASK-S7: titleLocalized is optional as of Suno Weaver Studio's v2 export
 *   format. A missing value falls back to the English `title` and is always
 *   recorded via `titleLocalizedFallback` on the song; when the output
 *   language is ko/ja (i.e. someone will actually read an English title where
 *   a Korean/Japanese one belongs) it also lands in set.warnings, prefixed
 *   `[중요]` once more than half the set fell back. Do not silence this —
 *   see docs/social-package-spec.md §14a for why it must stay loud.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon, loadStopwords, scanTextMulti, computeSourceCoverage, lookupExact } from './lexicon.js';
import { parseEmotionArc } from './emotionArcParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHANNELS_PATH = path.join(ROOT, 'data', 'channels.json');
const OUT_ROOT = path.join(ROOT, 'out');

const REQUIRED_META_FIELDS = ['setName', 'channelId', 'channelLabel', 'songCount', 'lyricLanguage'];
// TASK-S7: titleLocalized dropped from Suno Weaver Studio's v2 export format
// (upstream change, cause unconfirmed — see docs/social-package-spec.md §14a).
// It is intentionally NOT in this list anymore; normalizeSetPack() falls back
// to `title` and records the fallback instead of throwing. A missing song
// title itself (`title`) still throws — that one nothing can substitute for.
const REQUIRED_SONG_FIELDS = ['trackNo', 'title', 'listenerSituation', 'emotionArc', 'hookPhrase', 'lyrics'];
const ALLOWED_LYRIC_LANGUAGES = new Set(['english', 'korean', 'japanese']);
const OUTPUT_LANGUAGE_LABELS = { ko: '한국어', ja: '일본어' };

// Explicit upper bound so a malformed/adversarial input can't drive an
// unbounded loop below (TASK-S0 completion condition #9).
const MAX_SONGS_PER_SET = 500;

class SetPackValidationError extends Error {}

// ---------------------------------------------------------------------------
// 1. Load + validate
// ---------------------------------------------------------------------------

/** Reads a setpack JSON file from disk, stripping a leading BOM if present. */
export function readSetPackFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

/**
 * Validates the raw setpack object against the required-field contract in
 * schema/setpack.schema.json. Throws SetPackValidationError with a specific,
 * human-readable reason on the first problem found — no default-filling.
 * Returns non-fatal warnings (currently: songCount/songs.length mismatch).
 */
export function validateSetPack(data) {
  const warnings = [];
  if (!data || typeof data !== 'object') {
    throw new SetPackValidationError('setpack이 객체가 아닙니다.');
  }
  if (!data.meta || typeof data.meta !== 'object') {
    throw new SetPackValidationError('meta 필드가 없습니다.');
  }
  for (const field of REQUIRED_META_FIELDS) {
    if (data.meta[field] === undefined || data.meta[field] === null || data.meta[field] === '') {
      throw new SetPackValidationError(`meta.${field} 필드가 없습니다.`);
    }
  }
  if (!ALLOWED_LYRIC_LANGUAGES.has(data.meta.lyricLanguage)) {
    throw new SetPackValidationError(`meta.lyricLanguage 값이 올바르지 않습니다: ${data.meta.lyricLanguage}`);
  }
  if (!Array.isArray(data.songs) || data.songs.length === 0) {
    throw new SetPackValidationError('songs 배열이 비어 있거나 없습니다.');
  }
  if (data.songs.length > MAX_SONGS_PER_SET) {
    throw new SetPackValidationError(`songs 배열이 상한(${MAX_SONGS_PER_SET}곡)을 초과했습니다.`);
  }

  const seenTrackNo = new Set();
  for (let i = 0; i < data.songs.length; i += 1) {
    const song = data.songs[i];
    const label = `songs[${i}]`;
    if (!song || typeof song !== 'object') {
      throw new SetPackValidationError(`${label}이 객체가 아닙니다.`);
    }
    for (const field of REQUIRED_SONG_FIELDS) {
      if (song[field] === undefined || song[field] === null || song[field] === '') {
        throw new SetPackValidationError(`${label}.${field} 필드가 없습니다 (trackNo=${song.trackNo ?? '?'}).`);
      }
    }
    if (seenTrackNo.has(song.trackNo)) {
      throw new SetPackValidationError(`trackNo가 중복되었습니다: ${song.trackNo}`);
    }
    seenTrackNo.add(song.trackNo);
  }

  if (Number(data.meta.songCount) !== data.songs.length) {
    warnings.push(
      `meta.songCount(${data.meta.songCount})와 songs.length(${data.songs.length})가 다릅니다. songs.length를 기준으로 진행합니다.`
    );
  }

  return { warnings };
}

// ---------------------------------------------------------------------------
// 2. Channel -> output language
// ---------------------------------------------------------------------------

/** Loads data/channels.json and resolves channelId -> {language}. Throws on no match — never defaults. */
export function resolveChannelLanguage(channelId) {
  const raw = fs.readFileSync(CHANNELS_PATH, 'utf8').replace(/^﻿/, '');
  const config = JSON.parse(raw);
  const mappings = Array.isArray(config.mappings) ? config.mappings : [];
  for (const mapping of mappings) {
    if (mapping.type === 'exact' && mapping.match === channelId) return mapping.language;
    if (mapping.type === 'prefix' && channelId.startsWith(mapping.match)) return mapping.language;
  }
  throw new SetPackValidationError(
    `channelId "${channelId}"에 대한 출력 언어 매핑이 data/channels.json에 없습니다. 기본 언어로 넘어가지 않고 등록을 요청합니다.`
  );
}

// ---------------------------------------------------------------------------
// 3. Normalize
// ---------------------------------------------------------------------------

function loadLanguageLexicons(lang) {
  return {
    nouns: loadLexicon(lang, 'nouns'),
    emotions: loadLexicon(lang, 'emotions'),
    timewords: loadLexicon(lang, 'timewords'),
    transitions: loadLexicon(lang, 'transitions'),
  };
}

function topByFrequency(values, limit) {
  const counts = new Map();
  const firstSeenOrder = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (!counts.has(v)) {
      counts.set(v, 0);
      firstSeenOrder.push(v);
    }
    counts.set(v, counts.get(v) + 1);
  }
  return firstSeenOrder
    .sort((a, b) => counts.get(b) - counts.get(a))
    .slice(0, limit);
}

/**
 * Converts a validated setpack object into the S1-ready normalized shape.
 * @param {object} data - already validated via validateSetPack().
 * @param {string[]} initialWarnings - warnings collected during validation.
 */
export function normalizeSetPack(data, initialWarnings = []) {
  const outputLanguage = resolveChannelLanguage(data.meta.channelId);
  const lex = loadLanguageLexicons(outputLanguage);
  const stopwords = loadStopwords();

  const warnings = [...initialWarnings];
  const unknownTermEntries = [];
  const unmatchedEmotionArcs = [];
  const allMatchedTerms = [];
  const allUnknownTerms = [];
  const emotionPhraseResults = []; // {resolved: boolean} for coverage.emotions
  let titleLocalizedFallbackCount = 0;
  const upstreamWarnings = []; // song.warnings from Suno Weaver Studio itself (v2 field) — merged in with a "[상류]" prefix below

  const scanSources = [
    { name: 'timewords', lexicon: lex.timewords },
    { name: 'nouns', lexicon: lex.nouns },
  ];

  const normalizedSongs = data.songs.map((song) => {
    const { matchedTerms, unknownTerms } = scanTextMulti(song.listenerSituation, scanSources, stopwords);
    allMatchedTerms.push(...matchedTerms);
    allUnknownTerms.push(...unknownTerms);
    for (const term of unknownTerms) {
      unknownTermEntries.push({
        term,
        field: 'listenerSituation',
        trackNo: song.trackNo,
        context: song.listenerSituation,
      });
    }

    // TASK-S7: v2-only field. Same scan treatment as listenerSituation — it's
    // free scene-description text, just under a different key — so it's
    // added to the same coverage.nouns pool rather than tracked separately.
    // Absent on v1 files; scanTextMulti/lexicon lookups never run for null/undefined.
    let lyricThemeMatchedTerms = [];
    let lyricThemeUnknownTerms = [];
    if (song.lyricThemeText) {
      const themeScan = scanTextMulti(song.lyricThemeText, scanSources, stopwords);
      lyricThemeMatchedTerms = themeScan.matchedTerms;
      lyricThemeUnknownTerms = themeScan.unknownTerms;
      allMatchedTerms.push(...lyricThemeMatchedTerms);
      allUnknownTerms.push(...lyricThemeUnknownTerms);
      for (const term of lyricThemeUnknownTerms) {
        unknownTermEntries.push({
          term,
          field: 'lyricThemeText',
          trackNo: song.trackNo,
          context: song.lyricThemeText,
        });
      }
    }

    const emotionArc = parseEmotionArc(song.emotionArc, lex.transitions, lex.emotions);
    if (!emotionArc.parsed) {
      unmatchedEmotionArcs.push({ trackNo: song.trackNo, raw: song.emotionArc });
    } else {
      for (const side of [emotionArc.from, emotionArc.to]) {
        emotionPhraseResults.push(side.ko !== null);
        if (side.ko === null) {
          unknownTermEntries.push({
            term: side.en,
            field: 'emotionArc',
            trackNo: song.trackNo,
            context: song.emotionArc,
          });
        }
      }
    }

    // TASK-S7: titleLocalized is now optional (see REQUIRED_SONG_FIELDS
    // comment above). Falling back to the English `title` is the only way to
    // keep the pipeline running at all — but it must never happen quietly,
    // hence titleLocalizedFallback + the set-level warning built after this
    // map (needs the total count first).
    const titleLocalizedFallback = !song.titleLocalized;
    if (titleLocalizedFallback) titleLocalizedFallbackCount += 1;

    if (Array.isArray(song.warnings)) {
      for (const w of song.warnings) {
        if (w) upstreamWarnings.push(`[상류] (트랙 ${song.trackNo}) ${w}`);
      }
    }

    return {
      trackNo: song.trackNo,
      title: song.title,
      titleLocalized: song.titleLocalized || song.title,
      titleLocalizedFallback,
      seasonMoment: song.seasonMoment ?? null, // set.seasonHint promotion (below) clears this when uniform
      listenerSituation: {
        raw: song.listenerSituation,
        matchedTerms,
        unknownTerms,
      },
      lyricThemeText: song.lyricThemeText
        ? { raw: song.lyricThemeText, matchedTerms: lyricThemeMatchedTerms, unknownTerms: lyricThemeUnknownTerms }
        : null,
      emotionArc,
      hookPhrase: song.hookPhrase,
      stylePrompt: song.stylePrompt ?? null,
      excludePrompt: song.excludePrompt ?? null,
      lyrics: song.lyrics,
      youtube: song.youtube ?? null,
      // v2-only fields, passed through raw when present (v1 files leave these null/undefined) — see spec §7a.
      distinctChoice: song.distinctChoice ?? null,
      genreText: song.genreText ?? null,
      pov: song.pov ?? null,
      qualityScore: typeof song.qualityScore === 'number' ? song.qualityScore : null,
    };
  });

  if (titleLocalizedFallbackCount > 0) {
    const total = data.songs.length;
    const langLabel = OUTPUT_LANGUAGE_LABELS[outputLanguage];
    if (langLabel) {
      const prefix = titleLocalizedFallbackCount > total / 2 ? '[중요] ' : '';
      warnings.push(
        `${prefix}titleLocalized 누락 — 영어 원제로 대체함 (${total}곡 중 ${titleLocalizedFallbackCount}곡). ${langLabel} 채널이므로 곡목록이 영어로 출력됩니다.`
      );
    }
    // langLabel undefined (e.g. an eventual English-output channel) is not a
    // warning target — English titles falling back to English is normal.
  }
  warnings.push(...upstreamWarnings);

  // --- seasonMoment set-level promotion (spec section 7) ---
  let seasonHint = null;
  const seasonValues = data.songs.map((s) => s.seasonMoment);
  const allDefined = seasonValues.every((v) => v !== undefined && v !== null && v !== '');
  const allSame = allDefined && seasonValues.every((v) => v === seasonValues[0]);
  if (allSame) {
    const seasonKo = lookupExact(seasonValues[0], lex.timewords);
    seasonHint = { raw: seasonValues[0], ko: seasonKo ? seasonKo.ko : null, promoted: true };
    warnings.push('seasonMoment가 전곡 동일하여 세트 레벨로 승격함');
    for (const song of normalizedSongs) song.seasonMoment = null;
  }

  const dominantEmotions = topByFrequency(
    normalizedSongs.map((s) => (s.emotionArc.parsed ? s.emotionArc.to.ko : null)),
    3
  );
  const sceneNouns = topByFrequency(allMatchedTerms.map((m) => m.ko), 12);

  const coverageNouns = computeSourceCoverage(allMatchedTerms, allUnknownTerms, 'nouns');
  const emotionsCoverage =
    emotionPhraseResults.length === 0
      ? 1
      : emotionPhraseResults.filter(Boolean).length / emotionPhraseResults.length;

  if (coverageNouns < 0.9) {
    warnings.push(`coverage.nouns(${coverageNouns.toFixed(2)})가 0.90 미만입니다.`);
  }

  const normalized = {
    set: {
      setName: data.meta.setName,
      generatedAt: data.meta.generatedAt ?? null,
      channelId: data.meta.channelId,
      channelLabel: data.meta.channelLabel,
      conceptLabel: data.meta.conceptLabel ?? null,
      outputLanguage,
      lyricLanguage: data.meta.lyricLanguage,
      trackCount: data.songs.length,
      titlesKo: normalizedSongs.map((s) => s.titleLocalized),
      dominantEmotions,
      sceneNouns,
      seasonHint,
      warnings,
      assets: { shorts: [] },
    },
    songs: normalizedSongs,
  };

  const report = {
    setName: data.meta.setName,
    coverage: { nouns: coverageNouns, emotions: emotionsCoverage },
    unknownTerms: unknownTermEntries,
    unmatchedEmotionArcs,
  };

  return { normalized, report, warnings };
}

// ---------------------------------------------------------------------------
// 4. End-to-end pipeline (file in -> files out)
// ---------------------------------------------------------------------------

/**
 * Runs the full S0 pipeline against a setpack file and writes
 * out/{setName}/normalized.json and out/{setName}/unknown-terms.json.
 * Returns { normalized, report } so callers (tests, CLI) can inspect them
 * without re-reading from disk.
 */
export function runSetPackPipeline(filePath) {
  const data = readSetPackFile(filePath);
  const { warnings } = validateSetPack(data);
  const { normalized, report } = normalizeSetPack(data, warnings);

  const outDir = path.join(OUT_ROOT, data.meta.setName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'normalized.json'), JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'unknown-terms.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  return { normalized, report, outDir };
}

export { SetPackValidationError };
