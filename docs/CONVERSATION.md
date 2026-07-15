# Conversation Recap

## 1

**You:**

> We are in the early planning stage of this project and want to come up with an architecture and a stack. our org uses AWS infra, and is proficient in Node and Rails, thus the seed ideas.

**Me:**

- Reviewed `docs/sketch.png` and the (empty) repo, confirming this was a greenfield planning task
- Assessed the sketch: praised the S3-per-slug/subdomain design and single Access gate, but flagged the pass-through server as unnecessary, a Cloudflare-vs-AWS-native tension, "overwrite" needing to mean replace-not-merge, and zip-slip/slug-validation gaps
- Asked three clarifying questions: auth mechanism, serving approach, upload-app stack

## 2

**You:**

> Auth: Cloudflare Access (as sketched)
> Serving: CloudFront + S3, no server
> Upload stack: Node

**Me:**

- Locked in Cloudflare Access + CloudFront/S3 (serverless) + Node, flagging the origin-lock risk this combination creates
- Wrote the first full architecture plan (auth/DNS, serving, upload app, hardening, verification)
- Requested plan approval (not yet granted)

## 3

**You:**

> Note that we already use Cloudflare Access to protect some internal sites such as our Unleash installation at unleash.artsy.net
>
> Also note that ideally the confirmation of intent would include the identity of the previous uploader, e.g. "User roop uploaded a site to `mydash` 2 days ago. Overwrite?"
>
> Another consideration is caching. Users may potentially do repeated uploads as they fiddle with a design. We don't want stale assets to be served to browsers, but also prefer to avoid a build step with asset fingerprinting etc if possible.

**Me:**

- Noted Cloudflare Access already protects `unleash.artsy.net`, de-risking that choice
- Added uploader attribution (email + timestamp via the Access header, stored as S3 object metadata) to drive the overwrite-warning UX
- Added a caching strategy: `Cache-Control: no-cache` + ETag revalidation instead of a build step, plus a CloudFront invalidation on overwrite

## 4

**You:**

> What should we expect for costs? Consider this napkin math: a 200 person company, 1/2 of them hitting atelier sites 20x daily, mostly single-page html requests but some with assets. What is ballpark monthly cost for this usage?

**Me:**

- Translated the usage scenario into ~600K requests/month and built a cost table across Cloudflare Access, S3, CloudFront, and the upload app
- Concluded serving is near-free (~$1–2/mo) and the upload app's idle hosting is the dominant cost (~$5–15/mo on App Runner, or <$5 via Lambda)
- Flagged confirming the Cloudflare Access license doesn't need to be purchased standalone

## 5

**You:**

> Another angle to consider: the upload app could be deployed to our usual infra. Kubernetes clusters in AWS infra, fronted by nginx, managed by Hokusai. Not sure if you can estimate that, but include that as another cost alternative/lever and update the doc accordingly

**Me:**

- Estimated hosting the upload app on Artsy's existing k8s cluster via Hokusai at ~$0–5/month — cheapest option, least new ops surface
- Rewrote the plan's upload-app section to recommend it, added a full cost-comparison table (Hokusai/k8s vs. App Runner vs. Lambda), and updated the architecture diagram and repo layout

## 6

**You:**

> I don't believe we use EKS actually, something else in AWS. What could that likely be? (I'm also asking another agent to find out)

**Me:**

- Reasoned the cluster is likely kOps-provisioned Kubernetes on EC2 rather than EKS, since Hokusai is provisioner-agnostic
- Made the plan cluster-flavor-agnostic ("existing Kubernetes cluster via Hokusai" instead of naming EKS), noting the IAM wiring detail would depend on the answer

## 7

**You:**

> I'll update with agent findings, meanwhile what else have we not considered that might constitute an early blocker?

**Me:**

- Listed likely early blockers: domain ambiguity (`artsy.net` vs `artsy.dev`) and DNS lead time, a mandatory CloudFront origin-lock, CSRF on the shared-cookie upload endpoint, Cloudflare's request body-size cap, and an SPA-vs-MPA scoping decision
- Added a "Risks & early blockers" section to the plan plus a shorter "noted, not blocking" list
- Asked the user to decide the domain and SPA-vs-MPA questions

## 8

**You:**

> Domain: We have a registered and unused domain artsy.dev -- our VP Eng already hinted we should use that, likely because of the cookie stealing issue. Wdyt?
> SPA vs MPA: HOW big a change is SPA vs MPA, if its an easy addon lets go SPA for v1. If a lot of yaks we should optimize for MPA earlier maybe?

**Me:**

- Endorsed `artsy.dev`: a separate domain severs same-site cookie access between arbitrary uploaded JS and `artsy.net` production sessions
- Confirmed SPA support is a low-cost CloudFront Function addition (route by URL shape), not a big yak — recommended shipping it in v1
- Updated the plan: domain renamed throughout, CloudFront Function logic rewritten for SPA+MPA routing, risks section and rationale updated

## 9

**You:**

> ## Btw here is the agent finding, fyi
>
> [10:13 AM]Self-managed Kubernetes on AWS via kOps, not EKS — two clusters, no managed control plane.
>
> Clusters: kubernetes-production-draco.artsy.systems (prod, codename draco) and kubernetes-staging-leo.artsy.systems (staging, codename leo), both in us-east-1. Defined in substance/clusters/.
> Provisioning: the substance repo's manage.py CLI wraps kOps — kops update cluster --target terraform generates the Terraform, which is then apply'd. kOps state lives in s3://artsy-kops-state-store; cluster Terraform state in S3 bucket artsy-terraform + a DynamoDB lock table (main.tf).
> Node architecture: each cluster has 3 dedicated t3.large masters (one per AZ, HA etcd), Calico CNI, and several worker node groups — on-demand foreground/background/api/ingress groups plus spot-backed foreground-spot/background-spot, all autoscaled via cluster-autoscaler, on a custom Packer-built AMI. K8s version pinned at 1.23.17 in spec.yml.
> Auth: AWS IAM Authenticator maps IAM roles (KubernetesAdmin/KubernetesCI/KubernetesDev) to k8s RBAC groups — per the Notion doc Kubernetes API Authentication and Authorization (last edited June 2026).
> Secrets: Vault-backed, via either External Secrets Operator or a custom "Fortress" init container — doc. App manifests deploy via Hokusai; a separate artsy/infrastructure Terraform repo supplies VPC/Vault-role resources the cluster Terraform reads via remote state.
> EKS: evaluated in a 2022 RFC and rejected — no master-node visibility, immature Terraform EKS module at the time, CNI/custom-AMI mismatch. It's resurfaced a few times since as an unstarted "Later" roadmap item, most recently Sept 2025, so still kOps today.
>
> Both sources agree, and the Notion side is corroborated by a kudos post from July 9 about manually upgrading staging nodes — consistent with kOps rather than a managed control plane.

**Me:**

- Updated the plan with the confirmed kOps details (cluster names `draco`/`leo`, region, no EKS OIDC provider so IRSA doesn't apply)
- Switched the IAM approach to a scoped policy delivered via Vault/External Secrets Operator, matching how other Artsy apps get AWS credentials
- Plan was approved; exited plan mode and asked what to do next

## 10

**You:**

> Write this to ARCHITECTURE.md

**Me:**

- Wrote the approved plan content to `ARCHITECTURE.md` in the repo

## 11

**You:**

> Let's pivot now to what a minimal PoC would look like.
>
> Could we ignore the upload process for starters and set up:
> [Request interrupted by user]
> Let's pivot now to what a minimal PoC would look like.
>
> Could we ignore the upload process for starters and set up:
> [Request interrupted by user]
> Do we _need_ a cloudfront distro? Is that edge caching a performance concern? or a necessity in this archicture?

**Me:**

- Explained CloudFront isn't needed for performance at this scale, but for wildcard HTTPS, host→prefix routing compute, and keeping S3 private
- Noted Cloudflare — already in the request path — can do all three itself via a Worker, which also eliminates the origin-lock risk entirely
- Recommended dropping CloudFront for the PoC in favor of a Cloudflare Worker, and asked what the PoC scope was going to be

## 12

**You:**

> PoC:
>
> - A new dedicated S3 bucket, e.g. `artsy-atelier`
> - A test subfolder within it, e.g. `test`, containing an index.html file
> - The minimal setup (now Cloudflare it sounds like) to serve test.atelier.artsy.dev, optionally with desired caching settings
> - out of scope: auth, uploads
>
> Milestone 1: Auth
>
> - Cloudflare access, using our existing seats, I assume, to protect access to the test site
>
> Milestone 2: Uploads
>
> - Upload app deployed with our preferred infra choices
>
> I'm picturing a rough roadmap like that, wdyt? We would flesh out the PoC steps next

**Me:**

- Confirmed the roadmap's sequencing (PoC → auth → uploads) was sound, and flagged that DNS zone delegation is a pre-req even for the PoC, and that the PoC site is briefly public with no auth
- Produced a fleshed-out 6-step PoC plan: DNS, S3 bucket, scoped IAM credentials, Worker code, route binding, verification

## 13

**You:**

> Create POC.md with that summary, as well as detailed steps/scripts/instructions

**Me:**

- Wrote `POC.md`: scope/out-of-scope summary, prerequisites, and detailed runnable steps (S3 + IAM setup commands, a full Cloudflare Worker implementation using `aws4fetch`, wrangler config, DNS record guidance, verification commands including a 304 cache check), plus cleanup steps and a roadmap recap

## 14

**You:**

> And finally give me SUMMARY.md with an executive summary I can hand to my VP Engr that clearly and concise in a few bullet points names the major components and how they interact

**Me:**

- Drafted `SUMMARY.md` for the VP with component bullets (Cloudflare, Worker, S3, upload app, domain isolation) plus a status/cost line, framed around milestones

## 15

> Dont mention specific milestones, and be more concise

**Me:**

- Rewrote `SUMMARY.md`, removing milestone references and tightening the language

## 16

**You:**

> Now produce CONVERSATION.md that recaps this conversation:
>
> - every message from me, verbatim
> - every response from you, summarized in 1-3 bullet points, very concise
> - no thinking or reasoning traces

**Me:**

- Wrote this file, `CONVERSATION.md`
