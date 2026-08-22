# Alice's Store POS

An iPad-friendly checkout and shop management app for Alice's Store Ltd.

## Signing in

Staff sign in with their four-digit PIN. Accounts are managed in-app under
**Admin > Staff** by any admin. There are no built-in or default PINs: every
person who can sign in is a real, configured team member stored in the database.

## Included

- Barcode scanner input and product search
- Large product and quick-item buttons
- Basket quantity controls and cash/card completion
- Product creation and editing, including unknown barcodes
- Catalogue backfill with Needs attention, Skipped and Completed queues
- Automatic stock reduction and low-stock warnings
- Daily sales, basket and estimated margin reporting
- Optional spoken high-contrast checkout mode per staff member
- Multi-device safe: sales and product edits are merged on the server, so
  several tablets can run the till at the same time

Card payments are taken on the shop's own card reader terminal, on the same
device as the till, so there is no switching between apps. Take the card
payment on the reader, then confirm the sale in this app.

## Run locally

Install Node.js 22 or later, then run:

```text
npm install
npm run dev
```

Open the local address shown in the terminal. In development the app stores its
data in `.local/store-state.json` so you can test safely without a database.

## Deploying to Netlify (production)

The production app uses a Netlify (Neon) Postgres database. Three things must be
in place before staff use it. Do them once, in this order:

1. **Database connection** - enable Netlify DB for the site so
   `NETLIFY_DATABASE_URL` is set. The `store_state` table is created
   automatically on first use, so no manual migration is needed.

2. **Session secret** - set an environment variable `ALICE_STORE_ACCESS_CODE`
   to a long random string in the Netlify dashboard (Site settings >
   Environment variables). Without it, staff can enter a PIN but every request
   afterwards is rejected and the till does nothing.

3. **Seed the catalogue and team** - the products, prices and staff accounts
   live only in your local `.local/store-state.json` until you load them into
   the production database. Run once, with the database URL available:

   ```text
   NETLIFY_DATABASE_URL="<your connection string>" npm run seed
   ```

   By default the seed will not overwrite keys that already exist in the
   database. To replace existing production data with your local copy, add
   `-- --overwrite`.

After that, deploy as normal. Because there are no default logins, at least one
active **Admin** must exist in the seeded team or nobody can sign in.
