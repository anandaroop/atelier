(() => {
  // Mirrors src/lib/slug.ts — kept in sync by hand since this is a
  // dependency-free classic script with no build step to share it.
  const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const RESERVED_SLUGS = new Set(["atelier", "www", "api", "upload", "admin"]);

  // Client-side heads-up only — mirrors the server's default
  // MAX_UPLOAD_BYTES (see .env.example). The server is authoritative and
  // enforces its own configured limit regardless of this value.
  const MAX_UPLOAD_BYTES = 52428800;

  const fileInput = document.getElementById("file-input");
  const statusEl = document.getElementById("status");

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
    statusEl.innerHTML = `<span class="line">Your site is live!</span><a class="url" href="${url}" target="_blank" rel="noopener">${url}</a>`;
  }

  function showConfirm(slug, formData) {
    pendingFormData = formData;
    statusEl.hidden = false;
    statusEl.className = "status confirm";
    // slug is client-derived from SLUG_PATTERN, so it can't contain
    // markup — no escaping needed for it specifically.
    statusEl.innerHTML = `
      <span class="line">There is already a site at ${slug}.artsy.dev</span>
      <span class="line">Overwrite?
        <button type="button" class="link-btn" data-action="confirm-yes">Yes</button>
        /
        <button type="button" class="link-btn" data-action="confirm-no">No</button>
      </span>
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
      showConfirm(slug, formData);
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

  // Whole page is the drop target, so clicking anywhere opens the file
  // picker — except on interactive elements the status area renders
  // (the live-site link, the overwrite confirm buttons).
  document.body.addEventListener("click", (event) => {
    if (uploading || event.target.closest("a, button")) {
      return;
    }
    fileInput.click();
  });

  statusEl.addEventListener("click", (event) => {
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
