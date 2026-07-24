(() => {
  // Mirrors src/lib/slug.ts (validateSlug) and src/lib/deriveSlug.ts
  // (deriveSlug) — kept in sync by hand since this is a dependency-free
  // classic script with no build step to share them. Those files are the
  // tested source of truth (see their *.test.ts); if you change the
  // sanitization/validation rules here, update them (and their tests) too.
  const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const RESERVED_SLUGS = new Set([
    "atelier",
    "atelier-staging",
    "www",
    "staging",
    "api",
    "api-staging",
    "upload",
    "upload-staging",
    "admin",
    "admin-staging",
  ]);

  // Client-side heads-up only — mirrors the server's default
  // MAX_UPLOAD_BYTES (see .env.example). The server is authoritative and
  // enforces its own configured limit regardless of this value.
  const MAX_UPLOAD_BYTES = 52428800;

  const fileInput = document.getElementById("file-input");
  const statusEl = document.getElementById("status");
  const browseTrigger = document.getElementById("browse-trigger");
  const clickTarget = document.getElementById("click-target");

  let uploading = false;
  let pendingFormData = null;
  let dragDepth = 0;

  function validateSlug(slug) {
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

  // Turns a dropped zip's filename into a candidate slug: strip the
  // extension, lowercase, collapse anything non-alphanumeric into hyphens,
  // trim the ends, then cap at the server's 63-char limit.
  // Mirrors src/lib/deriveSlug.ts — that's the tested copy; update both.
  function deriveSlug(filename) {
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

  function isZipFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      return true;
    }
    return file.type === "application/zip" || file.type === "application/x-zip-compressed";
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  // The live URL is server-provided; escape before it lands in innerHTML.
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  // Conventional "opens in a new tab" glyph (Feather/Heroicons "external
  // link") — a box with an arrow escaping its corner. stroke="currentColor"
  // so it inherits the surrounding link's color; sized via CSS (.status a
  // svg) so it scales with the text instead of a fixed pixel size.
  const EXTERNAL_LINK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
    '<polyline points="15 3 21 3 21 9"></polyline>' +
    '<line x1="10" y1="14" x2="21" y2="3"></line>' +
    "</svg>";

  function showIdle() {
    statusEl.hidden = true;
    statusEl.className = "status";
    statusEl.innerHTML = "";
  }

  function showBusy(text) {
    statusEl.hidden = false;
    statusEl.className = "status";
    statusEl.textContent = text;
  }

  function showError(message) {
    statusEl.hidden = false;
    statusEl.className = "status error";
    statusEl.textContent = message;
  }

  function showSuccess(data) {
    statusEl.hidden = false;
    statusEl.className = "status success";
    const url = escapeHtml(data.url);
    statusEl.innerHTML = `<span class="line">Your site is live!</span><a class="url" href="${url}" target="_blank" rel="noopener" title="Opens in a new tab">${url}${EXTERNAL_LINK_ICON}</a>`;
  }

  // uploadedBy is best-effort provenance, not verified identity — it may be
  // an Access email, a free-text form value, "anonymous", or absent
  // entirely. Shown in full (not just the local-part): Access spans two
  // Google Workspace domains (Artsy and Artnet), so two people can share a
  // local-part, and the domain is what disambiguates them. Returns null
  // when there's nothing worth displaying.
  function formatUploader(value) {
    return !value || value === "anonymous" ? null : value;
  }

  // uploadedAt is a server-generated ISO timestamp (S3 object metadata) —
  // safe to trust, but still validated since it may be absent on
  // older/anonymous uploads. Returns null when it can't be parsed.
  const RELATIVE_UNITS = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const relativeTimeFormatter =
    typeof Intl !== "undefined" && Intl.RelativeTimeFormat
      ? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
      : null;

  function formatRelativeTime(iso) {
    if (!iso || !relativeTimeFormatter) {
      return null;
    }
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) {
      return null;
    }
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 60) {
      return relativeTimeFormatter.format(0, "minute"); // "now"-ish, but keep granularity coarse
    }
    for (const [unit, unitSeconds] of RELATIVE_UNITS) {
      if (seconds >= unitSeconds) {
        return relativeTimeFormatter.format(-Math.floor(seconds / unitSeconds), unit);
      }
    }
    return relativeTimeFormatter.format(-Math.floor(seconds / 60), "minute");
  }

  // Builds "Uploaded by roop 37 minutes ago", degrading gracefully when
  // either half is unavailable, or omitting the line entirely when neither
  // is. uploadedBy is untrusted free text — escaped, never used raw.
  function formatAttribution(uploadedBy, uploadedAt) {
    const who = formatUploader(uploadedBy);
    const when = formatRelativeTime(uploadedAt);
    if (who && when) {
      return `uploaded by ${escapeHtml(who)} ${escapeHtml(when)}`;
    }
    if (who) {
      return `uploaded by ${escapeHtml(who)}`;
    }
    if (when) {
      return `uploaded ${escapeHtml(when)}`;
    }
    return null;
  }

  function showConfirm(slug, formData, uploadedBy, uploadedAt) {
    pendingFormData = formData;
    statusEl.hidden = false;
    statusEl.className = "status confirm";
    const attribution = formatAttribution(uploadedBy, uploadedAt);
    const displayUrl = escapeHtml(`${slug}.artsy.dev`);
    const href = `https://${displayUrl}`;
    // slug is client-derived from SLUG_PATTERN, so it can't contain
    // markup — no escaping needed for it specifically. attribution is
    // already escaped by formatAttribution before it reaches this template.
    // target="_blank" opens the existing site in a new tab (like the
    // post-upload success link) so checking it doesn't lose the pending
    // confirm state held in `pendingFormData`.
    statusEl.innerHTML = `
      <span class="line">There is already a site at <a href="${href}" target="_blank" rel="noopener" title="Opens in a new tab">${displayUrl}${EXTERNAL_LINK_ICON}</a></span>
      <span class="line">Overwrite?
      <button type="button" class="link-btn" data-action="confirm-yes">Yes</button>
      /
      <button type="button" class="link-btn" data-action="confirm-no">No</button>
      </span>
      ${attribution ? `<span class="line fine-print">The current site was ${attribution}</span>` : ""}
    `;
  }

  function handleResponse(status, data, formData, slug) {
    uploading = false;

    if (!data) {
      showError("Something went wrong — please retry.");
      return;
    }
    if (status === 200 && data.ok) {
      showSuccess(data);
      return;
    }
    if (status === 409) {
      showConfirm(slug, formData, data.uploadedBy, data.uploadedAt);
      return;
    }
    showError(data.error || "Something went wrong — please retry.");
  }

  function upload(formData, slug) {
    uploading = true;
    showBusy("Uploading…");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        showBusy(`Uploading… ${Math.round((event.loaded / event.total) * 100)}%`);
      }
    });
    xhr.upload.addEventListener("load", () => showBusy("Processing…"));

    xhr.addEventListener("load", () => {
      handleResponse(xhr.status, safeJson(xhr.responseText), formData, slug);
    });
    xhr.addEventListener("error", () => {
      uploading = false;
      showError("Network error — please retry.");
    });

    xhr.send(formData);
  }

  function handleFile(file) {
    if (!file || uploading) {
      return;
    }
    if (!isZipFile(file)) {
      showError("Please drop a .zip file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showError("That file is larger than the upload limit.");
      return;
    }

    const derived = deriveSlug(file.name);
    if (!derived.valid) {
      showError(derived.error);
      return;
    }

    const formData = new FormData();
    formData.set("slug", derived.slug);
    formData.set("zip", file, file.name);
    upload(formData, derived.slug);
  }

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("drag-active");
  });
  window.addEventListener("dragover", (event) => {
    event.preventDefault(); // required on every dragover to allow a drop
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      document.body.classList.remove("drag-active");
    }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("drag-active");
    handleFile(event.dataTransfer?.files[0]);
  });

  fileInput.addEventListener("change", () => {
    handleFile(fileInput.files[0]);
    fileInput.value = ""; // allow re-selecting the same file later
  });

  // Whole page is the drop target, but click-to-browse is scoped to the
  // tagline/status area (not the giant title) so clicking elsewhere on the
  // page doesn't surprise the user with a file picker. Excludes the status
  // area entirely once it has content (busy/error/confirm/success text)
  // since that's informational/interactive, not an upload prompt. Relies on
  // the status click listener below calling stopPropagation() — it may
  // clear #status's contents (detaching event.target) before this handler
  // runs, which would otherwise make a closest("#status") check here fail.
  clickTarget.addEventListener("click", (event) => {
    if (uploading || event.target.closest("#status")) {
      return;
    }
    fileInput.click();
  });

  // Keyboard/screen-reader entry point — drag-and-drop and click-anywhere
  // are both pointer-only. A real <button>, so Enter/Space already work.
  browseTrigger.addEventListener("click", () => {
    if (!uploading) {
      fileInput.click();
    }
  });

  statusEl.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || !pendingFormData) {
      return;
    }
    if (action === "confirm-yes") {
      const slug = pendingFormData.get("slug");
      pendingFormData.set("confirm", "true");
      upload(pendingFormData, slug);
      pendingFormData = null;
    } else if (action === "confirm-no") {
      pendingFormData = null;
      showIdle();
    }
  });
})();
