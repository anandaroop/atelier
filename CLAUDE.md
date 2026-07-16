# Atelier

## Overview

Atelier will be a service internal to Artsy intended for dead-simple hosting of static html sites, such as might be produced by non-technical users with the assistance of LLMs and coding agents.

The inspirations are:

- [Quick](https://shopify.engineering/quick) — Shopify's version, for internal use
- [Drop](https://www.cloudflare.com/drop/) — Cloudflare's version, for public use

## Project Goals

- **Dead-simple UX**: drag a zip archive containing html/css/js onto a webpage, see it live in a few seconds

- **Simple naming conventions**: user supplies a slug e.g. `marketing-dashboard` which becomes the name of the folder where the assets are stored as well as the subdomain of the public url from which the site can be accessed, e.g. `marketing-dashboard.atelier.artsy.dev`

- **Comically simple permissions**: access is to the entire system, uploads and websites, is gated to only verified Artsy users. But once in, anyone can freely write and overwrite any folder, any project after confirmation they _intend_ to overwrite an existing upload.

Simple, simple, simple!

## Docs

- [docs/SUMMARY.md](docs/SUMMARY.md) — executive summary, current status vs.
  target design
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the target v1 architecture
  and stack
- [docs/POC.md](docs/POC.md) / [docs/SETUP.md](docs/SETUP.md) /
  [docs/TEARDOWN.md](docs/TEARDOWN.md) — the serving-layer PoC: what to build,
  what was actually built (with deviations), and how to tear it down
- [docs/PLAN.md](docs/PLAN.md) — shape & architecture for the current
  milestone (the upload app)
- Task tracking lives in the
  [Atelier GitHub project](https://github.com/users/anandaroop/projects/7),
  not in these docs
- docs/CONVERSATION.md — how we arrived at the initial design, for background
