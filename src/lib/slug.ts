// NOTE: public/app.js carries a hand-synced mirror of this validation logic
// (it's a dependency-free classic script with no build step, so it can't
// import this module). If you change these rules, update that mirror too.

export interface SlugValidationResult {
  valid: boolean;
  error?: string;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_SLUGS = new Set(["atelier", "www", "api", "upload", "admin"]);

export function validateSlug(slug: string): SlugValidationResult {
  if (!SLUG_PATTERN.test(slug)) {
    return {
      valid: false,
      error:
        "Slug must be lowercase alphanumeric with hyphens, 1-63 characters, and cannot start or end with a hyphen",
    };
  }

  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: `Slug "${slug}" is reserved` };
  }

  return { valid: true };
}
