# Atelier

## Overview

Atelier is a service internal to Artsy and Artnet, intended for dead-simple hosting of static html sites, such as might be produced by non-technical users with the assistance of LLMs and coding agents. Or indeed any static html, hand-coded, vibe-coded, generated, etc.

The inspirations are:

- [Quick](https://shopify.engineering/quick) — Shopify's version, for internal use
- [Drop](https://www.cloudflare.com/drop/) — Cloudflare's version, for public use

## Project Goals

- **Dead-simple UX**: drag a zip archive containing html/css/js onto a webpage, see it live in a few seconds

- **Simple naming conventions**: user supplies a slug e.g. `marketing-dashboard` which becomes the name of the folder where the assets are stored as well as the subdomain of the public url from which the site can be accessed, e.g. `marketing-dashboard.atelier.artsy.dev`

- **Comically simple permissions**: access is to the entire system, uploads and websites, is gated to only verified Artsy users. But once in, anyone can freely write and overwrite any folder, any project after confirmation they _intend_ to overwrite an existing upload.

Simple, simple, simple!

### Code quality

- All code is well-typed
- All code tested via Jest, and introduced via TDD
- All code linted via Biome, automatically on file-save and enforced at commit time
- CircleCI (`.circleci/config.yml`) runs `yarn test` on every push, and deploys via Hokusai: `main` to staging, `release` to production (behind a Horizon release block). It does not run lint or typecheck — run those locally before pushing.
- Additionally: an on-demand `@claude`-mention workflow (`.github/workflows/claude-review.yml`) runs a Claude Code review when someone comments `@claude` on a PR. It doesn't run on every push and isn't a substitute for the CircleCI pipeline.

### Commit hygiene

- All commit messages follow Conventional Commits
- Commits are as small and cohesive as reasonably possible. Prefer <500 LOC
- All agent-authored commits include a trailer e.g.
  - `Assisted-by: Claude:Sonnet-5`
  - `Assisted-by: Claude:Opus-4.8`

### Branch and PR hygiene

- All PR titles follow Conventional Commits
- This repo enforces **linear history, rebase-merge only** on `main`. Before starting new work (and before committing anything already in progress), check whether the current branch is the right base:
  1. `git branch --show-current` — if it's not `main` and isn't a branch created for the task at hand, stop and check further before committing.
  2. `git log --oneline main..<branch>` — if this shows commits, the branch has work not yet on `main`. Check whether that work is an **open PR** (`gh pr list --head <branch>` or ask the developer) rather than assuming it's abandoned or already merged.
  3. Once `main` reflects the intended base, create a fresh branch off it for the new work: `git checkout -b <new-branch>`. Untracked files in the working tree survive a branch switch, so any not-yet-committed new files carry over safely — but confirm with `git status` before and after.
  4. Never `git rebase`, force-push, or otherwise rewrite shared history without explicit developer instruction, given the rebase-merge-only policy.
  5. Do not self-merge PRs. PRs require review from a human and/or a separate agent. Do not @-mention Claude to trigger reviews, that is for a human to do.

### Github hygiene

- When opening a PR or Issue on developer's behalf, also use the `Assisted-by:` trailer in the PR description
- When posting a comment on developer's behalf, use a similar `Posted-by:` trailer in the comment
- When starting a task on the Github Project, always change its Status to In Progress. If you learn that a PR is merged, confirm the task's status is Done.

### Project board

Work is tracked as GitHub Issues on the [project board](https://github.com/orgs/artsy/projects/10) project, not in local docs.

- Use `gh project` to interact with projects
- Use the `chore` label for non-code tasks, and assign them to your developer
- Use `epic` field to group related tasks. Epics follow a `00 Name` zero-padded naming convention

### Other notes

- Note that you cannot run `aws` commands yourself due to role-based access and OTPs. Always ask the developer to run `aws` commands for you.

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the target v1 architecture
  and stack
- [docs/PLAN.md](docs/PLAN.md) — shape & architecture that seeded the
  upload-app milestone; historical rationale, not a live spec
- [docs/hackathon-poc/](docs/hackathon-poc/) — quarantined docs from the
  serving-layer PoC (what to build, what was actually built, how to tear it
  down, and the original design conversation) — background only, superseded
  by the docs above
- Task tracking lives in the
  [Atelier GitHub project](https://github.com/orgs/artsy/projects/10),
  not in these docs
