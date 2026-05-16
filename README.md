# Threads Stock Watch

GitHub-native project for reading a public Threads profile, extracting Taiwan stock mentions, and publishing a filterable dashboard with GitHub Pages.

## What It Does

- Uses local Chrome/Edge headless through Chrome DevTools Protocol to read public Threads posts.
- Extracts Taiwan stock mentions from post text using TWSE and TPEx official OpenAPI data.
- Adds simple action tags such as buy/add, sell, limit-up, limit-down, watch, and regret.
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

Fallback aliases live in `data/stock_aliases.json`.

## Access Scope

The reader only extracts content visible to the browser session. It does not bypass private accounts, deleted posts, login restrictions, or platform access controls.
