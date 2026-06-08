#!/usr/bin/env bun
import { chromium, type Page } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import CREDENTIALS from './credentials';
import pkg from './package.json' with { type: 'json' };

// --- Types ---

interface OrderItem {
  name: string;
  articleNumber: string;
  productUrl: string;
  imageUrl: string;
  count: number;
  unitPrice: string;
  unitPriceNum: number;
  lineTotal: string;
  lineTotalNum: number;
}

interface Order {
  orderNumber: string;
  orderType: string;   // "Kundenauftrag/-Bestellung" or "Gutschrift"
  date: string;        // DD.MM.YYYY as shown on site
  dateIso: string;     // YYYY-MM-DD
  totalSum: string;
  totalSumNum: number;
  status: string;
  orderUrl: string;
  invoiceUrl: string | null;
  items: OrderItem[];
  removed?: boolean;
}

interface ExportData {
  exportDate: string;
  orders: Order[];
}

// --- Config ---

const CONFIG = {
  baseUrl: 'https://www.thomann.de',
  orderlistUrl: 'https://www.thomann.de/de/mythomann_orderlist.html',
  outputFile: `orders-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`,
};

// --- Helpers ---

function parsePrice(raw: string): number {
  // German locale (dot = thousands, comma = decimal): "1.773,76 €" → 1773.76
  // This assumes the /de/ locale on thomann.de — other locales would need different parsing.
  const cleaned = raw.replace(/[€\s\u00a0]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

function toIsoDate(dmy: string): string {
  // "17.02.2026" → "2026-02-17"
  const [d, m, y] = dmy.split('.');
  return `${y}-${m}-${d}`;
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function findLatestExport(): Promise<string | null> {
  const { readdir } = await import('fs/promises');
  const files = (await readdir('.')).filter(f => /^orders-\d{14}\.json$/.test(f)).sort();
  return files.length > 0 ? files[files.length - 1]! : null;
}

async function loadExisting(): Promise<ExportData | null> {
  const file = await findLatestExport();
  if (!file) return null;
  try {
    console.log(`Loading existing data from ${file}`);
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as ExportData;
  } catch {
    return null;
  }
}

async function save(data: ExportData): Promise<void> {
  await writeFile(CONFIG.outputFile, JSON.stringify(data, null, 2) + '\n');
}

// --- Browser helpers ---

async function cookieConsent(page: Page) {
  try {
    await page.getByRole('button', { name: /accept/i }).or(
      page.locator('button.consent-button--primary')
    ).click({ timeout: 3000 });
  } catch {
    // no consent banner — already accepted
  }
}

async function login(page: Page) {
  const form = page.getByTestId('login-form-page');
  try {
    await form.waitFor({ timeout: 5000 });
  } catch {
    // no login form — already logged in, or redirected to order list
    return;
  }

  await form.getByRole('textbox', { name: 'E-Mail-Adresse*' }).fill(CREDENTIALS.username);
  await page.getByRole('textbox', { name: 'Passwort*' }).fill(CREDENTIALS.password);
  await form.getByRole('button', { name: /anmelden|log\s*in|sign\s*in/i }).click();

  await page.waitForURL(/mythomann/, { timeout: 10000 });
}

// --- Scraping ---

interface OrderSummary {
  orderNumber: string;
  date: string;
  totalSum: string;
  status: string;
  detailUrl: string;
}

async function scrapeOrderListPage(page: Page): Promise<OrderSummary[]> {
  return page.evaluate((baseUrl) => {
    const teasers = document.querySelectorAll('.mythomann-order-teaser');
    return [...teasers].map(teaser => {
      const values = teaser.querySelectorAll('.mythomann-order-teaser__detail-value');
      const link = teaser.querySelector<HTMLAnchorElement>('a.js-order-details-link');
      const href = link?.getAttribute('href') ?? '';
      const detailUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/de/'}${href}`;

      return {
        date: values[0]?.textContent?.trim() ?? '',
        orderNumber: values[1]?.textContent?.trim() ?? '',
        totalSum: values[2]?.textContent?.trim() ?? '',
        status: values[3]?.textContent?.trim() ?? '',
        detailUrl,
      };
    });
  }, CONFIG.baseUrl);
}

async function scrapeAllOrderSummaries(
  page: Page,
  knownOrderNumbers: Set<string>,
  opts: { slow: boolean; limit: number; reconcileCutoffIso: string | null },
): Promise<OrderSummary[]> {
  const allOrders: OrderSummary[] = [];
  const needed = opts.limit;
  const cutoff = opts.reconcileCutoffIso;

  function newOrderCount() {
    return allOrders.filter(o => !knownOrderNumbers.has(o.orderNumber)).length;
  }
  function pageInsideWindow(orders: OrderSummary[]): boolean {
    if (cutoff === null) return false;
    return orders.some(o => toIsoDate(o.date) >= cutoff);
  }

  // Scrape first page
  let pageOrders = await scrapeOrderListPage(page);
  allOrders.push(...pageOrders);
  console.log(`  Page 1: ${allOrders.length} orders`);

  // Find total pages from pagination
  const pageLinks = page.locator('.fx-pagination .fx-pagination__pages-button');
  const lastPageLink = pageLinks.last();
  const lastPageText = await lastPageLink.textContent().catch(() => null);
  const totalPages = lastPageText ? parseInt(lastPageText.trim(), 10) : 1;

  // Orders are listed newest-first. Outside the reconcile window the existing
  // short-circuits apply; inside the window we need every summary for drift
  // comparison, so we keep paging regardless of known/limit.
  for (let pg = 2; pg <= totalPages; pg++) {
    if (!pageInsideWindow(pageOrders)) {
      if (pageOrders.some(o => knownOrderNumbers.has(o.orderNumber))) {
        console.log(`  Reached previously-known orders, skipping remaining pages`);
        break;
      }
      if (newOrderCount() >= needed) {
        console.log(`  Collected enough new orders, skipping remaining pages`);
        break;
      }
    }
    if (opts.slow) await randomDelay(1000, 3000);
    await page.goto(`${CONFIG.orderlistUrl}?pg=${pg}`);
    await page.locator('#order-list').waitFor();
    pageOrders = await scrapeOrderListPage(page);
    allOrders.push(...pageOrders);
    console.log(`  Page ${pg}/${totalPages}: +${pageOrders.length} orders (total: ${allOrders.length})`);
  }

  return allOrders;
}

async function scrapeOrderDetail(page: Page, summary: OrderSummary): Promise<Order> {
  await page.goto(summary.detailUrl);
  await page.locator('.mythomann-order-articles').waitFor({ timeout: 10000 });

  // Extract everything in a single evaluate() call — avoids per-field roundtrips
  const { invoiceUrl, orderType, rawItems } = await page.evaluate(() => {
    const invoiceEl = document.querySelector<HTMLAnchorElement>('a[href*="mythomann_invoice"]');

    // Extract order type from the order details grid ("Auftragsart" → "Gutschrift" or "Kundenauftrag/-Bestellung")
    let orderType = '';
    const detailsGrid = document.querySelector('.mythomann-order-details .fx-grid');
    if (detailsGrid) {
      const cols = detailsGrid.querySelectorAll('.fx-grid__col');
      for (let i = 0; i < cols.length - 1; i++) {
        if (cols[i]!.textContent!.trim() === 'Auftragsart') {
          orderType = cols[i + 1]!.textContent!.trim();
          break;
        }
      }
    }

    function detailValue(article: Element, label: string): string {
      for (const detail of article.querySelectorAll('.article__detail')) {
        const title = detail.querySelector('.article__title');
        if (title && title.textContent!.trim() === label) {
          return detail.querySelector('.article__value')?.textContent?.trim() ?? '';
        }
      }
      return '';
    }

    const articles = document.querySelectorAll('.mythomann-order-articles .article');
    const rawItems = [...articles].map(article => {
      const name = article.querySelector('h3.article__name')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const articleNumber = detailValue(article, 'Artikelnr.');
      const link = article.querySelector<HTMLAnchorElement>('a.article__image-wrapper');
      const img = article.querySelector<HTMLImageElement>('img.article__image');
      const amountEl = article.querySelector('.article__amount-text');
      const amountText = amountEl?.textContent?.trim() ?? '';
      const count = amountText ? parseInt(amountText.replace('x', ''), 10) : 1;

      return {
        name,
        articleNumber,
        productUrl: link?.href ?? '',
        imageUrl: img?.src ?? '',
        count,
        unitPrice: detailValue(article, 'Einzelpreis'),
        lineTotal: detailValue(article, 'Summe'),
      };
    });

    return { invoiceUrl: invoiceEl?.href ?? null, orderType, rawItems };
  });

  const isRefund = orderType === 'Gutschrift';
  const sign = isRefund ? -1 : 1;

  const items: OrderItem[] = rawItems.map(r => ({
    ...r,
    unitPriceNum: parsePrice(r.unitPrice) * sign,
    lineTotalNum: parsePrice(r.lineTotal) * sign,
  }));

  return {
    orderNumber: summary.orderNumber,
    orderType,
    date: summary.date,
    dateIso: toIsoDate(summary.date),
    totalSum: summary.totalSum,
    totalSumNum: parsePrice(summary.totalSum) * sign,
    status: summary.status,
    orderUrl: summary.detailUrl,
    invoiceUrl,
    items,
  };
}

// --- CLI args ---

const HELP = `Usage: thomann-orders [options]

Export your Thomann order history to a timestamped JSON file. By default,
runs incrementally — only fetches orders not present in the most recent
existing export — and reconciles orders within a 3-month window against
the current listing to catch cancellations and item amendments.

Options:
  --full              Re-export all orders, ignoring previous exports
  --slow              Add random pauses between requests
  --limit N           Only fetch the first N new orders
  --reconcile=N       Reconcile cached orders within the last N months
                      against the listing (default: 3)
  --no-reconcile      Skip reconciliation
  --refresh=ORDERNO   Re-fetch a single order's details and exit
  -h, --help          Show this help and exit
  -v, --version       Show version and exit
`;

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let slow = false;
  let full = false;
  let reconcileMonths: number | null = 3;
  let refresh: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      console.log(pkg.version);
      process.exit(0);
    } else if (arg === '--full') full = true;
    else if (arg === '--slow') slow = true;
    else if (arg === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i]!, 10);
    } else if (arg === '--no-reconcile') {
      reconcileMonths = null;
    } else if (arg.startsWith('--reconcile=')) {
      const n = parseInt(arg.slice('--reconcile='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --reconcile value: ${arg}\n`);
        process.exit(2);
      }
      reconcileMonths = n;
    } else if (arg.startsWith('--refresh=')) {
      refresh = arg.slice('--refresh='.length);
      if (!refresh) {
        console.error(`Invalid --refresh value: ${arg}\n`);
        process.exit(2);
      }
    } else {
      console.error(`Unknown option: ${arg}\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  }
  // --full has no cache to reconcile against
  if (full) reconcileMonths = null;
  return { full, slow, limit, reconcileMonths, refresh };
}

function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main ---

async function findOrderInListing(page: Page, orderNumber: string): Promise<OrderSummary | null> {
  await page.goto(CONFIG.orderlistUrl);
  await page.locator('#order-list').waitFor();
  let pageOrders = await scrapeOrderListPage(page);

  const pageLinks = page.locator('.fx-pagination .fx-pagination__pages-button');
  const lastPageText = await pageLinks.last().textContent().catch(() => null);
  const totalPages = lastPageText ? parseInt(lastPageText.trim(), 10) : 1;

  for (let pg = 1; pg <= totalPages; pg++) {
    if (pg > 1) {
      await page.goto(`${CONFIG.orderlistUrl}?pg=${pg}`);
      await page.locator('#order-list').waitFor();
      pageOrders = await scrapeOrderListPage(page);
    }
    const match = pageOrders.find(o => o.orderNumber === orderNumber);
    if (match) return match;
  }
  return null;
}

async function refreshSingleOrder(
  page: Page,
  orderNumber: string,
  cached: Order | undefined,
): Promise<Order | null> {
  const summary: OrderSummary | null = cached
    ? {
        orderNumber: cached.orderNumber,
        date: cached.date,
        totalSum: cached.totalSum,
        status: cached.status,
        detailUrl: cached.orderUrl,
      }
    : await findOrderInListing(page, orderNumber);

  if (!summary) return null;

  try {
    return await scrapeOrderDetail(page, summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  Failed to fetch detail for ${orderNumber}: ${msg}`);
    return null;
  }
}

async function main() {
  const opts = parseArgs();

  // Load existing data for incremental mode
  const existing = opts.full ? null : await loadExisting();
  const knownOrderNumbers = new Set(existing?.orders.map(o => o.orderNumber) ?? []);
  if (existing && !opts.full) {
    console.log(`Incremental mode: ${knownOrderNumbers.size} orders already scraped`);
  }

  const reconcileCutoffIso = existing && opts.reconcileMonths !== null
    ? monthsAgoIso(opts.reconcileMonths)
    : null;
  if (reconcileCutoffIso) {
    console.log(`Reconciling orders since ${reconcileCutoffIso}`);
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    await page.goto(CONFIG.orderlistUrl);
    await cookieConsent(page);
    await login(page);
    await cookieConsent(page);

    // Ensure we're on the order list
    await page.locator('#order-list').waitFor({ timeout: 10000 });

    // --- Refresh single order and exit ---
    if (opts.refresh) {
      const cached = existing?.orders.find(o => o.orderNumber === opts.refresh);
      const refreshed = await refreshSingleOrder(page, opts.refresh, cached);

      const merged = new Map<string, Order>();
      for (const o of existing?.orders ?? []) merged.set(o.orderNumber, o);

      if (refreshed) {
        merged.set(refreshed.orderNumber, refreshed);
        console.log(`Refreshed order ${refreshed.orderNumber}`);
      } else if (cached) {
        merged.set(cached.orderNumber, { ...cached, removed: true });
        console.log(`Marked order ${cached.orderNumber} as removed`);
      } else {
        console.log(`Order ${opts.refresh} not in cache or listing — nothing to save`);
        return;
      }

      const allOrders = [...merged.values()].sort((a, b) => b.dateIso.localeCompare(a.dateIso));
      const exportData: ExportData = {
        exportDate: new Date().toISOString(),
        orders: allOrders,
      };
      await save(exportData);
      console.log(`Saved ${allOrders.length} orders to ${CONFIG.outputFile}`);
      return;
    }

    // --- Step 1: Collect order summaries ---
    console.log('Scraping order list...');
    const summaries = await scrapeAllOrderSummaries(page, knownOrderNumbers, {
      slow: opts.slow,
      limit: opts.limit,
      reconcileCutoffIso,
    });
    console.log(`Found ${summaries.length} orders in listing`);

    const cachedByNumber = new Map<string, Order>();
    for (const o of existing?.orders ?? []) cachedByNumber.set(o.orderNumber, o);
    const summaryByNumber = new Map<string, OrderSummary>();
    for (const s of summaries) summaryByNumber.set(s.orderNumber, s);

    // --- Step 2: Classify summaries (new vs drift vs no-op) ---
    const toScrapeAll: OrderSummary[] = [];
    const toRefetch: OrderSummary[] = [];
    for (const s of summaries) {
      const cached = cachedByNumber.get(s.orderNumber);
      if (!cached) {
        toScrapeAll.push(s);
        continue;
      }
      if (cached.removed) {
        // Was marked removed but is back in the listing — refetch to clear the flag
        toRefetch.push(s);
        continue;
      }
      const inWindow = reconcileCutoffIso !== null && toIsoDate(s.date) >= reconcileCutoffIso;
      if (inWindow && (cached.status !== s.status || cached.totalSum !== s.totalSum)) {
        toRefetch.push(s);
      }
    }
    const toScrape = opts.limit < toScrapeAll.length ? toScrapeAll.slice(0, opts.limit) : toScrapeAll;

    // --- Step 3: Cached orders within the window missing from the listing ---
    const nowRemoved: string[] = [];
    if (reconcileCutoffIso !== null) {
      for (const o of existing?.orders ?? []) {
        if (o.dateIso >= reconcileCutoffIso && !summaryByNumber.has(o.orderNumber) && !o.removed) {
          nowRemoved.push(o.orderNumber);
        }
      }
    }

    console.log(
      `Reconciliation: ${toScrape.length} new, ${toRefetch.length} drift, ${nowRemoved.length} removed`,
    );

    // --- Step 4: Detail fetches for new + drifted orders ---
    const detailFetches = [...toScrape, ...toRefetch];
    const fetched: Order[] = [];
    for (let i = 0; i < detailFetches.length; i++) {
      const summary = detailFetches[i]!;
      const tag = i < toScrape.length ? 'new' : 'drift';
      console.log(`  [${i + 1}/${detailFetches.length}] (${tag}) Order ${summary.orderNumber}...`);
      const order = await scrapeOrderDetail(page, summary);
      fetched.push(order);
      if (opts.slow) await randomDelay(1500, 4000);
    }

    // --- Step 5: Merge and save ---
    const merged = new Map<string, Order>();
    for (const o of existing?.orders ?? []) merged.set(o.orderNumber, o);
    for (const o of fetched) merged.set(o.orderNumber, o);
    for (const orderNumber of nowRemoved) {
      const cur = merged.get(orderNumber);
      if (cur) {
        merged.set(orderNumber, { ...cur, removed: true });
        console.log(`  Marked removed: ${orderNumber}`);
      }
    }

    const allOrders = [...merged.values()].sort((a, b) => b.dateIso.localeCompare(a.dateIso));

    const exportData: ExportData = {
      exportDate: new Date().toISOString(),
      orders: allOrders,
    };

    await save(exportData);
    console.log(`Saved ${allOrders.length} orders to ${CONFIG.outputFile}`);
  } finally {
    await browser.close();
  }
}

main();
