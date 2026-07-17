import "dotenv/config";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { S3Client } from "@aws-sdk/client-s3";
import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const s3Client = new S3Client({ region: config.s3Region });
const cloudFrontClient = new CloudFrontClient({ region: config.s3Region });

const app = createApp({
  s3Client,
  cloudFrontClient,
  bucket: config.s3Bucket,
  distributionId: config.cloudfrontDistributionId,
  publicDomain: config.publicDomain,
  maxUploadBytes: config.maxUploadBytes,
});

app.listen(config.port, () => {
  console.log(`atelier listening on :${config.port}`);
});
