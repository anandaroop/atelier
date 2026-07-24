# Atelier — Architecture & Stack

> [!NOTE]
>
> This is a verbose Claude-managed document meant more for agent consumption
> than for humans.
>
> The bird's eye view of the architecture is described more succinctly in
> the project README.

## Context

Atelier is a new internal Artsy service for dead-simple hosting of static
sites (typically LLM/agent-produced HTML/CSS/JS). A user drags a `.zip` onto a
page, supplies a slug, and the site goes live at `<slug>.artsy.dev`
within seconds. Access to _everything_ — the uploader and every hosted site —
is gated to verified Artsy users; once in, anyone may overwrite any slug after
confirming intent.

This document fixes the v1 architecture and stack — the target design we build
toward. Decisions below reflect the original sketch (now archived at
[docs/hackathon-poc/initial-sketch-now-obsolete.png](hackathon-poc/initial-sketch-now-obsolete.png),
superseded by the tldraw diagram in the [README](../README.md)) plus these
confirmed choices: **Cloudflare Access** for auth, **CloudFront + S3**
(serverless serving, no pass-through server) for delivery, **Node on the
existing Kubernetes cluster via Hokusai** for the upload app, the dedicated
**`artsy.dev`** domain (isolated from `artsy.net` production cookies), and
**SPA + MPA** support in v1.

**Decided: flat `*.artsy.dev` for hosted sites, not the nested
`*.atelier.artsy.dev` originally sketched below.** The nested wildcard hit a
Cloudflare free-tier TLS limit during the PoC (Cloudflare's free Universal SSL
covers only one wildcard level) and was replaced with the flat `*.artsy.dev` —
see [docs/hackathon-poc/3-SETUP.md](hackathon-poc/3-SETUP.md) ("Abandoned
detour"). **Confirmed 2026-07-20: this is the permanent design, not a
stopgap** — there is no plan to revisit the nested scheme. The diagram, DNS
records, and CloudFront alternate domain name below are written for the flat
scheme: `atelier.artsy.dev` (the app) and every `<slug>.artsy.dev` (a hosted
site) are both single-level subdomains of the one `artsy.dev` zone.

## Architecture

```
 verified user
   │  (SSO via Cloudflare Access — one policy over the whole zone)
   ▼
 Cloudflare (DNS proxied, wildcard TLS, Access JWT)
   ├── atelier.artsy.dev            → origin: Node upload app (k8s via Hokusai)
   └── *.artsy.dev                  → origin: CloudFront distribution
                                            │ CloudFront Function: Host → S3 prefix
                                            ▼
                                        S3  artsy-atelier  (private, OAC)
                                          braze-dash/  price-game/  …
   Node upload app  ── writes (delete-then-put under slug/) ──►  S3
```

### 1. Auth & DNS — Cloudflare Access

**Status (2026-07-24):** Cloudflare Access is live and gates every
`*.artsy.dev` subdomain (#52). The app-side piece below — reading and
validating the JWT/email header — is not yet implemented; the upload app still
treats any client-supplied uploader identity as unverified provenance, not
authentication.

- Cloudflare Access is **already in production at Artsy** (e.g.
  `unleash.artsy.net`), so this reuses a proven pattern and existing IdP wiring
  rather than introducing anything new.
- One Cloudflare Access application covering **both** `atelier.artsy.dev` and
  `*.artsy.dev`, policy = Artsy Google Workspace / IdP group. A single
  Access JWT cookie is shared across the zone, so uploader and hosted sites are
  gated uniformly.
- The Node upload app reads the authenticated user's email from the
  `Cf-Access-Authenticated-User-Email` header (validate the accompanying
  `Cf-Access-Jwt-Assertion` against Cloudflare's public keys). No separate
  login for the app.
- Cloudflare provides wildcard TLS for `*.artsy.dev` automatically (free
  Universal SSL, since it's a single wildcard level).
- DNS records (proxied / orange-cloud):
  - `atelier.artsy.dev` → the Node upload app origin.
  - `*.artsy.dev` → the CloudFront distribution domain.
  - `www.artsy.dev`, `upload.artsy.dev` → redirect to `atelier.artsy.dev`
    (Cloudflare Redirect Rule, not a proxied origin) — see risk #1.

### 2. Serving — CloudFront + S3, no server

- **Single CloudFront distribution** with alternate domain name
  `*.artsy.dev` and a wildcard ACM cert (must be in **us-east-1** for
  CloudFront).
- **CloudFront Function** (viewer-request) does the host→prefix mapping and
  routing. It routes by URL _shape_ (a viewer function has no network/async, so
  it cannot check whether an S3 key exists — shape is enough for both site
  types):
  - read the `Host` header, take the leftmost label as `slug`;
  - path has a **file extension** (`.js`, `.css`, `.png`, `.html`) → serve the
    exact key `slug<path>` (assets — works for SPA and MPA);
  - path **ends in `/`** → append `index.html` (`slug<path>index.html`) — MPA
    directory index;
  - otherwise (no extension, no trailing slash — a client-side route) → serve
    the site root `slug/index.html` (**SPA fallback**).
- This serves SPAs fully and MPAs that use `.html` files or trailing-slash
  directory URLs. The only unsupported pattern is an MPA with "clean URLs"
  (`/about` expecting `about/index.html`); if that's ever needed, upgrade this
  one function to a Lambda@Edge origin-request handler that does a real S3
  existence check before falling back.
- **Origin = S3 via Origin Access Control (OAC)**; the bucket stays fully
  private (no public access, no S3 website hosting). CloudFront is the only
  reader.

### 3. Upload app — Node

A single small Node service (Fastify or Express) that serves the UI and
processes uploads. **Recommended host: the existing Artsy Kubernetes cluster
via Hokusai, behind the shared nginx ingress** — it reuses infra and a deploy
paradigm the team already operates, needs no new load balancer, and adds only
fractional node capacity (see Cost & hosting). Hokusai is kubectl/Docker-based,
and the cluster is **kOps-managed on EC2** (confirmed): deploy to the prod
cluster `kubernetes-production-draco.artsy.systems` in us-east-1 — same region
as S3/CloudFront. Because there's no EKS OIDC provider, **IRSA is not the path
here**; instead give the pod a dedicated IAM policy scoped to write the
`artsy-atelier` bucket only and deliver its credentials the way other Artsy
apps do — via **Fortress**, the init-container secrets pattern (confirmed as
the actual v1 mechanism, registered under project `atelier` for
`production`/`staging` — see the `setenv` init container in
`hokusai/production.yml`/`staging.yml` — not a placeholder for a later swap).
App Runner and Lambda are viable alternatives with different
cost/ops trade-offs (see Cost & hosting).

Endpoints:

- `GET /` — drop-zone UI: a slug text field + a zip drop zone.
- `GET /check?slug=<slug>` — returns whether the prefix already has content
  and, if so, **who last uploaded and when**, so the UI can show
  "User roop uploaded a site to `mydash` 2 days ago. Overwrite?" (drives the
  warn-before-overwrite UX).
- `POST /upload` — multipart (slug + zip). Steps:
  1. **Validate slug**: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`, lowercase,
     DNS-label-safe; reject reserved names (`upload`, `www`, `api`, etc.).
  2. **Validate zip**: confirm it is a real zip, enforce a size cap, and reject
     any entry with `..` or an absolute path (**zip-slip** guard). Optionally
     require a top-level `index.html` (or auto-strip a single wrapping folder).
  3. **Overwrite = replace, not merge**: if the `slug/` prefix has objects and
     the request isn't confirmed, return a warning for the UI to confirm. On
     confirm, **delete all existing keys under `slug/`**, then upload.
  4. **Upload** each file to `slug/<path>` with a correct `Content-Type`
     (derive via the `mime-types` package) and `Cache-Control` (see Caching).
     Stamp each object with S3 user metadata `x-amz-meta-uploaded-by`
     (the Access email) and `x-amz-meta-uploaded-at` (ISO timestamp). Use a
     streaming unzip lib (`unzipper`) rather than loading the whole archive
     into memory.
  5. **Invalidate** the CloudFront path for the slug (`/slug/*`) so the edge
     drops any cached copies of the previous version.

**Tracking the last uploader (no database).** The warn step reads uploader +
timestamp straight from S3 object metadata via a `HEAD` on the slug's
`index.html` (set in step 4). This keeps v1 DB-free. If we later want a
queryable list of all sites/uploaders, a tiny DynamoDB table `atelier-sites`
(key = slug) is the clean upgrade — not needed for v1.

Because the browser POSTs the multipart directly to a container, there is no
API-Gateway/Lambda payload cap to worry about.

### 4. Caching — freshness without a build step

Users iterate on a design with repeated uploads to the same slug, so stale
assets are the main hazard — but we want to avoid asset fingerprinting and any
build step. Strategy:

- **Upload every object with `Cache-Control: no-cache`.** This does _not_ mean
  "don't cache" — it means CloudFront and the browser may store the object but
  **must revalidate** before reuse. Revalidation uses S3's `ETag`: unchanged
  assets return a tiny `304 Not Modified`, and after an overwrite the ETag
  changes so the next request pulls fresh bytes. Freshness is automatic, with
  no filename hashing.
- **Invalidate `/slug/*` on each overwrite** (step 5 above) as belt-and-
  suspenders, so the edge never even serves a stale revalidation candidate.
  CloudFront allows 1000 free invalidation paths/month and a wildcard counts as
  one path — ample for internal fiddling.
- The only cost is a conditional round-trip per asset; for internal, low-
  traffic dashboards that is a non-issue and well worth avoiding a build
  pipeline. If a specific site ever wants long-lived caching, it can opt into
  fingerprinted filenames on its own — the platform doesn't require it.

## Repo layout (proposed)

**Superseded:** the `app/`-nested layout below was the original proposal.
The upload app actually lives at the repo root instead (decided during issue
#2 scaffolding) — see [PLAN.md](PLAN.md#repo-layout) for the as-built layout.

```
atelier/
  app/                 Node upload service (UI + /upload + /check)
  infra/               IaC (Terraform): S3, CloudFront + Function, ACM cert,
                       scoped S3-write IAM policy; Cloudflare DNS + Access
  hokusai/             Hokusai config + k8s manifests (+ Vault/ESO secret wiring)
  docs/                architecture docs and diagrams
```

## Key decisions & rationale

- **S3 = source of truth, one prefix per slug.** No database in v1; slug↔folder
  ↔subdomain is a clean 1:1 mapping.
- **CloudFront Function over a pass-through server.** Eliminates the only
  stateful serving component; host→prefix rewrite is a few lines at the edge.
- **Cloudflare Access over AWS-native OIDC.** Simplest single-policy SSO gate
  over a wildcard zone, with free wildcard TLS.

## Cost & hosting

Napkin scenario: 100 active users × ~20 visits/day, mostly single-page HTML
with some assets → ~600K requests/month. With `Cache-Control: no-cache` + ETag,
most repeat requests return bodiless `304`s, so real bytes transferred stay
low.

The **serving path is effectively free** at this scale and nowhere near any
pricing cliff:

| Component                            | Est. monthly                                      |
| ------------------------------------ | ------------------------------------------------- |
| Cloudflare Access                    | ~$0 marginal (already covers `unleash.artsy.net`) |
| S3 storage + GETs                    | <$0.50                                            |
| CloudFront requests + data-out       | ~$2–6                                             |
| CloudFront Functions / invalidations | <$0.10                                            |

The real variable is **where the upload app runs** — it's traffic-independent,
so this is a pure hosting/ops lever, not a scaling concern:

| Upload-app host                            | Est. monthly | Notes                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Existing k8s via Hokusai (recommended)** | **~$0–5**    | Fractional capacity on existing nodes; shared nginx ingress (no new LB); reuses team's deploy paradigm. Lowest cost + least new ops surface. Cluster is kOps-on-EC2 (`draco` prod, us-east-1); marginal cost is just fractional node capacity. |
| AWS App Runner                             | ~$5–15       | Simplest standalone deploy, but bills a warm instance's provisioned memory regardless of load.                                                                                                                                                 |
| AWS Lambda                                 | <$2          | Scales to zero (uploads are infrequent); cheapest, but a different deploy model and needs presigned-upload/streaming to dodge payload limits.                                                                                                  |

**Bottom line: ~$5–15/month all-in, and as low as ~$5 on the existing k8s
cluster via Hokusai.** Total cost is dominated by the upload app's hosting
choice, not by traffic; the serverless serving layer is a rounding error.
Confirm Atelier can ride Artsy's existing Cloudflare Access entitlement — a
standalone 100-seat Zero Trust license (~$350/mo) would otherwise dwarf
everything, but Access already fronts internal sites so this is almost
certainly covered.

## Risks & early blockers

Must be resolved before/at v1 — several affect the design or need infra
coordination:

1. **Resolved: DNS.** Domain is **`artsy.dev`** — see the separate-domain
   rationale below, serving every hosted site flat as `<slug>.artsy.dev` (the
   originally-sketched nested `*.atelier.artsy.dev` is not coming back — see
   the decision note in Context above). The `artsy.dev` zone is **already
   delegated to Cloudflare nameservers** (a standing, one-time registrar-level
   change made during the PoC — see
   [docs/hackathon-poc/3-SETUP.md](hackathon-poc/3-SETUP.md); do not revert
   it), and all the records are now live:
   - `atelier.artsy.dev` (proxied) → the deployed Node upload app's k8s
     ingress, resolving and serving through Access.
   - `*.artsy.dev` (proxied) → the CloudFront distribution, with a wildcard
     ACM cert (us-east-1). Being a single wildcard level, this is covered by
     Cloudflare's free Universal SSL — no Advanced Certificate Manager add-on
     needed.
   - `www.artsy.dev` and `upload.artsy.dev` → redirect (301) to
     `atelier.artsy.dev` via a Cloudflare Redirect Rule / Bulk Redirect List
     (edge-only; no app or CloudFront-Function change needed). Both labels are
     already on the reserved-slug list (`src/lib/slug.ts`), so they can never
     be claimed by an upload.
2. **Origin lock is mandatory (not hardening).** Hosted sites are internal-
   only, but CloudFront is reachable at its public `*.cloudfront.net` URL.
   Without a Cloudflare-injected secret header enforced at CloudFront/WAF,
   anyone with that URL bypasses Access and reads every site. Ship in v1.
3. **CSRF on `/upload` via the shared Access cookie.** JS on any
   `<slug>.artsy.dev` site can POST to `atelier.artsy.dev/upload` with the
   visitor's Access cookie attached and overwrite other slugs. Require an
   Origin/Referer check or CSRF token from day one.
4. **Cloudflare body-size limit caps site size.** Non-Enterprise plans cap
   request bodies (~100 MB) and fail at the edge. Confirm Artsy's plan, or
   switch to presigned direct-to-S3 zip upload. Separately, the k8s ingress
   itself hit its own lower-layer default (1 MB, well under the app's 50 MB
   `MAX_UPLOAD_BYTES`), causing large uploads to hang — a fix adding explicit
   `proxy-body-size`/timeout annotations is in review as of 2026-07-24 (#69).
5. **SPA fallback — decided: supported in v1.** Handled by the CloudFront
   Function's shape-based routing (see §2), no extra infra. Known limitation:
   MPA "clean URLs" without trailing slashes; upgrade to Lambda@Edge later if
   needed.

**Why a separate domain (`artsy.dev`, not `*.atelier.artsy.net`).** Uploaded
sites run arbitrary, LLM-authored JS. On `artsy.net` that JS would be
_same-site with all of Artsy production_ — able to read any `Domain=.artsy.net`
cookie and to _set_ `.artsy.net` cookies (session fixation), with `SameSite=Lax`
production cookies riding along on navigations. A separate registrable domain
(`artsy.dev` is a different eTLD+1) severs that relationship entirely, so
uploaded content cannot touch any `artsy.net` cookie. Bonus: the `.dev` TLD is
HSTS-preloaded, so browsers force HTTPS. (Sites still share `.artsy.dev`
with each other — accepted under the "anyone can overwrite anyone" model.)

Noted, not launch-blocking: cross-subdomain trust / lookalike-slug phishing
(inherent to the permissions model — consider reserving sensitive slugs);
verifying Cloudflare's own cache respects `no-cache`; no delete / no
site-listing in v1 (orphans + discoverability); Cloudflare→CloudFront host/SNI
config (403 gotcha); zip symlink entries, extensionless files, and correct MIME
for `.wasm`/`.svg`.

## Hardening / open considerations (note, not blockers for a hackathon v1)

- **Lock the CloudFront origin to Cloudflare.** Because Access enforces at the
  Cloudflare edge, the raw `*.cloudfront.net` URL would bypass it. Mitigate by
  having Cloudflare inject a secret header that a CloudFront Function / WAF rule
  requires. Do this before treating the gate as trustworthy.
- **CloudFront is somewhat redundant** given Cloudflare is already CDN + TLS +
  Access. A Cloudflare Worker reading S3 directly could replace it entirely. We
  keep CloudFront per the chosen design (serving logic stays in AWS, S3 stays
  private via OAC); revisit only if the double-CDN hop is a problem.

## Verification (once built)

1. **Upload happy path**: drop a small zip with `index.html` under slug
   `test-site`; confirm objects land under `s3://artsy-atelier/test-site/` with
   correct content-types.
2. **Serve**: visit `https://test-site.artsy.dev/` (through Access) and
   confirm `index.html` renders and relative assets load.
3. **Overwrite = replace**: re-upload a zip that omits a previously-present
   file; confirm the stale file is gone from S3 and 404s when requested.
4. **Warn-before-overwrite**: re-upload to an existing slug and confirm the UI
   warns with the previous uploader's email and timestamp (read from S3 object
   metadata) and requires confirmation.
5. **Cache freshness**: change `index.html`, re-upload, and confirm the new
   content appears on hard-_and_-normal reload (no fingerprinting); verify
   objects carry `Cache-Control: no-cache` and responses show `ETag`/`304`
   revalidation.
6. **Auth gate**: hit both `atelier.artsy.dev` and a site subdomain in an
   unauthenticated/incognito session; confirm Cloudflare Access blocks and the
   raw CloudFront URL is not reachable unauthenticated (origin-lock check).
7. **Security**: attempt a zip with a `../escape` entry and an invalid slug
   (`Bad_Slug`); confirm both are rejected.
