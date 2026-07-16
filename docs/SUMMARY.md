# Atelier — Executive Summary

Atelier lets any verified Artsy employee drag a zip of a static site (often
LLM-generated) onto a page and have it live within seconds — no ticket, no
server to provision. Full target design in [ARCHITECTURE.md](ARCHITECTURE.md);
what's actually been built so far in [POC.md](POC.md) / [SETUP.md](SETUP.md)
and [PLAN.md](PLAN.md).

**Current reality vs. target design:** the target design calls for sites at
`<slug>.atelier.artsy.dev` via a nested Cloudflare wildcard. The PoC found
Cloudflare's free Universal SSL doesn't cover a wildcard-of-a-subdomain, so
sites currently live at the flat `<slug>.artsy.dev` instead — see "Open
question" below.

## Components and how they connect

- **Cloudflare** is the front door: it terminates TLS for the wildcard domain
  and (eventually) gates all access — both the upload page and every hosted
  site — behind our existing Artsy SSO, the same setup already protecting
  `unleash.artsy.net`. Not yet wired up — see [POC.md](POC.md)'s milestone
  roadmap.
- **CloudFront + a CloudFront Function** does the routing: it maps the
  subdomain a visitor requested to a folder in S3 and fetches the matching
  file directly — no dedicated app server needed for serving. (The original
  design considered a Cloudflare Worker doing this instead; CloudFront was
  chosen — see ARCHITECTURE.md §2.)
- **S3** is the only storage: one folder per site, named by its slug, fully
  private — nothing reads it except CloudFront (via Origin Access Control).
- **A small Node upload app** is the only write path: it validates uploads,
  replaces a site's folder contents, and records who uploaded and when. It
  runs on Artsy's existing Kubernetes infrastructure via Hokusai. Build
  in progress — see [PLAN.md](PLAN.md) and the
  [GitHub project](https://github.com/users/anandaroop/projects/7).
- **`atelier.artsy.dev`** is intended as a deliberately separate domain from
  `artsy.net`, so that arbitrary code in uploaded sites can never touch Artsy
  production cookies or sessions. Currently realized as `artsy.dev` (see
  "Current reality" above) — the isolation-from-`artsy.net` property already
  holds; only the isolation-of-the-upload-app-from-sites property (via the
  `atelier.` sub-namespace) is still pending.

## Open question: return to the nested-wildcard design

The nested `<slug>.atelier.artsy.dev` scheme is still the desired end state —
it isolates hosted sites into their own sub-namespace instead of sharing the
root `artsy.dev` domain with anything else. Returning to it requires either
Cloudflare's Advanced Certificate Manager add-on (~$10/mo, plus resolving the
CSR-access permission wall hit during the PoC) or another path to a
wildcard-of-a-subdomain cert. This is forward-compatible with the current
build: `atelier.artsy.dev` (reserved for the upload app) and
`*.atelier.artsy.dev` (for sites) are distinct DNS names that don't collide —
see [PLAN.md](PLAN.md) for the detailed compatibility argument. Tracked as a
follow-up, not blocking Milestone 1 (Uploads).

## Status and cost

Milestone 0 (core serving) is proven via PoC — see [SETUP.md](SETUP.md).
Milestone 1 (Uploads) is in progress — see [PLAN.md](PLAN.md) and the
[GitHub project](https://github.com/users/anandaroop/projects/7). Milestone 2
(Auth) is next after that. Estimated run cost is **~$5–15/month**, driven by
the upload app's hosting choice rather than by traffic — serving is
effectively free at this scale.
