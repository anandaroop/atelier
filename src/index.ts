import "dotenv/config";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import { loadConfig } from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { createCheckRouter } from "./routes/check";
import { createUploadRouter } from "./routes/upload";

const config = loadConfig(process.env);
const s3Client = new S3Client({ region: config.s3Region });
const cloudFrontClient = new CloudFrontClient({ region: config.s3Region });
const app = express();

app.get("/", (_req, res) => {
  res.type("text/plain").send("Atelier upload app — coming soon");
});

app.use(createCheckRouter(s3Client, config.s3Bucket));
app.use(
  createUploadRouter({
    s3Client,
    cloudFrontClient,
    bucket: config.s3Bucket,
    distributionId: config.cloudfrontDistributionId,
    publicDomain: config.publicDomain,
    maxUploadBytes: config.maxUploadBytes,
  }),
);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`atelier listening on :${config.port}`);
});
