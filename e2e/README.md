# Browser tests

These tests drive a real browser (Chromium, through Playwright) against a real OpenBooks container,
the same way you'd use the app. They complement the backend tests in `backend/tests`.

## Running them

You need Docker, Node.js 20+, and (for the bank-feeds suite) Python 3.11+ with the backend's packages.

```bash
pip install -r backend/requirements.txt
```

```bash
bash e2e/run.sh
```

The first run installs Playwright and its Chromium browser into `e2e/node_modules`. The script builds
the Docker image, starts a throwaway container on `127.0.0.1:3999`, runs every suite, and removes the
container afterwards. Your own OpenBooks container and its data are never touched.

It prints `ok` / `FAIL` for each step and exits with an error if anything failed. Screenshots of
failures are saved in `e2e/output/` (not committed).

Settings, as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_PORT` | `3999` | Port for the test container (the bank-feeds server uses the next port up) |
| `E2E_DOCKERFILE` | `Dockerfile` | A different Dockerfile to build |
| `E2E_SKIP_BUILD` | | `1` reuses the last `openbooks:e2e` image |
| `E2E_SKIP_BANK` | | `1` skips the bank-feeds suite (no Python needed) |
| `PYTHON` | `python3` | Python used for the bank-feeds server |
| `SCREENSHOTS` | | `1` makes the crawl save a screenshot of every page |

## What each suite checks

Every suite also fails on JavaScript errors, console errors and failed API calls seen in the browser.

| Suite | Database | Checks |
| --- | --- | --- |
| `01-flows.js` | brand new | First-run admin setup and the login hint; then creating and editing customers, vendors, products, invoices, estimates (and converting them), sales receipts, payments, expenses, bills, bill payments, deposits, transfers, journal entries, bank transactions and CSV import, reconciling, employees, timesheets, payroll, users, settings and the tax method; the books stay balanced; erase all data |
| `02-crawl.js` | brand new | Loads sample data and opens every page and detail view (about 80), clicking every tab. Fails on error banners or blank pages |
| `03-roles.js` | after 02 | Main pages as an accountant, a read-only viewer, and an admin on a phone-sized screen (no sideways scrolling). Viewers are redirected away from create screens |
| `04-wide.js` | after 02 | Layout at 1366 to 5120 pixels wide: no sideways scrolling, content centred, interface zoom on ultrawide screens, the chart inside its card, menus and pop-ups on screen. Saves `wide-<width>.png` for a visual check |
| `05-bank-feeds.js` | own server | Runs the app with stand-in SimpleFIN and GoCardless responses (`fake_provider_server.py`): saving provider keys, connecting a bank, linking an account, syncing transactions into For review, no duplicates on re-sync, the GoCardless bank picker |

`lib.js` holds the shared helpers (signing in, the first-run setup, finding form fields by label,
calling the API with the browser's login).
