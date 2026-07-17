import type { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import type { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import request from "supertest";
import { invalidateSlug } from "../lib/cloudfront";
import { deletePrefix, headIndex, putFile } from "../lib/s3";
import { extractZip, ZipValidationError } from "../lib/zip";
import { errorHandler } from "../middleware/errorHandler";
import { createUploadRouter } from "./upload";

jest.mock("../lib/s3");
// Keep the real ZipValidationError class — a plain jest.mock() automocks it
// too, which drops its constructor logic and leaves err.message empty.
jest.mock("../lib/zip", () => ({
  ...jest.requireActual("../lib/zip"),
  extractZip: jest.fn(),
}));
jest.mock("../lib/cloudfront");

const mockHeadIndex = headIndex as jest.MockedFunction<typeof headIndex>;
const mockDeletePrefix = deletePrefix as jest.MockedFunction<typeof deletePrefix>;
const mockPutFile = putFile as jest.MockedFunction<typeof putFile>;
const mockExtractZip = extractZip as jest.MockedFunction<typeof extractZip>;
const mockInvalidateSlug = invalidateSlug as jest.MockedFunction<typeof invalidateSlug>;

const s3Client = {} as S3Client;
const cloudFrontClient = {} as CloudFrontClient;
const bucket = "artsy-atelier";
const distributionId = "E123EXAMPLE";
const publicDomain = "artsy.dev";
const maxUploadBytes = 52428800;

const ZIP_ENTRIES = [
  { path: "index.html", content: Buffer.from("<html></html>") },
  { path: "assets/app.js", content: Buffer.from("console.log(1)") },
];

// extractZip is mocked below, so it never actually reads the busboy file
// stream it's handed. Without draining it here, busboy's internal parser
// never finishes consuming that part and its "close" event never fires —
// the request hangs. Every mock implementation must resume() the stream,
// whether it goes on to resolve or reject.
function resolvingExtractZip(entries: typeof ZIP_ENTRIES) {
  return (stream: NodeJS.ReadableStream) => {
    stream.resume();
    return Promise.resolve(entries);
  };
}

function rejectingExtractZip(err: Error) {
  return (stream: NodeJS.ReadableStream) => {
    stream.resume();
    return Promise.reject(err);
  };
}

function buildApp(overrides: { maxUploadBytes?: number } = {}) {
  const app = express();
  app.use(
    createUploadRouter({
      s3Client,
      cloudFrontClient,
      bucket,
      distributionId,
      publicDomain,
      maxUploadBytes,
      ...overrides,
    }),
  );
  app.use(errorHandler);
  return app;
}

// `null` (not the default `undefined`) means "send no zip file" — a default
// parameter value is substituted even when a caller explicitly passes
// `undefined`, so `undefined` can't be used as the "omit it" signal here.
function postUpload(
  fields: Record<string, string> = {},
  zipBuffer: Buffer | null = Buffer.from("PK\x03\x04fake"),
) {
  let req = request(buildApp()).post("/upload");
  for (const [key, value] of Object.entries(fields)) {
    req = req.field(key, value);
  }
  if (zipBuffer) {
    req = req.attach("zip", zipBuffer, "site.zip");
  }
  return req;
}

beforeEach(() => {
  mockHeadIndex.mockReset().mockResolvedValue({ exists: false });
  mockDeletePrefix.mockReset().mockResolvedValue(0);
  mockPutFile.mockReset().mockResolvedValue(undefined);
  mockExtractZip.mockReset().mockImplementation(resolvingExtractZip(ZIP_ENTRIES));
  mockInvalidateSlug.mockReset().mockResolvedValue(undefined);
});

describe("POST /upload", () => {
  it("uploads a fresh slug and returns the live URL", async () => {
    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      url: "https://marketing-dashboard.artsy.dev",
      fileCount: 2,
    });

    expect(mockDeletePrefix).toHaveBeenCalledWith(s3Client, bucket, "marketing-dashboard");
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "marketing-dashboard",
      "index.html",
      ZIP_ENTRIES[0]?.content,
      "text/html",
      "anonymous",
      undefined,
    );
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "marketing-dashboard",
      "assets/app.js",
      ZIP_ENTRIES[1]?.content,
      "text/javascript",
      "anonymous",
      undefined,
    );
    expect(mockInvalidateSlug).toHaveBeenCalledWith(
      cloudFrontClient,
      distributionId,
      "marketing-dashboard",
    );
  });

  it("strips a Finder-compressed wrapping folder and its __MACOSX junk before writing to S3", async () => {
    mockExtractZip.mockImplementation(
      resolvingExtractZip([
        { path: "test-upload/index.html", content: Buffer.from("<html></html>") },
        { path: "__MACOSX/test-upload/._index.html", content: Buffer.from("junk") },
      ]),
    );

    const res = await postUpload({ slug: "test-upload" });

    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(1);
    expect(mockPutFile).toHaveBeenCalledTimes(1);
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "test-upload",
      "index.html",
      Buffer.from("<html></html>"),
      "text/html",
      "anonymous",
      undefined,
    );
  });

  it("aliases a sole root .html file as index.html and notes it in the response", async () => {
    mockExtractZip.mockImplementation(
      resolvingExtractZip([
        { path: "art-history-quiz.html", content: Buffer.from("<html>quiz</html>") },
        { path: "assets/quiz.css", content: Buffer.from("body {}") },
      ]),
    );

    const res = await postUpload({ slug: "art-quiz" });

    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(3);
    expect(res.body.notes).toEqual([
      "Used art-history-quiz.html as the homepage since no index.html was found",
    ]);
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "art-quiz",
      "art-history-quiz.html",
      Buffer.from("<html>quiz</html>"),
      "text/html",
      "anonymous",
      undefined,
    );
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "art-quiz",
      "index.html",
      Buffer.from("<html>quiz</html>"),
      "text/html",
      "anonymous",
      { "aliased-from": "art-history-quiz.html" },
    );
  });

  it("rejects a zip with multiple root-level .html files and no index.html", async () => {
    mockExtractZip.mockImplementation(
      resolvingExtractZip([
        { path: "page1.html", content: Buffer.from("a") },
        { path: "page2.html", content: Buffer.from("b") },
      ]),
    );

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html/i);
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("rejects a zip that contains nothing but macOS junk", async () => {
    mockExtractZip.mockImplementation(
      resolvingExtractZip([{ path: "__MACOSX/._index.html", content: Buffer.from("junk") }]),
    );

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no usable files/i);
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("rejects a zip with no root index.html", async () => {
    mockExtractZip.mockImplementation(
      resolvingExtractZip([{ path: "assets/app.js", content: Buffer.from("console.log(1)") }]),
    );

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("rejects an existing slug without confirm, surfacing the prior uploader/time", async () => {
    mockHeadIndex.mockResolvedValue({
      exists: true,
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Slug "marketing-dashboard" already exists',
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("replaces an existing slug when confirm is set", async () => {
    mockHeadIndex.mockResolvedValue({
      exists: true,
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });

    const res = await postUpload({ slug: "marketing-dashboard", confirm: "true" });

    expect(res.status).toBe(200);
    expect(mockDeletePrefix).toHaveBeenCalledWith(s3Client, bucket, "marketing-dashboard");
    expect(mockPutFile).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid slug with a 4xx and clear message", async () => {
    // extractZip is still invoked here — busboy streams the "slug" field and
    // the "zip" file part concurrently, so the zip is already extracted by
    // the time the route gets to validate the slug. What matters is that no
    // S3 write happens for an invalid slug.
    const res = await postUpload({ slug: "Bad_Slug" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowercase/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("rejects a reserved slug with a 4xx and clear message", async () => {
    const res = await postUpload({ slug: "admin" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reserved/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
  });

  it("rejects a request with no zip file", async () => {
    const res = await postUpload({ slug: "marketing-dashboard" }, null);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zip/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
  });

  it("rejects a zip-slip / oversized zip with a 4xx surfacing the validation message", async () => {
    mockExtractZip.mockImplementation(
      rejectingExtractZip(
        new ZipValidationError('Zip entry escapes the archive root: "../escape"'),
      ),
    );

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/escapes the archive root/i);
    expect(mockDeletePrefix).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
  });

  it("surfaces busboy's fileSize truncation as a 400, not a 500", async () => {
    // busboy truncates the file part in place rather than erroring it once
    // its own fileSize limit is hit; the truncated bytes then reach
    // extractZip as a corrupt archive. Simulate that: a generic parse error
    // (not ZipValidationError) from extractZip on a stream that busboy has
    // marked truncated.
    mockExtractZip.mockImplementation((stream) => {
      stream.resume();
      return Promise.reject(new Error("invalid signature (readSlice)"));
    });

    const res = await request(buildApp({ maxUploadBytes: 5 }))
      .post("/upload")
      .field("slug", "marketing-dashboard")
      .attach("zip", Buffer.from("PK\x03\x04 this archive is well over five bytes"), "site.zip");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/byte limit/i);
  });

  it("still returns 200 when CloudFront invalidation fails, logging the error", async () => {
    mockInvalidateSlug.mockRejectedValue(
      Object.assign(new Error("Throttled"), { name: "Throttling" }),
    );
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const res = await postUpload({ slug: "marketing-dashboard" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("stamps the form uploadedBy field when no Access header is present", async () => {
    await postUpload({ slug: "marketing-dashboard", uploadedBy: "roop@artsymail.com" });

    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "marketing-dashboard",
      "index.html",
      expect.anything(),
      expect.anything(),
      "roop@artsymail.com",
      undefined,
    );
  });

  it("prefers the Cf-Access-Authenticated-User-Email header over the form field", async () => {
    const res = await request(buildApp())
      .post("/upload")
      .set("Cf-Access-Authenticated-User-Email", "access@artsymail.com")
      .field("slug", "marketing-dashboard")
      .field("uploadedBy", "roop@artsymail.com")
      .attach("zip", Buffer.from("PK\x03\x04fake"), "site.zip");

    expect(res.status).toBe(200);
    expect(mockPutFile).toHaveBeenCalledWith(
      s3Client,
      bucket,
      "marketing-dashboard",
      "index.html",
      expect.anything(),
      expect.anything(),
      "access@artsymail.com",
      undefined,
    );
  });
});
