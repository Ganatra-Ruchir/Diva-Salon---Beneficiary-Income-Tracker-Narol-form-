# Connecting this form to MySQL

## What changed

3 files added, 1 file edited, in this repo:

| File | What it does |
|---|---|
| `api/submit.js` | **New.** Vercel serverless function. Receives the same JSON payload the form already builds and writes it into `clients`, `service_visits`, and one `income_transactions` row per beneficiary. |
| `package.json` | **New.** Declares the `mysql2` dependency `api/submit.js` needs. |
| `.env.example` | **New.** Documents the environment variable names the code expects. Not loaded automatically — it's just a reference for what to type into Vercel. |
| `index.html` | **Edited.** The submit handler now sends to the Google Sheet (unchanged) *and* to `/api/submit` at the same time, and reports if either one fails. |

Nothing about the Google Sheet / Apps Script flow was removed — it's a second write path, not a replacement, so nothing breaks if the database step ever has a problem.

## Before this will work: your MySQL server needs to be reachable from the internet

You confirmed the MySQL server in your screenshot is running locally (on your
laptop). **That's the one thing that has to change before any of this can
work** — a Vercel serverless function runs in Vercel's cloud, not on your
laptop, so it has no way to reach `localhost` on your machine. This isn't a
code problem, it's a networking fact: no code change can get around it.

You need the database itself moved to (or created on) a host that's reachable
over the internet — options, roughly cheapest/simplest to most involved:

- A managed MySQL hosting service (many offer a free or low-cost tier —
  search "managed MySQL hosting" for current options, since pricing and free
  tiers change often).
- A small VPS (DigitalOcean, Linode, Hetzner, etc.) with MySQL installed on it.
- If your organization already pays for any cloud provider (AWS, Google
  Cloud, Azure), their managed MySQL offering (RDS, Cloud SQL, etc.).

Once you have a reachable host:

1. Run `schema.sql` against it (same command as before, just pointed at the
   new host: `mysql -h <host> -u <user> -p < schema.sql`).
2. Create a MySQL user *specifically for this app* with access to only the
   `sashakt_beneficiary_db` database — don't reuse `root` for an
   internet-facing application. Something like:
   ```sql
   CREATE USER 'diva_salon_app'@'%' IDENTIFIED BY 'a-strong-generated-password';
   GRANT SELECT, INSERT, UPDATE ON sashakt_beneficiary_db.* TO 'diva_salon_app'@'%';
   FLUSH PRIVILEGES;
   ```
3. Make sure the host's firewall/security group allows inbound connections
   on port 3306 from Vercel (or, more safely, from "anywhere" combined with
   a strong password and SSL — Vercel's outbound IPs aren't fixed/listable).

## Setting it up in Vercel

1. In the Vercel dashboard, open this project → **Settings** → **Environment
   Variables**.
2. Add each variable from `.env.example` with your real values:
   `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
   `MYSQL_DATABASE` (and `MYSQL_SSL=true` if your host requires it).
3. Redeploy (Vercel → Deployments → ⋯ → Redeploy), so the function picks up
   the new variables.
4. Submit a test entry on the live form and check:
   - The Google Sheet got a new row (as before).
   - `SELECT * FROM service_visits ORDER BY visit_id DESC LIMIT 1;` and
     `SELECT * FROM income_transactions ORDER BY income_id DESC LIMIT 5;`
     on your MySQL database show the new entry.

## What happens with a beneficiary the database has never seen

Family profiling (the intake form) and salon income tracking are two
separate workflows, so it's normal for a beneficiary to show up at the salon
before their family record exists in the database, or with a Book No. that
doesn't exactly match. When that happens, `api/submit.js` doesn't reject the
entry or lose the income — it creates a lightweight placeholder
`families` + `family_members` row (tagged in `special_remarks` as
auto-created), so the payment is captured immediately. Periodically run:

```sql
SELECT family_id, family_code, special_remarks
FROM families
WHERE family_code LIKE 'PENDING-%';
```

...and reconcile those with real family records (update `family_id`
references, or merge/delete the placeholder once the real one is confirmed).

## Security note

Never commit real database credentials to this repository, especially since
it may become public. Vercel's environment variables (not `.env` files
checked into git) are the right place for them. If a real password was ever
typed into a chat, a commit, or a file, treat it as compromised and change
it.
