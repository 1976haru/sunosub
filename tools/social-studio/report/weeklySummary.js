/**
 * TASK-S6 — weekly publish summary. Reads store/data/history.json only
 * through store/history.js's query API (spec completion condition #11: no
 * other file reads history.json directly) plus each channel's template
 * pool sizes under templates/, and reports:
 *  - how many items were actually PUBLISHED per channel×platform in the
 *    last 7 days
 *  - how many templates remain unused within the last `weeks` (default 4,
 *    matching data/lintThresholds.json's R2_templateReuseWeeks — the same
 *    window that actually governs exhaustion in generate/slotFiller.js),
 *    flagging any channel×platform combo under LOW_TEMPLATE_THRESHOLD so a
 *    pool doesn't quietly run out mid-rotation.
 * Writes to console AND out/reports/{ISO week}.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as history from '../store/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEMPLATES_ROOT = path.join(ROOT, 'templates');
const REPORTS_DIR = path.join(ROOT, 'out', 'reports');

const DEFAULT_WEEKS = 4;
const LOW_TEMPLATE_THRESHOLD = 5;
const MAX_DIR_ENTRIES = 500; // explicit bound
const MAX_TEMPLATE_FILES_SCANNED = 100;

/** ISO 8601 week label, e.g. "2026-W32" — used as the report's filename token. */
function isoWeekLabel(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Same rough per-platform aggregate lint/socialLint.js's own (private)
 * loadTemplatePoolSizes() computes — duplicated locally rather than
 * exported/imported across files, matching this repo's own "두 벌은
 * 의도적으로" convention (CLAUDE.md 3.3) for small pieces two files can't
 * cleanly share.
 */
function templatePoolSizes(channelId) {
  const dir = path.join(TEMPLATES_ROOT, channelId);
  const sizes = {};
  if (!fs.existsSync(dir)) return sizes;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, MAX_TEMPLATE_FILES_SCANNED);
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
    if (!Array.isArray(data.templates)) continue;
    const platform = file.replace(/\.json$/, '').split('-')[0];
    sizes[platform] = (sizes[platform] || 0) + data.templates.length;
  }
  return sizes;
}

function listChannelIds() {
  if (!fs.existsSync(TEMPLATES_ROOT)) return [];
  return fs
    .readdirSync(TEMPLATES_ROOT, { withFileTypes: true })
    .slice(0, MAX_DIR_ENTRIES)
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => e.name);
}

/**
 * @param {object} [options]
 * @param {number} [options.weeks] - window for "남은 템플릿" (default DEFAULT_WEEKS)
 * @param {Date} [options.now]
 */
export function buildWeeklySummary({ weeks = DEFAULT_WEEKS, now = new Date() } = {}) {
  const weekLabel = isoWeekLabel(now);
  const channelIds = listChannelIds();
  const channels = [];
  const lowStock = [];

  for (const channelId of channelIds) {
    const poolSizes = templatePoolSizes(channelId);
    const rows = [];
    for (const platform of Object.keys(poolSizes)) {
      let publishedThisWeek = [];
      let usedTemplateIds = [];
      try {
        publishedThisWeek = history.getPublished(channelId, platform, 1, now);
        usedTemplateIds = history.getUsedTemplateIds(channelId, platform, weeks, now);
      } catch {
        // history 조회 실패 -> 아직 발행 기록이 없는 것처럼 진행 (에러로 보고하지 않음)
      }
      const poolSize = poolSizes[platform];
      const remaining = Math.max(poolSize - usedTemplateIds.length, 0);
      const row = { platform, poolSize, used: usedTemplateIds.length, remaining, publishedThisWeek: publishedThisWeek.length };
      rows.push(row);
      if (remaining < LOW_TEMPLATE_THRESHOLD) lowStock.push({ channelId, platform, remaining });
    }
    channels.push({ channelId, rows });
  }

  const text = renderText({ weekLabel, generatedAt: now.toISOString(), channels, lowStock, weeks });
  return { generatedAt: now.toISOString(), weekLabel, channels, lowStock, text };
}

function renderText({ weekLabel, generatedAt, channels, lowStock, weeks }) {
  const lines = [];
  lines.push(`# 주간 발행 요약 (${weekLabel})`);
  lines.push('');
  lines.push(`생성 시각: ${generatedAt}`);
  lines.push(`템플릿 소진 계산 기준: 최근 ${weeks}주, published 상태만 집계 (generated는 소진으로 치지 않음)`);
  lines.push('');

  if (channels.length === 0) {
    lines.push('templates/ 아래에 채널 폴더가 없습니다.');
  }

  for (const { channelId, rows } of channels) {
    lines.push(`## ${channelId}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('템플릿 파일이 없습니다.');
      lines.push('');
      continue;
    }
    lines.push('| 플랫폼 | 이번 주 발행 | 최근 사용 템플릿 | 남은 템플릿 |');
    lines.push('|---|---|---|---|');
    for (const row of rows) {
      const flag = row.remaining < LOW_TEMPLATE_THRESHOLD ? ' (부족)' : '';
      lines.push(`| ${row.platform} | ${row.publishedThisWeek}건 | ${row.used}/${row.poolSize} | ${row.remaining}개${flag} |`);
    }
    lines.push('');
  }

  lines.push('## 경고');
  if (lowStock.length === 0) {
    lines.push(`- 남은 템플릿이 ${LOW_TEMPLATE_THRESHOLD}개 미만인 채널×플랫폼 조합이 없습니다.`);
  } else {
    for (const item of lowStock) {
      lines.push(`- ${item.channelId} × ${item.platform}: 남은 템플릿 ${item.remaining}개 — 추가 템플릿이 필요합니다.`);
    }
  }

  return lines.join('\n') + '\n';
}

/** buildWeeklySummary() + print to console + write out/reports/{week}.md. */
export function runWeeklySummary(options = {}) {
  const summary = buildWeeklySummary(options);
  console.log(summary.text);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, `${summary.weekLabel}.md`);
  fs.writeFileSync(outPath, summary.text, 'utf8');
  return { ...summary, outPath };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  runWeeklySummary();
}
