import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args._[0] || 'evachien_threads.json');
const outputPath = resolve(args.out || args.output || 'data/latest.json');
const aliasesPath = resolve(args.aliases || 'data/stock_aliases.json');
const universePath = resolve(args.universe || 'data/stock_universe.json');
const fundamentalsPath = resolve(args.fundamentals || 'data/fundamentals.json');

const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
const aliases = existsSync(aliasesPath) ? JSON.parse(readFileSync(aliasesPath, 'utf8')) : [];
const universe = await loadUniverse({ aliases, universePath, refresh: Boolean(args.refreshUniverse) });
const fundamentals = await loadFundamentals({
  fundamentalsPath,
  refresh: Boolean(args.refreshFundamentals || args.refreshUniverse),
});
const analysis = analyze(raw, universe, fundamentals);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
console.log(`Stocks: ${analysis.summary.uniqueStocks}, posts: ${analysis.summary.totalPosts}`);

async function loadFundamentals({ fundamentalsPath: targetPath, refresh }) {
  if (!refresh && existsSync(targetPath)) {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  }

  try {
    const fundamentals = await fetchOfficialFundamentals();
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(fundamentals, null, 2)}\n`, 'utf8');
    return fundamentals;
  } catch (error) {
    console.warn(`Official fundamentals refresh failed: ${error.message}`);
    if (existsSync(targetPath)) return JSON.parse(readFileSync(targetPath, 'utf8'));
    return {};
  }
}

async function fetchOfficialFundamentals() {
  const [
    twsePrices,
    twseValuations,
    twseEps,
    tpexPrices,
    tpexValuations,
    tpexEps,
  ] = await Promise.all([
    fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL'),
    fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap14_L'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O'),
  ]);

  const byCode = {};

  for (const row of twsePrices) {
    const code = clean(row.Code);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row.Name),
      market: 'TWSE',
      price: numberOrNull(row.ClosingPrice),
      change: numberOrNull(row.Change),
      priceDate: clean(row.Date),
    });
  }
  for (const row of twseValuations) {
    const code = clean(row.Code);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row.Name),
      market: 'TWSE',
      peRatio: numberOrNull(row.PEratio),
      dividendYield: numberOrNull(row.DividendYield),
      pbRatio: numberOrNull(row.PBratio),
      valuationDate: clean(row.Date),
    });
  }
  for (const row of twseEps) {
    const code = clean(row['公司代號']);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row['公司名稱']),
      market: 'TWSE',
      industry: clean(row['產業別']),
      fiscalYear: clean(row['年度']),
      fiscalQuarter: clean(row['季別']),
      quarterlyEps: numberOrNull(row['基本每股盈餘(元)']),
      revenue: numberOrNull(row['營業收入']),
      operatingProfit: numberOrNull(row['營業利益']),
      netIncome: numberOrNull(row['稅後淨利']),
      financialDate: clean(row['出表日期']),
    });
  }

  for (const row of tpexPrices) {
    const code = clean(row.SecuritiesCompanyCode);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row.CompanyName),
      market: 'TPEx',
      price: numberOrNull(row.Close),
      change: numberOrNull(row.Change),
      priceDate: clean(row.Date),
    });
  }
  for (const row of tpexValuations) {
    const code = clean(row.SecuritiesCompanyCode);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row.CompanyName),
      market: 'TPEx',
      peRatio: numberOrNull(row.PriceEarningRatio),
      dividendYield: numberOrNull(row.YieldRatio),
      pbRatio: numberOrNull(row.PriceBookRatio),
      dividendPerShare: numberOrNull(row.DividendPerShare),
      valuationDate: clean(row.Date),
    });
  }
  for (const row of tpexEps) {
    const code = clean(row.SecuritiesCompanyCode);
    if (!code) continue;
    mergeFundamental(byCode, code, {
      code,
      name: clean(row.CompanyName),
      market: 'TPEx',
      industry: clean(row['產業別']),
      fiscalYear: clean(row.Year),
      fiscalQuarter: clean(row['季別']),
      quarterlyEps: numberOrNull(row['基本每股盈餘']),
      revenue: numberOrNull(row['營業收入']),
      operatingProfit: numberOrNull(row['營業利益']),
      netIncome: numberOrNull(row['稅後淨利']),
      financialDate: clean(row.Date),
    });
  }

  for (const item of Object.values(byCode)) {
    item.estimatedTtmEps = item.price && item.peRatio ? round(item.price / item.peRatio, 2) : null;
    item.annualizedQuarterlyEps = item.quarterlyEps !== null && item.quarterlyEps !== undefined ? round(item.quarterlyEps * 4, 2) : null;
    item.analysis = fundamentalAnalysis(item);
  }

  return byCode;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return await response.json();
}

function mergeFundamental(byCode, code, patch) {
  byCode[code] = { ...(byCode[code] || {}), ...patch };
}

async function loadUniverse({ aliases, universePath: targetPath, refresh }) {
  if (!refresh && existsSync(targetPath)) {
    return mergeUniverse(JSON.parse(readFileSync(targetPath, 'utf8')), aliases);
  }

  try {
    const official = await fetchOfficialUniverse();
    const merged = mergeUniverse(official, aliases);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return merged;
  } catch (error) {
    console.warn(`Official stock universe refresh failed: ${error.message}`);
    if (existsSync(targetPath)) {
      return mergeUniverse(JSON.parse(readFileSync(targetPath, 'utf8')), aliases);
    }
    return normalizeUniverse(aliases);
  }
}

async function fetchOfficialUniverse() {
  const sources = [
    {
      market: 'TWSE',
      url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      code: 'Code',
      name: 'Name',
    },
    {
      market: 'TPEx',
      url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      code: 'SecuritiesCompanyCode',
      name: 'CompanyName',
    },
  ];

  const records = [];
  for (const source of sources) {
    const response = await fetch(source.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`${source.url}: ${response.status} ${response.statusText}`);
    const rows = await response.json();
    for (const row of rows) {
      const code = clean(row[source.code]);
      const name = clean(row[source.name]);
      if (!code || !name) continue;
      records.push({ code, name, market: source.market, aliases: buildAliases(name) });
    }
  }
  return normalizeUniverse(records);
}

function mergeUniverse(primary, extra) {
  const byCodeName = new Map();
  for (const item of [...normalizeUniverse(primary), ...normalizeUniverse(extra)]) {
    const key = item.code ? `${item.market}:${item.code}` : `${item.market}:${item.name}`;
    const existing = byCodeName.get(key);
    if (!existing) {
      byCodeName.set(key, item);
      continue;
    }
    existing.aliases = [...new Set([...existing.aliases, ...item.aliases])];
  }
  return [...byCodeName.values()].sort((a, b) => b.aliases.join('').length - a.aliases.join('').length);
}

function normalizeUniverse(records) {
  return records
    .map((record) => {
      const name = clean(record.name);
      const code = clean(record.code);
      const aliases = [...new Set([name, ...(record.aliases || []), ...buildAliases(name)].map(clean).filter(Boolean))]
        .filter((alias) => alias.length >= 2);
      return {
        code,
        name,
        market: clean(record.market || 'TW'),
        aliases,
      };
    })
    .filter((record) => record.name && record.aliases.length);
}

function buildAliases(name) {
  const aliases = [name];
  for (const pattern of [/-KY$/i, /\*$/, /－KY$/i]) {
    const stripped = name.replace(pattern, '');
    if (stripped !== name) aliases.push(stripped);
  }
  return aliases;
}

function analyze(rawInput, universe, fundamentals = {}) {
  const posts = (rawInput.posts || []).map((post, index) => {
    const mentions = findMentions(post.text || '', universe);
    return {
      index,
      url: post.url || null,
      topic: post.topic || null,
      time: post.time || null,
      text: post.text || '',
      mentions: mentions.map(({ stock, aliases, contexts }) => ({
        code: stock.code || null,
        name: stock.name,
        market: stock.market,
        aliases,
        actions: classifyActions(contexts, aliases),
        contexts,
      })),
    };
  });

  const stocks = aggregateStocks(posts).map((stock) => ({
    ...stock,
    fundamentals: fundamentals[stock.code] || null,
  }));
  return {
    generatedAt: new Date().toISOString(),
    source: {
      target: rawInput.target,
      finalUrl: rawInput.finalUrl,
      title: rawInput.title,
      fetchedAt: rawInput.fetchedAt,
      postsFound: rawInput.postsFound,
    },
    summary: {
      totalPosts: posts.length,
      postsWithStocks: posts.filter((post) => post.mentions.length).length,
      uniqueStocks: stocks.length,
      topStocks: stocks.slice(0, 10).map((stock) => ({
        code: stock.code,
        name: stock.name,
        count: stock.count,
        actions: stock.actions,
      })),
      actionTotals: summarizeActions(stocks),
      fundamentalsCoverage: stocks.filter((stock) => stock.fundamentals).length,
    },
    dataSources: {
      price: [
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
      ],
      valuation: [
        'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
      ],
      eps: [
        'https://openapi.twse.com.tw/v1/opendata/t187ap14_L',
        'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O',
      ],
    },
    stocks,
    posts,
  };
}

function findMentions(text, universe) {
  const normalizedText = clean(text);
  const matches = [];

  for (const stock of universe) {
    for (const alias of stock.aliases) {
      let start = -1;
      while ((start = normalizedText.indexOf(alias, start + 1)) !== -1) {
        const end = start + alias.length;
        if (isExcludedContext(normalizedText, start, end)) continue;
        matches.push({ stock, alias, start, end });
      }
    }
  }

  const selected = [];
  for (const match of matches.sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (selected.some((item) => rangesOverlap(item, match))) continue;
    selected.push(match);
  }

  const byStock = new Map();
  for (const match of selected.sort((a, b) => a.start - b.start)) {
    const key = match.stock.code || match.stock.name;
    if (!byStock.has(key)) {
      byStock.set(key, {
        stock: match.stock,
        aliases: new Set(),
        contexts: [],
      });
    }
    const item = byStock.get(key);
    item.aliases.add(match.alias);
    item.contexts.push(contextWindow(normalizedText, match.start, match.end));
  }

  return [...byStock.values()].map((item) => ({
    stock: item.stock,
    aliases: [...item.aliases],
    contexts: [...new Set(item.contexts)].slice(0, 5),
  })).sort((a, b) => b.aliases[0].length - a.aliases[0].length);
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function contextWindow(text, start, end) {
  const leftBreaks = ['。', '！', '？', '!', '?', '\n'];
  const rightBreaks = ['。', '！', '？', '!', '?', '\n'];
  let left = Math.max(0, start - 80);
  let right = Math.min(text.length, end + 80);
  for (let index = start; index >= Math.max(0, start - 120); index -= 1) {
    if (leftBreaks.includes(text[index])) {
      left = index + 1;
      break;
    }
  }
  for (let index = end; index < Math.min(text.length, end + 120); index += 1) {
    if (rightBreaks.includes(text[index])) {
      right = index + 1;
      break;
    }
  }
  return clean(text.slice(left, right));
}

function isExcludedContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 8);
  if (/[-－—]\s*$/.test(before) && /^\s*\d+\s*元/.test(after)) return true;
  return false;
}

function splitSentences(text) {
  return text
    .split(/(?<=[。！？!?])|\n|(?=「)|(?<=」)|(?<=；)|(?<=，)/u)
    .map((part) => clean(part))
    .filter((part) => part.length >= 2);
}

function classifyActions(contexts, aliases = []) {
  const joined = contexts.join(' ');
  const actions = [];
  if (contexts.some((context) => keywordNearAlias(context, aliases, /(買|進場|加碼|低接|建倉)/g))) actions.push('buy');
  if (contexts.some((context) => keywordNearAlias(context, aliases, /(賣|出場|出掉|賣飛|出「|出 )/g))) actions.push('sell');
  if (contexts.some((context) => actionWordAppliesToAlias(context, aliases, '漲停'))) actions.push('limitUp');
  if (contexts.some((context) => actionWordAppliesToAlias(context, aliases, '跌停'))) actions.push('limitDown');
  if (/(看好|觀察|佈局|等待|驗證)/.test(joined)) actions.push('watch');
  if (/(可惜|哭|唉|捨不得|賣飛)/.test(joined)) actions.push('regret');
  return actions;
}

function keywordNearAlias(context, aliases, regex, distance = 60) {
  for (const alias of aliases) {
    const aliasIndexes = allIndexes(context, alias);
    const matches = [...context.matchAll(regex)];
    for (const match of matches) {
      const keyword = match[0];
      const keywordStart = match.index;
      const keywordEnd = keywordStart + keyword.length;
      if (keyword === '買' && /股|股票/.test(context.slice(keywordEnd, keywordEnd + 2))) continue;
      if (aliasIndexes.some((aliasStart) => Math.abs(aliasStart - keywordEnd) <= distance || Math.abs(keywordStart - (aliasStart + alias.length)) <= distance)) {
        return true;
      }
    }
  }
  return false;
}

function actionWordAppliesToAlias(context, aliases, word) {
  let cursor = -1;
  while ((cursor = context.indexOf(word, cursor + 1)) !== -1) {
    const previousAction = Math.max(context.lastIndexOf('漲停', cursor - 1), context.lastIndexOf('跌停', cursor - 1));
    const previousPunctuation = Math.max(
      context.lastIndexOf('。', cursor),
      context.lastIndexOf('！', cursor),
      context.lastIndexOf('？', cursor),
      context.lastIndexOf('；', cursor)
    );
    const start = Math.max(previousAction >= 0 ? previousAction + 2 : 0, previousPunctuation + 1, cursor - 100);
    const segment = context.slice(start, cursor);
    if (aliases.some((alias) => segment.includes(alias))) return true;
  }
  return false;
}

function allIndexes(text, needle) {
  const indexes = [];
  let cursor = -1;
  while ((cursor = text.indexOf(needle, cursor + 1)) !== -1) indexes.push(cursor);
  return indexes;
}

function aggregateStocks(posts) {
  const byStock = new Map();
  for (const post of posts) {
    for (const mention of post.mentions) {
      const key = mention.code || mention.name;
      if (!byStock.has(key)) {
        byStock.set(key, {
          code: mention.code,
          name: mention.name,
          market: mention.market,
          count: 0,
          actions: {},
          posts: [],
        });
      }
      const item = byStock.get(key);
      item.count += 1;
      for (const action of mention.actions) {
        item.actions[action] = (item.actions[action] || 0) + 1;
      }
      item.posts.push({
        url: post.url,
        time: post.time,
        topic: post.topic,
        aliases: mention.aliases,
        actions: mention.actions,
        snippet: snippetFromContexts(mention.contexts),
      });
    }
  }
  return [...byStock.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
}

function summarizeActions(stocks) {
  const totals = {};
  for (const stock of stocks) {
    for (const [action, count] of Object.entries(stock.actions)) {
      totals[action] = (totals[action] || 0) + count;
    }
  }
  return totals;
}

function snippetFromContexts(contexts) {
  return clean(contexts.join(' ')).slice(0, 220);
}

function fundamentalAnalysis(item) {
  const notes = [];
  const flags = [];

  if (item.peRatio === null || item.peRatio === undefined) {
    notes.push('本益比資料不足或不適用');
  } else if (item.peRatio <= 0) {
    notes.push('本益比為負或零，通常代表近四季獲利不佳');
    flags.push('earnings-risk');
  } else if (item.peRatio < 12) {
    notes.push('本益比偏低，需確認是否為景氣循環或一次性因素');
    flags.push('low-pe');
  } else if (item.peRatio <= 25) {
    notes.push('本益比位於常見合理區間，仍需和同產業比較');
    flags.push('normal-pe');
  } else {
    notes.push('本益比偏高，市場可能反映較高成長期待');
    flags.push('high-pe');
  }

  if (item.pbRatio !== null && item.pbRatio !== undefined) {
    if (item.pbRatio < 1) {
      notes.push('股價淨值比低於 1，需檢查資產品質與獲利能力');
      flags.push('low-pb');
    } else if (item.pbRatio > 5) {
      notes.push('股價淨值比較高，通常需要較強 ROE 或成長支撐');
      flags.push('high-pb');
    }
  }

  if (item.quarterlyEps !== null && item.quarterlyEps !== undefined) {
    if (item.quarterlyEps > 0) {
      notes.push(`最新季度 EPS 為 ${item.quarterlyEps}`);
      flags.push('positive-eps');
    } else {
      notes.push(`最新季度 EPS 為 ${item.quarterlyEps}，需留意獲利壓力`);
      flags.push('negative-eps');
    }
  }

  if (item.dividendYield !== null && item.dividendYield !== undefined) {
    if (item.dividendYield >= 4) {
      notes.push('殖利率偏高，適合再檢查配息穩定度');
      flags.push('income');
    } else if (item.dividendYield > 0) {
      notes.push('有現金殖利率，但不是高息型訊號');
    }
  }

  return {
    flags,
    notes,
    score: fundamentalScore(item),
  };
}

function fundamentalScore(item) {
  let score = 50;
  if (item.peRatio && item.peRatio > 0) {
    if (item.peRatio < 12) score += 12;
    else if (item.peRatio <= 25) score += 8;
    else if (item.peRatio <= 40) score -= 4;
    else score -= 10;
  }
  if (item.pbRatio && item.pbRatio > 0) {
    if (item.pbRatio < 1) score += 4;
    else if (item.pbRatio > 5) score -= 8;
  }
  if (item.quarterlyEps !== null && item.quarterlyEps !== undefined) {
    score += item.quarterlyEps > 0 ? 8 : -12;
  }
  if (item.dividendYield && item.dividendYield >= 4) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numberOrNull(value) {
  const normalized = clean(value).replace(/,/g, '');
  if (!normalized || normalized === '-' || normalized === 'N/A') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }
    const eq = value.indexOf('=');
    if (eq !== -1) {
      parsed[toCamel(value.slice(2, eq))] = value.slice(eq + 1);
      continue;
    }
    const key = toCamel(value.slice(2));
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
