import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';

const handle = process.env.THREADS_HANDLE || '@evachien.chien';
const postPages = process.env.POST_PAGES || '4';
const scrollRounds = process.env.SCROLL_ROUNDS || '4';
const settleMs = process.env.SETTLE_MS || '3500';
const latestPath = 'data/latest.json';
const candidatePath = 'data/latest.candidate.json';

mkdirSync('data', { recursive: true });
if (existsSync(candidatePath)) unlinkSync(candidatePath);

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
  candidatePath,
  '--refresh-universe',
  '--refresh-fundamentals',
]);

const existing = readJsonIfExists(latestPath);
const candidate = readJsonIfExists(candidatePath);
if (!candidate) {
  throw new Error(`Analyzer did not write ${candidatePath}`);
}

if (shouldKeepExisting(existing, candidate)) {
  const oldSummary = existing.summary || {};
  const newSummary = candidate.summary || {};
  console.warn(
    `Keeping existing ${latestPath}: candidate looks partial `
    + `(stocks ${newSummary.uniqueStocks} vs ${oldSummary.uniqueStocks}, `
    + `stock-posts ${newSummary.postsWithStocks} vs ${oldSummary.postsWithStocks}).`,
  );
} else {
  copyFileSync(candidatePath, latestPath);
  console.log(`Promoted ${candidatePath} to ${latestPath}`);
}

unlinkSync(candidatePath);

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

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function shouldKeepExisting(existing, candidate) {
  if (!existing?.summary) return false;
  const oldSummary = existing.summary;
  const newSummary = candidate.summary || {};
  const oldStockPosts = Number(oldSummary.postsWithStocks || 0);
  const oldStocks = Number(oldSummary.uniqueStocks || 0);
  const newStockPosts = Number(newSummary.postsWithStocks || 0);
  const newStocks = Number(newSummary.uniqueStocks || 0);

  if (!oldStockPosts || !oldStocks) return false;
  const stockPostDrop = newStockPosts < Math.max(1, oldStockPosts * 0.7);
  const stockDrop = newStocks < Math.max(1, oldStocks * 0.7);
  return stockPostDrop && stockDrop;
}
