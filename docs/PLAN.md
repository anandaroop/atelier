# Atelier — Milestone 1: Upload App (shape & architecture)

## Context

The serving path is proven: a zip's contents placed under `s3://artsy-atelier/<slug>/`
are served live at `https://<slug>.artsy.dev` via CloudFront + a viewer-request
Function (see [SETUP.md](SETUP.md)). But today the *only* way to get content
into S3 is hand-running `aws s3 cp`. This milestone builds the piece that makes
Atelier usable by non-technical people: a **web app where you drop a zip, pick a
slug, and the site goes live in seconds.**

Per the just-swapped milestone order in [POC.md](POC.md), **Uploads is now
Milestone 1** and **Auth (Cloudflare Access) is Milestone 2**. So this app ships
*without* auth for now — accepted, hardened in M2.

Confirmed decisions:
- **Stack:** Node + TypeScript + Express, transpiled to plain JS (`tsc` → `dist/`),
  deployed via Hokusai to Artsy k8s on AWS.
- **Sequencing:** local-first — get the full upload→serve loop working locally
  against the real `artsy-atelier` bucket + live CloudFront distribution, then
  do the Hokusai/k8s deploy as the final step.
- **AWS creds:** a scoped static IAM key now (env vars), swap to Vault/ESO in a
  later hardening pass.
- **Auth gap:** ship `/upload` open; document the CSRF/open-write risk; close it
  in M2 when Cloudflare Access lands.
- **UI:** minimal server-rendered vanilla HTML + JS (no frontend build).

Note: the POC landed on the flat **`<slug>.artsy.dev`** namespace (the nested
`*.atelier.artsy.dev` wildcard was abandoned — Cloudflare free SSL covers only
one wildcard level). The app therefore shares the `artsy.dev` namespace with any
other subdomain, which makes the **reserved-slug list** load-bearing (must
include the app's own hostname label + `www`/`api`/`upload` etc.).

**Upload app host = `atelier.artsy.dev`** (explicit DNS record → the app), and
`atelier` is a reserved slug. This is **forward-compatible** with solving the
nested-wildcard problem later: `atelier.artsy.dev` and `*.atelier.artsy.dev` are
distinct DNS names — a wildcard matches exactly one label to its left, so
`*.atelier.artsy.dev` never matches the bare `atelier.artsy.dev`. In that future
end state we keep `atelier.artsy.dev` for the app and move user sites to
`<slug>.atelier.artsy.dev` (restoring namespace isolation). TLS divides cleanly:
the bare app host stays on the free `*.artsy.dev` Universal cert, while
`*.atelier.artsy.dev` uses the Advanced Certificate Manager cert. Migration cost
is only that existing site URLs change `<slug>.artsy.dev` → `<slug>.atelier.artsy.dev`.
Nothing in the flat scheme blocks this.

## Repo layout

Follows the proposed layout in [ARCHITECTURE.md](ARCHITECTURE.md). This milestone
creates `app/`:

```
app/
  src/
    index.ts          # Express bootstrap, config load, route wiring, listen
    config.ts         # env parsing/validation (bucket, region, dist id, caps, domain)
    routes/
      check.ts        # GET /check?slug=
      upload.ts       # POST /upload  (multipart: slug + zip + confirm)
    lib/
      slug.ts         # validate + reserved-name check
      zip.ts          # streaming unzip + zip-slip / entry guards
      s3.ts           # list/delete-prefix, put-object, head-index (metadata)
      cloudfront.ts   # createInvalidation(/<slug>/*)
      mime.ts         # content-type resolution (mime-types wrapper)
  public/
    index.html        # drop-zone UI (slug field + dropzone)
    app.js            # vanilla client: /check + /upload via fetch, progress, warn
    styles.css
  package.json  tsconfig.json  .env.example  Dockerfile  .dockerignore
```

Package manager: **yarn** (Artsy convention). Node 20 LTS.

## App architecture

Single small Express service serving both the UI and the write API. No database —
uploader/time comes from S3 object metadata (per ARCHITECTURE.md §3).

### Endpoints

- **`GET /`** — serves `public/index.html` (static). Client JS talks to the two
  APIs below.
- **`GET /check?slug=<slug>`** — validate slug shape; `HEAD s3://<bucket>/<slug>/index.html`.
  Returns `{ exists, uploadedBy?, uploadedAt? }` read from `x-amz-meta-uploaded-by` /
  `x-amz-meta-uploaded-at`. Drives the "roop uploaded here 2 days ago — overwrite?"
  warning. 404 on the HEAD → `{ exists: false }`.
- **`POST /upload`** — multipart form: `slug`, `confirm` (bool), `zip` (file),
  optional `uploadedBy`. Steps:
  1. **Validate slug** — `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, lowercase,
     DNS-label-safe; reject reserved names. (`lib/slug.ts`)
  2. **Overwrite guard** — if `<slug>/` has objects and `confirm` is not set →
     `409` with the existing uploader/time so the UI can prompt. (`lib/s3.ts`)
  3. **Stream + validate zip** — parse entries streaming (`unzipper`); enforce a
     size cap (both total request size and uncompressed total, to resist zip
     bombs); reject any entry whose normalized path escapes the root (`..` /
     absolute) — **zip-slip guard**; skip directory entries & symlinks.
     (`lib/zip.ts`)
  4. **Replace, not merge** — delete all keys under `<slug>/`
     (ListObjectsV2 → DeleteObjects, batched 1000), then put each file to
     `<slug>/<path>` with correct `Content-Type` (`mime-types`) and
     `Cache-Control: no-cache`; stamp `x-amz-meta-uploaded-by` (Access email if
     the `Cf-Access-Authenticated-User-Email` header is present — future-proof —
     else the form value or `anonymous`) and `x-amz-meta-uploaded-at` (ISO).
     (`lib/s3.ts`, `lib/mime.ts`)
  5. **Invalidate** CloudFront path `/<slug>/*` (`lib/cloudfront.ts`) — the
     viewer-request Function rewrites host→`/<slug>/…`, so the cache key is
     prefixed by the slug and this invalidation is correct.
  6. Respond `{ ok, url: "https://<slug>.artsy.dev", fileCount }`.

### Key implementation details

- **Multipart handling:** `busboy` (or `multer` with disk temp storage) to obtain
  the zip as a stream / temp file without buffering the whole archive in memory,
  then feed `unzipper`. Enforce the byte cap during streaming, not after.
- **AWS SDK v3:** `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`. Credentials
  from the default provider chain (env vars locally, Vault-injected later).
- **Config (env):** `S3_BUCKET`, `S3_REGION` (`us-east-1`), `CLOUDFRONT_DISTRIBUTION_ID`,
  `PUBLIC_DOMAIN` (`artsy.dev`), `MAX_UPLOAD_BYTES`, `PORT`. Fail fast on missing
  required vars. `.env.example` documents them.
- **Reserved slugs:** central list in `lib/slug.ts` — at minimum `atelier`
  (the app's own label), `www`, `api`, `upload`, `admin`, `test` optional.
- **IAM policy (documented, applied out of band):** `s3:ListBucket` (scoped to
  `<slug>` prefixes) + `s3:GetObject`/`PutObject`/`DeleteObject` on
  `arn:aws:s3:::artsy-atelier/*`, plus `cloudfront:CreateInvalidation` on the
  distribution. Least-privilege, this bucket + this distribution only.
- **Build/run scripts:** `dev` (ts-node-dev / nodemon), `build` (`tsc`),
  `start` (`node dist/index.js`), `typecheck`, `lint`.

## Explicitly out of scope (this milestone)

- Cloudflare Access / any real auth → **Milestone 2**.
- CloudFront origin-lock (secret header) → M2, only matters once Access gates.
- CSRF token/Origin check → tracked, lands with M2 (open-write risk documented).
- Vault/ESO secret delivery → later hardening; static IAM key for now.
- Site delete / site listing / DynamoDB index → future (ARCHITECTURE.md notes).
- The ETag-through-Cloudflare open item (SETUP.md) — serving-layer issue, not
  this app.

## Task tracking

Tasks are tracked as issues in the [Atelier GitHub project](https://github.com/users/anandaroop/projects/7),
organized under epics **01 Uploads — app** and **02 Uploads — deploy**. That
project (not this file) is the source of truth for what's done and what's next.

## Verification (end-to-end)

Local, against the real bucket + live distribution (mirrors ARCHITECTURE.md
§Verification):
1. **Happy path:** `yarn dev`, open `/`, drop a small zip with `index.html` under
   slug `test-upload`; confirm objects land under `s3://artsy-atelier/test-upload/`
   with correct content-types, then `https://test-upload.artsy.dev/` renders.
2. **Overwrite = replace:** re-upload a zip missing a previously-present file;
   confirm the stale key is gone from S3 and 404s when requested.
3. **Warn-before-overwrite:** re-upload to an existing slug without confirm;
   confirm `/check` / the `409` surfaces the prior uploader + timestamp and the
   UI requires confirmation.
4. **Cache freshness:** change `index.html`, re-upload; confirm new content
   appears on normal reload (objects carry `Cache-Control: no-cache`; invalidation
   issued).
5. **Security:** upload a zip containing `../escape` (expect rejection) and an
   invalid slug `Bad_Slug` / a reserved slug (expect rejection).
6. **Unit tests:** `yarn test` covers slug validation, zip-slip, and size-cap
   paths.
