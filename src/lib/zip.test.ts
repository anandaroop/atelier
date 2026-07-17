import { Readable } from "node:stream";
import { extractZip, ZipValidationError } from "./zip";

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
