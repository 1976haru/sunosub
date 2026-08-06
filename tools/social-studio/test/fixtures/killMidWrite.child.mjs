// TASK-S6 test helper — NOT a fixture data file. Deliberately replicates
// atomicWrite.js's own open->write->fsync->close steps by hand (rather than
// importing atomicWriteText) so a sleep can be inserted between "the temp
// file is durably on disk" and "rename() swaps it in" — the exact window
// the parent test (condition 5) needs to SIGKILL this process inside of.
import fs from 'node:fs';
import path from 'node:path';

const [, , targetPath] = process.argv;
const dir = path.dirname(targetPath);
const tmpPath = path.join(dir, '.killtest.tmp');
const bigText = JSON.stringify({ version: 1, entries: new Array(20000).fill({ note: 'x'.repeat(40) }) });

const fd = fs.openSync(tmpPath, 'w');
fs.writeSync(fd, bigText, null, 'utf8');
fs.fsyncSync(fd);
fs.closeSync(fd);

// Synchronous block (not setTimeout — this must not yield back to the event
// loop) so the process is reliably still alive, sitting right before
// renameSync, when the parent's SIGKILL arrives.
const sab = new SharedArrayBuffer(4);
const ia = new Int32Array(sab);
Atomics.wait(ia, 0, 0, 5000);

fs.renameSync(tmpPath, targetPath);
