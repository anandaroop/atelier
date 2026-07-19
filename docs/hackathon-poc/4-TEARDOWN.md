# Atelier PoC — Teardown

Full cleanup if the PoC doesn't pan out. Covers both the live `*.artsy.dev`
setup ([3-SETUP.md](3-SETUP.md)) and the leftover artifacts from the abandoned
`*.atelier.artsy.dev` detour. Order matters — CloudFront resources can't be
deleted while still referenced by something else.

## 1. CloudFront distribution

Must be disabled and fully redeployed *before* it can be deleted — budget
~15–20 min.

```sh
ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront get-distribution-config --id "$DIST_ID" \
  | jq '.DistributionConfig.Enabled = false | .DistributionConfig' \
  > /tmp/atelier-distribution-disabled.json
aws cloudfront update-distribution --id "$DIST_ID" \
  --distribution-config file:///tmp/atelier-distribution-disabled.json --if-match "$ETAG"

# poll until Status: Deployed, then:
FINAL_ETAG=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$FINAL_ETAG"
```

## 2. ACM certificates (`us-east-1`)

Both the live one and the orphaned detour one — a cert can't be deleted while
attached to a distribution, so this must follow step 1.

```sh
aws acm delete-certificate --certificate-arn "$CERT_ARN" --region us-east-1          # *.artsy.dev
aws acm delete-certificate --certificate-arn "<atelier cert ARN>" --region us-east-1 # *.atelier.artsy.dev, orphaned
```

## 3. CloudFront Function

```sh
FUNC_ETAG=$(aws cloudfront describe-function --name atelier-poc-router --stage LIVE --query 'ETag' --output text)
aws cloudfront delete-function --name atelier-poc-router --if-match "$FUNC_ETAG"
```

## 4. Origin Access Control

```sh
aws cloudfront delete-origin-access-control --id "$OAC_ID"
```

## 5. S3 bucket

```sh
aws s3 rm "s3://artsy-atelier/test/index.html"
aws s3api delete-bucket --bucket artsy-atelier --region us-east-1
```

## 6. Cloudflare DNS records (manual, dashboard)

Remove:
- `CNAME *` → distribution domain (the live one)
- `CNAME *.atelier` → distribution domain (orphaned detour leftover)
- Both ACM DNS-validation `CNAME` records (one per cert from step 2)

## 7. Cloudflare Advanced Certificate Manager

**Billing decision, not a mechanical step** — confirm with whoever owns
Cloudflare billing before downgrading. If nothing else on the zone needs
multi-level-wildcard cert support, cancel the $10/mo ACM add-on
(SSL/TLS → Edge Certificates → manage plan).

## 8. Local scratch files (optional)

```sh
rm -rf /tmp/atelier-poc /tmp/atelier-router.js /tmp/atelier-distribution*.json /tmp/atelier-bucket-policy.json
```

## Explicitly out of scope

- **`artsy.dev` → Cloudflare nameserver delegation.** This is a standing
  registrar-level change, not PoC-specific infrastructure — do not revert it
  as part of tearing down this PoC.
- **Zone SSL/TLS mode (`Full (strict)`).** Generally the correct setting
  regardless of this PoC; leave as-is unless someone has a specific reason to
  change it.
