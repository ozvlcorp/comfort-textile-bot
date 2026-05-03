# Design: Direct Demand-Based Selling

**Date:** 2026-03-11
**Project:** Comfort Textile Shopbot

## Context

Previously the bot created a CustomerOrder (заказ покупателя) and staff would then create a Demand (отгрузка) linked to it in MoySklad. Users want to skip the CustomerOrder layer entirely and use Demands as the primary selling document.

## Decision

The bot creates a **Demand directly** on checkout. The demand IS the sale. Payments, status updates, and other documents can be linked to the demand in MoySklad as normal. The delivery/pickup system, address capture, GPS, Yandex Maps, and driver tracking are all removed.

## What Changes

### Bot Flow
- Remove delivery method selection step (pickup/delivery)
- Remove address prompt and location sharing
- Remove saved address feature
- Checkout: confirm cart → create demand → done

### MoySklad Client (`mosklad.ts`)
- Add `createDemand(counterpartyId, items)` — creates отгрузка directly
- Remove `createCustomerOrder()`
- Remove all delivery/GPS/driver/address attribute handling
- `listCustomerOrders()` replaced by `listDemands(counterpartyId)` for order history
- `listOrderDemands()` removed (no parent order)

### PDF (`pdf.ts` + `demand-pdf.ts`)
- Remove "remaining" column (no parent order to compare against)
- Remove delivery address section
- Simple receipt: header, client info, items table (name / qty / price / total), balance summary
- Replace TX Electronics branding with Comfort Textile (logo placeholder)

### Order History
- Show list of demands, not CustomerOrders
- Call them "buyurtma / заказ / order" in all 3 languages — users never see "demand/отгрузка"

### WebApp (`App.tsx`)
- Remove delivery method selection from checkout
- Checkout flow: cart review → confirm → submit

### Database (`schema.prisma`)
- Remove from `DraftOrder`: `deliveryMethod`, `locationLat`, `locationLng`, `addressText`

### Webhooks (`api.ts`)
- Demand CREATE fired by bot: skip customer notification (customer already got confirmation at checkout)
- Demand UPDATE: still notify customer
- Payment CREATE (paymentin/cashin): still notify customer
- Counterparty DELETE: still handled

### Branding
- Replace all "TX Electronics" references with "Comfort Textile"
- Logo asset is a placeholder — will be replaced separately

## What Does NOT Change
- Registration flow (phone → counterparty lookup/create)
- Balance queries
- Payment notifications
- Admin panel and notification settings
- Reminders (adapt to demand-based — remind about unpaid demands)
- 3-language support (uz/uzc/ru)
- Webhook handling for updates and payments
