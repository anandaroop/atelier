# Atelier — Proof of Concept

## Summary

Goal: prove the core serving mechanism — `<slug>.atelier.artsy.dev` resolving
to a folder in S3 — works end to end, before building auth or uploads. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full design this PoC is validating
(in particular §2 "Serving" and §4 "Caching").

**In scope:**

- A dedicated S3 bucket (`artsy-atelier`) with a `test/` prefix containing a
  static `index.html`.
- A serving layer that maps `Host` → S3 key, with the same shape-based
  routing rules (asset / directory / SPA-fallback) and `Cache-Control`/`ETag`
  behavior as the full design. **Two implementations are documented below —
  build Option A unless you have a specific reason to reach for Option B:**
  - **Option A — CloudFront + CloudFront Function (preferred).** Matches the
    architecture already confirmed in ARCHITECTURE.md §2, keeps everything in
    AWS tooling the team already knows, and makes this PoC an honest dry run
    of the real production design.
  - **Option B — Cloudflare Worker (alternative).** Fewer AWS resources to
    stand up, but a CloudFront Function fundamentally can't do what a Worker
    does (it can only rewrite the request URI before CloudFront forwards to
    its configured origin, not fetch/sign a request itself) — so this path
    doesn't validate the CloudFront-based design and would mean adopting a
    second, divergent serving pattern. Kept here for comparison / in case
    that tradeoff ever flips.
- DNS wired so `test.atelier.artsy.dev` actually resolves and serves.

**Explicitly out of scope (deferred to the roadmap below):**

- **Milestone 1 — Uploads**: the Node upload app (Hokusai/k8s, Vault-delivered
  write credentials, overwrite/warn UX) per ARCHITECTURE.md §3.
- **Milestone 2 — Auth**: gate the zone with Cloudflare Access (existing
  Artsy seats/policy, same pattern as `unleash.artsy.net`). Until this lands,
  the PoC site is reachable by anyone with the URL — don't put anything
  sensitive in `test/`. This also means the **CloudFront origin-lock**
  hardening step from ARCHITECTURE.md (blocking the raw `*.cloudfront.net`
  URL from bypassing Access) is deferred too — it only matters once Access is
  actually gating something.

Note on credentials: **Option A needs no long-lived AWS credentials at all**
— CloudFront's Origin Access Control (OAC) authenticates to S3 using AWS's
own request signing, scoped to the specific distribution via a bucket policy
condition. **Option B does** need a static IAM key pair stored as a Worker
secret — a throwaway PoC-only shortcut, not to be reused once Milestone 2
introduces real (Vault-delivered) write credentials.

## Prerequisites

Shared:

- AWS CLI configured with credentials that can create S3 buckets (and, for
  Option A, CloudFront/ACM/IAM-policy resources; for Option B, IAM
  users/keys).
- The `artsy.dev` zone already added to Cloudflare (or in progress — this is
  the longest-lead-time item; see ARCHITECTURE.md Risk #1). Everything below
  up through DNS assumes it's live.

Option A only:

- `jq`, for pulling IDs/ARNs out of AWS CLI JSON output.

Option B only:

- Node.js + npm (for `wrangler`, the Cloudflare Workers CLI — no global
  install needed, we use `npx`).
- A Cloudflare account with access to the `artsy.dev` zone, authenticated via
  `npx wrangler login`.

## Step 1 — S3 bucket + test content (shared)

```bash
BUCKET=artsy-atelier
REGION=us-east-1

# Create the bucket (us-east-1 needs no LocationConstraint; other regions do)
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# Block all public access — content is only ever reached through the serving
# layer (CloudFront+OAC or the Worker), never directly
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
    <p>Served straight from S3 — no origin server in front of it.</p>
  </body>
</html>
HTML

# Upload with the same Cache-Control the real upload app will use (ARCHITECTURE.md §4)
aws s3 cp /tmp/atelier-poc/test/index.html "s3://$BUCKET/test/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8"
```

Both options below build on this bucket — pick one and follow it through.

---

## Option A — CloudFront + CloudFront Function (preferred)

### Step A2 — Origin Access Control (OAC)

```bash
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config \
    Name="atelier-poc-oac",SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query 'OriginAccessControl.Id' --output text)
echo "$OAC_ID"
```

### Step A3 — CloudFront Function (host → prefix routing)

Same shape-based routing as ARCHITECTURE.md §2 and the Worker below, written
for the CloudFront Functions runtime. Unlike a Worker, a CloudFront Function
only rewrites the _request_ — it can't fetch anything itself; CloudFront
takes the rewritten `uri` and forwards it to the S3 origin already configured
on the distribution (Step A4).

```bash
cat > /tmp/atelier-router.js <<'JS'
function handler(event) {
  var request = event.request;
  var slug = request.headers.host.value.split(".")[0];
  var uri = request.uri;

  var hasExtension = /\.[a-zA-Z0-9]+$/.test(uri);
  if (hasExtension) {
    request.uri = "/" + slug + uri;                  // asset — exact key
  } else if (uri.endsWith("/")) {
    request.uri = "/" + slug + uri + "index.html";    // directory index
  } else {
    request.uri = "/" + slug + "/index.html";         // SPA fallback
  }

  return request;
}
JS

aws cloudfront create-function \
  --name atelier-poc-router \
  --function-config Comment="Atelier PoC host-to-prefix router",Runtime=cloudfront-js-2.0 \
  --function-code fileb:///tmp/atelier-router.js

ETAG=$(aws cloudfront describe-function --name atelier-poc-router --stage DEVELOPMENT --query 'ETag' --output text)
aws cloudfront publish-function --name atelier-poc-router --if-match "$ETAG"

FUNCTION_ARN=$(aws cloudfront describe-function --name atelier-poc-router --stage LIVE \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
echo "$FUNCTION_ARN"
```

### Step A4 — ACM certificate (must be in us-east-1)

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.atelier.artsy.dev" \
  --validation-method DNS \
  --region us-east-1 \
  --query 'CertificateArn' --output text)
echo "$CERT_ARN"

# Get the CNAME validation record ACM needs
aws acm describe-certificate --certificate-arn "$CERT_ARN" --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add the returned `Name`/`Value` as a CNAME in Cloudflare DNS — **DNS-only
(grey cloud)**, since this is just a validation target, not something to
proxy. Then wait for issuance:

```bash
aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region us-east-1
```

### Step A5 — CloudFront distribution

```bash
cat > /tmp/atelier-distribution.json <<EOF
{
  "CallerReference": "atelier-poc-$(date +%s)",
  "Comment": "Atelier PoC",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "Aliases": { "Quantity": 1, "Items": ["*.atelier.artsy.dev"] },
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "atelier-s3",
        "DomainName": "$BUCKET.s3.$REGION.amazonaws.com",
        "OriginAccessControlId": "$OAC_ID",
        "S3OriginConfig": { "OriginAccessIdentity": "" }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "atelier-s3",
    "ViewerProtocolPolicy": "redirect-to-https",
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "Compress": true,
    "FunctionAssociations": {
      "Quantity": 1,
      "Items": [ { "EventType": "viewer-request", "FunctionARN": "$FUNCTION_ARN" } ]
    }
  },
  "CustomErrorResponses": {
    "Quantity": 1,
    "Items": [
      { "ErrorCode": 403, "ResponseCode": "404", "ResponsePagePath": "", "ErrorCachingMinTTL": 10 }
    ]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "$CERT_ARN",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  }
}
EOF

aws cloudfront create-distribution \
  --distribution-config file:///tmp/atelier-distribution.json \
  > /tmp/atelier-distribution-result.json

DIST_ID=$(jq -r '.Distribution.Id' /tmp/atelier-distribution-result.json)
DIST_ARN=$(jq -r '.Distribution.ARN' /tmp/atelier-distribution-result.json)
DIST_DOMAIN=$(jq -r '.Distribution.DomainName' /tmp/atelier-distribution-result.json)
echo "$DIST_ID $DIST_ARN $DIST_DOMAIN"
```

`CachePolicyId` `658327ea-f89d-4fab-a63d-7e88639e58f6` is AWS's managed
**CachingOptimized** policy — it respects `Cache-Control`/`ETag` from the
origin, which is what carries our no-cache-but-revalidate strategy (§4)
through to CloudFront's cache. The `403 → 404` custom error response covers a
known S3+OAC quirk: private buckets return 403 (not 404) for missing keys, to
avoid leaking which objects exist.

The distribution takes several minutes to deploy; poll with:

```bash
aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text
# proceed once this prints: Deployed
```

### Step A6 — S3 bucket policy (allow this distribution only)

```bash
cat > /tmp/atelier-bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$BUCKET/*",
      "Condition": { "StringEquals": { "AWS:SourceArn": "$DIST_ARN" } }
    }
  ]
}
EOF

aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/atelier-bucket-policy.json
```

No IAM user, no access keys — the policy's `AWS:SourceArn` condition scopes
read access to this exact distribution.

### Step A7 — DNS

- Type: `CNAME`
- Name: `*.atelier`
- Content: `$DIST_DOMAIN` (e.g. `d111111abcdef8.cloudfront.net`, from Step A5)
- Proxy status: **Proxied**

Also set the zone's SSL/TLS mode to **Full (strict)** in Cloudflare — the ACM
cert from Step A4 is publicly trusted, so strict validation works and gives
end-to-end encryption on both hops (visitor→Cloudflare, Cloudflare→CloudFront).

### Step A8 — Verify

```bash
curl -sI https://test.atelier.artsy.dev/ | grep -i "HTTP\|cache-control\|etag\|content-type"

curl -s https://test.atelier.artsy.dev/   # should print the test HTML

# Cache/revalidation check (ARCHITECTURE.md §4)
ETAG=$(curl -sI https://test.atelier.artsy.dev/ | grep -i etag | cut -d' ' -f2 | tr -d '\r')
curl -sI -H "If-None-Match: $ETAG" https://test.atelier.artsy.dev/ | head -1   # expect: HTTP/2 304
```

Also confirm SPA-fallback and directory-index routing:

- `https://test.atelier.artsy.dev/some/deep/route` (no extension, no trailing
  slash) → same `index.html` (SPA fallback).
- `https://test.atelier.artsy.dev/some/dir/` (trailing slash) → looks for
  `test/some/dir/index.html` (404 in this PoC since it doesn't exist yet —
  upload a file there to test the positive case).

### Cleanup

CloudFront requires disabling a distribution and waiting for it to redeploy
_before_ it can be deleted — budget ~15–20 minutes for teardown.

```bash
ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront get-distribution-config --id "$DIST_ID" \
  | jq '.DistributionConfig.Enabled = false | .DistributionConfig' \
  > /tmp/atelier-distribution-disabled.json
aws cloudfront update-distribution --id "$DIST_ID" \
  --distribution-config file:///tmp/atelier-distribution-disabled.json --if-match "$ETAG"

# Poll until Status: Deployed again, then:
FINAL_ETAG=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$FINAL_ETAG"

FUNC_ETAG=$(aws cloudfront describe-function --name atelier-poc-router --stage LIVE --query 'ETag' --output text)
aws cloudfront delete-function --name atelier-poc-router --if-match "$FUNC_ETAG"

aws cloudfront delete-origin-access-control --id "$OAC_ID"
aws acm delete-certificate --certificate-arn "$CERT_ARN" --region us-east-1
aws s3 rm "s3://$BUCKET/test/index.html"
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
```

Remove the DNS and ACM-validation CNAME records manually.

---

## Option B — Cloudflare Worker (alternative)

Kept for comparison; build this only if you'd rather avoid standing up
CloudFront/ACM/OAC, or want a from-scratch benchmark against Option A. It
does **not** exercise the CloudFront Function runtime, so it doesn't validate
that part of the production design.

### Step B1 — Scoped IAM credentials for the Worker

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

### Step B2 — Worker project

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
        "application/octet-stream",
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

### Step B3 — Secrets + deploy

```bash
npx wrangler login   # once, opens a browser to authorize against the artsy.dev account

npx wrangler secret put AWS_ACCESS_KEY_ID       # paste the value from Step B1
npx wrangler secret put AWS_SECRET_ACCESS_KEY   # paste the value from Step B1

npx wrangler deploy
```

`wrangler deploy` binds the Worker to the route pattern in `wrangler.toml`
(`*.atelier.artsy.dev/*`) — no separate dashboard step needed, as long as the
`artsy.dev` zone is already on the Cloudflare account.

### Step B4 — DNS

Workers routes intercept matching requests before they'd reach an origin, so
the wildcard record just needs to exist and be proxied (orange cloud) — its
target is never actually contacted. Cloudflare's convention for this is a
dummy address:

- Type: `A`
- Name: `*.atelier`
- Content: `192.0.2.1` (a reserved documentation-only address — a visible
  signal this record has no real origin)
- Proxy status: **Proxied**

### Step B5 — Verify

```bash
curl -sI https://test.atelier.artsy.dev/ | grep -i "HTTP\|cache-control\|etag\|content-type"

curl -s https://test.atelier.artsy.dev/   # should print the test HTML

ETAG=$(curl -sI https://test.atelier.artsy.dev/ | grep -i etag | cut -d' ' -f2 | tr -d '\r')
curl -sI -H "If-None-Match: $ETAG" https://test.atelier.artsy.dev/ | head -1   # expect: HTTP/2 304
```

### Cleanup

```bash
npx wrangler delete                                   # removes the Worker + its route
aws s3 rm "s3://artsy-atelier/test/index.html"
aws s3api delete-bucket --bucket artsy-atelier --region us-east-1
aws iam delete-access-key --user-name atelier-poc-worker --access-key-id <the AccessKeyId from Step B1>
aws iam delete-user-policy --user-name atelier-poc-worker --policy-name atelier-poc-read
aws iam delete-user --user-name atelier-poc-worker
```

Remove the DNS record and Cloudflare secrets manually if you don't plan to
reuse this Worker.

---

## Roadmap after this PoC

- **Milestone 1 — Uploads**: build the Node upload app per ARCHITECTURE.md
  §3, deployed via Hokusai to the existing kOps cluster (`draco`). Ships with
  a static, scoped IAM key rather than Vault-delivered credentials, and with
  `/upload` open (no auth yet) — both hardened in Milestone 2. See
  [PLAN.md](PLAN.md) for the detailed shape and task list.
- **Milestone 2 — Auth**: add a Cloudflare Access application over
  `*.atelier.artsy.dev` (and `atelier.artsy.dev`, now that the upload app
  exists), policy = existing Artsy Google Workspace/IdP group — the same
  pattern already used for `unleash.artsy.net`. No code changes needed
  either way; Access enforces before the request reaches CloudFront/the
  Worker. This is also when the CloudFront origin-lock hardening step
  becomes necessary if Option A was built, and when the static IAM key gets
  swapped for Vault-delivered credentials.
