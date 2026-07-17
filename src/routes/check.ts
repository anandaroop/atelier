import type { S3Client } from "@aws-sdk/client-s3";
import { Router } from "express";
import { headIndex } from "../lib/s3";
import { validateSlug } from "../lib/slug";

export function createCheckRouter(client: S3Client, bucket: string): Router {
  const router = Router();

  router.get("/check", async (req, res) => {
    const slug = typeof req.query.slug === "string" ? req.query.slug : "";
    const validation = validateSlug(slug);

    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const result = await headIndex(client, bucket, slug);
    res.json(result);
  });

  return router;
}
