import { type SlugValidationResult, validateSlug } from "./slug";

// NOTE: public/app.js carries a hand-synced mirror of this logic (it's a
// dependency-free classic script with no build step, so it can't import this
// module). If you change the sanitization rules here, update that mirror —
// and its comment pointing back here — too. See public/app.js's `deriveSlug`.

export interface DeriveSlugResult extends SlugValidationResult {
  slug?: string;
}

// Turns a dropped zip's filename into a candidate slug: strip the extension,
// lowercase, collapse anything non-alphanumeric into hyphens, trim the ends,
// then cap at the server's 63-char limit.
export function deriveSlug(filename: string): DeriveSlugResult {
  let slug = filename
    .replace(/\.zip$/i, "")
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
