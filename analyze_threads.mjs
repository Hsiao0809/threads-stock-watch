import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args._[0] || 'evachien_threads.json');
const outputPath = resolve(args.out || args.output || 'data/latest.json');
const aliasesPath = resolve(args.aliases || 'data/stock_aliases.json');
const universePath = resolve(args.universe || 'data/stock_universe.json');
const fundamentalsPath = resolve(args.fundamentals || 'data/fundamentals.json');
const FINANCIAL_CATEGORIES = ['basi', 'bd', 'ci', 'fh', 'ins', 'mim'];

const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
const aliases = existsSync(aliasesPath) ? JSON.parse(readFileSync(aliasesPath, 'utf8')) : [];
const universe = await loadUniverse({ aliases, universePath, refresh: Boolean(args.refreshUniverse) });
const preliminary = analyze(raw, universe, {});
const targetCodes = [...new Set(preliminary.stocks.map((stock) => stock.code).filter(Boolean))];
const fundamentals = await loadFundamentals({
  fundamentalsPath,
  refresh: Boolean(args.refreshFundamentals || args.refreshUniverse),
  targetCodes,
});
const analysis = analyze(raw, universe, fundamentals);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
console.log(`Stocks: ${analysis.summary.uniqueStocks}, posts: ${analysis.summary.totalPosts}`);

async function loadFundamentals({ fundamentalsPath: targetPath, refresh, targetCodes = [] }) {
  if (!refresh && existsSync(targetPath)) {
    return JSON.parse(readFileSync(targetPath, 'utf8'));
  }

  try {
    const fundamentals = await fetchOfficialFundamentals(targetCodes);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(fundamentals, null, 2)}\n`, 'utf8');
    return fundamentals;
  } catch (error) {
    console.warn(`Official fundamentals refresh failed: ${error.message}`);
    if (existsSync(targetPath)) return JSON.parse(readFileSync(targetPath, 'utf8'));
    return {};
  }
}

async function fetchOfficialFundamentals(targetCodes = []) {
  const [
    twsePrices,
    twseValuations,
    twseEps,
    twseRevenues,
    twseIncomeRows,
    twseBalanceRows,
    tpexPrices,
    tpexValuations,
    tpexEps,
    tpexRevenues,
    tpexIncomeRows,
    tpexBalanceRows,
  ] = await Promise.all([
    fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL'),
    fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap14_L'),
    fetchJson('https://openapi.twse.com.tw/v1/opendata/t187ap05_L'),
    fetchRows(FINANCIAL_CATEGORIES.map((category) => `https://openapi.twse.com.tw/v1/opendata/t187ap06_L_${category}`)),
    fetchRows(FINANCIAL_CATEGORIES.map((category) => `https://openapi.twse.com.tw/v1/opendata/t187ap07_L_${category}`)),
    fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O'),
    fetchJson('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'),
    fetchRows(FINANCIAL_CATEGORIES.map((category) => `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_${category}`)),
    fetchRows(FINANCIAL_CATEGORIES.map((category) => `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_${category}`)),
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
  for (const row of twseRevenues) {
    mergeRevenue(byCode, row, 'TWSE');
  }
  mergeIncomeStatements(byCode, twseIncomeRows, 'TWSE');
  mergeBalanceSheets(byCode, twseBalanceRows, 'TWSE');

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
  for (const row of tpexRevenues) {
    mergeRevenue(byCode, row, 'TPEx');
  }
  mergeIncomeStatements(byCode, tpexIncomeRows, 'TPEx');
  mergeBalanceSheets(byCode, tpexBalanceRows, 'TPEx');

  const cashflowByCode = await fetchCashflowMetrics(targetCodes);
  for (const [code, cashflow] of Object.entries(cashflowByCode)) {
    mergeFundamental(byCode, code, cashflow);
  }

  for (const item of Object.values(byCode)) {
    item.estimatedTtmEps = item.price && item.peRatio ? round(item.price / item.peRatio, 2) : null;
    item.annualizedQuarterlyEps = item.quarterlyEps !== null && item.quarterlyEps !== undefined ? round(item.quarterlyEps * 4, 2) : null;
    const equityBase = firstPresentNumber(item.equityParent, item.totalEquity);
    const netIncomeBase = firstPresentNumber(item.netIncomeParent, item.netIncome);
    const annualizationFactor = fiscalQuarterAnnualization(item.fiscalQuarter);
    item.roe = isFiniteNumber(netIncomeBase) && isFiniteNumber(equityBase) && equityBase !== 0
      ? round((netIncomeBase / equityBase) * annualizationFactor * 100, 2)
      : null;
    item.roeBasis = item.roe === null ? null : `年化，依第 ${item.fiscalQuarter || '?'} 季累計獲利估算`;
    item.debtRatio = isFiniteNumber(item.totalLiabilities) && isFiniteNumber(item.totalAssets) && item.totalAssets !== 0
      ? round((item.totalLiabilities / item.totalAssets) * 100, 2)
      : null;
    item.fcfToNetIncomeRatio = isFiniteNumber(item.freeCashFlowApprox) && isFiniteNumber(netIncomeBase) && netIncomeBase !== 0
      ? round((item.freeCashFlowApprox / netIncomeBase) * 100, 2)
      : null;
    item.analysis = fundamentalAnalysis(item);
  }

  return byCode;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return await response.json();
}

async function fetchRows(urls) {
  const rows = [];
  for (const url of urls) {
    try {
      rows.push(...await fetchJson(url));
    } catch (error) {
      console.warn(`Official row fetch failed: ${url}: ${error.message}`);
    }
  }
  return rows;
}

function mergeFundamental(byCode, code, patch) {
  byCode[code] = { ...(byCode[code] || {}), ...patch };
}

function mergeRevenue(byCode, row, market) {
  const code = companyCode(row);
  if (!code) return;
  const monthlyRevenueYoY = numberOrNull(row['營業收入-去年同月增減(%)']);
  mergeFundamental(byCode, code, {
    code,
    name: companyName(row),
    market,
    monthlyRevenue: numberOrNull(row['營業收入-當月營收']),
    revenueYoY: monthlyRevenueYoY,
    monthlyRevenueYoY,
    cumulativeRevenueYoY: numberOrNull(row['累計營業收入-前期比較增減(%)']),
    revenueMonth: clean(row['資料年月']),
    revenueReportDate: clean(row['出表日期']),
  });
}

function mergeIncomeStatements(byCode, rows, market) {
  for (const row of rows) {
    const code = companyCode(row);
    if (!code) continue;
    const revenue = numberOrNull(row['營業收入']);
    const grossProfit = firstNumber(row, ['營業毛利（毛損）淨額', '營業毛利（毛損）']);
    const grossMargin = isFiniteNumber(revenue) && revenue !== 0 && isFiniteNumber(grossProfit)
      ? round((grossProfit / revenue) * 100, 2)
      : null;
    const netIncome = firstNumber(row, ['本期淨利（淨損）', '稅後淨利']);
    const netIncomeParent = firstNumber(row, ['淨利（淨損）歸屬於母公司業主', '稅後淨利']);
    mergeFundamental(byCode, code, {
      code,
      name: companyName(row),
      market,
      fiscalYear: clean(row['年度'] || row.Year),
      fiscalQuarter: clean(row['季別'] || row.Season),
      quarterlyEps: firstPresentNumber(firstNumber(row, ['基本每股盈餘（元）', '基本每股盈餘(元)', '基本每股盈餘']), byCode[code]?.quarterlyEps),
      revenue,
      grossProfit,
      grossMargin,
      operatingProfit: firstNumber(row, ['營業利益（損失）', '營業利益']),
      netIncome,
      netIncomeParent,
      financialDate: clean(row['出表日期'] || row.Date),
    });
  }
}

function mergeBalanceSheets(byCode, rows, market) {
  for (const row of rows) {
    const code = companyCode(row);
    if (!code) continue;
    const totalAssets = firstNumber(row, ['資產總額', '資產總計']);
    const totalLiabilities = firstNumber(row, ['負債總額', '負債總計']);
    const totalEquity = firstNumber(row, ['權益總額', '權益總計']);
    mergeFundamental(byCode, code, {
      code,
      name: companyName(row),
      market,
      fiscalYear: clean(row['年度'] || row.Year || byCode[code]?.fiscalYear),
      fiscalQuarter: clean(row['季別'] || row.Season || byCode[code]?.fiscalQuarter),
      totalAssets,
      totalLiabilities,
      totalEquity,
      equityParent: firstNumber(row, ['歸屬於母公司業主之權益合計']),
      bookValuePerShare: firstNumber(row, ['每股參考淨值']),
      balanceSheetDate: clean(row['出表日期'] || row.Date),
    });
  }
}

async function fetchCashflowMetrics(targetCodes) {
  const byCode = {};
  const codes = [...new Set((targetCodes || []).map(clean).filter(Boolean))];
  for (const code of codes) {
    try {
      const [operating, investing] = await Promise.all([
        fetchMopsfinSeries(code, 'OperatingCashflow'),
        fetchMopsfinSeries(code, 'InvestingCashflow'),
      ]);
      const common = latestCommonCashflow(operating, investing);
      if (!common) continue;
      byCode[code] = {
        operatingCashflow: common.operating,
        investingCashflow: common.investing,
        freeCashFlowApprox: round(common.operating + common.investing, 2),
        cashflowPeriod: common.period,
        cashflowMethod: '營業活動現金流 + 投資活動現金流，作為 FCF 近似值',
        cashflowDataSource: 'https://mopsfin.twse.com.tw/compare/data',
      };
    } catch (error) {
      console.warn(`Cashflow fetch failed for ${code}: ${error.message}`);
    }
  }
  return byCode;
}

async function fetchMopsfinSeries(code, compareItem) {
  const body = new URLSearchParams({
    compareItem,
    quarter: '0',
    ylabel: '仟元',
    ys: '0',
    revenue: '',
    bcodeAvg: '',
    companyAvg: 'false',
    qnumber: '',
  });
  body.append('companyId', code);
  body.append('displayCompanyId', code);
  const response = await fetch('https://mopsfin.twse.com.tw/compare/data', {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: 'https://mopsfin.twse.com.tw/index',
      'x-requested-with': 'XMLHttpRequest',
    },
    body,
  });
  if (!response.ok) throw new Error(`${compareItem}: ${response.status} ${response.statusText}`);
  const payload = await response.json();
  const parsed = payload.json ? JSON.parse(payload.json) : {};
  const xaxisList = payload.xaxisList || parsed.xaxisList || [];
  const graphData = payload.graphData || parsed.graphData || [];
  const points = graphData[0]?.data || [];
  return points
    .map(([index, value, quality]) => ({
      period: xaxisList[index] || String(index),
      value: numberOrNull(value),
      quality,
    }))
    .filter((point) => point.period && isFiniteNumber(point.value));
}

function latestCommonCashflow(operating, investing) {
  const investingByPeriod = new Map(investing.map((point) => [point.period, point]));
  for (let index = operating.length - 1; index >= 0; index -= 1) {
    const operatingPoint = operating[index];
    const investingPoint = investingByPeriod.get(operatingPoint.period);
    if (!investingPoint) continue;
    return {
      period: operatingPoint.period,
      operating: operatingPoint.value,
      investing: investingPoint.value,
    };
  }
  return null;
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
      qualityMetricsCoverage: stocks.filter((stock) => stock.fundamentals?.revenueYoY !== null && stock.fundamentals?.grossMargin !== null && stock.fundamentals?.roe !== null && stock.fundamentals?.debtRatio !== null).length,
      cashflowCoverage: stocks.filter((stock) => stock.fundamentals?.fcfToNetIncomeRatio !== null && stock.fundamentals?.fcfToNetIncomeRatio !== undefined).length,
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
      revenue: [
        'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
        'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
      ],
      incomeStatement: [
        'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_{category}',
        'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_{category}',
      ],
      balanceSheet: [
        'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_{category}',
        'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_{category}',
      ],
      cashflow: [
        'https://mopsfin.twse.com.tw/compare/data',
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
        index: post.index,
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

  if (item.revenueYoY !== null && item.revenueYoY !== undefined) {
    if (item.revenueYoY >= 20) {
      notes.push(`月營收年增 ${item.revenueYoY}% ，成長動能明顯`);
      flags.push('revenue-growth');
    } else if (item.revenueYoY > 0) {
      notes.push(`月營收年增 ${item.revenueYoY}%`);
    } else {
      notes.push(`月營收年減 ${Math.abs(item.revenueYoY)}% ，需確認衰退原因`);
      flags.push('revenue-decline');
    }
  }

  if (item.grossMargin !== null && item.grossMargin !== undefined) {
    if (item.grossMargin >= 30) {
      notes.push(`毛利率 ${item.grossMargin}% ，產品或定價能力較佳`);
      flags.push('high-margin');
    } else if (item.grossMargin < 10) {
      notes.push(`毛利率 ${item.grossMargin}% ，獲利緩衝較薄`);
      flags.push('thin-margin');
    }
  }

  if (item.roe !== null && item.roe !== undefined) {
    if (item.roe >= 20) {
      notes.push(`ROE 約 ${item.roe}% ，股東權益報酬率偏強`);
      flags.push('high-roe');
    } else if (item.roe < 5) {
      notes.push(`ROE 約 ${item.roe}% ，資本效率偏弱`);
      flags.push('low-roe');
    }
  }

  if (item.debtRatio !== null && item.debtRatio !== undefined) {
    if (item.debtRatio > 70) {
      notes.push(`負債比 ${item.debtRatio}% 偏高，需看現金流與利息負擔`);
      flags.push('high-debt');
    } else if (item.debtRatio < 40) {
      notes.push(`負債比 ${item.debtRatio}% ，資產負債表壓力較低`);
      flags.push('low-debt');
    }
  }

  if (item.fcfToNetIncomeRatio !== null && item.fcfToNetIncomeRatio !== undefined) {
    if (item.fcfToNetIncomeRatio >= 80) {
      notes.push(`FCF/淨利約 ${item.fcfToNetIncomeRatio}% ，獲利現金轉換佳`);
      flags.push('cash-conversion');
    } else if (item.fcfToNetIncomeRatio < 0) {
      notes.push(`FCF/淨利約 ${item.fcfToNetIncomeRatio}% ，自由現金流為負`);
      flags.push('negative-fcf');
    }
  } else {
    notes.push('FCF/淨利需現金流資料，若 MOPSFIN 無資料則暫缺');
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
  if (item.revenueYoY !== null && item.revenueYoY !== undefined) {
    if (item.revenueYoY >= 20) score += 8;
    else if (item.revenueYoY > 0) score += 4;
    else score -= 8;
  }
  if (item.grossMargin !== null && item.grossMargin !== undefined) {
    if (item.grossMargin >= 30) score += 5;
    else if (item.grossMargin < 10) score -= 5;
  }
  if (item.roe !== null && item.roe !== undefined) {
    if (item.roe >= 20) score += 10;
    else if (item.roe >= 10) score += 5;
    else if (item.roe < 0) score -= 10;
    else if (item.roe < 5) score -= 4;
  }
  if (item.debtRatio !== null && item.debtRatio !== undefined) {
    if (item.debtRatio > 70) score -= 8;
    else if (item.debtRatio < 40) score += 4;
  }
  if (item.fcfToNetIncomeRatio !== null && item.fcfToNetIncomeRatio !== undefined) {
    if (item.fcfToNetIncomeRatio >= 80) score += 8;
    else if (item.fcfToNetIncomeRatio >= 0) score += 3;
    else score -= 6;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function numberOrNull(value) {
  const normalized = clean(value).replace(/,/g, '');
  if (!normalized || normalized === '-' || normalized === 'N/A') return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = numberOrNull(row[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstPresentNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fiscalQuarterAnnualization(quarter) {
  const value = Number(quarter);
  if (!Number.isFinite(value) || value <= 0 || value > 4) return 4;
  return 4 / value;
}

function companyCode(row) {
  return clean(row['公司代號'] || row.SecuritiesCompanyCode || row.Code);
}

function companyName(row) {
  return clean(row['公司名稱'] || row.CompanyName || row.Name);
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
