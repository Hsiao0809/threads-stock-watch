import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const handle = process.env.THREADS_HANDLE || '@evachien.chien';
const postPages = process.env.POST_PAGES || '4';
const scrollRounds = process.env.SCROLL_ROUNDS || '4';
const settleMs = process.env.SETTLE_MS || '3500';

mkdirSync('data', { recursive: true });

await run(process.execPath, [
  'threads_reader.mjs',
  handle,
  '--post-pages',
  postPages,
  '--scroll',
  scrollRounds,
  '--settle-ms',
  settleMs,
  '--out',
  'data/raw.json',
]);

await run(process.execPath, [
  'analyze_threads.mjs',
  'data/raw.json',
  '--out',
  'data/latest.json',
  '--refresh-universe',
  '--refresh-fundamentals',
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
