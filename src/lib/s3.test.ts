import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { deletePrefix, headIndex, listPrefix, putFile } from "./s3";

const s3Mock = mockClient(S3Client);
const client = new S3Client({ region: "us-east-1" });
const bucket = "artsy-atelier";

beforeEach(() => {
  s3Mock.reset();
});

describe("headIndex", () => {
  it("returns exists: false when the index object is missing", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("Not Found"), { name: "NotFound" }));

    const result = await headIndex(client, bucket, "marketing-dashboard");
    expect(result).toEqual({ exists: false });
  });

  it("returns the uploader metadata when the index object exists", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      Metadata: {
        "uploaded-by": "roop@artsymail.com",
        "uploaded-at": "2026-07-16T12:00:00.000Z",
      },
    });

    const result = await headIndex(client, bucket, "marketing-dashboard");
    expect(result).toEqual({
      exists: true,
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("re-throws errors other than NotFound", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("Forbidden"), { name: "Forbidden" }));

    await expect(headIndex(client, bucket, "marketing-dashboard")).rejects.toThrow("Forbidden");
  });
});

describe("listPrefix", () => {
  it("returns all keys under the slug prefix", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "marketing-dashboard/index.html" }, { Key: "marketing-dashboard/app.js" }],
      IsTruncated: false,
    });

    const keys = await listPrefix(client, bucket, "marketing-dashboard");
    expect(keys).toEqual(["marketing-dashboard/index.html", "marketing-dashboard/app.js"]);
  });

  it("follows continuation tokens across pages", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "big-site/a.html" }],
        IsTruncated: true,
        NextContinuationToken: "token-1",
      })
      .resolvesOnce({
        Contents: [{ Key: "big-site/b.html" }],
        IsTruncated: false,
      });

    const keys = await listPrefix(client, bucket, "big-site");
    expect(keys).toEqual(["big-site/a.html", "big-site/b.html"]);
  });

  it("returns an empty array when the slug has no objects", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    const keys = await listPrefix(client, bucket, "empty-slug");
    expect(keys).toEqual([]);
  });
});

describe("deletePrefix", () => {
  it("deletes every key found under the prefix in a single batch", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "old-site/index.html" }, { Key: "old-site/app.js" }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const deletedCount = await deletePrefix(client, bucket, "old-site");

    expect(deletedCount).toBe(2);
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.args[0]?.input.Delete?.Objects).toEqual([
      { Key: "old-site/index.html" },
      { Key: "old-site/app.js" },
    ]);
  });

  it("batches deletes in groups of 1000 keys", async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => ({
      Key: `big-site/file-${i}.html`,
    }));
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: keys, IsTruncated: false });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const deletedCount = await deletePrefix(client, bucket, "big-site");

    expect(deletedCount).toBe(1500);
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]?.args[0]?.input.Delete?.Objects).toHaveLength(1000);
    expect(deleteCalls[1]?.args[0]?.input.Delete?.Objects).toHaveLength(500);
  });

  it("does nothing when the slug has no objects", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    const deletedCount = await deletePrefix(client, bucket, "empty-slug");

    expect(deletedCount).toBe(0);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });
});

describe("putFile", () => {
  it("uploads the file with uploader metadata and no-cache headers", async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    await putFile(
      client,
      bucket,
      "marketing-dashboard",
      "index.html",
      "<html></html>",
      "text/html",
      "roop@artsymail.com",
    );

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0]?.input;
    expect(input?.Bucket).toBe(bucket);
    expect(input?.Key).toBe("marketing-dashboard/index.html");
    expect(input?.Body).toBe("<html></html>");
    expect(input?.ContentType).toBe("text/html");
    expect(input?.CacheControl).toBe("no-cache");
    expect(input?.Metadata?.["uploaded-by"]).toBe("roop@artsymail.com");
    expect(input?.Metadata?.["uploaded-at"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
