import path from "node:path";
import type { Readable } from "node:stream";
import unzipper from "unzipper";

export interface ZipEntry {
  path: string;
  content: Buffer;
}

export class ZipValidationError extends Error {}

function normalizeEntryPath(rawPath: string): string {
  if (path.posix.isAbsolute(rawPath)) {
    throw new ZipValidationError(`Zip entry has an absolute path: "${rawPath}"`);
  }

  const normalized = path.posix.normalize(rawPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ZipValidationError(`Zip entry escapes the archive root: "${rawPath}"`);
  }

  return normalized;
}

export function extractZip(source: Readable, maxTotalBytes: number): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  const zip = source.pipe(unzipper.Parse());

  return new Promise<ZipEntry[]>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      zip.destroy();
      reject(err);
    };

    zip.on("entry", (entry: unzipper.Entry) => {
      if (settled) {
        entry.autodrain();
        return;
      }

      if (entry.type === "Directory") {
        entry.autodrain();
        return;
      }

      let normalizedPath: string;
      try {
        normalizedPath = normalizeEntryPath(entry.path);
      } catch (err) {
        entry.autodrain();
        fail(err as Error);
        return;
      }

      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxTotalBytes) {
          fail(new ZipValidationError(`Zip contents exceed the ${maxTotalBytes}-byte limit`));
          return;
        }
        chunks.push(chunk);
      });

      entry.on("end", () => {
        if (!settled) {
          entries.push({ path: normalizedPath, content: Buffer.concat(chunks) });
        }
      });

      entry.on("error", fail);
    });

    zip.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(entries);
      }
    });

    zip.on("error", fail);
  });
}
