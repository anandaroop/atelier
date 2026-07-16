# Atelier PoC — Setup

Concise, canonical path to stand the PoC up as it currently exists (serving
via `*.artsy.dev`, not the originally-planned `*.atelier.artsy.dev` — see
"Abandoned detour" below). Full raw log with exploratory dead-ends lives in
[STEPS.md](STEPS.md).

## Prerequisites

- `artsy.dev` delegated to Cloudflare nameservers (registrar-level change at
  GoDaddy). One-time, not PoC-specific — don't revert this in teardown.
- An AWS identity that can create S3/CloudFront/IAM-adjacent resources. Note:
  `acm:RequestCertificate` and Cloudflare's CSR access both required an
  elevated role (Jian, `InfrastructureAdmin`) — the default `Developer` role
  can't do either.

## Steps

1. **S3 bucket + test content** — bucket `artsy-atelier` (`us-east-1`),
   public access fully blocked, `test/index.html` uploaded with
   `Cache-Control: no-cache` and explicit `Content-Type`.

2. **CloudFront Origin Access Control (OAC)** — `atelier-poc-oac`, lets
   CloudFront read the private bucket via SigV4 request signing (no static
   credentials).

3. **CloudFront Function** — `atelier-poc-router`, `viewer-request` stage.
   Extracts the slug from the `Host` header and rewrites the URI to
   `/<slug>/...`, with asset / directory-index / SPA-fallback branches.
   Created, then published to `LIVE`.

4. **ACM certificate for `*.artsy.dev`** (`us-east-1`, DNS validation).
   Requires the elevated role — done via AWS Console. Validation CNAME added
   in Cloudflare DNS (**DNS only**, not proxied).

5. **CloudFront distribution** — S3 origin (via OAC), the router function
   attached on `viewer-request`, `CachingOptimized` managed cache policy,
   alias `*.artsy.dev`, the ACM cert from step 4. (A `403→404`
   `CustomErrorResponse` was attempted but dropped — AWS requires a real
   `ResponsePagePath` to pair with a `ResponseCode`, which we don't have;
   missing pages currently 403 rather than 404.)

6. **S3 bucket policy** — allows `cloudfront.amazonaws.com` to `GetObject`,
   scoped via `Condition.StringEquals["AWS:SourceArn"]` to this exact
   distribution's ARN.

7. **Cloudflare DNS + TLS** — `CNAME *` → the distribution's
   `*.cloudfront.net` domain, **Proxied**. Zone SSL/TLS mode set to
   **Full (strict)**.

8. **Verify** — `curl -sI https://test.artsy.dev/` returns `200` with the
   uploaded content, correct `content-type`/`cache-control`.

## Abandoned detour: nested `atelier` subdomain

Originally built against `*.atelier.artsy.dev` per [POC.md](POC.md) — same
steps as above, but with that alias and a cert scoped to it. TLS handshakes
failed: Cloudflare's free Universal SSL only covers one level of wildcard
(`*.artsy.dev`), not a wildcard-of-a-subdomain. Activating Cloudflare's
Advanced Certificate Manager ($10/mo) would fix this, but hit a second
permissions wall (no CSR access for our role) after paying for it. Pivoted to
bare `*.artsy.dev` instead, trading away the `atelier.` namespace isolation.

Leftover artifacts from this detour that teardown must also cover: an ACM
cert for `*.atelier.artsy.dev`, its DNS validation CNAME, and the (now
orphaned) `*.atelier` DNS CNAME.

## Known open item

`ETag` header is present at S3 and at CloudFront directly, but missing by the
time Cloudflare proxies the response to the viewer. Root cause unidentified —
see STEPS.md's "Open items" section. Not a correctness issue (`no-cache`
still guarantees freshness), just loses the `304`-revalidation savings from
ARCHITECTURE.md §4.
