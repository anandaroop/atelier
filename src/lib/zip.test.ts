import { Readable } from "node:stream";
import {
  extractZip,
  normalizeZipEntries,
  promoteSoleRootHtmlToIndex,
  stripCommonRoot,
  stripMacosJunk,
  ZipValidationError,
} from "./zip";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Hand-rolled, uncompressed ("store") zip builder for tests. Real zip-writer
 * libraries (archiver, yazl) sanitize or reject escaping entry paths, which
 * makes them unusable for building zip-slip fixtures.
 */
function buildZip(entries: Array<{ path: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, "utf8");
    const contentBuf = Buffer.from(entry.content, "utf8");
    const crc = crc32(contentBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(contentBuf.length, 18);
    localHeader.writeUInt32LE(contentBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, contentBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(contentBuf.length, 20);
    centralHeader.writeUInt32LE(contentBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + contentBuf.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDirectory, eocd]);
}

function bufferToStream(buffer: Buffer): Readable {
  return Readable.from([buffer]);
}

describe("extractZip", () => {
  it("extracts every file entry with its path and content", async () => {
    const zip = buildZip([
      { path: "index.html", content: "<html></html>" },
      { path: "assets/app.js", content: "console.log('hi')" },
    ]);

    const entries = await extractZip(bufferToStream(zip), 1024 * 1024);

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.path).sort()).toEqual(["assets/app.js", "index.html"]);
    const index = entries.find((e) => e.path === "index.html");
    expect(index?.content.toString("utf8")).toBe("<html></html>");
  });

  it("skips directory entries", async () => {
    const zip = buildZip([{ path: "assets/", content: "" }]);

    const entries = await extractZip(bufferToStream(zip), 1024 * 1024);

    expect(entries).toEqual([]);
  });

  it("rejects an entry whose path escapes the archive root via ..", async () => {
    const zip = buildZip([{ path: "../escape.html", content: "gotcha" }]);

    await expect(extractZip(bufferToStream(zip), 1024 * 1024)).rejects.toThrow(ZipValidationError);
  });

  it("rejects an entry with an absolute path", async () => {
    const zip = buildZip([{ path: "/etc/passwd", content: "gotcha" }]);

    await expect(extractZip(bufferToStream(zip), 1024 * 1024)).rejects.toThrow(ZipValidationError);
  });

  it("rejects an entry escaping the root via a Windows-style backslash path", async () => {
    const zip = buildZip([{ path: "..\\..\\escape.html", content: "gotcha" }]);

    await expect(extractZip(bufferToStream(zip), 1024 * 1024)).rejects.toThrow(ZipValidationError);
  });

  it("rejects an entry whose path contains a null byte", async () => {
    const zip = buildZip([{ path: "index.html\0.png", content: "gotcha" }]);

    await expect(extractZip(bufferToStream(zip), 1024 * 1024)).rejects.toThrow(ZipValidationError);
  });

  it("rejects mid-stream once total uncompressed bytes exceed the cap", async () => {
    const zip = buildZip([
      { path: "big.txt", content: "a".repeat(1000) },
      { path: "also-big.txt", content: "b".repeat(1000) },
    ]);

    await expect(extractZip(bufferToStream(zip), 500)).rejects.toThrow(ZipValidationError);
  });

  it("allows total uncompressed bytes exactly equal to the cap", async () => {
    const zip = buildZip([{ path: "exact.txt", content: "a".repeat(500) }]);

    const entries = await extractZip(bufferToStream(zip), 500);

    expect(entries).toHaveLength(1);
  });

  it("rejects when the source stream errors instead of hanging", async () => {
    const source = new Readable({
      read() {
        this.emit("error", new Error("aborted upload"));
      },
    });

    await expect(extractZip(source, 1024 * 1024)).rejects.toThrow("aborted upload");
  });
});

describe("stripMacosJunk", () => {
  it("drops the __MACOSX sidecar directory", () => {
    const entries = [
      { path: "index.html", content: Buffer.from("") },
      { path: "__MACOSX/index.html", content: Buffer.from("") },
      { path: "__MACOSX/nested/._app.js", content: Buffer.from("") },
    ];

    expect(stripMacosJunk(entries).map((e) => e.path)).toEqual(["index.html"]);
  });

  it("drops .DS_Store at any depth", () => {
    const entries = [
      { path: "index.html", content: Buffer.from("") },
      { path: ".DS_Store", content: Buffer.from("") },
      { path: "assets/.DS_Store", content: Buffer.from("") },
    ];

    expect(stripMacosJunk(entries).map((e) => e.path)).toEqual(["index.html"]);
  });

  it("drops AppleDouble ._ resource-fork files at any depth", () => {
    const entries = [
      { path: "index.html", content: Buffer.from("") },
      { path: "._index.html", content: Buffer.from("") },
      { path: "assets/._app.js", content: Buffer.from("") },
    ];

    expect(stripMacosJunk(entries).map((e) => e.path)).toEqual(["index.html"]);
  });

  it("does not touch legitimate filenames that merely contain an underscore or dot", () => {
    const entries = [
      { path: "my_file.txt", content: Buffer.from("") },
      { path: "data.config.js", content: Buffer.from("") },
    ];

    expect(stripMacosJunk(entries)).toEqual(entries);
  });
});

describe("stripCommonRoot", () => {
  it("collapses a single wrapping directory shared by every entry", () => {
    const entries = [
      { path: "site/index.html", content: Buffer.from("a") },
      { path: "site/assets/app.js", content: Buffer.from("b") },
    ];

    expect(stripCommonRoot(entries).map((e) => e.path)).toEqual(["index.html", "assets/app.js"]);
  });

  it("leaves entries untouched when they already sit at the zip root", () => {
    const entries = [
      { path: "index.html", content: Buffer.from("a") },
      { path: "assets/app.js", content: Buffer.from("b") },
    ];

    expect(stripCommonRoot(entries)).toEqual(entries);
  });

  it("leaves entries untouched when they don't share a single common root", () => {
    const entries = [
      { path: "site/index.html", content: Buffer.from("a") },
      { path: "other/thing.txt", content: Buffer.from("b") },
    ];

    expect(stripCommonRoot(entries)).toEqual(entries);
  });

  it("handles a single-file zip with no wrapping directory", () => {
    const entries = [{ path: "index.html", content: Buffer.from("a") }];

    expect(stripCommonRoot(entries)).toEqual(entries);
  });
});

describe("promoteSoleRootHtmlToIndex", () => {
  it("aliases a sole root .html file as index.html when none exists", () => {
    const entries = [
      { path: "art-history-quiz.html", content: Buffer.from("<html>quiz</html>") },
      { path: "assets/quiz.css", content: Buffer.from("body {}") },
    ];

    const result = promoteSoleRootHtmlToIndex(entries);

    expect(result.aliasedIndexFrom).toBe("art-history-quiz.html");
    expect(result.entries).toEqual([
      ...entries,
      { path: "index.html", content: Buffer.from("<html>quiz</html>") },
    ]);
  });

  it("leaves entries untouched when index.html already exists", () => {
    const entries = [
      { path: "index.html", content: Buffer.from("a") },
      { path: "extra.html", content: Buffer.from("b") },
    ];

    const result = promoteSoleRootHtmlToIndex(entries);

    expect(result).toEqual({ entries });
  });

  it("does not guess when there's more than one root-level .html file", () => {
    const entries = [
      { path: "page1.html", content: Buffer.from("a") },
      { path: "page2.html", content: Buffer.from("b") },
    ];

    const result = promoteSoleRootHtmlToIndex(entries);

    expect(result).toEqual({ entries });
  });

  it("does not promote a nested .html file — only root-level counts", () => {
    const entries = [{ path: "pages/quiz.html", content: Buffer.from("a") }];

    const result = promoteSoleRootHtmlToIndex(entries);

    expect(result).toEqual({ entries });
  });
});

describe("normalizeZipEntries", () => {
  it("strips macOS junk and a wrapping directory together, matching a Finder-compressed folder", () => {
    // extractZip already omits directory entries themselves (e.g. "test-upload/"),
    // so real output never includes one — only its contained files do.
    const entries = [
      { path: "test-upload/index.html", content: Buffer.from("<html></html>") },
      { path: "__MACOSX/test-upload/._index.html", content: Buffer.from("junk") },
    ];

    const result = normalizeZipEntries(entries);

    expect(result.entries).toEqual([{ path: "index.html", content: Buffer.from("<html></html>") }]);
    expect(result.aliasedIndexFrom).toBeUndefined();
  });

  it("composes common-root stripping with sole-html aliasing for an LLM-generated single page", () => {
    // A Finder-compressed folder containing exactly one descriptively-named
    // HTML file — the exact shape LLM coding assistants tend to produce.
    const entries = [
      { path: "quiz-site/art-history-quiz.html", content: Buffer.from("<html>quiz</html>") },
      { path: "__MACOSX/quiz-site/._art-history-quiz.html", content: Buffer.from("junk") },
    ];

    const result = normalizeZipEntries(entries);

    expect(result.aliasedIndexFrom).toBe("art-history-quiz.html");
    expect(result.entries).toEqual([
      { path: "art-history-quiz.html", content: Buffer.from("<html>quiz</html>") },
      { path: "index.html", content: Buffer.from("<html>quiz</html>") },
    ]);
  });
});
