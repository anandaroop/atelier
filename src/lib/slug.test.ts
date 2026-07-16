import { validateSlug } from "./slug";

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
