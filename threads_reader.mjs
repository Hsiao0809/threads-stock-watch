import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_BROWSER_PATHS = [
  process.env.CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUrl = normalizeTarget(args._[0] || '@evachien.chien');
  const timeoutMs = Number(args.timeoutMs || args.timeout || 45000);
  const limit = Number(args.limit || 30);
  const postPageLimit = Number(args.postPages || args.postPageLimit || 0);
  const scrollRounds = Number(args.scrollRounds || args.scroll || 4);
  const settleMs = Number(args.settleMs || 7000);
  const profileDir = resolve(args.profileDir || args.profile || '.threads-cdp-profile');
  const headful = Boolean(args.headful);
  const keepProfile = Boolean(args.keepProfile || args.profileDir || args.profile);
  const browserPath = args.browser || DEFAULT_BROWSER_PATHS.find((path) => existsSync(path));

  if (!browserPath) {
    fail('Chrome or Edge was not found. Pass --browser "C:\\path\\to\\chrome.exe".');
  }

  mkdirSync(profileDir, { recursive: true });

  let browser;
  let cdp;

  try {
    const port = 20000 + Math.floor(Math.random() * 20000);
    browser = startBrowser(browserPath, port, profileDir, headful);
    const browserInfo = await waitForJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
    const pageInfo = await createPage(port);
    cdp = await CDP.connect(pageInfo.webSocketDebuggerUrl || browserInfo.webSocketDebuggerUrl);

    const networkBodies = [];
    const networkSeen = new Map();

    cdp.on('Network.responseReceived', (event) => {
      const url = event?.response?.url || '';
      if (url.includes('/api/graphql') || url.includes('/graphql')) {
        networkSeen.set(event.requestId, {
          requestId: event.requestId,
          url,
          status: event.response.status,
          mimeType: event.response.mimeType,
        });
      }
    });

    cdp.on('Network.loadingFinished', (event) => {
      const seen = networkSeen.get(event.requestId);
      if (!seen) return;
      cdp.send('Network.getResponseBody', { requestId: event.requestId })
        .then((body) => {
          const text = body.base64Encoded
            ? Buffer.from(body.body, 'base64').toString('utf8')
            : body.body;
          networkBodies.push({ ...seen, text });
        })
        .catch(() => {});
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
      platform: 'Windows',
    });

    await cdp.send('Page.navigate', { url: targetUrl });
    await waitForPageLoad(cdp, timeoutMs);
    await sleep(settleMs);
    await autoScroll(cdp, scrollRounds);
    await sleep(2500);

    const pageText = await evaluate(cdp, 'document.body ? document.body.innerText : ""');
    const documentTitle = await evaluate(cdp, 'document.title || ""');
    const locationHref = await evaluate(cdp, 'location.href');
    const domPosts = await evaluate(cdp, domExtractionExpression());
    const postUrls = await evaluate(cdp, postUrlsExpression(handleFromUrl(targetUrl)));
    const graphPosts = extractPostsFromGraphql(networkBodies);
    const visiblePosts = extractPostsFromVisibleText(pageText, handleFromUrl(targetUrl));
    const selectedPostUrls = postUrls.slice(0, postPageLimit);
    const postPagePosts = postPageLimit > 0
      ? await fetchPostPages(cdp, selectedPostUrls, handleFromUrl(targetUrl), settleMs)
      : [];
    const posts = uniquePosts([...postPagePosts, ...visiblePosts, ...graphPosts, ...domPosts])
      .filter((post) => post.text.length > 12 || post.source !== 'dom')
      .slice(0, limit);

    const result = {
      target: targetUrl,
      finalUrl: locationHref,
      title: documentTitle,
      fetchedAt: new Date().toISOString(),
      browser: browserPath,
      mode: headful ? 'headful' : 'headless',
      scrollRounds,
      postUrlsFound: postUrls.length,
      postPagesVisited: selectedPostUrls.length,
      graphqlResponses: networkBodies.length,
      postsFound: posts.length,
      posts,
      pageTextPreview: normalizeText(pageText).slice(0, 1500),
    };

    const output = JSON.stringify(result, null, 2);
    if (args.out || args.output) {
      const outputPath = resolve(args.out || args.output);
      writeFileSync(outputPath, `${output}\n`, 'utf8');
      console.error(`Wrote ${outputPath}`);
    }
    console.log(output);
    if (!posts.length) {
      process.exitCode = 2;
    }
  } finally {
    if (cdp) {
      try {
        await cdp.close();
      } catch {}
    }
    if (browser) {
      await stopBrowser(browser);
    }
    if (!keepProfile) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    }
  }
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

function normalizeTarget(input) {
  if (/^https?:\/\//i.test(input)) return input;
  const handle = input.replace(/^@/, '');
  return `https://www.threads.com/@${handle}`;
}

function handleFromUrl(url) {
  const match = url.match(/@([^/?#]+)/);
  return match ? match[1].toLowerCase() : '';
}

function startBrowser(executable, port, userDataDir, showWindow) {
  const browserArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--lang=zh-TW',
    'about:blank',
  ];
  if (process.platform !== 'win32') {
    browserArgs.push('--no-sandbox');
  }
  if (!showWindow) {
    browserArgs.unshift('--headless=new');
    browserArgs.push('--disable-gpu');
  }
  return spawn(executable, browserArgs, {
    detached: false,
    stdio: 'ignore',
    windowsHide: !showWindow,
  });
}

async function waitForJson(url, timeoutMsValue) {
  const deadline = Date.now() + timeoutMsValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function createPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (response.ok) return await response.json();
  const pages = await waitForJson(`http://127.0.0.1:${port}/json`, 5000);
  const page = pages.find((entry) => entry.type === 'page');
  if (!page) throw new Error('No debuggable browser page was found.');
  return page;
}

async function waitForPageLoad(client, timeoutMsValue) {
  await Promise.race([
    new Promise((resolveLoaded) => {
      client.once('Page.loadEventFired', resolveLoaded);
    }),
    sleep(timeoutMsValue),
  ]);
}

async function autoScroll(client, rounds) {
  for (let index = 0; index < rounds; index += 1) {
    await evaluate(client, 'window.scrollBy(0, Math.max(document.documentElement.clientHeight, 900)); true');
    await sleep(1200);
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(text);
  }
  return result.result?.value;
}

function domExtractionExpression() {
  return `(() => {
    const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href*="/post/"], a[href*="/t/"]')];
    const posts = [];
    const seen = new Set();
    for (const anchor of anchors) {
      const article = anchor.closest('article') || anchor.closest('[role="article"]') || anchor.closest('div');
      const container = article || anchor.parentElement;
      const text = normalize(container?.innerText || '');
      const href = anchor.href || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      if (text.length < 8) continue;
      posts.push({ source: 'dom', url: href, text });
    }
    return posts;
  })()`;
}

function postUrlsExpression(handle) {
  return `(() => {
    const handle = ${JSON.stringify(handle)};
    const urls = [...document.querySelectorAll('a[href*="/post/"]')]
      .map((anchor) => anchor.href)
      .filter((href) => href && href.includes('/post/') && (!handle || href.toLowerCase().includes('/@' + handle + '/post/')));
    return [...new Set(urls)];
  })()`;
}

async function fetchPostPages(client, urls, handle, settleMs) {
  const posts = [];
  for (const url of urls) {
    await client.send('Page.navigate', { url });
    await waitForPageLoad(client, Math.max(settleMs + 5000, 12000));
    await sleep(Math.min(Math.max(settleMs, 2500), 8000));
    const pageText = await evaluate(client, 'document.body ? document.body.innerText : ""');
    const parsed = extractPostsFromVisibleText(pageText, handle);
    if (parsed.length) {
      const mainPost = parsed.find((post) => post.topic) || parsed[0];
      posts.push({ ...mainPost, source: 'post-page', url });
      continue;
    }
    const fallback = fallbackPostText(pageText, handle);
    if (fallback) {
      posts.push({ source: 'post-page-fallback', url, text: fallback });
    }
  }
  return posts;
}

function fallbackPostText(pageText, handle) {
  const lines = pageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isUiLine(line) && line.toLowerCase() !== handle);
  const translationIndex = lines.findIndex((line) => line === '翻譯' || line === 'Translate');
  const useful = translationIndex >= 0 ? lines.slice(0, translationIndex) : lines;
  const text = normalizeText(useful.join('\n'));
  return looksLikePostText(text) ? text : null;
}

function extractPostsFromGraphql(responses) {
  const posts = [];
  for (const response of responses) {
    for (const jsonText of splitPossiblyJsonLines(response.text)) {
      let data;
      try {
        data = JSON.parse(jsonText);
      } catch {
        continue;
      }
      walk(data, (value) => {
        if (!value || typeof value !== 'object') return;
        const text = findPostText(value);
        if (!text) return;
        const url = findPostUrl(value);
        posts.push({
          source: 'graphql',
          url,
          text,
          rawKeys: Object.keys(value).slice(0, 20),
        });
      });
    }
  }
  return posts;
}

function splitPossiblyJsonLines(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [trimmed];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') || line.startsWith('['));
}

function walk(value, visitor, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor, seen);
    return;
  }
  for (const item of Object.values(value)) walk(item, visitor, seen);
}

function findPostText(value) {
  const directCandidates = [
    value?.caption?.text,
    value?.caption,
    value?.text_post_app_info?.text_fragments?.text,
    value?.text_post_app_info?.share_info?.quoted_post?.caption?.text,
    value?.post?.caption?.text,
    value?.thread_item?.post?.caption?.text,
    value?.node?.thread_items?.[0]?.post?.caption?.text,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && looksLikePostText(candidate)) return normalizeText(candidate);
  }
  return null;
}

function findPostUrl(value) {
  const candidates = [
    value?.url,
    value?.permalink,
    value?.post?.url,
    value?.post?.permalink,
    value?.thread_item?.post?.url,
    value?.thread_item?.post?.permalink,
    value?.node?.thread_items?.[0]?.post?.url,
    value?.node?.thread_items?.[0]?.post?.permalink,
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.startsWith('http')) || null;
}

function looksLikePostText(text) {
  const normalized = normalizeText(text);
  if (normalized.length < 2) return false;
  if (/^(Log in|Sign up|Threads|Instagram)$/i.test(normalized)) return false;
  return true;
}

function uniquePosts(posts) {
  const seen = new Set();
  const result = [];
  for (const post of posts) {
    const text = normalizeText(post.text);
    if (!text) continue;
    const key = text;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...post, text });
  }
  return result;
}

function extractPostsFromVisibleText(pageText, handle) {
  if (!handle) return [];
  const lines = pageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const posts = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].toLowerCase() !== handle) continue;

    const timeIndex = findTimeLine(lines, index + 1, Math.min(lines.length, index + 8));
    if (timeIndex === -1) continue;

    const topic = lines.slice(index + 1, timeIndex).find((line) => !isUiLine(line)) || null;
    const body = [];
    for (let cursor = timeIndex + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const nextIsPost = line.toLowerCase() === handle && findTimeLine(lines, cursor + 1, Math.min(lines.length, cursor + 8)) !== -1;
      if (nextIsPost) break;
      if (line === '翻譯' || line === 'Translate') break;
      if (isUiLine(line)) continue;
      body.push(line);
    }

    const text = normalizeText(body.join('\n'));
    if (looksLikePostText(text)) {
      posts.push({
        source: 'visible-text',
        url: null,
        topic,
        time: lines[timeIndex],
        text,
      });
    }
  }

  return posts;
}

function findTimeLine(lines, start, end) {
  for (let index = start; index < end; index += 1) {
    if (isRelativeOrDateTime(lines[index])) return index;
  }
  return -1;
}

function isRelativeOrDateTime(line) {
  return /^(\d+\s*(秒|分鐘|分|小時|時|天|週|周|月|年)|\d+\s*(s|m|h|d|w|mo|y)|昨天|今天)$/i.test(line)
    || /^\d{4}-\d{1,2}-\d{1,2}$/.test(line)
    || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(line);
}

function isUiLine(line) {
  return [
    '登入',
    'Log in',
    '追蹤',
    'Follow',
    '提及',
    'Mentions',
    '串文',
    'Threads',
    '回覆',
    'Replies',
    '影音內容',
    'Media',
    '轉發',
    'Reposts',
  ].includes(line);
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function stopBrowser(browser) {
  if (browser.exitCode !== null) return;
  browser.kill();
  await Promise.race([
    new Promise((resolveClose) => browser.once('close', resolveClose)),
    sleep(3000),
  ]);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (message) => {
      const payload = JSON.parse(message.data);
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
        } else {
          pending.resolve(payload.result || {});
        }
        return;
      }
      const callbacks = this.listeners.get(payload.method) || [];
      for (const callback of callbacks) callback(payload.params || {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  once(method, callback) {
    const wrapper = (params) => {
      const callbacks = this.listeners.get(method) || [];
      this.listeners.set(method, callbacks.filter((item) => item !== wrapper));
      callback(params);
    };
    this.on(method, wrapper);
  }

  close() {
    this.socket.close();
  }
}

await main();
