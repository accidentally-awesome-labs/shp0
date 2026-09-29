# PR #91's two human-run steps

These scripts do the two steps that PR #91 (Stripe Accounts v2, ADR-0006) left to a person. Run them from a checkout of `main` at or after 096f6b8, after `pnpm install`.

## 1. Database: `01-stripe-payment-accounts.sql`

```sh
psql "$SHP0_PROD_DATABASE_URL" -X -f ops/stripe-accounts-v2/01-stripe-payment-accounts.sql
```

- **Connect as the owner of `stores`**, the role `PLATFORM_DATABASE_URL` uses (`cloud_admin`). The script refuses any other role, so the new sequence and function belong to the app's role.
- **It lists the saved accounts first**, and any rows the new rules would refuse:
  - an account id saved for two Stores;
  - an id that is not `acct_…`;
  - a status Stripe never reports.

  If any row is refused, it stops and changes nothing.
- **The change itself** is `applySchema`'s `stripe_payment_accounts` block, unchanged. It runs in one transaction with a 5 s lock timeout. The pager is off, and the result is listed only after COMMIT, so nothing waits on the terminal while the table is locked.
- **A second run changes nothing.**
- **Stores lose card payments until their account is read again.** This applies to Stores with `charges_enabled` today, since no read of Stripe set that flag. A read happens when an Admin opens the Store's Payments page, or when an account event arrives (step 2).

## 2. Stripe, test mode: `02-account-events-destination.mjs`

```sh
STRIPE_SECRET_KEY=sk_test_... node ops/stripe-accounts-v2/02-account-events-destination.mjs create https://<app host>
```

- **Test-mode keys only.** A live key is refused.
- **It creates one thin destination** at `https://<app host>/api/stripe/account-events`, for the route's 5 events. `events_from` is left at Stripe's default, `@self`.
- **It creates nothing** if a destination already points at that URL. It shows that destination instead, and exits 1, saying what to do, when that destination:
  - is not thin (its payload cannot be changed: delete it and run the script again);
  - has other events;
  - is disabled.
- **The signing secret goes to a new file**, `./stripe-account-events-secret` (mode 600; use `--secret-out <file>` to choose another, outside the repo). The file holds the secret only, with no newline. It is never printed. Stripe returns it only on create.

Then:

1. Set the file's contents as `STRIPE_ACCOUNT_EVENTS_SECRET` where the app runs. It must differ from `STRIPE_WEBHOOK_SECRET`. Delete the file.
2. Once the app has the secret, check it:

   ```sh
   node ops/stripe-accounts-v2/02-account-events-destination.mjs ping ed_...
   ```

   The app logs `ignored: event type not handled` for the ping when the secret is right. It answers 400 when the secret is wrong.

Until the app has the secret, the route answers 500 and Stripe retries the deliveries.

## Not verified against real Stripe or a real database

- Both scripts were tested only against a local Postgres 16 and a local stand-in for Stripe's API.
- Whether `@self` receives `v2.core.account` events for the platform's Accounts v2 accounts is one of #74's open questions.
