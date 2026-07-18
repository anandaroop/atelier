import { deriveSlug, validateSlug } from "./slug";

describe("validateSlug", () => {
  it("accepts valid DNS-safe slugs", () => {
    expect(validateSlug("marketing-dashboard")).toEqual({ valid: true });
    expect(validateSlug("a")).toEqual({ valid: true });
    expect(validateSlug("abc123")).toEqual({ valid: true });
    expect(validateSlug("a".repeat(63))).toEqual({ valid: true });
  });

  it("rejects uppercase characters", () => {
    expect(validateSlug("Marketing-Dashboard").valid).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(validateSlug("marketing_dashboard").valid).toBe(false);
    expect(validateSlug("marketing dashboard").valid).toBe(false);
    expect(validateSlug("marketing.dashboard").valid).toBe(false);
  });

  it("rejects leading or trailing hyphens", () => {
    expect(validateSlug("-marketing").valid).toBe(false);
    expect(validateSlug("marketing-").valid).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(validateSlug("").valid).toBe(false);
  });

  it("rejects slugs longer than 63 characters", () => {
    expect(validateSlug("a".repeat(64)).valid).toBe(false);
  });

  it("rejects reserved names", () => {
    for (const reserved of ["atelier", "www", "api", "upload", "admin"]) {
      const result = validateSlug(reserved);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/reserved/i);
    }
  });
});

describe("deriveSlug", () => {
  it("derives a slug from a folder zip's filename", () => {
    expect(deriveSlug("my-portfolio.zip")).toEqual({ valid: true, slug: "my-portfolio" });
  });

  it("strips a trailing .html before slugifying a single-file zip", () => {
    expect(deriveSlug("mypage.html.zip")).toEqual({ valid: true, slug: "mypage" });
    expect(deriveSlug("mondrian_generative_art.html.zip")).toEqual({
      valid: true,
      slug: "mondrian-generative-art",
    });
  });

  it("strips a trailing .htm before slugifying", () => {
    expect(deriveSlug("report.htm.zip")).toEqual({ valid: true, slug: "report" });
  });

  it("strips extensions case-insensitively", () => {
    expect(deriveSlug("Page.HTML.ZIP")).toEqual({ valid: true, slug: "page" });
  });

  it("slugifies spaces and mixed case", () => {
    expect(deriveSlug("My Cool Site.zip")).toEqual({ valid: true, slug: "my-cool-site" });
  });

  it("trims leading and trailing hyphens produced by slugification", () => {
    expect(deriveSlug("__My Site__.zip")).toEqual({ valid: true, slug: "my-site" });
  });

  it("caps the slug at 63 characters and trims a trailing hyphen left by truncation", () => {
    const longName = `${"a".repeat(62)} b.zip`;
    const result = deriveSlug(longName);
    expect(result.valid).toBe(true);
    expect(result.slug).toHaveLength(62);
    expect(result.slug?.endsWith("-")).toBe(false);
  });

  it("reports an error when nothing usable remains after stripping", () => {
    expect(deriveSlug("___.zip")).toEqual({
      valid: false,
      error: "Couldn't derive a name from that filename — try renaming the zip.",
    });
  });

  it("flows the derived slug through validateSlug for reserved names", () => {
    const result = deriveSlug("upload.zip");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/reserved/i);
    expect(result.slug).toBe("upload");
  });
});
