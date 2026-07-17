import { resolveContentType } from "./mime";

describe("resolveContentType", () => {
  it("resolves common extensions to their content type", () => {
    expect(resolveContentType("index.html")).toBe("text/html");
    expect(resolveContentType("styles.css")).toBe("text/css");
    expect(resolveContentType("app.js")).toBe("text/javascript");
    expect(resolveContentType("data.json")).toBe("application/json");
    expect(resolveContentType("logo.png")).toBe("image/png");
  });

  it("resolves a nested path by its filename", () => {
    expect(resolveContentType("assets/img/logo.svg")).toBe("image/svg+xml");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(resolveContentType("archive.unknownext")).toBe("application/octet-stream");
  });

  it("falls back to application/octet-stream for a path with no extension", () => {
    expect(resolveContentType("Makefile")).toBe("application/octet-stream");
  });
});
