# Direct Demand-Based Selling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CustomerOrder-based selling with direct Demand creation — bot creates отгрузка directly on checkout, no delivery/address system.

**Architecture:** On checkout the webapp/bot calls a simplified endpoint that creates a Demand (отгрузка) directly in MoySklad. The Demand IS the sale. Webhooks still fire for demand updates and payments. Bot-created demands are tagged in cache to suppress the redundant webhook CREATE notification.

**Tech Stack:** Node.js + TypeScript, Fastify, Telegraf, Prisma/PostgreSQL, MoySklad API, pdfmake

---

## Chunk 1: Data + MoySklad Layer

### Task 1: Simplify DraftOrder schema

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Remove delivery fields from DraftOrder model**

In `backend/prisma/schema.prisma`, replace the DraftOrder model:

```prisma
model DraftOrder {
  id             String   @id @default(cuid())
  userId         String   @unique
  orderNote      String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  items          DraftOrderItem[]

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

(Remove `deliveryMethod`, `addressText`, `locationLat`, `locationLng` fields.)

- [ ] **Step 2: Generate and apply migration**

```bash
cd backend
npx prisma migrate dev --name remove_delivery_fields
```

Expected: Migration created and applied. Prisma client regenerated.

- [ ] **Step 3: Remove defaultAddress from User (also remove from User model)**

In `schema.prisma`, remove `defaultAddress String?` from the User model.

```bash
npx prisma migrate dev --name remove_default_address
```

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/
git commit -m "feat: remove delivery fields from DraftOrder and User schema"
```

---

### Task 2: Add createDemand() and listDemands() to mosklad.ts

**Files:**
- Modify: `backend/src/mosklad.ts`

- [ ] **Step 1: Add `createDemand()` after the balance section (around line 413)**

Add this function after `getBaseCurrencyCode()`:

```typescript
type DemandItem = { id: string; quantity: number; price?: number | null };

export async function createDemand(
  counterpartyId: string,
  items: DemandItem[],
  note?: string | null
) {
  const organizationId = process.env.MOSKLAD_ORGANIZATION_ID || (await getDefaultOrganizationId());
  if (!organizationId) throw new Error("No organization found for demand creation");
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

  const body: Record<string, unknown> = {
    organization: {
      meta: { href: `${baseUrl}/entity/organization/${organizationId}`, type: "organization", mediaType: "application/json" }
    },
    ...(storeId ? {
      store: { meta: { href: `${baseUrl}/entity/store/${storeId}`, type: "store", mediaType: "application/json" } }
    } : {}),
    agent: {
      meta: { href: `${baseUrl}/entity/counterparty/${counterpartyId}`, type: "counterparty", mediaType: "application/json" }
    },
    positions,
    ...(note?.trim() ? { description: note.trim() } : {})
  };

  return moskladFetch<{ id: string; name: string }>(`/entity/demand`, { method: "POST", body });
}
```

- [ ] **Step 2: Replace `listCustomerShipments()` with paginated `listDemands()`**

Find `listCustomerShipments` (around line 608) and replace the entire function with:

```typescript
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
```

- [ ] **Step 3: Remove `createCustomerOrder()`, delivery helpers, and dead code**

Delete the following from `mosklad.ts`:
- The entire `createCustomerOrder()` function (lines ~452-584)
- `formatYandexMapsLink()` helper (line ~586)
- `buildCustomEntityHref()` helper (line ~590)
- `updateCounterpartyAddress()` function (lines ~221-266)
- `listCustomerOrders()` function (lines ~414-440) — replaced by `listDemands()`
- `getCustomerOrder()` function (lines ~650-665)
- `listCustomerOrderPositions()` function (lines ~667-682)
- `listOrderDemands()` function (lines ~630-648)
- `fetchOrdersInRange()` function (lines ~684-690) — only used by reports
- `extractDriverInfo()` function (lines ~765-777)
- `envList()` function (lines ~779-781)
- The `DeliveryInfo` type (lines ~443-450)
- The `OrderItem` type alias (line ~442) — keep it as `DemandItem` added above

Also remove `updateCounterpartyAddress` from exports. Check if `fetchOrdersInRange` and `fetchTopProductsInRange` are used in `reports.ts` — if so, keep them.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd backend
npm run build 2>&1 | head -40
```

Expected: No errors (or only errors in files not yet updated).

- [ ] **Step 5: Commit**

```bash
git add backend/src/mosklad.ts
git commit -m "feat: add createDemand(), replace listCustomerShipments with paginated listDemands(), remove CustomerOrder functions"
```

---

## Chunk 2: PDF Layer

### Task 3: Simplify pdf.ts — remove remaining/delivery, rebrand to Comfort Textile

**Files:**
- Modify: `backend/src/pdf.ts`

- [ ] **Step 1: Remove `remainingQty` and `remainingSum` from `DemandPosition` type (line 64)**

Replace:
```typescript
export type DemandPosition = {
  name: string;
  quantity: number;
  price: number | null;
  remainingQty?: number | null;
  remainingSum?: number | null;
};
```
With:
```typescript
export type DemandPosition = {
  name: string;
  quantity: number;
  price: number | null;
};
```

- [ ] **Step 2: Remove `leftToPay` and `deliveryAddress` from `DemandPdfParams` (line 72)**

Replace the params type:
```typescript
export type DemandPdfParams = {
  demand: {
    id: string;
    name: string;
    moment?: string;
    sum?: number;
    state?: { name?: string };
  };
  positions: DemandPosition[];
  client: {
    firstName?: string | null;
    lastName?: string | null;
    phoneNumber?: string | null;
  };
  lang: string;
  currencyCode: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
};
```

- [ ] **Step 3: Remove remaining-related labels from `labels()` function**

In all three language blocks (ru, uzc, uz) remove these label keys:
- `colRemainingQty`
- `colRemainingSum`
- `remainingShort`
- `deliveryAddress`
- `leftToPay`
- `balanceBefore` (keep `balanceAfter` and `demandAmount`)

- [ ] **Step 4: Update `generateDemandPdf()` — remove remaining logic and delivery address**

In `generateDemandPdf()` (line 255):

a) Change destructuring — remove `leftToPay` and `deliveryAddress`:
```typescript
const { demand, positions, client, lang, currencyCode, balanceBefore, balanceAfter } = params;
```

b) Remove `hasRemaining` variable and all conditional blocks that use it.

c) Replace header content — change "TX Electronics" to "Comfort Textile" in both the logo and no-logo variants (lines 282, 306).

d) Update table widths — remove remaining columns. Change:
```typescript
widths: hasRemaining ? [22, "*", 48, 78, 78, 48, 78] : [22, "*", 52, 90, 90],
```
To:
```typescript
widths: [22, "*", 52, 90, 90],
```

e) Remove the `hasRemaining` spread from `headerRow`, `dataRows`, and `totalRow`.

f) In the balance section (the IIFE starting at line 440):
- Remove the `deliveryAddress` block entirely
- Remove the `leftToPay` block entirely
- Keep: `balanceBefore`, `demandAmount`, `balanceAfter` rows

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd backend
npm run build 2>&1 | head -40
```

Expected: No errors in pdf.ts.

- [ ] **Step 6: Commit**

```bash
git add backend/src/pdf.ts
git commit -m "feat: simplify PDF — remove remaining/delivery columns, rebrand to Comfort Textile"
```

---

### Task 4: Delete demand-pdf.ts

**Files:**
- Delete: `backend/src/demand-pdf.ts`

- [ ] **Step 1: Remove `demand-pdf.ts` import from all consumers before deleting**

Before deleting the file, confirm it is imported only in `bot.ts` (already updated in Task 5 Step 1 to remove the import) and `routes/api.ts` (already updated in Task 6 Step 1). If Tasks 5 and 6 have been run first, no consumers remain.

If running tasks in order, do Task 4 AFTER Tasks 5 and 6.

- [ ] **Step 2: Delete the file and verify build**

```bash
git rm backend/src/demand-pdf.ts
cd backend && npm run build 2>&1 | head -40
```

Expected: File deleted. Build shows no errors referencing `demand-pdf`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: remove demand-pdf.ts (no longer needed without parent CustomerOrder)"
```

---

## Chunk 3: Bot + API Layer

### Task 5: Update bot.ts

**Files:**
- Modify: `backend/src/bot.ts`

- [ ] **Step 1: Update imports at top of file**

Replace the import block (lines 1-20) with:
```typescript
import { Telegraf, Markup } from "telegraf";
import { prisma } from "./db.js";
import {
  createDemand,
  getCustomerBalance,
  getOrCreateCounterparty,
  listDemands,
  getDemand,
  listDemandPositions,
  getBaseCurrencyCode,
  findCounterpartyByPhone,
  updateCounterpartyAttrs,
  createCounterparty
} from "./mosklad.js";
import { generateDemandPdf, makePdfFilename } from "./pdf.js";
import { cache } from "./cache.js";
```

Note: `getDemand` (line 709) and `listDemandPositions` (line 724) already exist in `mosklad.ts` and are NOT removed in Task 2 — they are kept as-is.

(Removed: `createCustomerOrder`, `listCustomerOrders`, `getCustomerOrder`, `listCustomerOrderPositions`, `listOrderDemands`, `getCounterparty`, `updateCounterpartyAddress`, `buildDemandPdfData` import)

- [ ] **Step 2: Remove delivery middleware (lines 76-95)**

Delete the entire `bot.use` block that checks `draft?.deliveryMethod === "delivery" && !draft.addressText && !draft.locationLat`.

- [ ] **Step 3: Remove `delivery:(pickup|delivery)` action handler (lines 193-223)**

Delete the entire `bot.action(/delivery:(pickup|delivery)/, ...)` block.

- [ ] **Step 4: Remove `addr:useSaved` action handler (lines 226-261)**

Delete the entire `bot.action("addr:useSaved", ...)` block.

- [ ] **Step 5: Replace `order:(confirm|cancel)` handler**

Replace the entire `bot.action(/order:(confirm|cancel)/, ...)` block (lines 263-332) with:

```typescript
bot.action(/order:(confirm|cancel)/, async (ctx) => {
  if (!ctx.from) return;
  const lang = await getLanguage(ctx.from.id);
  const user = await getUser(ctx.from.id);
  if (!user?.phoneNumber) {
    await sendRegistrationPrompt(ctx, lang);
    return;
  }

  const action = ctx.match[1];
  try {
    await ctx.editMessageReplyMarkup(undefined as any);
  } catch {}

  if (action === "cancel") {
    await clearDraft(user.id);
    await ctx.answerCbQuery();
    await ctx.reply(t(lang, "orderCancelled"), mainMenu(lang, user.telegramId));
    return;
  }

  const draft = await getDraftOrder(user.id);
  if (!draft || !draft.items.length) {
    await ctx.reply(t(lang, "cartEmpty"));
    return;
  }

  let counterpartyId: string;
  try {
    counterpartyId = await getOrCreateCounterparty(
      user.telegramId,
      user.phoneNumber!,
      user.firstName || undefined,
      user.username || undefined
    );
  } catch (err: any) {
    if (err.message === "COUNTERPARTY_DELETED") {
      await ctx.answerCbQuery();
      await handleCounterpartyDeleted(ctx, lang);
      return;
    }
    throw err;
  }

  const demand = await createDemand(
    counterpartyId,
    draft.items.map((item) => ({ id: item.productId, quantity: item.quantity, price: item.price / 100 })),
    draft.orderNote || null
  );

  // Suppress webhook CREATE notification — user gets PDF here
  cache.set(`bot_demand:${demand.id}`, true, 60);

  await clearDraft(user.id);
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, "orderCreated"), mainMenu(lang, user.telegramId));

  // Send PDF receipt immediately
  try {
    const [positions, currencyCode, balance] = await Promise.all([
      listDemandPositions(demand.id).catch(() => []),
      getBaseCurrencyCode().catch(() => null),
      getCustomerBalance(counterpartyId).catch(() => null)
    ]);
    const pdfBuffer = await generateDemandPdf({
      demand,
      positions,
      client: { firstName: user.firstName, lastName: user.lastName, phoneNumber: user.phoneNumber },
      lang,
      currencyCode,
      balanceAfter: balance
    });
    await ctx.replyWithDocument({ source: pdfBuffer, filename: makePdfFilename(demand) });
  } catch (err) {
    console.error("PDF on checkout failed:", err);
  }
});
```

- [ ] **Step 6: Replace `order:detail` action handler to show demand details**

Replace the entire `bot.action(/order:detail:(.+)/, ...)` block (lines 334-417) with:

```typescript
bot.action(/order:detail:(.+)/, async (ctx) => {
  if (!ctx.from) return;
  const demandId = ctx.match[1];
  const lang = await getLanguage(ctx.from.id);
  await ctx.answerCbQuery();

  try {
    const [demand, positions, currencyCode] = await Promise.all([
      getDemand(demandId),
      listDemandPositions(demandId).catch(() => []),
      getBaseCurrencyCode().catch(() => null)
    ]);
    const labels = getOrderDetailLabels(lang);
    const date = demand.moment ? formatDate(demand.moment) : "";
    const sum = demand.sum ? formatMoneyWithCurrency(demand.sum / 100, currencyCode, lang) : "";
    const status = demand.state?.name ? mapOrderStatus(demand.state.name, lang) : "";

    const lines = [
      `📋 ${demand.name}`,
      date ? `📅 ${labels.date}: ${date}` : "",
      sum ? `💰 ${labels.total}: ${sum}` : "",
      status ? `📊 ${labels.status}: ${status}` : ""
    ].filter(Boolean);

    const sections: string[] = [lines.map(escapeHtml).join("\n")];
    if (positions.length) {
      sections.push(formatOrderItemsTable(positions, labels.items));
    }

    const pdfButton = Markup.inlineKeyboard([
      [Markup.button.callback("📄 PDF", `demand:pdf:${demandId}`)]
    ]);
    await ctx.reply(sections.join("\n\n"), { parse_mode: "HTML", reply_markup: pdfButton.reply_markup });
  } catch {
    await ctx.reply(t(lang, "noOrders"));
  }
});
```

- [ ] **Step 7: Remove `order:demands` action handler (lines 420-457)**

Delete the entire `bot.action(/order:demands:(.+)/, ...)` block. Demands are now the primary documents — no sub-document list needed.

- [ ] **Step 8: Simplify `demand:pdf` handler (lines 459-500)**

Replace the entire `bot.action(/demand:pdf:(.+)/, ...)` block with:

```typescript
bot.action(/demand:pdf:(.+)/, async (ctx) => {
  if (!ctx.from) return;
  const demandId = ctx.match[1];
  const lang = await getLanguage(ctx.from.id);
  await ctx.answerCbQuery(lang === "ru" ? "Формируется PDF…" : lang === "uzc" ? "PDF тайёрланмоқда…" : "PDF tayyorlanmoqda…");
  try {
    const user = await getUser(ctx.from.id);
    const [demand, positions, currencyCode] = await Promise.all([
      getDemand(demandId),
      listDemandPositions(demandId).catch(() => []),
      getBaseCurrencyCode().catch(() => null)
    ]);
    const demandSum = typeof demand.sum === "number" ? demand.sum / 100 : null;
    const balance = user?.moskladCounterpartyId
      ? await getCustomerBalance(user.moskladCounterpartyId).catch(() => null)
      : null;
    const pdfBuffer = await generateDemandPdf({
      demand: { ...demand, sum: demandSum ?? undefined },
      positions,
      client: {
        firstName: demand.agent?.name || user?.firstName,
        lastName: null,
        phoneNumber: user?.phoneNumber
      },
      lang,
      currencyCode,
      balanceAfter: balance
    });
    await ctx.replyWithDocument({ source: pdfBuffer, filename: makePdfFilename(demand) });
  } catch (err) {
    console.error("demand:pdf error:", err);
    await ctx.reply(lang === "ru" ? "⚠️ Не удалось создать PDF." : lang === "uzc" ? "⚠️ PDF тайёрлаб бўлмади." : "⚠️ PDF tayyorlab bo'lmadi.");
  }
});
```

- [ ] **Step 9: Update `handleOrders()` to use `listDemands()`**

Replace the body of `handleOrders()` (starting at line 895, the data-fetch part after the counterpartyId lookup):

Replace:
```typescript
const [ordersData, currencyCode] = await Promise.all([
  listCustomerOrders(counterpartyId, offset, ORDER_PAGE_SIZE),
  getBaseCurrencyCode().catch(() => null)
]);
const { rows: orders, total } = ordersData;
```
With:
```typescript
const [demandsData, currencyCode] = await Promise.all([
  listDemands(counterpartyId, offset, ORDER_PAGE_SIZE),
  getBaseCurrencyCode().catch(() => null)
]);
const { rows: orders, total } = demandsData;
```

Row shape compatibility: `listDemands` returns rows with `{ id, name, moment, sum, state }` — the exact same fields accessed by `handleOrders`'s rendering logic (`order.name`, `order.sum`, `order.moment`, `order.state`). The old `listCustomerOrders` returned the same shape. No other fields from the row are used in the rendering below.

- [ ] **Step 10: Remove `location` event handler (lines 650-673)**

Delete the entire `bot.on("location", ...)` block.

- [ ] **Step 11: Simplify `text` message handler (lines 675-729)**

Remove the delivery address capture block (lines 692-726):
```typescript
// DELETE this entire block:
const draft = await getDraftOrder(user.id);
if (draft?.deliveryMethod === "delivery" && !draft.addressText && !draft.locationLat) {
  // ... entire address capture block
  return;
}
```

The handler body becomes:
```typescript
bot.on("text", async (ctx) => {
  const textRaw = ctx.message.text?.trim() || "";
  if (textRaw.startsWith("/")) return;

  const lang = await getLanguage(ctx.from?.id);
  const user = await getUser(ctx.from?.id);

  if (!user?.phoneNumber) {
    await ctx.reply(t(lang, "shareContactHint"), sendRegistrationPromptInline(lang));
    return;
  }

  await ctx.reply(t(lang, "menuHint"), mainMenu(lang, user.telegramId));
});
```

- [ ] **Step 12: Remove dead delivery helpers**

Delete these functions from `bot.ts`:
- `askForAddressOrLocation()` (lines ~1055-1074)
- `askForDefaultAddress()` (lines ~1041-1053)
- `getCounterpartyLocation()` (lines ~1203-1216)
- `parseLatLng()` (lines ~1149-1189)
- `formatAddress()` (lines ~1191-1197)
- `formatGoogleMapsLink()` (lines ~1199-1201)
- `isSavedAddressChoice()` (lines ~1113-1117)
- `deliveryKeyboard()` (lines ~1140-1147)
- `extractDeliveryMethod()` (lines ~1463-1491)
- `extractOrderLocation()` (lines ~1508-1526)
- `formatDeliveryLabel()` (lines ~1493-1506)
- `mapCustomFieldLabel()` (lines ~1422-1442)
- `envList()` (lines ~1444-1446) — used only by mapCustomFieldLabel

Also remove `extractOrderNote()` if it was only used in `order:detail` (now replaced).

- [ ] **Step 13: Simplify `getOrderDetailLabels()` — remove delivery/address fields**

Remove `delivery`, `address`, `demandTitle` from all three language blocks in `getOrderDetailLabels()`. Keep: `date`, `total`, `status`, `note`, `items`, `paid`, `due`.

- [ ] **Step 14: Simplify `formatDraftSummary()`**

Remove the delivery method, address, and location lines from `formatDraftSummary()`:

```typescript
function formatDraftSummary(lang: string, draft: any, currencyCode: string | null = null) {
  const lines: string[] = [t(lang, "orderSummaryTitle")];
  let total = 0;

  for (const item of draft.items) {
    const lineTotal = (item.price / 100) * item.quantity;
    total += lineTotal;
    lines.push(`• ${item.name} ×${item.quantity} — ${formatMoneyWithCurrency(lineTotal, currencyCode, lang)}`);
  }

  lines.push(`\n💰 ${lang === "ru" ? "Итого" : lang === "uzc" ? "Жами" : "Jami"}: ${formatMoneyWithCurrency(total, currencyCode, lang)}`);
  if (draft.orderNote) {
    lines.push(`📝 ${lang === "ru" ? "Комментарий" : lang === "uzc" ? "Изоҳ" : "Izoh"}: ${draft.orderNote}`);
  }
  lines.push(`\n${t(lang, "confirmOrder")}`);
  return lines.join("\n");
}
```

- [ ] **Step 15: Remove delivery translation keys from `t()` function**

In all three language blocks (`uz`, `uzc`, `ru`) inside `t()`, remove these keys:
`chooseDelivery`, `pickup`, `delivery`, `sendAddress`, `sendAddressWithSaved`, `askDefaultAddress`, `useSaved`, `addressSaved`, `skipAddress`, `locationSaved`

- [ ] **Step 16: Verify TypeScript compiles**

```bash
cd backend
npm run build 2>&1 | head -60
```

Expected: No errors in bot.ts.

- [ ] **Step 17: Commit**

```bash
git add backend/src/bot.ts
git commit -m "feat: remove delivery flow from bot, checkout creates demand directly, order history shows demands"
```

---

### Task 6: Update routes/api.ts

**Files:**
- Modify: `backend/src/routes/api.ts`

- [ ] **Step 1: Update imports — add `createDemand`, `listDemands`, remove delivery-related**

Replace the import block at the top:
```typescript
import {
  listCategories,
  listProducts,
  listProductsByCategory,
  getProductsByIds,
  getOrCreateCounterparty,
  createDemand,
  fetchProductImages,
  getCustomerBalance,
  getBaseCurrencyCode,
  listDemands,
  getDemand,
  listDemandPositions,
  getIncomingPayment,
  getCashIn,
  getCounterparty
} from "../mosklad.js";
import { generateDemandPdf, makePdfFilename } from "../pdf.js";
import { createOrderReminders } from "../reminders.js";
import { cache } from "../cache.js";
```

(Removed: `getCustomerOrder`, `createCustomerOrder`, `listCustomerOrders`, `listCustomerOrderPositions`, `updateCounterpartyAddress`, `buildDemandPdfData` import)

- [ ] **Step 2: Simplify `/api/draft-order` endpoint**

Replace the entire `server.post("/api/draft-order", ...)` handler (lines 156-326) with:

```typescript
server.post("/api/draft-order", async (request, reply) => {
  const body = request.body as {
    telegramId: string;
    items: Array<{ id: string; quantity: number }>;
    language?: string;
    orderNote?: string | null;
  };

  const user = await prisma.user.upsert({
    where: { telegramId: body.telegramId },
    update: { language: body.language || undefined },
    create: {
      telegramId: body.telegramId,
      phoneNumber: null,
      language: body.language || "uz"
    }
  });

  if (!body.items?.length) {
    reply.code(400);
    return { error: "Cart is empty" };
  }

  const products = await getProductsByIds(body.items.map((item) => item.id));
  const productMap = new Map(products.map((product) => [product.id, product]));

  const items = body.items
    .map((item) => {
      const product = productMap.get(item.id);
      if (!product) return null;
      return {
        productId: product.id,
        name: product.name,
        price: Math.round(product.price * 100),
        quantity: Math.max(1, Math.round(item.quantity))
      };
    })
    .filter(Boolean) as Array<{ productId: string; name: string; price: number; quantity: number }>;

  if (!items.length) {
    reply.code(400);
    return { error: "No valid items" };
  }

  const orderNote = body.orderNote?.trim() || null;

  // Always save draft first (fallback if MoySklad call fails)
  const draft = await prisma.draftOrder.upsert({
    where: { userId: user.id },
    update: {
      orderNote,
      items: { deleteMany: {}, create: items }
    },
    create: {
      userId: user.id,
      orderNote,
      items: { create: items }
    },
    include: { items: true }
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { lastOrderAt: new Date() }
  });
  await createOrderReminders(user.id);

  // Create demand immediately if user is registered
  if (user.phoneNumber) {
    try {
      const counterpartyId = await getOrCreateCounterparty(
        user.telegramId,
        user.phoneNumber,
        user.firstName || undefined,
        user.username || undefined
      );
      const demand = await createDemand(
        counterpartyId,
        items.map((i) => ({ id: i.productId, quantity: i.quantity, price: i.price / 100 })),
        orderNote
      );

      // Suppress webhook CREATE — user gets notification via Telegram message below
      cache.set(`bot_demand:${demand.id}`, true, 60);

      await prisma.draftOrder.delete({ where: { userId: user.id } }).catch(() => {});

      const lang = user.language || "uz";
      const receivedMsg =
        lang === "ru" ? "📝 Заказ получен." :
        lang === "uzc" ? "📝 Буюртма қабул қилинди." :
        "📝 Buyurtma qabul qilindi.";
      await sendTelegramMessage(user.telegramId, receivedMsg);

      return { demandName: demand.name };
    } catch (err) {
      console.error("Failed to create demand on checkout:", err);
      return { draftId: draft.id };
    }
  }

  return { draftId: draft.id };
});
```

- [ ] **Step 3: Update `/api/user-info` endpoint — remove address fields**

In the `/api/user-info` handler:
- Delete `parseDefaultAddress()` helper function (lines 28-36) — used only for building address coords
- Remove the `defaultLat`, `defaultLng`, `defaultAddressText`, `defaultAddressExtra` fields from the response
- Remove the counterparty attribute lookups for `MOSKLAD_COUNTERPARTY_ADDRESS_ATTR` and `COUNTERPARTY_ADDRESS_DETAILS`
- Keep the `getCounterparty()` call — it is still needed to populate `counterpartyName` in the response

Simplified response (keep `counterparty` fetch, just don't extract address attrs):
```typescript
return {
  isRegistered: true,
  language: user.language || "uz",
  balance,
  balanceCurrency,
  firstName: user.firstName,
  phoneNumber: user.phoneNumber ?? null,
  counterpartyName: counterparty?.name ?? null
};
```

- [ ] **Step 4: Update webhook handler — suppress bot-created demand notifications**

In `routes/api.ts`, find `if (eventAction === "CREATE") {` inside the `entityType === "demand"` block (around line 417). Add these two lines as the FIRST thing inside that block, before `demandCreatedCounterparties.add(...)`:

```typescript
if (eventAction === "CREATE") {
  // Skip notification if this demand was created by the bot (user already notified at checkout)
  if (cache.get(`bot_demand:${demandId}`)) {
    cache.delete(`bot_demand:${demandId}`);
    continue;
  }

  demandCreatedCounterparties.add(counterpartyId);
  cache.set(`demand_created:${counterpartyId}`, true, 60);

  const msg = /* ... existing message building code stays here unchanged ... */
  // ... all existing CREATE handler code (message, PDF send, admin notify) continues unchanged
}
```

`cache.delete()` is confirmed to exist in `backend/src/cache.ts` (line 36).

- [ ] **Step 5: Remove `sendDeliveryAddressRequest` helper if it exists in api.ts**

Search for and delete any `sendDeliveryAddressRequest` function and its call.

- [ ] **Step 6: Remove `/api/orders` endpoint if it calls `listCustomerOrders`**

Search for `listCustomerOrders` usage in api.ts and update to use `listDemands`, or remove if unused.

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd backend
npm run build 2>&1 | head -60
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/api.ts
git commit -m "feat: simplify checkout endpoint to create demand directly, suppress webhook for bot-created demands"
```

---

## Chunk 4: Frontend + Branding

### Task 7: Update webapp — remove delivery method selection

**Files:**
- Modify: `webapp/src/App.tsx`

- [ ] **Step 1: Read current checkout flow in App.tsx**

Read `webapp/src/App.tsx` fully to understand exactly where delivery method selection lives before making changes.

- [ ] **Step 2: Remove delivery method selection UI**

Find and remove the delivery method selection step (pickup/delivery buttons). The checkout flow should be: cart → order note (optional) → confirm → submit.

- [ ] **Step 3: Update the draft-order API call — remove delivery fields**

Find where the webapp calls `POST /api/draft-order` and remove `deliveryMethod`, `locationLat`, `locationLng`, `addressDetails`, `addressExtra` from the request body.

- [ ] **Step 4: Remove address/location capture UI**

Remove any location sharing, GPS, or address input UI from the checkout flow.

- [ ] **Step 5: Remove delivery-related state variables**

Remove any state variables like `deliveryMethod`, `locationLat`, `locationLng`, `addressText`, `showLocationPicker` etc.

- [ ] **Step 6: Verify webapp builds**

```bash
cd webapp
npm run build 2>&1 | tail -20
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add webapp/src/App.tsx
git commit -m "feat: remove delivery method selection from webapp checkout"
```

---

### Task 8: Branding — replace TX Electronics with Comfort Textile

**Files:**
- Modify: `backend/src/pdf.ts` (already done in Task 3)
- Check: `backend/src/routes/api.ts`, `backend/src/bot.ts`, `webapp/src/App.tsx`, `README.md`

- [ ] **Step 1: Search for remaining TX Electronics references**

```bash
grep -r "TX Electronics" backend/src webapp/src --include="*.ts" --include="*.tsx" -l
```

- [ ] **Step 2: Replace any remaining occurrences with "Comfort Textile"**

For each file found, update "TX Electronics" → "Comfort Textile".

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: replace TX Electronics branding with Comfort Textile"
```

---

## Final Verification

- [ ] **Full build check**

```bash
cd backend && npm run build && cd ../webapp && npm run build
```

Expected: Both build cleanly.

- [ ] **Smoke test checklist (manual)**

1. Register a new user via bot → send phone
2. Open webapp → add items to cart → checkout → confirm
3. Verify demand is created in MoySklad
4. Verify user gets "Buyurtma qabul qilindi" + PDF in Telegram
5. Verify NO duplicate notification from webhook
6. Verify order history (`📦 Buyurtmalar`) shows the demand
7. Tap demand → shows detail + PDF button
8. Tap PDF button → PDF received

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat: complete direct demand-based selling implementation"
```
