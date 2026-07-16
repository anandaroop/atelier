import type { PutObjectCommandInput, S3Client } from "@aws-sdk/client-s3";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

export interface HeadIndexResult {
  exists: boolean;
  uploadedBy?: string;
  uploadedAt?: string;
}

const DELETE_BATCH_SIZE = 1000;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "NotFound"
  );
}

export async function headIndex(
  client: S3Client,
  bucket: string,
  slug: string,
): Promise<HeadIndexResult> {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: `${slug}/index.html` }),
    );
    const uploadedBy = result.Metadata?.["uploaded-by"];
    const uploadedAt = result.Metadata?.["uploaded-at"];
    return {
      exists: true,
      ...(uploadedBy !== undefined && { uploadedBy }),
      ...(uploadedAt !== undefined && { uploadedAt }),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { exists: false };
    }
    throw err;
  }
}

export async function listPrefix(
  client: S3Client,
  bucket: string,
  slug: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${slug}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) {
        keys.push(obj.Key);
      }
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

export async function deletePrefix(
  client: S3Client,
  bucket: string,
  slug: string,
): Promise<number> {
  const keys = await listPrefix(client, bucket, slug);
  let deletedCount = 0;
  const failedKeys: string[] = [];

  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    const result = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
    deletedCount += result.Deleted?.length ?? 0;
    for (const error of result.Errors ?? []) {
      if (error.Key) {
        failedKeys.push(error.Key);
      }
    }
  }

  if (failedKeys.length > 0) {
    throw new Error(`Failed to delete ${failedKeys.length} object(s): ${failedKeys.join(", ")}`);
  }

  return deletedCount;
}

export async function putFile(
  client: S3Client,
  bucket: string,
  slug: string,
  path: string,
  body: NonNullable<PutObjectCommandInput["Body"]>,
  contentType: string,
  uploadedBy: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${slug}/${path}`,
      Body: body,
      ContentType: contentType,
      CacheControl: "no-cache",
      Metadata: {
        "uploaded-by": uploadedBy,
        "uploaded-at": new Date().toISOString(),
      },
    }),
  );
}
