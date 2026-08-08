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
const SCENE_NOUN_WEIGHTS_PATH = path.join(ROOT, 'data', 'sceneNounWeights.json');
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

export function loadSceneNounWeights() {
  const raw = fs.readFileSync(SCENE_NOUN_WEIGHTS_PATH, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

function sceneNounBandWeight(songCount, weights) {
  if (songCount <= weights.rareMaxSongCount) return weights.rareWeight;
  if (songCount >= weights.commonMinSongCount) return weights.commonWeight;
  return weights.midWeight;
}

/**
 * TASK-S8 — rarity-weighted scene-noun scoring (replaces plain
 * top-by-frequency, which let words appearing in nearly every song dominate
 * every generated sentence — see data/sceneNounWeights.json's _comment).
 *
 * `termInfo` is Map<ko, {songs: Set<trackNo>, category: string|null, order: number}>.
 * Returns every entry, sorted score-descending (not sliced to a limit) —
 * unknown terms never reach this map at all, since it's only ever fed from
 * scanTextMulti's matchedTerms (spec requirement: "사전에 등재된 단어만
 * 대상으로 한다").
 */
export function scoreSceneTerms(termInfo, weights) {
  const entries = [...termInfo.entries()].map(([ko, info]) => {
    const songCount = info.songs.size;
    const score = sceneNounBandWeight(songCount, weights) * (1 / songCount);
    return { ko, en: info.en ?? null, songCount, category: info.category, order: info.order, score };
  });
  entries.sort((a, b) => b.score - a.score || a.order - b.order);
  return entries;
}

/**
 * Same ranking as rankSceneTerms(), but returns the full entry objects
 * ({ko, en, songCount, category, order, score}) instead of a flat ko[]
 * array — TASK-S9's set.sceneNounDetails needs the "why was this word
 * picked" data (songCount/score/category/the original English term) that
 * rankSceneTerms() throws away at the end. rankSceneTerms() is now a thin
 * wrapper around this, kept for its existing callers (generate/youtubeSet.js's
 * per-template sceneNoun1-3 slots, which only ever wanted the ko strings).
 *
 * Takes the top `limit` scored entries and, ONLY when `limit` is large
 * enough for the rule to be meaningful (>= weights.minRareInTop /
 * diversityCheckCount respectively — a 3-slot list has no room for a
 * "6 rare words" guarantee), applies the rare-word backstop and category
 * diversity swap described in data/sceneNounWeights.json.
 */
export function rankSceneEntries(termInfo, weights, limit) {
  const isRare = (e) => e.songCount <= weights.rareMaxSongCount;
  const sorted = scoreSceneTerms(termInfo, weights);
  let top = sorted.slice(0, limit);

  if (weights.minRareInTop <= limit) {
    let rareCount = top.filter(isRare).length;
    if (rareCount < weights.minRareInTop) {
      const topKoSet = new Set(top.map((e) => e.ko));
      const extraRare = sorted.filter((e) => isRare(e) && !topKoSet.has(e.ko));
      for (let i = 0; i < extraRare.length && rareCount < weights.minRareInTop; i += 1) {
        let worstIdx = -1;
        for (let j = top.length - 1; j >= 0; j -= 1) {
          if (!isRare(top[j])) { worstIdx = j; break; }
        }
        if (worstIdx === -1) break; // every slot is already rare
        top[worstIdx] = extraRare[i];
        rareCount += 1;
      }
      top.sort((a, b) => b.score - a.score || a.order - b.order);
    }
  }

  if (weights.diversityCheckCount <= limit) {
    // Category diversity: per spec, only the literal "top N are ALL the
    // same category" case forces a swap-in — a mixed-but-object-heavy top
    // isn't touched. No re-sort-by-score after swapping: the whole point is
    // to plant a lower-scored place/time word inside the head window, and a
    // final score sort would immediately sink it back out again.
    let head = top.slice(0, weights.diversityCheckCount);
    const headCategories = new Set(head.map((e) => e.category));
    if (headCategories.size === 1) {
      for (const wantCategory of weights.diversityCategories) {
        if (headCategories.has(wantCategory)) continue;
        const headKoSet = new Set(head.map((e) => e.ko));
        // Prefer a same-category entry already ranked just outside the head
        // (promote its position); otherwise pull the best-scored one from
        // the full ranking that isn't already in the head.
        const candidate =
          top.find((e) => e.category === wantCategory && !headKoSet.has(e.ko)) ||
          sorted.find((e) => e.category === wantCategory && !headKoSet.has(e.ko));
        if (!candidate) continue;
        let swapIdx = head.findIndex((e) => !isRare(e));
        if (swapIdx === -1) swapIdx = weights.diversityCheckCount - 1;
        const candidateIdx = top.indexOf(candidate);
        if (candidateIdx !== -1) {
          [top[swapIdx], top[candidateIdx]] = [top[candidateIdx], top[swapIdx]];
        } else {
          top[swapIdx] = candidate; // pulled from below the `limit` cutoff — the displaced entry simply drops out
        }
        head = top.slice(0, weights.diversityCheckCount);
        headCategories.add(wantCategory);
      }
    }
  }

  return top;
}

/** Thin wrapper over rankSceneEntries() for callers that only want the ko strings, in rank order. */
export function rankSceneTerms(termInfo, weights, limit) {
  return rankSceneEntries(termInfo, weights, limit).map((e) => e.ko);
}

function rankSceneNouns(termInfo, weights) {
  return rankSceneEntries(termInfo, weights, weights.topCount);
}

/**
 * TASK-S9 — a "scene noun" sets a scene: a thing, a place, a moment, a meal,
 * someone present. Verbs (action) and modifiers (description/quantity) score
 * just as high under pure rarity weighting (many are rare too), and body
 * parts ("어깨") / abstract concepts ("용기", "순간") read as broken filling
 * a noun-shaped template slot, not vivid. Which categories those are is a
 * dictionary-editing decision, not a code one — `weights.excludeCategories`
 * (data/sceneNounWeights.json) is the single source of truth, read by both
 * this function (set.sceneNouns, S0) and generate/youtubeSet.js's
 * deriveSceneNouns (the {sceneNoun1-3} template slots, S1) so removing
 * "body" from that list makes "어깨" eligible in both places at once, not
 * just one.
 */
export function isSceneNounCategory(category, weights) {
  return Boolean(category) && !weights.excludeCategories.includes(category);
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
  const sceneNounWeights = loadSceneNounWeights(); // TASK-S9: excludeCategories drives trackSceneTerms below, not a hardcoded Set
  const sceneTermInfo = new Map(); // TASK-S8: ko -> {songs: Set<trackNo>, category, order} — feeds rankSceneNouns()
  // TASK-S9: a SEPARATE pool of category:"description" matches, used only as
  // a fallback source if excludeCategories ever leaves set.sceneNouns short
  // of topCount (spec §2 요구사항 5) — description words are still excluded
  // from the primary ranking, this is a deliberate last-resort top-up.
  const descriptionTermInfo = new Map();

  const scanSources = [
    { name: 'timewords', lexicon: lex.timewords },
    { name: 'nouns', lexicon: lex.nouns },
  ];

  function trackSceneTerms(matchedTerms, trackNo) {
    for (const m of matchedTerms) {
      // TASK-S9: `m.term` is the actual surface text matched in the source
      // (e.g. "coffee", or "windows" for a plural resolved via
      // lexicon.js's morphological fallback) — kept as sceneNounDetails.en
      // so a reviewer can trace exactly which input word produced a given
      // Korean sceneNoun, not just guess from the dictionary key.
      if (isSceneNounCategory(m.category, sceneNounWeights)) {
        if (!sceneTermInfo.has(m.ko)) {
          sceneTermInfo.set(m.ko, { songs: new Set(), category: m.category ?? null, order: sceneTermInfo.size, en: m.term });
        }
        sceneTermInfo.get(m.ko).songs.add(trackNo);
      } else if (m.category === 'description') {
        if (!descriptionTermInfo.has(m.ko)) {
          descriptionTermInfo.set(m.ko, { songs: new Set(), category: m.category, order: descriptionTermInfo.size, en: m.term });
        }
        descriptionTermInfo.get(m.ko).songs.add(trackNo);
      }
    }
  }

  const normalizedSongs = data.songs.map((song) => {
    const { matchedTerms, unknownTerms } = scanTextMulti(song.listenerSituation, scanSources, stopwords);
    allMatchedTerms.push(...matchedTerms);
    allUnknownTerms.push(...unknownTerms);
    trackSceneTerms(matchedTerms, song.trackNo);
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
      trackSceneTerms(lyricThemeMatchedTerms, song.trackNo);
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
  let sceneNounEntries = rankSceneNouns(sceneTermInfo, sceneNounWeights);
  // TASK-S9 요구사항 5: excludeCategories 재분류로 후보가 줄어 topCount를
  // 못 채우면, description에서 부족분만큼 보충하고 warnings에 남긴다 —
  // 조용히 짧은 목록을 내보내지 않는다.
  if (sceneNounEntries.length < sceneNounWeights.topCount) {
    const shortfall = sceneNounWeights.topCount - sceneNounEntries.length;
    const alreadyUsed = new Set(sceneNounEntries.map((e) => e.ko));
    const fallback = scoreSceneTerms(descriptionTermInfo, sceneNounWeights)
      .filter((e) => !alreadyUsed.has(e.ko))
      .slice(0, shortfall);
    if (fallback.length > 0) {
      sceneNounEntries = [...sceneNounEntries, ...fallback];
      warnings.push(`sceneNouns 후보가 부족해 description 카테고리에서 ${fallback.length}개를 보충했습니다.`);
    }
  }
  // TASK-S9 — sceneNouns(문자열 배열, 기존 호환)와 sceneNounDetails(왜 이
  // 단어가 뽑혔는지 검증용: en/category/songCount/score)를 같은 entries
  // 배열에서 함께 만든다 — 둘을 따로 계산하면 순서가 어긋날 수 있다.
  const sceneNouns = sceneNounEntries.map((e) => e.ko);
  const sceneNounDetails = sceneNounEntries.map((e) => ({
    en: e.en,
    ko: e.ko,
    category: e.category,
    songCount: e.songCount,
    score: e.score,
  }));

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
      sceneNounDetails, // TASK-S9: same order as sceneNouns — {en, ko, category, songCount, score} per word
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
