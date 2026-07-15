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

## Initial architecture

- See [docs/SUMMARY.md](docs/SUMMARY.md) for an overview
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details

(We arrived here after much back-and-forth, summarized in docs/CONVERSATION.md)here
