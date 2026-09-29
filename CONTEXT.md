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
The middle Role. Manages the Store's catalog, Orders, Customers, and Store settings (including connecting the Store's Stripe account), but cannot transfer or delete the Store, change platform billing, or manage Memberships.
_Avoid_: manager, full access

**Staff**:
The lowest Role. May view the catalog, Orders, and Customers, and fulfill Orders; cannot change settings, money, or Memberships.
_Avoid_: employee, limited user, agent

**Operator**:
A person who runs the platform itself rather than a Store. An Operator can see every Store and suspend, reinstate, or terminate any of them from the platform admin (`/admin`). Being an Operator is not a Role and comes from no Membership: it is granted to a Merchant account by listing its user id in the `SHP0_OPERATOR_USER_IDS` environment variable (comma-separated better-auth user ids, never emails). With the variable unset or empty there are no Operators and the platform admin is locked (fail closed).
_Avoid_: admin (that is a Role), super admin, platform owner

**Customer**:
A person who buys from one Store. A Customer's account, cart, orders, and addresses belong to that single Store and exist only within it.
_Avoid_: shopper (informal only; use Customer in formal language), buyer, user (too generic), member (collides with Membership)

**Current Store**:
The single Store that a request is scoped to. It is resolved differently by surface: on the storefront it is derived from the request host; on the dashboard it is the Store the Merchant has selected, and only if they hold a Membership there.
_Avoid_: active store, current tenant, workspace

**Subdomain**:
A Store's default address on the platform, of the form `<name>.shp0.dev`. It is assigned at Store creation and served immediately with no setup.
_Avoid_: default url, storefront url

**Custom Domain**:
A domain the Merchant owns and points at their Store instead of (or in addition to) the Subdomain. A Custom Domain is only served after the Merchant proves control of it via DNS, and it is re-verified periodically; a Custom Domain that fails re-verification stops being served.
_Avoid_: custom url, vanity domain, branded domain

**Product**:
A sellable entity a Merchant creates in a Store — its title, description, images, and the option axes a shopper can choose from (e.g. Size, Color).
_Avoid_: item, listing, SKU (that is a Variant attribute)

**Variant**:
A specific, purchasable configuration of a Product — one concrete combination of options, with its own SKU, price, and inventory. Every Product has at least one Variant; a Product with no options has a single implicit Variant.
_Avoid_: option, variant option (that describes an axis/value, not the purchasable unit), product version

**Collection**:
A named grouping of Products within a Store, used to organize the storefront (e.g. "Summer", "On Sale"). A Collection is one of two types: a Manual Collection, whose members are added and removed explicitly by the Merchant; or an Automated Collection, whose members are derived from rules (e.g. a tag or a price range) and update automatically as the catalog changes.
_Avoid_: category (overloaded), group, folder

**Order**:
A Customer's intent to buy one or more Variants from a Store, carrying its totals and a delivery address. An Order's lifecycle runs along two independent axes — its payment status and its fulfillment status. An Order is open while either axis is non-terminal, and closed once both are terminal.
_Avoid_: purchase, transaction (that is a payment event, not the Order), basket
**Order Line**:
A single line within an Order, referencing one Variant at a quantity and a unit price. An Order has one or more Order Lines.
_Avoid_: line item, item (too generic)

**Cart**:
A Customer's ephemeral, pre-purchase selection of Variants and quantities for one Store. A Cart holds no money and reserves no inventory; it is lightweight storage only. A Cart is converted into an Order when checkout begins.
_Avoid_: basket, shopping bag, pending order (an Order is a separate thing)

**Discount**:
A reduction applied to an Order, defined by a Trigger, a Reward, and Conditions. Multiple Discounts may stack on one Order, under a fixed precedence with a never-negative floor.
_Avoid_: coupon (that is a code-based Trigger, not the whole Discount), deal, offer, promotion (informal; a Discount with an automatic Trigger is still just a Discount)

**Trigger**:
The event that makes a Discount apply — either a code the shopper enters at checkout, or an automatic condition (e.g. a minimum spend, a quantity of a Product, or always-on).
_Avoid_: discount type

**Reward**:
The reduction a Discount grants. One of: an amount off (fixed or percent) applied to the Order, specific Order Lines, or shipping; a free item, which adds an Order Line at unit price 0 and decrements that Variant's inventory like any other line; or free shipping, which zeroes the shipping cost.
_Avoid_: discount value

**Conditions**:
The constraints on a Discount's applicability — validity window, usage limit, minimum spend, eligible Products or Collections.
_Avoid_: rules (too generic)

**Tier**:
A named plan level a Store subscribes to, defining a monthly price and a set of included Usage limits (e.g. Free, Pro, Scale).
_Avoid_: plan (use Tier for the level; Subscription for the Store's choice of it), package, level

**Subscription**:
A Store's active choice of Tier — the recurring monthly relationship that sets its price and included Usage limits.
_Avoid_: plan, membership (collides with Merchant Membership)

**Commission**:
A percentage of a paid Order taken by the platform as its fee. shp0 takes no Commission (0%) on Orders from a Store's own traffic — its storefront, its API, and AI agents acting for its Customers — on every Tier, and adds no platform fee to a Store's payments (ADR-0007). A fee on demand shp0 itself creates is undecided.
_Avoid_: transaction fee, platform cut, take rate

**Usage**:
A Store's measured consumption against its Tier's included limits — counts of Products, Orders over a period, bandwidth, and staff seats. Exceeding a limit incurs an overage rather than blocking the Store, except on the Free Tier, where the limit is a hard cap.
_Avoid_: quota, consumption, meter

**Payment status**:
Where an Order stands on the money axis — its own state machine (e.g. pending, paid, partially paid, refunded, partially refunded). Independent of fulfillment status.
_Avoid_: order status (that is the derived overall state)

**Stripe account**:
The Store's own Stripe account, owned by the Merchant's business, on which every Payment and refund for the Store's Orders is made (direct charges; the Store, not shp0, is the merchant of record). A Store has at most one Stripe account and a Stripe account serves one Store. The Store can take Payments only while Stripe reports the account able to accept card payments.
_Avoid_: Connect account, payout account, merchant account

**Payment**:
One Customer payment for an Order, made through Stripe on the Store's Stripe account and identified by its Stripe PaymentIntent. An Order is paid by exactly one Payment. Any other Payment for it, and any Payment shp0 cannot honour (for example, the stock ran out before it arrived), is refunded in full automatically (ADR-0006).
_Avoid_: transaction, charge (a Stripe object within a Payment)

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

- A Merchant holds one or more Memberships, at most one in any one Store.
- Each Membership belongs to exactly one Store and carries exactly one Role. A Store always has exactly one Owner, who cannot be removed and cannot leave without first transferring ownership; ownership transfer is atomic.
- A Store has many Customers; each Customer belongs to exactly one Store.
- A Customer and a Merchant are distinct identities. The same human may be a Merchant on one Store and a Customer on another, with no relationship between those two identities.
- Each Store is independently isolated and independently billed.
- An Operator acts across all Stores without holding a Membership in any of them. Operator access is granted per Merchant user id by configuration and is never inferred from a Role.
- Each request resolves to at most one Current Store. A storefront request derives it from the host; a dashboard request derives it from the Merchant's selection, authorized by a Membership.
- A Store is addressable by its Subdomain by default, and may have zero or more Custom Domains. A Custom Domain is served only after DNS-proven ownership and is re-verified periodically; a failing Custom Domain stops being served, and the host-to-store cache is invalidated whenever a domain is added, removed, or fails verification.
- A Store has many Products. A Product has one or more Variants. A Variant is the single purchasable unit: anything that can be priced, stocked, added to a cart, or ordered is a Variant.
- A Store has many Collections. Each Collection groups Products and is either Manual (explicit members) or Automated (members derived from rules).
- A Customer places Orders in one Store. An Order has one or more Order Lines; each Order Line references one Variant at a quantity and unit price. An Order's overall state is derived from its payment status and fulfillment status, which progress independently.
- A Customer has one Cart per Store. A Cart holds no inventory and reserves nothing. Checkout converts a Cart into an Order; Variant inventory is decremented atomically inside the payment transaction.
- A Cart line is a Variant of a published Product of the Cart's own Store, at a whole quantity from 1 to 99 (`MAX_LINE_QUANTITY`, a storefront limit, not a stock level). Checkout re-checks every line against the live catalog and refuses the whole Cart if any line is invalid; it never drops a line silently.
- Each Store denominates in exactly one Currency. All Money in that Store (prices, totals, fees) is held and computed as integer minor units of that Currency; floating-point is used only to parse input or format display, never in arithmetic.
- A Store defines Discounts. Each Discount is a Trigger plus a Reward plus Conditions. Multiple Discounts may stack on one Order under a fixed precedence (line-level before order-level before shipping; percent before fixed; never below zero), and the merchant sees a previewed outcome rather than choosing the combination order. A free-item Reward adds an Order Line at unit price 0 and decrements that Variant's inventory like any other line.
- A Store holds one Subscription to a Tier at a time. The Tier sets a monthly price and included Usage limits. shp0 takes no Commission on Orders from the Store's own traffic (ADR-0007). Exceeding a Usage limit incurs an overage rather than blocking the Store, except on the Free Tier, where the limit is a hard cap.
- A Store has at most one Stripe account, and Customers pay for its Orders on that account (direct charges); shp0 never holds a Customer's money. An Order is paid by exactly one Payment. A Payment for an Order that is already paid, that no longer matches the Order, or for stock that ran out before it arrived is refunded in full automatically, and in the last case the Order stays payment: pending (ADR-0002, ADR-0006).

## Flagged ambiguities

- _Resolved_ — "customer" vs "merchant" identity: these are two separate identity domains. A Customer is scoped to a single Store; a Merchant manages Stores. The same person can hold both, as unrelated identities. (Recorded for a forthcoming ADR on the identity model.)
- _Resolved_ — how the Current Store is established per request: derived from host on the storefront; a Merchant's selection authorized by Membership on the dashboard. (Backed by ADR-0001's isolation model.)
- _Resolved_ — catalog shape: a Variant is mandatory; every Product has at least one Variant. A Variant is the single purchasable unit (price, inventory, cart line, order line all key off a Variant). A Product with no options has a single implicit Variant.
- _Resolved_ — Order lifecycle: an Order has two independent status dimensions, payment status and fulfillment status, each its own state machine. The overall order state (open vs closed) is derived. This replaces a single linear status and makes partial payment, partial fulfillment, and partial refund representable.
- _Resolved_ — Cart-to-Order boundary and inventory timing: a Cart is ephemeral and reserves no inventory; checkout creates an Order in payment: pending; Variant inventory is decremented atomically inside the payment transaction (row-locked), preventing oversell. Recorded in ADR-0002.
- _Resolved_ — Money representation: all Money is stored and computed as signed integer minor units of the Store's Currency; floating-point is used only to parse input or format display. Each Store has exactly one Currency. Recorded in ADR-0004.
- _Resolved_ — Roles and permissions: three ranked tiers — Owner, Admin, Staff — where each tier inherits the capabilities of the one below. Authorization is a rank comparison. A Store has exactly one Owner, who cannot be removed and cannot leave without an atomic ownership transfer.
- _Resolved_ — Collection model: a Collection groups Products and is one of two types — Manual (explicit membership) or Automated (membership derived from rules such as tag or price range).
- _Resolved_ — Discounts and promotions: a Discount is a unified, declarative Trigger + Reward + Conditions entity (so a code-based and an automatic/BOGO discount are the same concept, not two). Discounts stack from day one under a fixed precedence (line → order → shipping; percent before fixed; never-negative floor) shown via a merchant preview, not configurable ordering. Reward types include amount off (order/line/shipping), free item (an Order Line at unit price 0 that decrements inventory), and free shipping. Percentage reductions round half-up on minor units. Usage limits are enforced under a row-lock at redemption.
- _Resolved_ — Custom Domain verification: a Custom Domain is served only after DNS-proven ownership (CNAME for subdomains, TXT/ALIAS for apex), and is re-verified periodically; a domain that fails re-verification stops being served. Vercel is orchestrated for serving and TLS. Recorded in ADR-0005.
- _Implemented, pending decision #73_ — Operator access (Issue #52, as proposed in decision #73; mark it _Resolved_ once #73 is accepted): Operators are an allowlist of Merchant user ids in `SHP0_OPERATOR_USER_IDS` (comma-separated; whitespace and empty entries ignored), never emails, because Merchant emails are not verified and an email allowlist would make whoever signs up with that address first an Operator. Unset, empty, or separators only means nobody is an Operator and the platform admin is locked (fail closed); there is no wildcard. Every Operator server action checks this itself, and CI checks that they do (`scripts/ci/operator-guard.mjs`). A signed-out visitor to `/admin` is sent to sign in; a signed-in non-Operator gets a not-found page.
- _Implemented, pending owner decision_ — Dashboard authorization by Role (no decision issue exists yet; mark it _Resolved_ once the owner accepts or changes each **Pending** choice below): each dashboard capability has a minimum Role and a Merchant may use it when their Role ranks at or above it (`packages/db/src/roles.ts`). Staff: view the catalog (Products, Collections and their members, the Discounts list), Customers and a Customer's Orders, view and fulfill Orders. Admin: manage the catalog, create and preview Discounts, Store settings including the Store's Stripe account and Custom Domains. Owner: change platform billing, Memberships, transfer or delete the Store. Role text other than exactly `owner`, `admin` or `staff` grants nothing. A dashboard action refuses a non-member, a missing Store and a too-low Role with the same "Not authorized for this store"; a dashboard page shows a non-member the not-found page, and a member whose Role is too low a message naming the Role required, without the data. CI checks that every action and page makes the check (`scripts/ci/action-guard.mjs`). **Pending** (choices this document did not settle): (1) viewing platform billing (Tier, Usage) is Owner-only; this document reserves only _managing_ billing to the Owner; (2) _moot_: the database refuses a second Membership for one person in one Store (`memberships_user_store_key`) and any role text other than exactly `owner`, `admin` or `staff` (`memberships_role_check`), so several rows or invalid role text cannot be stored; the read still fails closed on them as defense in depth (several rows: the lowest Role counts; any invalid row: no access); (3) opening a Store's dashboard home at all (`store.view`) takes any Role, Staff included.
- _Resolved_ — Platform billing: a Store holds one Subscription to a Tier at a time. Tiers define a monthly price and included Usage limits (products, orders, bandwidth, staff seats). Usage overages are charged (not blocking) except on the Free Tier, which hard-caps.
- _Resolved_ — Commission: 0% on Orders from a Store's own traffic, on every Tier, with no platform fee on a Store's payments (decision #70, accepted 2026-09-28). This replaces a Tier-set Commission collected as the Stripe Connect application fee. A fee on demand shp0 itself creates is undecided. Recorded in ADR-0007.
- _Provisional, test mode only (decision #74, final 2026-10-26)_ — Charge model: direct charges on the Store's own, Merchant-owned Stripe account (Accounts v2 with the full Stripe Dashboard; Stripe collects fees and carries losses). shp0 is not the merchant of record and holds no Customer money. A payment taken for stock that ran out is refunded in full automatically and the Order stays payment: pending (owner, 2026-09-28). Recorded in ADR-0006.
