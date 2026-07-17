import type { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import type { S3Client } from "@aws-sdk/client-s3";
import Busboy from "busboy";
import type { Request } from "express";
import { Router } from "express";
import { invalidateSlug } from "../lib/cloudfront";
import { resolveContentType } from "../lib/mime";
import { deletePrefix, headIndex, putFile } from "../lib/s3";
import { validateSlug } from "../lib/slug";
import { extractZip, normalizeZipEntries, type ZipEntry, ZipValidationError } from "../lib/zip";

export interface UploadRouterDeps {
  s3Client: S3Client;
  cloudFrontClient: CloudFrontClient;
  bucket: string;
  distributionId: string;
  publicDomain: string;
  maxUploadBytes: number;
}

interface ParsedUpload {
  slug: string;
  confirm: boolean;
  uploadedBy?: string;
  entries?: ZipEntry[];
}

const CONFIRM_TRUE_VALUES = new Set(["true", "1", "on"]);

/**
 * Streams the multipart request into its form fields plus the zip's
 * validated entries, without ever buffering the whole raw archive in
 * memory (busboy hands `extractZip` the file part as it arrives).
 */
function parseUpload(req: Request, maxUploadBytes: number): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxUploadBytes } });

    let slug = "";
    let confirm = false;
    let uploadedBy: string | undefined;
    let entriesPromise: Promise<ZipEntry[]> | undefined;
    let fileStream: (NodeJS.ReadableStream & { truncated?: boolean }) | undefined;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    bb.on("field", (name, value) => {
      if (name === "slug") {
        slug = value;
      } else if (name === "confirm") {
        confirm = CONFIRM_TRUE_VALUES.has(value.toLowerCase());
      } else if (name === "uploadedBy") {
        uploadedBy = value;
      }
    });

    bb.on("file", (name, stream) => {
      if (name !== "zip" || entriesPromise) {
        stream.resume();
        return;
      }
      fileStream = stream;
      entriesPromise = extractZip(stream, maxUploadBytes);
    });

    bb.on("error", fail);
    req.on("error", fail);

    bb.on("close", async () => {
      try {
        let entries: ZipEntry[] | undefined;
        try {
          entries = entriesPromise ? await entriesPromise : undefined;
        } catch (err) {
          // busboy truncates the file part on its own fileSize limit rather
          // than erroring it — the truncated bytes then reach extractZip as
          // a corrupt archive, which throws its own (non-ZipValidationError)
          // parse error. Recognize the truncation and report the size cap
          // instead of letting that raw parse error 500.
          if (fileStream?.truncated) {
            throw new ZipValidationError(`Uploaded zip exceeds the ${maxUploadBytes}-byte limit`);
          }
          throw err;
        }

        if (fileStream?.truncated) {
          throw new ZipValidationError(`Uploaded zip exceeds the ${maxUploadBytes}-byte limit`);
        }

        if (settled) {
          return;
        }
        settled = true;
        resolve({
          slug,
          confirm,
          ...(uploadedBy !== undefined && { uploadedBy }),
          ...(entries !== undefined && { entries }),
        });
      } catch (err) {
        fail(err as Error);
      }
    });

    req.pipe(bb);
  });
}

export function createUploadRouter(deps: UploadRouterDeps): Router {
  const { s3Client, cloudFrontClient, bucket, distributionId, publicDomain, maxUploadBytes } = deps;
  const router = Router();

  router.post("/upload", async (req, res, next) => {
    try {
      const parsed = await parseUpload(req, maxUploadBytes);

      const validation = validateSlug(parsed.slug);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      if (!parsed.entries) {
        res.status(400).json({ error: "Missing zip file" });
        return;
      }

      const { entries, aliasedIndexFrom } = normalizeZipEntries(parsed.entries);
      if (entries.length === 0) {
        res.status(400).json({ error: "Zip contains no usable files" });
        return;
      }

      // Both headIndex and the serving layer key off <slug>/index.html.
      // normalizeZipEntries already aliases a sole root .html file as
      // index.html (common for LLM-generated single-page output), so this
      // only rejects the genuinely ambiguous cases: several root .html files
      // with no index.html among them, or none at all.
      if (!entries.some((entry) => entry.path === "index.html")) {
        res.status(400).json({
          error:
            "Zip must contain an index.html at the root, or exactly one root-level .html file to use as one",
        });
        return;
      }

      const existing = await headIndex(s3Client, bucket, parsed.slug);
      if (existing.exists && !parsed.confirm) {
        res.status(409).json({
          error: `Slug "${parsed.slug}" already exists`,
          ...(existing.uploadedBy !== undefined && { uploadedBy: existing.uploadedBy }),
          ...(existing.uploadedAt !== undefined && { uploadedAt: existing.uploadedAt }),
        });
        return;
      }

      // Only trustworthy once Cloudflare Access sits in front of this origin
      // and sets this header itself (Milestone 2, see docs/PLAN.md); until
      // then any client can spoof it, so it's provenance metadata only —
      // never used for authz.
      const uploadedBy =
        req.get("Cf-Access-Authenticated-User-Email") || parsed.uploadedBy || "anonymous";

      // Delete-then-put per docs/PLAN.md's "replace, not merge" design. A
      // putFile failure mid-loop leaves the old content already gone and the
      // new content partially written — accepted as a PoC-scale tradeoff
      // rather than the more complex put-all-then-delete-orphans ordering.
      await deletePrefix(s3Client, bucket, parsed.slug);

      for (const entry of entries) {
        const isAliasedIndex = entry.path === "index.html" && aliasedIndexFrom !== undefined;
        await putFile(
          s3Client,
          bucket,
          parsed.slug,
          entry.path,
          entry.content,
          resolveContentType(entry.path),
          uploadedBy,
          isAliasedIndex ? { "aliased-from": aliasedIndexFrom } : undefined,
        );
      }

      try {
        await invalidateSlug(cloudFrontClient, distributionId, parsed.slug);
      } catch (err) {
        console.error(`CloudFront invalidation failed for slug "${parsed.slug}":`, err);
      }

      res.json({
        ok: true,
        url: `https://${parsed.slug}.${publicDomain}`,
        fileCount: entries.length,
        ...(aliasedIndexFrom !== undefined && {
          notes: [`Used ${aliasedIndexFrom} as the homepage since no index.html was found`],
        }),
      });
    } catch (err) {
      if (err instanceof ZipValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
