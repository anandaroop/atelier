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

export interface DeriveSlugResult extends SlugValidationResult {
  slug?: string;
}

/**
 * Turns a dropped zip's filename into a candidate slug: strip the .zip
 * extension, then a trailing .html/.htm — Finder names a single-file zip
 * after the file including its extension (e.g. mypage.html -> mypage.html.zip),
 * so without this the slug would pick up a stray "-html" — then lowercase,
 * collapse anything non-alphanumeric into hyphens, trim the ends, and cap at
 * the 63-char slug limit.
 */
export function deriveSlug(filename: string): DeriveSlugResult {
  let slug = filename
    .replace(/\.zip$/i, "")
    .replace(/\.html?$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  slug = slug.slice(0, 63).replace(/-+$/g, "");

  if (!slug) {
    return {
      valid: false,
      error: "Couldn't derive a name from that filename — try renaming the zip.",
    };
  }
  return { ...validateSlug(slug), slug };
}
