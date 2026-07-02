# shp0

A multi-tenant SaaS platform on which Merchants create and run their own online Stores, and Shoppers buy from them.

## Language

**Store**:
The boundary of a single merchant business on the platform — the scope of its products, orders, customers, branding, and billing. One Store is one tenant.
_Avoid_: tenant (use only in technical/infra contexts), shop, site, account

**Merchant**:
A person who manages one or more Stores. A Merchant's access to any given Store comes from holding a Membership there.
_Avoid_: vendor, seller, admin (that is a Role, not a person), account

**Membership**:
The association between a person and a single Store, granting them a Role within it. A person may hold many Memberships across many Stores; each is independent.
_Avoid_: store access, permission, team member

**Role**:
The level of authority a Merchant holds within a particular Store's Membership. Roles are ranked: Owner above Admin above Staff. A Role grants the capabilities of its own tier and every tier below it.
_Avoid_: permission level, user type

**Owner**:
The highest Role within a Store's Membership — exactly one per Store. Holds every capability, including the ones no other Role has: transfer ownership, manage platform billing, and manage Memberships. A Store always has exactly one Owner; the Owner cannot be removed, and cannot leave without first transferring ownership.
_Avoid_: primary admin, super admin

**Admin**:
The middle Role. Manages the Store's catalog, Orders, Customers, and Store settings (including payouts), but cannot transfer or delete the Store, change platform billing, or manage Memberships.
_Avoid_: manager, full access

**Staff**:
The lowest Role. May view the catalog, Orders, and Customers, and fulfill Orders; cannot change settings, money, or Memberships.
_Avoid_: employee, limited user, agent

**Customer**:
A person who buys from one Store. A Customer's account, cart, orders, and addresses belong to that single Store and exist only within it.
_Avoid_: shopper (informal only; use Customer in formal language), buyer, user (too generic), member (collides with Membership)

**Current Store**:
The single Store that a request is scoped to. It is resolved differently by surface: on the storefront it is derived from the request host; on the dashboard it is the Store the Merchant has selected, and only if they hold a Membership there.
_Avoid_: active store, current tenant, workspace

**Product**:
A sellable entity a Merchant creates in a Store — its title, description, images, and the option axes a shopper can choose from (e.g. Size, Color).
_Avoid_: item, listing, SKU (that is a Variant attribute)

**Variant**:
A specific, purchasable configuration of a Product — one concrete combination of options, with its own SKU, price, and inventory. Every Product has at least one Variant; a Product with no options has a single implicit Variant.
_Avoid_: option, variant option (that describes an axis/value, not the purchasable unit), product version

**Order**:
A Customer's intent to buy one or more Variants from a Store, carrying its totals and a delivery address. An Order's lifecycle runs along two independent axes — its payment status and its fulfillment status. An Order is open while either axis is non-terminal, and closed once both are terminal.
_Avoid_: purchase, transaction (that is a payment event, not the Order), basket

**Order Line**:
A single line within an Order, referencing one Variant at a quantity and a unit price. An Order has one or more Order Lines.
_Avoid_: line item, item (too generic)

**Cart**:
A Customer's ephemeral, pre-purchase selection of Variants and quantities for one Store. A Cart holds no money and reserves no inventory; it is lightweight storage only. A Cart is converted into an Order when checkout begins.
_Avoid_: basket, shopping bag, pending order (an Order is a separate thing)

**Payment status**:
Where an Order stands on the money axis — its own state machine (e.g. pending, paid, partially paid, refunded, partially refunded). Independent of fulfillment status.
_Avoid_: order status (that is the derived overall state)

**Fulfillment status**:
Where an Order stands on the delivery axis — its own state machine (e.g. unfulfilled, partially fulfilled, fulfilled). Independent of payment status.
_Avoid_: order status (that is the derived overall state)

**Money**:
An amount in a Store's currency. Internally it is represented as a signed integer count of that currency's smallest unit (its minor units), never as a floating-point number. A pure helper converts to and from minor units only at the edges (input parsing and display); all arithmetic is integer math.
_Avoid_: amount (too generic), price (a price is Money in a specific role), total (a role of Money within an Order)

**Currency**:
The unit of money a Store denominates in — an ISO 4217 code (e.g. USD) together with the number of decimal places that code defines. Each Store has exactly one Currency; all Money in that Store is expressed in that Currency's minor units.
_Avoid_: locale, money format

## Relationships

- A Merchant holds one or more Memberships.
- Each Membership belongs to exactly one Store and carries exactly one Role. A Store always has exactly one Owner, who cannot be removed and cannot leave without first transferring ownership; ownership transfer is atomic.
- A Store has many Customers; each Customer belongs to exactly one Store.
- A Customer and a Merchant are distinct identities. The same human may be a Merchant on one Store and a Customer on another, with no relationship between those two identities.
- Each Store is independently isolated and independently billed.
- Each request resolves to at most one Current Store. A storefront request derives it from the host; a dashboard request derives it from the Merchant's selection, authorized by a Membership.
- A Store has many Products. A Product has one or more Variants. A Variant is the single purchasable unit: anything that can be priced, stocked, added to a cart, or ordered is a Variant.
- A Customer places Orders in one Store. An Order has one or more Order Lines; each Order Line references one Variant at a quantity and unit price. An Order's overall state is derived from its payment status and fulfillment status, which progress independently.
- A Customer has one Cart per Store. A Cart holds no inventory and reserves nothing. Checkout converts a Cart into an Order; Variant inventory is decremented atomically inside the payment transaction.
- Each Store denominates in exactly one Currency. All Money in that Store (prices, totals, fees) is held and computed as integer minor units of that Currency; floating-point is used only to parse input or format display, never in arithmetic.

## Flagged ambiguities

- _Resolved_ — "customer" vs "merchant" identity: these are two separate identity domains. A Customer is scoped to a single Store; a Merchant manages Stores. The same person can hold both, as unrelated identities. (Recorded for a forthcoming ADR on the identity model.)
- _Resolved_ — how the Current Store is established per request: derived from host on the storefront; a Merchant's selection authorized by Membership on the dashboard. (Backed by ADR-0001's isolation model.)
- _Resolved_ — catalog shape: a Variant is mandatory; every Product has at least one Variant. A Variant is the single purchasable unit (price, inventory, cart line, order line all key off a Variant). A Product with no options has a single implicit Variant.
- _Resolved_ — Order lifecycle: an Order has two independent status dimensions, payment status and fulfillment status, each its own state machine. The overall order state (open vs closed) is derived. This replaces a single linear status and makes partial payment, partial fulfillment, and partial refund representable.
- _Resolved_ — Cart-to-Order boundary and inventory timing: a Cart is ephemeral and reserves no inventory; checkout creates an Order in payment: pending; Variant inventory is decremented atomically inside the payment transaction (row-locked), preventing oversell. Recorded in ADR-0002.
- _Resolved_ — Money representation: all Money is stored and computed as signed integer minor units of the Store's Currency; floating-point is used only to parse input or format display. Each Store has exactly one Currency. Recorded in ADR-0004.
- _Resolved_ — Roles and permissions: three ranked tiers — Owner, Admin, Staff — where each tier inherits the capabilities of the one below. Authorization is a rank comparison. A Store has exactly one Owner, who cannot be removed and cannot leave without an atomic ownership transfer.
