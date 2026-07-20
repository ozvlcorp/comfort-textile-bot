import { prisma } from "./db.js";

const baseUrl = process.env.MOSKLAD_BASE_URL || "https://api.moysklad.ru/api/remap/1.2";
const token = process.env.MOSKLAD_TOKEN || "";

// ── Concurrency limiter ───────────────────────────────────────────────────────
// MoySklad allows max 5 parallel requests per solution token.

const MAX_CONCURRENT = 5;
let _activeRequests = 0;
const _requestQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (_activeRequests < MAX_CONCURRENT) {
      _activeRequests++;
      resolve();
    } else {
      _requestQueue.push(() => { _activeRequests++; resolve(); });
    }
  });
}

function releaseSlot(): void {
  _activeRequests--;
  const next = _requestQueue.shift();
  if (next) next();
}

type FetchOptions = {
  method?: string;
  body?: unknown;
};

function isTransientError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("EAI_AGAIN") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
}

const FETCH_TIMEOUT_MS = 30_000;

async function moskladFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  if (!token) {
    throw new Error("MOSKLAD_TOKEN is not set");
  }
  const MAX_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    await acquireSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        method: options.method || "GET",
        headers: {
          Authorization: `Basic ${token}`,
          "Content-Type": "application/json"
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Mosklad request failed: ${response.status} ${text}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      lastError = err;
      if (!isTransientError(err)) throw err;
      console.warn(`moskladFetch transient error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timeoutId);
      releaseSlot();
    }
  }
  throw lastError;
}

// ── In-flight dedup + meta caches ────────────────────────────────────────────
// Stock and products: no TTL cache — always fresh, but deduplicate concurrent requests.
// Currency/org/store: stable meta — cache for 10 min.

let _currencyCache: { code: string | null; expiresAt: number } | null = null;
let _usdRateCache: { rate: number | null; expiresAt: number } | null = null;
let _organizationCache: { id: string | null; expiresAt: number } | null = null;
let _storeCache: { id: string | null; expiresAt: number } | null = null;

let _stockFetchPromise: Promise<Map<string, number>> | null = null;
let _productsCache: { data: MoyskladProduct[]; expiresAt: number } | null = null;
let _productsFetchPromise: Promise<MoyskladProduct[]> | null = null;

async function getStockMap(): Promise<Map<string, number>> {
  if (_stockFetchPromise) return _stockFetchPromise;

  _stockFetchPromise = (async () => {
    const data = await moskladFetch<{
      rows: Array<{ meta: { href: string; type: string }; stock: number }>;
    }>("/report/stock/all?filter=stockMode=all&limit=1000");

    const map = new Map<string, number>();
    for (const row of data.rows) {
      if (row.meta.type !== "product") continue;
      const parts = row.meta.href.split("/");
      const id = parts[parts.length - 1].split("?")[0];
      if (id) map.set(id, Math.max(0, Math.floor(row.stock)));
    }
    return map;
  })().finally(() => { _stockFetchPromise = null; });

  return _stockFetchPromise;
}

// ── Pagination helper ─────────────────────────────────────────────────────────

async function fetchAllPages<T>(basePath: string, maxRows = 10_000): Promise<T[]> {
  const limit = basePath.includes("expand=") ? 100 : 1000;
  let offset = 0;
  const allRows: T[] = [];

  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const data = await moskladFetch<{ meta: { size: number }; rows: T[] }>(
      `${basePath}${sep}limit=${limit}&offset=${offset}`
    );
    allRows.push(...data.rows);
    offset += data.rows.length;
    if (data.rows.length === 0 || offset >= (data.meta?.size ?? 0) || allRows.length >= maxRows) break;
  }

  return allRows;
}

// ── Products ──────────────────────────────────────────────────────────────────

type MoyskladProduct = {
  id: string;
  name: string;
  article?: string;
  salePrices?: Array<{ value: number; priceType?: { name?: string }; currency?: { isoCode?: string; name?: string; symbol?: string } }>;
  images?: { meta?: { size?: number } };
  productFolder?: { meta?: { href?: string } };
};

function pickSalePrice(
  prices?: Array<{ value: number; priceType?: { name?: string }; currency?: { isoCode?: string; name?: string; symbol?: string } }>
) {
  if (!prices || prices.length === 0) return { value: 0, currency: null as string | null };
  const saleName = "Цена продажи";
  const preferred =
    prices.find((p) => (p.priceType?.name || "") === saleName) ||
    prices.find((p) => (p.priceType?.name || "").toLowerCase().includes("sale"));
  const price = preferred || prices[0];
  const currency = price?.currency?.isoCode || price?.currency?.symbol || price?.currency?.name || null;
  return { value: price?.value ? price.value / 100 : 0, currency };
}

function mapProduct(row: MoyskladProduct, stockMap: Map<string, number> | null, baseCurrency: string | null) {
  const pickedPrice = pickSalePrice(row.salePrices);
  return {
    id: row.id,
    name: row.name,
    article: row.article || null,
    price: pickedPrice.value,
    priceCurrency: pickedPrice.currency || baseCurrency,
    stock: stockMap ? (stockMap.get(row.id) ?? 0) : 9999,
    imageCount: row.images?.meta?.size ?? 0
  };
}

async function getAllProducts(): Promise<MoyskladProduct[]> {
  const now = Date.now();
  if (_productsCache && _productsCache.expiresAt > now) return _productsCache.data;
  if (_productsFetchPromise) return _productsFetchPromise;

  _productsFetchPromise = fetchAllPages<MoyskladProduct>(
    "/entity/product?expand=salePrices.currency,productFolder"
  ).then((data) => {
    _productsCache = { data, expiresAt: Date.now() + 60 * 60_000 }; // 1 hour
    return data;
  }).finally(() => { _productsFetchPromise = null; });

  return _productsFetchPromise;
}

export async function listProducts() {
  const [rows, baseCurrency] = await Promise.all([
    getAllProducts(),
    // Stock disabled — all products show as 9999 (unlimited). Re-enable by adding:
    // getStockMap().catch(() => null),
    // and restoring stockMap in the destructure + passing it to mapProduct.
    getBaseCurrencyCode()
  ]);
  return rows.map((row) => mapProduct(row, null, baseCurrency));
}

export async function listCategories() {
  const rows = await fetchAllPages<{ id: string; name: string }>("/entity/productfolder");
  if (rows.length === 0) {
    return [{ id: "all", name: "All products" }];
  }
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

export async function listProductsByCategory(categoryId: string) {
  const [allRows, baseCurrency] = await Promise.all([
    getAllProducts(),
    // Stock disabled — see listProducts comment.
    getBaseCurrencyCode()
  ]);
  const rows = categoryId === "all"
    ? allRows
    : allRows.filter((r) => r.productFolder?.meta?.href?.includes(categoryId));
  return rows.map((row) => mapProduct(row, null, baseCurrency));
}

export async function getProductsByIds(ids: string[]) {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  const [results, baseCurrency] = await Promise.all([
    Promise.all(
      uniqueIds.map((id) => moskladFetch<MoyskladProduct>(`/entity/product/${id}?expand=salePrices.currency`))
    ),
    // Stock disabled — see listProducts comment.
    getBaseCurrencyCode()
  ]);
  return results.map((row) => mapProduct(row, null, baseCurrency));
}

export async function fetchProductImages(productId: string): Promise<Array<{ id: string; url: string }>> {
  const data = await moskladFetch<{
    rows: Array<{ meta: { href: string }; id?: string }>;
  }>(`/entity/product/${productId}/images?limit=10`);

  return data.rows.map((row) => {
    const parts = row.meta.href.split("/");
    const imageId = row.id || parts[parts.length - 1].split("?")[0];
    return { id: imageId, url: `/api/product-image/${productId}/${imageId}` };
  });
}

// ── Counterparty ──────────────────────────────────────────────────────────────

/** Normalize a phone to +998XXXXXXXXX format.
 * Handles: spaces, missing +, missing country code (9-digit local numbers). */
export function normalizePhone(phone: string): string {
  // Strip spaces and any non-digit chars except a leading +
  const clean = phone.trim().replace(/\s+/g, "");
  const digits = clean.startsWith("+") ? clean.slice(1).replace(/\D/g, "") : clean.replace(/\D/g, "");

  if (digits.length === 9) return `+998${digits}`;           // local: 9XXXXXXXX
  if (digits.length === 12 && digits.startsWith("998")) return `+${digits}`;  // full without +
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`; // Russian
  // Already correct or unknown format — just ensure leading +
  return `+${digits}`;
}

export async function findCounterpartyByPhone(phoneNumber: string): Promise<string | null> {
  const normalized = normalizePhone(phoneNumber); // e.g. +998331006434

  // Build all variants to try: +998XXXXXXXXX, 998XXXXXXXXX, XXXXXXXXX (9-digit local)
  const candidates: string[] = [normalized];
  if (normalized.startsWith("+998") && normalized.length === 13) {
    candidates.push(normalized.slice(1));   // 998XXXXXXXXX
    candidates.push(normalized.slice(4));   // XXXXXXXXX  (9 digits, as some old records were saved)
  }

  for (const candidate of candidates) {
    const result = await moskladFetch<{ rows: Array<{ id: string }> }>(
      `/entity/counterparty?filter=phone=${encodeURIComponent(candidate)}`
    );
    if (result.rows[0]?.id) return result.rows[0].id;
  }

  return null;
}

export async function updateCounterpartyAttrs(
  counterpartyId: string,
  telegramId: string,
  username?: string
): Promise<void> {
  const usernameAttr = process.env.MOSKLAD_COUNTERPARTY_USERNAME_ATTR;
  const telegramIdAttr = process.env.MOSKLAD_COUNTERPARTY_TELEGRAM_ID_ATTR;
  if (!usernameAttr && !telegramIdAttr) return;

  const attributes: Array<{ meta: object; value: string }> = [];
  if (telegramIdAttr) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${telegramIdAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: telegramId
    });
  }
  if (usernameAttr && username) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${usernameAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: username
    });
  }

  if (attributes.length === 0) return;

  await moskladFetch(`/entity/counterparty/${counterpartyId}`, {
    method: "PUT",
    body: { attributes }
  });
}

export async function updateCounterpartyAddress(
  counterpartyId: string,
  opts: { location?: string | null; addressName?: string | null; addressExtra?: string | null }
): Promise<void> {
  const locationAttr = process.env.MOSKLAD_COUNTERPARTY_LOCATION_ATTR;
  const addressAttr = process.env.MOSKLAD_COUNTERPARTY_ADDRESS_ATTR;
  const addressDetailsAttr = process.env.COUNTERPARTY_ADDRESS_DETAILS;

  const attributes: object[] = [];
  if (locationAttr && opts.location) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${locationAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.location
    });
  }
  if (addressAttr && opts.addressName) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${addressAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.addressName
    });
  }
  if (addressDetailsAttr && opts.addressExtra) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${addressDetailsAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: opts.addressExtra
    });
  }
  if (attributes.length === 0) return;

  await moskladFetch(`/entity/counterparty/${counterpartyId}`, {
    method: "PUT",
    body: { attributes }
  });
}

export async function getCounterparty(counterpartyId: string) {
  return moskladFetch<{
    id: string;
    name?: string;
    attributes?: Array<{ id?: string; value: any; meta?: { href?: string } }>;
  }>(`/entity/counterparty/${counterpartyId}`);
}

export async function createCounterparty(
  telegramId: string,
  phoneNumber: string,
  name: string,
  username?: string
): Promise<string> {
  const usernameAttr = process.env.MOSKLAD_COUNTERPARTY_USERNAME_ATTR;
  const telegramIdAttr = process.env.MOSKLAD_COUNTERPARTY_TELEGRAM_ID_ATTR;

  const attributes: Array<{ meta: object; value: string }> = [];
  if (telegramIdAttr) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${telegramIdAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: telegramId
    });
  }
  if (usernameAttr && username) {
    attributes.push({
      meta: {
        href: `${baseUrl}/entity/counterparty/metadata/attributes/${usernameAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: username
    });
  }

  const body: Record<string, unknown> = { name, phone: phoneNumber };
  if (attributes.length > 0) body.attributes = attributes;

  const created = await moskladFetch<{ id: string }>(`/entity/counterparty`, {
    method: "POST",
    body
  });

  await prisma.user.update({
    where: { telegramId },
    data: { moskladCounterpartyId: created.id }
  });

  return created.id;
}

export async function getOrCreateCounterparty(
  telegramId: string,
  phoneNumber: string,
  name?: string,
  username?: string
) {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) throw new Error("User not found");

  const phone = normalizePhone(phoneNumber);

  if (user.moskladCounterpartyId) {
    const active = await moskladFetch<{ archived?: boolean }>(
      `/entity/counterparty/${user.moskladCounterpartyId}`
    )
      .then((r) => !r.archived)
      .catch((err: Error) => {
        if (err.message.includes("404")) return false;
        throw err;
      });
    if (active) return user.moskladCounterpartyId;

    // Counterparty was deleted or archived in MoySklad — unlink and force re-registration
    await prisma.user.update({
      where: { telegramId },
      data: { moskladCounterpartyId: null }
    });
    throw new Error("COUNTERPARTY_DELETED");
  }

  const existing = await findCounterpartyByPhone(phone);
  if (existing) {
    await prisma.user.update({
      where: { telegramId },
      data: { moskladCounterpartyId: existing }
    });
    await updateCounterpartyAttrs(existing, telegramId, username);
    return existing;
  }

  return createCounterparty(
    telegramId,
    phone,
    name || user.firstName || user.username || phone,
    username
  );
}

// ── Balance & Orders ──────────────────────────────────────────────────────────

export async function getCustomerBalance(counterpartyId: string) {
  const data = await moskladFetch<{ balance: number }>(
    `/report/counterparty/${counterpartyId}`
  );
  return (data.balance ?? 0) / 100;
}

export async function getBaseCurrencyCode(): Promise<string | null> {
  const now = Date.now();
  if (_currencyCache && _currencyCache.expiresAt > now) {
    return _currencyCache.code;
  }

  const data = await moskladFetch<{
    currency?: { isoCode?: string; name?: string; symbol?: string };
  }>("/context/companysettings");
  const code = data.currency?.isoCode || data.currency?.symbol || data.currency?.name || null;
  _currencyCache = { code, expiresAt: now + 10 * 60 * 1000 };
  return code;
}

export async function getUsdRate(): Promise<number | null> {
  const now = Date.now();
  if (_usdRateCache && _usdRateCache.expiresAt > now) return _usdRateCache.rate;

  const data = await moskladFetch<{
    rows: Array<{ isoCode: string; rate: number; multiplicity: number }>;
  }>("/entity/currency?limit=50");
  const usd = data.rows.find((c) => c.isoCode === "USD");
  let rate: number | null = null;
  if (usd && usd.rate > 0) {
    // rate = UZS per `multiplicity` units of USD → UZS per 1 USD
    rate = usd.rate / (usd.multiplicity || 1);
  } else {
    // USD not configured in MoySklad or rate=0 — try env fallback
    const envRate = parseFloat(process.env.FALLBACK_USD_RATE ?? "");
    if (!isNaN(envRate) && envRate > 0) rate = envRate;
  }
  _usdRateCache = { rate, expiresAt: now + 10 * 60 * 1000 };
  return rate;
}

// Shop orders are created in UZS (like manually created orders). Returns the UZS
// currency meta href plus the UZS-per-USD rate from the account's currency
// directory (manual rate, e.g. 1 USD = 12 070 UZS). Cached for 60 seconds so
// every new order picks up the current rate almost immediately.
let _uzsCurrencyCache: { href: string; uzsPerUsd: number; expiresAt: number } | null = null;

export async function getUzsCurrencyInfo(): Promise<{ href: string; uzsPerUsd: number } | null> {
  const now = Date.now();
  if (_uzsCurrencyCache && _uzsCurrencyCache.expiresAt > now) {
    return { href: _uzsCurrencyCache.href, uzsPerUsd: _uzsCurrencyCache.uzsPerUsd };
  }
  try {
    const data = await moskladFetch<{
      rows: Array<{ meta: { href: string }; isoCode?: string; name?: string; rate: number; multiplicity?: number }>;
    }>("/entity/currency?limit=50");
    const uzsRow = data.rows.find(
      (c) => (c.isoCode || "").toUpperCase() === "UZS" || (c.name || "").toLowerCase().includes("сум")
    );
    if (!uzsRow?.meta?.href || !uzsRow.rate || uzsRow.rate <= 0) return null;
    // The directory stores the rate either as UZS-per-USD (12 070, "обратный курс")
    // or as USD-per-UZS (0.0000828) — disambiguate by magnitude.
    const k = uzsRow.rate / (uzsRow.multiplicity || 1);
    const uzsPerUsd = k > 1 ? k : 1 / k;
    if (!isFinite(uzsPerUsd) || uzsPerUsd < 1000 || uzsPerUsd > 1000000) return null;
    _uzsCurrencyCache = { href: uzsRow.meta.href, uzsPerUsd, expiresAt: now + 60 * 1000 };
    return { href: uzsRow.meta.href, uzsPerUsd };
  } catch {
    return null;
  }
}

type SumRow = { sum?: number; rate?: { value?: number } };

function rowToUsd(row: SumRow, usdRate: number): number {
  return ((row.sum || 0) * (row.rate?.value ?? 1)) / 100 / usdRate;
}

function aggregateRows(rows: SumRow[], usdRate: number) {
  return { count: rows.length, usd: rows.reduce((s, r) => s + rowToUsd(r, usdRate), 0) };
}

export async function fetchReportSummary(startStr: string, endStr: string) {
  const filter = `moment>=${startStr};moment<=${endStr}`;
  const enc = encodeURIComponent(filter);

  const [usdRate, orderRows, demandRows, retailRows, payinRows, cashinRows, payoutRows, cashoutRows, supplyRows] =
    await Promise.all([
      getUsdRate(),
      fetchAllPages<SumRow>(`/entity/customerorder?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/demand?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/retaildemand?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/paymentin?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/cashin?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/paymentout?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/cashout?filter=${enc}`).catch(() => [] as SumRow[]),
      fetchAllPages<SumRow>(`/entity/supply?filter=${enc}`).catch(() => [] as SumRow[]),
    ]);

  const rate = usdRate ?? 1;
  return {
    orders:        aggregateRows(orderRows,   rate),
    demands:       aggregateRows(demandRows,  rate),
    retailDemands: aggregateRows(retailRows,  rate),
    paymentIn:     aggregateRows(payinRows,   rate),
    cashIn:        aggregateRows(cashinRows,  rate),
    paymentOut:    aggregateRows(payoutRows,  rate),
    cashOut:       aggregateRows(cashoutRows, rate),
    supply:        aggregateRows(supplyRows,  rate),
  };
}

async function getDefaultOrganizationId(): Promise<string | null> {
  const now = Date.now();
  if (_organizationCache && _organizationCache.expiresAt > now) {
    return _organizationCache.id;
  }

  const data = await moskladFetch<{ rows: Array<{ id: string }> }>("/entity/organization?limit=1");
  const id = data.rows?.[0]?.id || null;
  _organizationCache = { id, expiresAt: now + 10 * 60 * 1000 };
  return id;
}

async function getDefaultStoreId(): Promise<string | null> {
  const now = Date.now();
  if (_storeCache && _storeCache.expiresAt > now) {
    return _storeCache.id;
  }

  const data = await moskladFetch<{ rows: Array<{ id: string }> }>("/entity/store?limit=1");
  const id = data.rows?.[0]?.id || null;
  _storeCache = { id, expiresAt: now + 10 * 60 * 1000 };
  return id;
}

export async function listDemands(counterpartyId: string, offset = 0, limit = 10) {
  const data = await moskladFetch<{
    meta: { size: number };
    rows: Array<{
      id: string;
      name: string;
      moment: string;
      sum: number;
      state?: { name?: string };
    }>;
  }>(
    `/entity/demand?filter=agent=${encodeURIComponent(`${baseUrl}/entity/counterparty/${counterpartyId}`)}&order=moment,desc&limit=${limit}&offset=${offset}&expand=state`
  );

  return {
    rows: data.rows.map((row) => ({
      id: row.id,
      name: row.name,
      moment: row.moment,
      sum: row.sum / 100,
      state: row.state?.name || null
    })),
    total: data.meta?.size ?? 0
  };
}

export async function listCustomerOrders(counterpartyId: string, offset = 0, limit = 10) {
  const data = await moskladFetch<{
    meta: { size: number };
    rows: Array<{
      id: string;
      name: string;
      moment: string;
      sum: number;
      state?: { name?: string };
      attributes?: Array<{ name: string; value: string | number | boolean | null }>;
    }>;
  }>(
    `/entity/customerorder?filter=agent=${encodeURIComponent(`${baseUrl}/entity/counterparty/${counterpartyId}`)}&order=moment,desc&limit=${limit}&offset=${offset}&expand=state`
  );

  return {
    rows: data.rows.map((row) => ({
      id: row.id,
      name: row.name,
      moment: row.moment,
      sum: row.sum / 100,
      state: row.state?.name || null,
      driverInfo: extractDriverInfo(row.attributes || [])
    })),
    total: data.meta?.size ?? 0
  };
}

type OrderItem = { id: string; quantity: number; price?: number | null; currency?: string | null };
type DeliveryInfo = {
  deliveryMethod?: "pickup" | "delivery";
  orderNote?: string | null;
  addressText?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  addressExtra?: string | null;
};

export async function createCustomerOrder(
  counterpartyId: string,
  items: OrderItem[],
  deliveryInfo: DeliveryInfo = {}
) {
  const organizationId = process.env.MOSKLAD_ORGANIZATION_ID || (await getDefaultOrganizationId());
  if (!organizationId) {
    throw new Error("No organization found for order creation");
  }
  const storeId = process.env.MOSKLAD_STORE_ID || (await getDefaultStoreId());

  // Create the order in UZS (like manual orders): convert non-UZS sale prices
  // (usually USD) into UZS with the manual rate from the currency directory.
  // If the directory lookup fails, fall back to the old behavior (no rate).
  const uzs = await getUzsCurrencyInfo();
  const positions = items.map((item) => {
    let price = typeof item.price === "number" ? item.price : null;
    if (price !== null && uzs) {
      const cur = (item.currency || "USD").toUpperCase();
      const isUzs = cur === "UZS" || cur.includes("СУМ") || cur.includes("SO'M") || cur.includes("SOM");
      if (!isUzs) price = price * uzs.uzsPerUsd;
    }
    return {
      quantity: item.quantity,
      ...(price !== null ? { price: Math.round(price * 100) } : {}),
      assortment: {
        meta: {
          href: `${baseUrl}/entity/product/${item.id}`,
          type: "product",
          mediaType: "application/json"
        }
      }
    };
  });

  const trimmedNote = deliveryInfo.orderNote?.trim() || undefined;

  const orderBody: Record<string, unknown> = {
    ...(uzs
      ? {
          rate: {
            currency: {
              meta: {
                href: uzs.href,
                type: "currency",
                mediaType: "application/json"
              }
            }
          }
        }
      : {}),
    organization: {
      meta: {
        href: `${baseUrl}/entity/organization/${organizationId}`,
        type: "organization",
        mediaType: "application/json"
      }
    },
    ...(storeId
      ? {
          store: {
            meta: {
              href: `${baseUrl}/entity/store/${storeId}`,
              type: "store",
              mediaType: "application/json"
            }
          }
        }
      : {}),
    agent: {
      meta: {
        href: `${baseUrl}/entity/counterparty/${counterpartyId}`,
        type: "counterparty",
        mediaType: "application/json"
      }
    },
    positions,
    shipmentAddress: deliveryInfo.addressText || undefined,
    ...(trimmedNote ? { description: trimmedNote } : {})
  };

  const orderLocationAttr = process.env.MOSKLAD_ORDER_LOCATION_ATTR;
  const orderAddressAttr = process.env.MOSKLAD_ORDER_ADDRESS_ATTR;
  const orderAddressDetailsAttr = process.env.ORDER_ADDRESS_DETAILS;
  const deliveryMethodAttr = process.env.MOSKLAD_DELIVERY_METHOD_ATTR;
  const deliveryMethodPickup = process.env.MOSKLAD_DELIVERY_METHOD_PICKUP;
  const deliveryMethodDelivery = process.env.MOSKLAD_DELIVERY_METHOD_DELIVERY;
  const orderNoteAttr = process.env.MOSKLAD_ORDER_NOTE_ATTR;
  const orderAttributes: object[] = [];
  if (orderLocationAttr && deliveryInfo.locationLat && deliveryInfo.locationLng) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderLocationAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: formatYandexMapsLink(deliveryInfo.locationLat, deliveryInfo.locationLng)
    });
  }
  if (orderAddressAttr && deliveryInfo.addressText) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderAddressAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressText
    });
  }
  if (deliveryMethodAttr && deliveryInfo.deliveryMethod) {
    const optionId =
      deliveryInfo.deliveryMethod === "pickup" ? deliveryMethodPickup : deliveryMethodDelivery;
    if (optionId) {
      const href = buildCustomEntityHref(optionId);
      orderAttributes.push({
        meta: {
          href: `${baseUrl}/entity/customerorder/metadata/attributes/${deliveryMethodAttr}`,
          type: "attributemetadata",
          mediaType: "application/json"
        },
        value: {
          meta: {
            href,
            type: "customentity",
            mediaType: "application/json"
          }
        }
      });
    }
  }
  if (orderNoteAttr && trimmedNote) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderNoteAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: trimmedNote
    });
  }
  if (orderAddressDetailsAttr && deliveryInfo.addressExtra) {
    orderAttributes.push({
      meta: {
        href: `${baseUrl}/entity/customerorder/metadata/attributes/${orderAddressDetailsAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressExtra
    });
  }
  if (orderAttributes.length > 0) orderBody.attributes = orderAttributes;

  const data = await moskladFetch<{ id: string; name: string }>(`/entity/customerorder`, {
    method: "POST",
    body: orderBody
  });

  return data;
}

export async function createDemand(
  counterpartyId: string,
  items: OrderItem[],
  deliveryInfo: DeliveryInfo = {}
) {
  const organizationId = process.env.MOSKLAD_ORGANIZATION_ID || (await getDefaultOrganizationId());
  if (!organizationId) {
    throw new Error("No organization found for demand creation");
  }
  const storeId = process.env.MOSKLAD_STORE_ID || (await getDefaultStoreId());

  const positions = items.map((item) => ({
    quantity: item.quantity,
    ...(typeof item.price === "number" ? { price: Math.round(item.price * 100) } : {}),
    assortment: {
      meta: {
        href: `${baseUrl}/entity/product/${item.id}`,
        type: "product",
        mediaType: "application/json"
      }
    }
  }));

  const trimmedNote = deliveryInfo.orderNote?.trim() || undefined;

  const demandBody: Record<string, unknown> = {
    organization: {
      meta: {
        href: `${baseUrl}/entity/organization/${organizationId}`,
        type: "organization",
        mediaType: "application/json"
      }
    },
    ...(storeId
      ? {
          store: {
            meta: {
              href: `${baseUrl}/entity/store/${storeId}`,
              type: "store",
              mediaType: "application/json"
            }
          }
        }
      : {}),
    agent: {
      meta: {
        href: `${baseUrl}/entity/counterparty/${counterpartyId}`,
        type: "counterparty",
        mediaType: "application/json"
      }
    },
    positions,
    shipmentAddress: deliveryInfo.addressText || undefined,
    ...(trimmedNote ? { description: trimmedNote } : {})
  };

  const orderLocationAttr = process.env.MOSKLAD_ORDER_LOCATION_ATTR;
  const orderAddressAttr = process.env.MOSKLAD_ORDER_ADDRESS_ATTR;
  const orderAddressDetailsAttr = process.env.ORDER_ADDRESS_DETAILS;
  const deliveryMethodAttr = process.env.MOSKLAD_DELIVERY_METHOD_ATTR;
  const deliveryMethodPickup = process.env.MOSKLAD_DELIVERY_METHOD_PICKUP;
  const deliveryMethodDelivery = process.env.MOSKLAD_DELIVERY_METHOD_DELIVERY;
  const orderNoteAttr = process.env.MOSKLAD_ORDER_NOTE_ATTR;
  const demandAttributes: object[] = [];
  if (orderLocationAttr && deliveryInfo.locationLat && deliveryInfo.locationLng) {
    demandAttributes.push({
      meta: {
        href: `${baseUrl}/entity/demand/metadata/attributes/${orderLocationAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: formatYandexMapsLink(deliveryInfo.locationLat, deliveryInfo.locationLng)
    });
  }
  if (orderAddressAttr && deliveryInfo.addressText) {
    demandAttributes.push({
      meta: {
        href: `${baseUrl}/entity/demand/metadata/attributes/${orderAddressAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressText
    });
  }
  if (deliveryMethodAttr && deliveryInfo.deliveryMethod) {
    const optionId =
      deliveryInfo.deliveryMethod === "pickup" ? deliveryMethodPickup : deliveryMethodDelivery;
    if (optionId) {
      const href = buildCustomEntityHref(optionId);
      demandAttributes.push({
        meta: {
          href: `${baseUrl}/entity/demand/metadata/attributes/${deliveryMethodAttr}`,
          type: "attributemetadata",
          mediaType: "application/json"
        },
        value: {
          meta: {
            href,
            type: "customentity",
            mediaType: "application/json"
          }
        }
      });
    }
  }
  if (orderNoteAttr && trimmedNote) {
    demandAttributes.push({
      meta: {
        href: `${baseUrl}/entity/demand/metadata/attributes/${orderNoteAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: trimmedNote
    });
  }
  if (orderAddressDetailsAttr && deliveryInfo.addressExtra) {
    demandAttributes.push({
      meta: {
        href: `${baseUrl}/entity/demand/metadata/attributes/${orderAddressDetailsAttr}`,
        type: "attributemetadata",
        mediaType: "application/json"
      },
      value: deliveryInfo.addressExtra
    });
  }
  if (demandAttributes.length > 0) demandBody.attributes = demandAttributes;

  const data = await moskladFetch<{ id: string; name: string }>(`/entity/demand`, {
    method: "POST",
    body: demandBody
  });

  return data;
}

function formatYandexMapsLink(lat: number, lng: number) {
  return `https://yandex.ru/maps/?ll=${lng},${lat}&z=16&pt=${lng},${lat}`;
}

function buildCustomEntityHref(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("/entity/customentity/")) {
    return `${baseUrl}${trimmed}`;
  }
  if (trimmed.startsWith("entity/customentity/")) {
    return `${baseUrl}/${trimmed}`;
  }
  if (trimmed.startsWith("customentity/")) {
    return `${baseUrl}/entity/${trimmed}`;
  }
  if (trimmed.includes("/")) {
    return `${baseUrl}/entity/customentity/${trimmed}`;
  }
  return `${baseUrl}/entity/customentity/${trimmed}`;
}

export async function listCustomerShipments(counterpartyId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      id: string;
      name: string;
      moment: string;
      sum: number;
      state?: { name?: string };
      attributes?: Array<{ name: string; value: string | number | boolean | null }>;
    }>;
  }>(`/entity/demand?filter=agent=${encodeURIComponent(`${baseUrl}/entity/counterparty/${counterpartyId}`)}&order=moment,desc&limit=10`);

  return data.rows.map((row) => ({
    id: row.id,
    name: row.name,
    moment: row.moment,
    sum: row.sum / 100,
    state: row.state?.name || null,
    driverInfo: extractDriverInfo(row.attributes || [])
  }));
}

export async function listOrderDemands(orderId: string) {
  const rows = await fetchAllPages<{
    id: string;
    name: string;
    moment: string;
    sum: number;
    payedSum?: number;
    state?: { name?: string };
    attributes?: Array<{ name: string; value: string | number | boolean | null }>;
  }>(`/entity/customerorder/${orderId}/demands?expand=state`);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    moment: row.moment,
    sum: row.sum / 100,
    payedSum: typeof row.payedSum === "number" ? row.payedSum / 100 : null,
    state: row.state?.name || null,
    driverInfo: extractDriverInfo(row.attributes || [])
  }));
}

export async function getCustomerOrder(orderId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    applicable?: boolean;
    moment?: string;
    sum?: number;
    payedSum?: number;
    description?: string;
    shipmentAddress?: string;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string; phone?: string };
    attributes?: Array<{ id?: string; name: string; value: any; meta?: { href?: string } }>;
    demands?: Array<{ id: string; name: string; moment: string; sum: number; state?: { name?: string } }>;
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/customerorder/${orderId}?expand=state,demands,demands.state,agent,currency`);
}

export async function listCustomerOrderPositions(orderId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/customerorder/${orderId}/positions?expand=assortment&limit=100`);

  return data.rows.map((row) => ({
    assortmentId: extractIdFromHref(row.assortment?.meta?.href),
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

export async function fetchOrdersInRange(startStr: string, endStr: string) {
  const filter = `moment>=${startStr};moment<=${endStr}`;
  const data = await moskladFetch<{
    rows: Array<{ sum: number; currency?: { isoCode?: string } }>;
  }>(`/entity/customerorder?filter=${encodeURIComponent(filter)}&limit=1000&expand=currency`);
  return data.rows;
}

export async function fetchTopProductsInRange(startStr: string, endStr: string, limit = 5) {
  try {
    const data = await moskladFetch<{
      rows: Array<{
        assortment?: { name?: string };
        sellQuantity?: number;
      }>;
    }>(`/report/sales/byproduct?momentFrom=${encodeURIComponent(startStr)}&momentTo=${encodeURIComponent(endStr)}&limit=100`);
    return data.rows
      .sort((a, b) => (b.sellQuantity ?? 0) - (a.sellQuantity ?? 0))
      .slice(0, limit);
  } catch (err) {
    console.error('[mosklad] fetchTopProductsInRange error:', err);
    return [];
  }
}

export async function getDemand(demandId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    applicable?: boolean;
    moment?: string;
    sum?: number;
    payedSum?: number;
    shipmentAddress?: string;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string; phone?: string };
    customerOrder?: { meta?: { href?: string } };
    attributes?: Array<{ name: string; value: string | number | boolean | null }>;
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/demand/${demandId}?expand=state,agent,customerOrder,currency`);
}

export async function listDemandPositions(demandId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/demand/${demandId}/positions?expand=assortment&limit=100`);

  return data.rows.map((row) => ({
    assortmentId: extractIdFromHref(row.assortment?.meta?.href),
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

export async function getIncomingPayment(paymentId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/paymentin/${paymentId}?expand=agent,currency`);
}

export async function getCashIn(cashinId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/cashin/${cashinId}?expand=agent,currency`);
}

export async function getPaymentOut(paymentId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/paymentout/${paymentId}?expand=agent,currency`);
}

export async function getCashOut(cashoutId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    description?: string;
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/cashout/${cashoutId}?expand=agent,currency`);
}

export async function getSupply(supplyId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/supply/${supplyId}?expand=state,agent,currency`);
}

export async function listSupplyPositions(supplyId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/supply/${supplyId}/positions?expand=assortment`);
  return data.rows.map((row) => ({
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

export async function getSalesReturn(salesReturnId: string) {
  return moskladFetch<{
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    state?: { name?: string };
    agent?: { meta?: { href?: string }; name?: string };
    currency?: { isoCode?: string };
    rate?: { value?: number };
  }>(`/entity/salesreturn/${salesReturnId}?expand=state,agent,currency`);
}

export async function listSalesReturnPositions(salesReturnId: string) {
  const data = await moskladFetch<{
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string; meta?: { href?: string } };
    }>;
  }>(`/entity/salesreturn/${salesReturnId}/positions?expand=assortment`);
  return data.rows.map((row) => ({
    name: row.assortment?.name || "Item",
    quantity: row.quantity,
    price: typeof row.price === "number" ? row.price / 100 : null
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDriverInfo(attributes: Array<{ name: string; value: string | number | boolean | null }>) {
  const modelKeys = envList("MOSKLAD_DRIVER_MODEL_ATTRS");
  const numberKeys = envList("MOSKLAD_DRIVER_NUMBER_ATTRS");

  const findValue = (names: string[]) =>
    attributes.find((attr) => names.includes(attr.name))?.value?.toString() || null;

  const model = findValue(modelKeys);
  const number = findValue(numberKeys);

  if (!model && !number) return null;
  return { model, number };
}

function envList(name: string) {
  return (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function extractIdFromHref(href?: string) {
  if (!href) return null;
  const parts = href.split("/");
  const last = parts[parts.length - 1];
  return last ? last.split("?")[0] : null;
}

// ── User report: all document types in a date range ───────────────────────────

type ReportDocRow = {
  id: string;
  name: string;
  moment?: string;
  sum?: number;
  state?: { name?: string };
  description?: string;
  positions?: {
    rows: Array<{
      quantity: number;
      price?: number;
      assortment?: { name?: string };
    }>;
  };
};

export async function fetchCounterpartyDocumentsInRange(
  counterpartyId: string,
  startStr: string | null,
  endStr: string | null
): Promise<{
  orders: ReportDocRow[];
  demands: ReportDocRow[];
  paymentins: ReportDocRow[];
  cashins: ReportDocRow[];
  paymentouts: ReportDocRow[];
  cashouts: ReportDocRow[];
  supplies: ReportDocRow[];
  salesreturns: ReportDocRow[];
}> {
  const agentHref = `${baseUrl}/entity/counterparty/${counterpartyId}`;
  const parts = [`agent=${agentHref}`];
  if (startStr) parts.push(`moment>=${startStr}`);
  if (endStr) parts.push(`moment<=${endStr}`);
  const filterStr = parts.join(";");
  const qsWithPos = `filter=${encodeURIComponent(filterStr)}&expand=state,positions.assortment`;
  const qs = `filter=${encodeURIComponent(filterStr)}&expand=state`;

  const [orders, demands, paymentins, cashins, paymentouts, cashouts, supplies, salesreturns] = await Promise.all([
    fetchAllPages<ReportDocRow>(`/entity/customerorder?${qsWithPos}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/demand?${qsWithPos}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/paymentin?${qs}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/cashin?${qs}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/paymentout?${qs}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/cashout?${qs}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/supply?${qs}`).catch(() => [] as ReportDocRow[]),
    fetchAllPages<ReportDocRow>(`/entity/salesreturn?${qs}`).catch(() => [] as ReportDocRow[]),
  ]);

  return { orders, demands, paymentins, cashins, paymentouts, cashouts, supplies, salesreturns };
}
