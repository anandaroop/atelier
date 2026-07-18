import { deriveSlug } from "./deriveSlug";

describe("deriveSlug", () => {
  it("strips the .zip extension, case-insensitively", () => {
    expect(deriveSlug("marketing-dashboard.zip")).toEqual({
      valid: true,
      slug: "marketing-dashboard",
    });
    expect(deriveSlug("Marketing-Dashboard.ZIP").slug).toBe("marketing-dashboard");
  });

  it("lowercases and collapses non-alphanumeric runs into single hyphens", () => {
    expect(deriveSlug("My Site!!.zip").slug).toBe("my-site");
    expect(deriveSlug("Q3_Report (final).zip").slug).toBe("q3-report-final");
  });

  it("trims leading and trailing hyphens", () => {
    expect(deriveSlug("--marketing--.zip").slug).toBe("marketing");
    expect(deriveSlug("!!!hello!!!.zip").slug).toBe("hello");
  });

  it("caps at 63 characters and re-trims a trailing hyphen left by the cap", () => {
    const derived = deriveSlug(`${"a".repeat(63)}-overflow.zip`);
    expect(derived.slug).toBe("a".repeat(63));

    // 62 a's then a hyphen lands exactly on the cap boundary, which would
    // leave a dangling trailing hyphen if not re-trimmed.
    const boundary = deriveSlug(`${"a".repeat(62)}-b.zip`);
    expect(boundary.slug).toBe("a".repeat(62));
    expect(boundary.slug?.endsWith("-")).toBe(false);
  });

  it("reports an error when nothing survives sanitization", () => {
    expect(deriveSlug("___.zip")).toEqual({
      valid: false,
      error: "Couldn't derive a name from that filename — try renaming the zip.",
    });
    expect(deriveSlug(".zip").valid).toBe(false);
  });

  it("delegates to validateSlug for reserved names", () => {
    const derived = deriveSlug("admin.zip");
    expect(derived.valid).toBe(false);
    expect(derived.error).toMatch(/reserved/i);
    expect(derived.slug).toBe("admin");
  });
});
