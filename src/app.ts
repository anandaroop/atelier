import path from "node:path";
import type { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import type { S3Client } from "@aws-sdk/client-s3";
import express, { type Express } from "express";
import { errorHandler } from "./middleware/errorHandler";
import { createCheckRouter } from "./routes/check";
import { createUploadRouter } from "./routes/upload";

export interface AppDeps {
  s3Client: S3Client;
  cloudFrontClient: CloudFrontClient;
  bucket: string;
  distributionId: string;
  publicDomain: string;
  maxUploadBytes: number;
}

/**
 * Builds the Express app: the static drop-zone UI (public/) plus the
 * check/upload API routers. Kept separate from index.ts so tests can
 * construct it without booting a real listener.
 */
export function createApp(deps: AppDeps): Express {
  const { s3Client, cloudFrontClient, bucket, distributionId, publicDomain, maxUploadBytes } = deps;

  // dist/../public in the compiled build, src/../public under tsx — public/
  // sits as a sibling of both.
  const publicDir = path.join(__dirname, "..", "public");

  const app = express();

  app.get("/health/ping", (_req, res) => {
    res.sendStatus(200);
  });
  app.use(express.static(publicDir));
  app.use(createCheckRouter(s3Client, bucket));
  app.use(
    createUploadRouter({
      s3Client,
      cloudFrontClient,
      bucket,
      distributionId,
      publicDomain,
      maxUploadBytes,
    }),
  );
  app.use(errorHandler);

  return app;
}
