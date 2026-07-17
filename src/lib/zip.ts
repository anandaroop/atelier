import path from "node:path";
import type { Readable } from "node:stream";
import unzipper from "unzipper";

export interface ZipEntry {
  path: string;
  content: Buffer;
}

export class ZipValidationError extends Error {}

function normalizeEntryPath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new ZipValidationError(`Zip entry path contains a null byte: "${rawPath}"`);
  }

  const posixPath = rawPath.replace(/\\/g, "/");

  if (path.posix.isAbsolute(posixPath)) {
    throw new ZipValidationError(`Zip entry has an absolute path: "${rawPath}"`);
  }

  const normalized = path.posix.normalize(posixPath);
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

    source.on("error", fail);

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

const MACOS_JUNK_PATTERN = /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]+$)/;

/**
 * Drops macOS Finder zip artifacts (the `__MACOSX/` sidecar directory,
 * `.DS_Store`, and `._*` AppleDouble resource-fork files) that ride along
 * whenever someone zips a folder via Finder's "Compress" action.
 */
export function stripMacosJunk(entries: ZipEntry[]): ZipEntry[] {
  return entries.filter((entry) => !MACOS_JUNK_PATTERN.test(entry.path));
}

/**
 * Collapses a single common wrapping directory (e.g. zipping a folder
 * itself, rather than its contents, produces every entry nested under
 * `<folder-name>/`) so `index.html` lands at the site root. Leaves entries
 * untouched unless every one of them shares the same top-level directory.
 */
export function stripCommonRoot(entries: ZipEntry[]): ZipEntry[] {
  const first = entries[0];
  if (!first) {
    return entries;
  }

  const slashIndex = first.path.indexOf("/");
  if (slashIndex === -1) {
    return entries;
  }

  const prefix = first.path.slice(0, slashIndex + 1);
  if (!entries.every((entry) => entry.path.startsWith(prefix))) {
    return entries;
  }

  return entries
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
    .filter((entry) => entry.path.length > 0);
}

const ROOT_HTML_PATTERN = /^[^/]+\.html?$/i;

export interface PromoteIndexResult {
  entries: ZipEntry[];
  aliasedIndexFrom?: string;
}

/**
 * When a zip has no root `index.html` but exactly one root-level `.html`
 * file, aliases that file's content as `index.html` too — LLM-generated
 * single-page output is rarely named `index.html` (e.g. `art-history-quiz.html`).
 * Adds a second copy rather than renaming, so the original filename (and any
 * links to it) keeps working. Left alone when there's more than one root
 * `.html` file, since there's no way to guess the intended entry point.
 */
export function promoteSoleRootHtmlToIndex(entries: ZipEntry[]): PromoteIndexResult {
  if (entries.some((entry) => entry.path === "index.html")) {
    return { entries };
  }

  const rootHtmlEntries = entries.filter((entry) => ROOT_HTML_PATTERN.test(entry.path));
  const sole = rootHtmlEntries.length === 1 ? rootHtmlEntries[0] : undefined;
  if (!sole) {
    return { entries };
  }

  return {
    entries: [...entries, { path: "index.html", content: sole.content }],
    aliasedIndexFrom: sole.path,
  };
}

/** Prepares raw `extractZip` output for upload: strip macOS junk, collapse a common wrapping folder, then alias a sole root .html file as index.html if needed. */
export function normalizeZipEntries(entries: ZipEntry[]): PromoteIndexResult {
  return promoteSoleRootHtmlToIndex(stripCommonRoot(stripMacosJunk(entries)));
}
