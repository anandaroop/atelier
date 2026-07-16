# Steps

Keeping a running log of configuration steps.

```sh
##################################################
##### Step 1 — S3 bucket + test content
##################################################

# set up shell vars for convenience

export BUCKET=artsy-atelier
export REGION=us-east-1

# create a bucket

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

# block all public access, no accidental leakage

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# upload a test site

mkdir -p /tmp/atelier-poc/test
cat > /tmp/atelier-poc/test/index.html <<'HTML'
<html>
<title>Hello, Atelier?</title>
<body>Hello, Atelier!</body>
</html>
HTML

bat  /tmp/atelier-poc/test/index.html

aws s3 cp /tmp/atelier-poc/test/index.html "s3://$BUCKET/test/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8"

# confirm test site

aws s3 ls s3://artsy-atelier/test/
# 2026-07-15 20:23:05         75 index.html

##################################################
##### Step 2 — Origin Access Control (OAC)
##################################################

# create an Origin Access Control object so Cloudfront can securely reach into artsy-atelier bucket

OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config \
    Name="atelier-poc-oac",SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query 'OriginAccessControl.Id' --output text)
echo "$OAC_ID"

##################################################
##### Step 3 — CloudFront Function (host → prefix routing)
##################################################

# write a request rewriting function in js -- extract slug, construct asset path

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

bat /tmp/atelier-router.js

# create (but don't activate) the function

aws cloudfront create-function \
  --name atelier-poc-router \
  --function-config Comment="Atelier PoC host-to-prefix router",Runtime=cloudfront-js-2.0 \
  --function-code fileb:///tmp/atelier-router.js

# response json below…
```

```json
{
  "Location": "https://cloudfront.amazonaws.com/2020-05-31/function/arn:aws:cloudfront::585031190124:function/atelier-poc-router",
  "ETag": "ETVPDKIKX0DER",
  "FunctionSummary": {
    "Name": "atelier-poc-router",
    "Status": "UNPUBLISHED",
    "FunctionConfig": {
      "Comment": "Atelier PoC host-to-prefix router",
      "Runtime": "cloudfront-js-2.0"
    },
    "FunctionMetadata": {
      "FunctionARN": "arn:aws:cloudfront::585031190124:function/atelier-poc-router",
      "Stage": "DEVELOPMENT",
      "CreatedTime": "2026-07-16T01:06:39.626000+00:00",
      "LastModifiedTime": "2026-07-16T01:06:39.626000+00:00"
    }
  }
}
```

```sh

# publish the function

ETAG=$(aws cloudfront describe-function --name atelier-poc-router --stage DEVELOPMENT --query 'ETag' --output text)
aws cloudfront publish-function --name atelier-poc-router --if-match "$ETAG"

# response json below…
```

```json
{
  "FunctionSummary": {
    "Name": "atelier-poc-router",
    "Status": "UNASSOCIATED",
    "FunctionConfig": {
      "Comment": "Atelier PoC host-to-prefix router",
      "Runtime": "cloudfront-js-2.0"
    },
    "FunctionMetadata": {
      "FunctionARN": "arn:aws:cloudfront::585031190124:function/atelier-poc-router",
      "Stage": "LIVE",
      "CreatedTime": "2026-07-16T01:08:58.327000+00:00",
      "LastModifiedTime": "2026-07-16T01:08:58.327000+00:00"
    }
  }
}
```

```sh

# grab the ARN

FUNCTION_ARN=$(aws cloudfront describe-function --name atelier-poc-router --stage LIVE \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
echo "$FUNCTION_ARN"

# arn:aws:cloudfront::585031190124:function/atelier-poc-router

##################################################
##### Step 4 — ACM certificate
##################################################

# request certificate

CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.atelier.artsy.dev" \
  --validation-method DNS \
  --region us-east-1 \
  --query 'CertificateArn' --output text)
echo "$CERT_ARN"

# An error occurred (AccessDeniedException) when calling the RequestCertificate operation: User: arn:aws:sts::585031190124:assumed-role/Developer/roop is not authorized to perform: acm:RequestCertificate on resource: arn:aws:acm:us-east-1:585031190124:certificate/* because no identity-based policy allows the acm:RequestCertificate action

# Jian did this in AWS Console UI with InfrastructureAdmin role
```

```sh
export CERT_ARN="<the ARN Jian gave you>"

# done by Jian
aws acm wait certificate-validated --certificate-arn "$CERT_ARN" --region us-east-1
```

```sh
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


# error on 403->404 remap -- add it later

DIST_ID=$(jq -r '.Distribution.Id' /tmp/atelier-distribution-result.json)
DIST_ARN=$(jq -r '.Distribution.ARN' /tmp/atelier-distribution-result.json)
DIST_DOMAIN=$(jq -r '.Distribution.DomainName' /tmp/atelier-distribution-result.json)
echo "$DIST_ID $DIST_ARN $DIST_DOMAIN"
```

```sh
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
      { "ErrorCode": 403, "ErrorCachingMinTTL": 10 }
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

```sh
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

aws cloudfront get-distribution --id E22U9CWUDKPZP6 --query 'Distribution.Status' --output text
```

## Open items

- **Lost the nested `atelier` subdomain.** Cloudflare's free Universal SSL only
  covers one level of wildcard (`*.artsy.dev`), not `*.atelier.artsy.dev`.
  Activating Advanced Certificate Manager ($10/mo) would fix this, but hit a
  separate "no CSR access" permission wall for our role after activating it.
  Pivoted to bare `*.artsy.dev` instead — slugs now live at `<slug>.artsy.dev`,
  sharing the root namespace with any other `artsy.dev` subdomain (an exact
  match still wins over the wildcard, but any *new* single-label subdomain
  created later without one would silently land on this distribution).

- **`ETag` header missing from responses through the full chain.** Confirmed
  present on the S3 object directly (`aws s3api head-object`) and still
  present hitting CloudFront directly (bypassing Cloudflare), but missing by
  the time it reaches the viewer through Cloudflare's proxy. Ruled out so far:
  Speed → Content Optimization (all off), Transform Rules (0/10 configured on
  the zone). Root cause still unknown — worth a Cloudflare support
  ticket/docs dig. Not a correctness issue (`Cache-Control: no-cache` still
  guarantees freshness), just means we lose the `304`-revalidation bandwidth
  savings described in ARCHITECTURE.md §4.
