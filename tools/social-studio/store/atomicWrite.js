/**
 * TASK-S6 — shared atomic-write primitive: write to a temp file in the same
 * directory, fsync it, close it, then rename over the real path. The rename
 * step alone (what S2/S3's own atomic writers did) is usually enough, but
 * spec section 5 asks specifically for the fsync step too — without it,
 * the OS can still have the temp file's bytes sitting in a page-cache
 * buffer, not actually on disk, when a rename happens; a crash in that
 * narrow window can leave the temp file (and therefore the renamed-over
 * target) truncated on some filesystems. fsync forces the flush before the
 * rename is allowed to happen at all.
 *
 * Built to be reusable outside store/history.js too (spec: "S2의 상태
 * 저장에서도 재사용할 수 있게 공용으로 만든다") — nothing about this
 * module is history-specific.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Writes `data` (any JSON-serializable value) to `filePath` atomically. */
export function atomicWriteJson(filePath, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  atomicWriteText(filePath, text);
}

/** Same guarantee as atomicWriteJson, for callers that already have a string to write. */
export function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}
