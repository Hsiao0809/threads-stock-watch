import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const handle = process.env.THREADS_HANDLE || '@evachien.chien';
const postPages = process.env.POST_PAGES || '4';
const scrollRounds = process.env.SCROLL_ROUNDS || '4';
const settleMs = process.env.SETTLE_MS || '3500';
const latestPath = 'data/latest.json';
const candidatePath = 'data/latest.candidate.json';
const maxMergedPosts = Number(process.env.MAX_MERGED_POSTS || 40);

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

let finalSnapshot = candidate;
if (existing) {
  finalSnapshot = mergeSnapshots(existing, candidate);
}

if (shouldKeepExisting(existing, candidate)) {
  const oldSummary = existing.summary || {};
  const newSummary = candidate.summary || {};
  console.warn(
    `Merging partial candidate into existing ${latestPath}: `
    + `(stocks ${newSummary.uniqueStocks} vs ${oldSummary.uniqueStocks}, `
    + `stock-posts ${newSummary.postsWithStocks} vs ${oldSummary.postsWithStocks}).`,
  );
}
writeFileSync(latestPath, `${JSON.stringify(finalSnapshot, null, 2)}\n`, 'utf8');
console.log(
  `Wrote ${latestPath}: stocks ${finalSnapshot.summary?.uniqueStocks || 0}, `
  + `posts ${finalSnapshot.summary?.totalPosts || 0}.`,
);

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

function mergeSnapshots(existing, candidate) {
  const posts = mergePosts(candidate.posts || [], existing.posts || []).slice(0, maxMergedPosts);
  const stockData = aggregateStocksFromPosts(posts, existing.stocks || [], candidate.stocks || []);
  const stocks = stockData.stocks;
  return {
    ...existing,
    ...candidate,
    generatedAt: candidate.generatedAt || new Date().toISOString(),
    source: {
      ...(existing.source || {}),
      ...(candidate.source || {}),
      cachedPosts: posts.length,
    },
    summary: summarize(stocks, posts),
    dataSources: candidate.dataSources || existing.dataSources,
    stocks,
    posts,
  };
}

function mergePosts(primaryPosts, secondaryPosts) {
  const seen = new Set();
  const posts = [];
  for (const post of [...primaryPosts, ...secondaryPosts]) {
    const key = postKey(post);
    if (seen.has(key)) continue;
    seen.add(key);
    posts.push(post);
  }
  return posts.map((post, index) => ({ ...post, index }));
}

function postKey(post) {
  return post.url || `${post.time || ''}:${cleanText(post.text || '').slice(0, 180)}`;
}

function aggregateStocksFromPosts(posts, oldStocks, newStocks) {
  const fundamentals = new Map();
  for (const stock of [...oldStocks, ...newStocks]) {
    if (stock.code && stock.fundamentals) fundamentals.set(stock.code, stock.fundamentals);
  }

  const byStock = new Map();
  for (const post of posts) {
    for (const mention of post.mentions || []) {
      const key = mention.code || mention.name;
      if (!key) continue;
      if (!byStock.has(key)) {
        byStock.set(key, {
          code: mention.code || null,
          name: mention.name,
          market: mention.market,
          count: 0,
          actions: {},
          posts: [],
        });
      }
      const item = byStock.get(key);
      item.count += 1;
      for (const action of mention.actions || []) {
        item.actions[action] = (item.actions[action] || 0) + 1;
      }
      item.posts.push({
        url: post.url,
        time: post.time,
        index: post.index,
        topic: post.topic,
        aliases: mention.aliases || [],
        actions: mention.actions || [],
        snippet: snippetFromMention(post, mention),
      });
    }
  }

  const stocks = [...byStock.values()]
    .map((stock) => ({
      ...stock,
      fundamentals: stock.code ? fundamentals.get(stock.code) || null : null,
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-Hant'));
  return { stocks };
}

function summarize(stocks, posts) {
  return {
    totalPosts: posts.length,
    postsWithStocks: posts.filter((post) => (post.mentions || []).length).length,
    uniqueStocks: stocks.length,
    topStocks: stocks.slice(0, 10).map((stock) => ({
      code: stock.code,
      name: stock.name,
      count: stock.count,
      actions: stock.actions,
    })),
    actionTotals: summarizeActions(stocks),
    fundamentalsCoverage: stocks.filter((stock) => stock.fundamentals).length,
    qualityMetricsCoverage: stocks.filter((stock) => stock.fundamentals?.revenueYoY !== null && stock.fundamentals?.grossMargin !== null && stock.fundamentals?.roe !== null && stock.fundamentals?.debtRatio !== null).length,
    cashflowCoverage: stocks.filter((stock) => stock.fundamentals?.fcfToNetIncomeRatio !== null && stock.fundamentals?.fcfToNetIncomeRatio !== undefined).length,
  };
}

function summarizeActions(stocks) {
  const totals = {};
  for (const stock of stocks) {
    for (const [action, count] of Object.entries(stock.actions || {})) {
      totals[action] = (totals[action] || 0) + count;
    }
  }
  return totals;
}

function snippetFromMention(post, mention) {
  const contexts = (mention.contexts || []).join(' ');
  return cleanText(contexts || post.text || '').slice(0, 220);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
