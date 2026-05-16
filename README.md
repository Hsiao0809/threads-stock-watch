# Threads Stock Watch

GitHub-native project for reading a public Threads profile, extracting Taiwan stock mentions, and publishing a filterable dashboard with GitHub Pages.

## What It Does

- Uses local Chrome/Edge headless through Chrome DevTools Protocol to read public Threads posts.
- Extracts Taiwan stock mentions from post text using TWSE and TPEx official OpenAPI data.
- Adds simple action tags such as buy/add, sell, limit-up, limit-down, watch, and regret.
- Adds fundamental indicators for mentioned stocks: close price, P/E, P/B, dividend yield, EPS, revenue YoY, gross margin, ROE, debt ratio, and FCF/net income.
- Produces `data/latest.json` for downstream analysis.
- Publishes `public/index.html` as a GitHub Pages dashboard through GitHub Actions.

This is an information extraction tool. It does not provide investment advice.

## Local Run

```powershell
npm run update
```

Environment variables:

```powershell
$env:THREADS_HANDLE='@evachien.chien'
$env:POST_PAGES='4'
$env:SCROLL_ROUNDS='4'
$env:SETTLE_MS='3500'
npm run update
```

Output:

- `data/raw.json`: raw Threads extraction.
- `data/latest.json`: stock mention analysis used by the dashboard.

Preview the dashboard locally:

```powershell
npm run serve
```

Then open `http://127.0.0.1:8787/`.

## GitHub Setup

1. Create a new GitHub repo and push this folder.
2. Go to `Settings > Pages`.
3. Set source to `GitHub Actions`.
4. Run `Actions > Update Threads Stock Dashboard > Run workflow`.

The workflow also runs every 4 hours and deploys the dashboard to GitHub Pages.

## Change Target Account

Edit `.github/workflows/pages.yml`:

```yaml
THREADS_HANDLE: "@evachien.chien"
POST_PAGES: "4"
```

Increase `POST_PAGES` to inspect more post permalinks. Higher values take longer because the workflow opens each post page.

## Data Sources

- TWSE OpenAPI: `https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`
- TPEx OpenAPI: `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes`
- TWSE valuation: `https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL`
- TWSE quarterly EPS: `https://openapi.twse.com.tw/v1/opendata/t187ap14_L`
- TWSE monthly revenue: `https://openapi.twse.com.tw/v1/opendata/t187ap05_L`
- TWSE income statement: `https://openapi.twse.com.tw/v1/opendata/t187ap06_L_{category}`
- TWSE balance sheet: `https://openapi.twse.com.tw/v1/opendata/t187ap07_L_{category}`
- TPEx valuation: `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis`
- TPEx quarterly EPS: `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O`
- TPEx monthly revenue: `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O`
- TPEx income statement: `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_{category}`
- TPEx balance sheet: `https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_{category}`
- MOPSFIN cashflow comparison: `https://mopsfin.twse.com.tw/compare/data`

FCF/net income uses a practical approximation from MOPSFIN: operating cash flow plus investing cash flow, divided by net income. It is labeled in the dashboard because official open data does not expose a direct capital expenditure field in the same simple endpoint set.

Fallback aliases live in `data/stock_aliases.json`.

## Access Scope

The reader only extracts content visible to the browser session. It does not bypass private accounts, deleted posts, login restrictions, or platform access controls.
