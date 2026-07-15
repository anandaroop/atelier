# Atelier — Executive Summary

Atelier lets any verified Artsy employee drag a zip of a static site (often
LLM-generated) onto a page and have it live at `<slug>.atelier.artsy.dev`
within seconds — no ticket, no server to provision. Full design in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Components and how they connect

- **Cloudflare** is the front door: it terminates TLS for the wildcard domain
  and gates all access — both the upload page and every hosted site — behind
  our existing Artsy SSO, the same setup already protecting
  `unleash.artsy.net`.
- **A Cloudflare Worker** does the routing: it maps the subdomain a visitor
  requested to a folder in S3 and fetches the matching file directly — no
  dedicated app server or AWS CDN needed for serving.
- **S3** is the only storage: one folder per site, named by its slug, fully
  private — nothing reads it except the Worker.
- **A small Node upload app** is the only write path: it validates uploads,
  replaces a site's folder contents, and records who uploaded and when. It
  runs on Artsy's existing Kubernetes infrastructure via Hokusai.
- **`atelier.artsy.dev`** is a deliberately separate domain from
  `artsy.net`, so that arbitrary code in uploaded sites can never touch Artsy
  production cookies or sessions.

## Status and cost

Architecture is designed; no code has shipped yet. Estimated run cost is
**~$5–15/month**, driven by the upload app's hosting choice rather than by
traffic — serving is effectively free at this scale.
