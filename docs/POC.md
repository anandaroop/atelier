# Atelier — Proof of Concept

## Summary

Goal: prove the core serving mechanism — `<slug>.atelier.artsy.dev` resolving
to a folder in S3 — works end to end, before building auth or uploads. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full design this PoC is validating
(in particular §2 "Serving" and §4 "Caching").

**In scope:**
- A dedicated S3 bucket (`artsy-atelier`) with a `test/` prefix containing a
  static `index.html`.
- A **Cloudflare Worker** (not CloudFront — see the architecture doc's
  rationale) that maps `Host` → S3 key and fetches from S3 directly, with the
  same shape-based routing rules (asset / directory / SPA-fallback) and
  `Cache-Control`/`ETag` pass-through as the full design.
- DNS wired so `test.atelier.artsy.dev` actually resolves and serves.

**Explicitly out of scope (deferred to the roadmap below):**
- **Milestone 1 — Auth**: gate the zone with Cloudflare Access (existing
  Artsy seats/policy, same pattern as `unleash.artsy.net`). Until this lands,
  the PoC site is reachable by anyone with the URL — don't put anything
  sensitive in `test/`.
- **Milestone 2 — Uploads**: the Node upload app (Hokusai/k8s, Vault-delivered
  write credentials, overwrite/warn UX) per ARCHITECTURE.md §3.

The PoC's IAM credentials are a static, read-only, PoC-scoped key pair stored
as a Worker secret — **this is a throwaway shortcut for the PoC only** and
must not be reused once Milestone 2 introduces real (Vault-delivered) write
credentials.

## Prerequisites

- AWS CLI configured with credentials that can create S3 buckets and IAM
  users/policies.
- The `artsy.dev` zone already added to Cloudflare (or in progress — this is
  the longest-lead-time item; see ARCHITECTURE.md Risk #1). Everything below
  up through DNS assumes it's live.
- Node.js + npm (for `wrangler`, the Cloudflare Workers CLI — no global
  install needed, we use `npx`).
- A Cloudflare account with access to the `artsy.dev` zone, authenticated via
  `npx wrangler login`.

## Step 1 — S3 bucket + test content

```bash
BUCKET=artsy-atelier
REGION=us-east-1

# Create the bucket (us-east-1 needs no LocationConstraint; other regions do)
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# Block all public access — the Worker reads via signed requests, not public ACLs
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Create a minimal test site
mkdir -p /tmp/atelier-poc/test
cat > /tmp/atelier-poc/test/index.html <<'HTML'
<!doctype html>
<html>
  <head><title>Atelier PoC</title></head>
  <body>
    <h1>test.atelier.artsy.dev is live 🎉</h1>
    <p>Served straight from S3 via a Cloudflare Worker.</p>
  </body>
</html>
HTML

# Upload with the same Cache-Control the real upload app will use (ARCHITECTURE.md §4)
aws s3 cp /tmp/atelier-poc/test/index.html "s3://$BUCKET/test/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8"
```

## Step 2 — Scoped IAM credentials for the Worker

Least-privilege: read-only, this bucket only.

```bash
cat > /tmp/atelier-poc-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::artsy-atelier/*"
    }
  ]
}
JSON

aws iam create-user --user-name atelier-poc-worker

aws iam put-user-policy \
  --user-name atelier-poc-worker \
  --policy-name atelier-poc-read \
  --policy-document file:///tmp/atelier-poc-policy.json

# Prints AccessKeyId + SecretAccessKey — save these now, the secret is shown only once
aws iam create-access-key --user-name atelier-poc-worker
```

## Step 3 — Worker project

```bash
mkdir -p atelier-poc-worker/src
cd atelier-poc-worker
npm init -y
npm install aws4fetch
npm install -D wrangler
```

`atelier-poc-worker/wrangler.toml`:

```toml
name = "atelier-poc-worker"
main = "src/index.js"
compatibility_date = "2026-07-15"

[vars]
S3_BUCKET = "artsy-atelier"
S3_REGION = "us-east-1"

[[routes]]
pattern = "*.atelier.artsy.dev/*"
zone_name = "artsy.dev"
```

`atelier-poc-worker/src/index.js`:

```js
import { AwsClient } from "aws4fetch";

// Fallback map for common static-site extensions; S3 usually sets the
// right Content-Type already (aws s3 cp infers it), this just covers gaps.
const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  wasm: "application/wasm",
};

// Same shape-based routing as ARCHITECTURE.md §2: extension -> exact key,
// trailing slash -> directory index, otherwise -> SPA fallback to site root.
function resolveKey(slug, pathname) {
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
  if (hasExtension) return `${slug}${pathname}`;
  if (pathname.endsWith("/")) return `${slug}${pathname}index.html`;
  return `${slug}/index.html`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const slug = url.hostname.split(".")[0];
    const key = resolveKey(slug, url.pathname);

    const aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
      service: "s3",
    });

    const originUrl = `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
    const signedRequest = await aws.sign(originUrl, {
      method: "GET",
      headers: request.headers.get("if-none-match")
        ? { "if-none-match": request.headers.get("if-none-match") }
        : {},
    });

    const originResponse = await fetch(signedRequest);

    if (originResponse.status === 403 || originResponse.status === 404) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    const ext = key.split(".").pop();
    headers.set(
      "content-type",
      originResponse.headers.get("content-type") ||
        CONTENT_TYPES[ext] ||
        "application/octet-stream"
    );
    const cacheControl = originResponse.headers.get("cache-control");
    if (cacheControl) headers.set("cache-control", cacheControl);
    const etag = originResponse.headers.get("etag");
    if (etag) headers.set("etag", etag);

    return new Response(originResponse.body, {
      status: originResponse.status,
      headers,
    });
  },
};
```

## Step 4 — Secrets + deploy

```bash
npx wrangler login   # once, opens a browser to authorize against the artsy.dev account

npx wrangler secret put AWS_ACCESS_KEY_ID       # paste the value from Step 2
npx wrangler secret put AWS_SECRET_ACCESS_KEY   # paste the value from Step 2

npx wrangler deploy
```

`wrangler deploy` binds the Worker to the route pattern in `wrangler.toml`
(`*.atelier.artsy.dev/*`) — no separate dashboard step needed, as long as the
`artsy.dev` zone is already on the Cloudflare account.

## Step 5 — DNS

Workers routes intercept matching requests before they'd reach an origin, so
the wildcard record just needs to exist and be proxied (orange cloud) — its
target is never actually contacted. Cloudflare's convention for this is a
dummy address:

- Type: `A`
- Name: `*.atelier`
- Content: `192.0.2.1` (a reserved documentation-only address — a visible
  signal this record has no real origin)
- Proxy status: **Proxied**

Via the dashboard (DNS → Records → Add record), or via API/`flarectl` if you
prefer scripting it — ask if you want that form instead.

## Step 6 — Verify

```bash
curl -sI https://test.atelier.artsy.dev/ | grep -i "HTTP\|cache-control\|etag\|content-type"

curl -s https://test.atelier.artsy.dev/   # should print the test HTML

# Cache/revalidation check (ARCHITECTURE.md §4): re-request with the ETag
# from the first response and confirm a 304 with no body.
ETAG=$(curl -sI https://test.atelier.artsy.dev/ | grep -i etag | cut -d' ' -f2 | tr -d '\r')
curl -sI -H "If-None-Match: $ETAG" https://test.atelier.artsy.dev/ | head -1   # expect: HTTP/2 304
```

Also confirm SPA-fallback and directory-index routing work as designed:
- `https://test.atelier.artsy.dev/some/deep/route` (no extension, no trailing
  slash) → same `index.html` (SPA fallback).
- `https://test.atelier.artsy.dev/some/dir/` (trailing slash) → looks for
  `test/some/dir/index.html` (will 404 in this PoC since it doesn't exist —
  that's expected; upload a file there to test the positive case).

## Cleanup

Since this is throwaway, tear down when done to avoid orphaned billed
resources and a stale credential lying around:

```bash
npx wrangler delete                                   # removes the Worker + its route
aws s3 rm "s3://artsy-atelier/test/index.html"
aws s3api delete-bucket --bucket artsy-atelier --region us-east-1
aws iam delete-access-key --user-name atelier-poc-worker --access-key-id <the AccessKeyId from Step 2>
aws iam delete-user-policy --user-name atelier-poc-worker --policy-name atelier-poc-read
aws iam delete-user --user-name atelier-poc-worker
```

Remove the DNS record and Cloudflare secrets manually if you don't plan to
reuse this Worker for Milestone 1.

## Roadmap after this PoC

- **Milestone 1 — Auth**: add a Cloudflare Access application over
  `*.atelier.artsy.dev` (and `atelier.artsy.dev` once the upload app exists),
  policy = existing Artsy Google Workspace/IdP group — the same pattern
  already used for `unleash.artsy.net`. No code changes to the Worker needed;
  Access enforces before the request reaches it.
- **Milestone 2 — Uploads**: build the Node upload app per ARCHITECTURE.md
  §3, deployed via Hokusai to the existing kOps cluster (`draco`), with
  write credentials delivered via Vault rather than the static PoC key pair
  used here.
