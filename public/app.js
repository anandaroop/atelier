(() => {
  // Mirrors src/lib/slug.ts — kept in sync by hand since this is a
  // dependency-free classic script with no build step to share it.
  const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const RESERVED_SLUGS = new Set(["atelier", "www", "api", "upload", "admin"]);

  // Client-side heads-up only — mirrors the server's default
  // MAX_UPLOAD_BYTES (see .env.example). The server is authoritative and
  // enforces its own configured limit regardless of this value.
  const MAX_UPLOAD_BYTES = 52428800;

  const form = document.getElementById("upload-form");
  const slugInput = document.getElementById("slug");
  const slugMsg = document.getElementById("slug-msg");
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const fileNameEl = document.getElementById("file-name");
  const overwriteEl = document.getElementById("overwrite");
  const overwriteMsg = document.getElementById("overwrite-msg");
  const overwriteConfirm = document.getElementById("overwrite-confirm");
  const progressEl = document.getElementById("progress");
  const statusEl = document.getElementById("status");
  const submitBtn = document.getElementById("submit");
  const resultEl = document.getElementById("result");

  let selectedFile = null;
  let checkSequence = 0;
  let pendingFormData = null;

  function debounce(fn, waitMs) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), waitMs);
    };
  }

  function validateSlugLocal(slug) {
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

  function isZipFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      return true;
    }
    return file.type === "application/zip" || file.type === "application/x-zip-compressed";
  }

  function formatRelativeTime(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) {
      return iso;
    }
    const diffMs = Date.now() - then;
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  // data.notes / data.error can echo back attacker-controlled strings (e.g.
  // an uploaded zip's filename), so anything server-provided must be
  // escaped before landing in innerHTML.
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function describeExisting(data) {
    const who = data.uploadedBy || "someone";
    const when = data.uploadedAt ? formatRelativeTime(data.uploadedAt) : "previously";
    return `${who} uploaded here ${when} — uploading will overwrite it.`;
  }

  function setSlugMsg(text, isError) {
    slugMsg.textContent = text;
    slugMsg.hidden = !text;
    slugMsg.classList.toggle("error", Boolean(isError));
  }

  function hideOverwrite() {
    overwriteEl.hidden = true;
    overwriteMsg.textContent = "";
    overwriteConfirm.checked = false;
    pendingFormData = null;
  }

  function showOverwrite(data) {
    overwriteMsg.textContent = describeExisting(data);
    overwriteEl.hidden = false;
  }

  function setResult(html) {
    resultEl.innerHTML = html;
  }

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function setProgress(fraction) {
    if (fraction === null) {
      progressEl.hidden = true;
      return;
    }
    progressEl.hidden = false;
    progressEl.value = Math.round(fraction * 100);
  }

  const runCheck = debounce((slug) => {
    const sequence = ++checkSequence;
    fetch(`/check?slug=${encodeURIComponent(slug)}`)
      .then((res) => res.json())
      .then((data) => {
        if (sequence !== checkSequence) {
          return; // a newer check has since started; ignore this stale response
        }
        if (data.exists) {
          setSlugMsg(describeExisting(data), false);
        } else {
          setSlugMsg("", false);
        }
      })
      .catch(() => {
        if (sequence === checkSequence) {
          setSlugMsg("", false);
        }
      });
  }, 300);

  slugInput.addEventListener("input", () => {
    const slug = slugInput.value.trim();
    hideOverwrite();

    if (!slug) {
      setSlugMsg("", false);
      return;
    }

    const validation = validateSlugLocal(slug);
    if (!validation.valid) {
      checkSequence++; // invalidate any in-flight check for the previous value
      setSlugMsg(validation.error, true);
      return;
    }

    // Clear any stale local-validation error immediately — otherwise it
    // lingers until the debounced /check call resolves, which can take a
    // while (or hang) on a slow connection.
    setSlugMsg("", false);
    runCheck(slug);
  });

  function setFile(file) {
    if (!file) {
      return;
    }
    selectedFile = file;
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    fileNameEl.textContent = `${file.name} (${sizeMb} MB)`;
    fileNameEl.hidden = false;

    if (!isZipFile(file)) {
      setResult('<p class="error">Please choose a .zip file.</p>');
    } else if (file.size > MAX_UPLOAD_BYTES) {
      setResult('<p class="error">That file is larger than the upload limit.</p>');
    } else {
      setResult("");
    }
  }

  // A real <button>, so Enter/Space already trigger a native "click" —
  // no manual keydown handling needed for keyboard activation.
  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

  ["dragenter", "dragover"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("drag-active");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag-active");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files[0];
    setFile(file);
  });

  function handleResponse(status, data, formData) {
    setProgress(null);
    setStatus("");
    submitBtn.disabled = false;
    overwriteConfirm.disabled = false;

    if (!data) {
      setResult('<p class="error">Something went wrong — please retry.</p>');
      return;
    }

    if (status === 200 && data.ok) {
      hideOverwrite();
      const url = escapeHtml(data.url);
      const notes = Array.isArray(data.notes)
        ? data.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("")
        : "";
      setResult(
        `<p class="success">Live at <a href="${url}" target="_blank" rel="noopener">${url}</a> (${data.fileCount} files)</p>${notes}`,
      );
      return;
    }

    if (status === 409) {
      pendingFormData = formData;
      showOverwrite(data);
      setResult('<p class="error">Confirm the overwrite above, then upload again.</p>');
      return;
    }

    const message = data.error ? escapeHtml(data.error) : "Something went wrong — please retry.";
    setResult(`<p class="error">${message}</p>`);
  }

  function upload(formData) {
    setResult("");
    setStatus("Uploading…");
    setProgress(0);
    submitBtn.disabled = true;
    // Guards against a re-toggled confirm checkbox firing a second upload
    // for the same pending overwrite while this one is still in flight.
    overwriteConfirm.disabled = true;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        setProgress(event.loaded / event.total);
      }
    });
    xhr.upload.addEventListener("load", () => {
      setProgress(1);
      setStatus("Processing…");
    });

    xhr.addEventListener("load", () => {
      handleResponse(xhr.status, safeJson(xhr.responseText), formData);
    });
    xhr.addEventListener("error", () => {
      setProgress(null);
      setStatus("");
      submitBtn.disabled = false;
      overwriteConfirm.disabled = false;
      setResult('<p class="error">Network error — please retry.</p>');
    });

    xhr.send(formData);
  }

  overwriteConfirm.addEventListener("change", () => {
    if (!overwriteConfirm.checked || !pendingFormData) {
      return;
    }
    pendingFormData.set("confirm", "true");
    upload(pendingFormData);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const slug = slugInput.value.trim();
    const validation = validateSlugLocal(slug);
    if (!validation.valid) {
      setSlugMsg(validation.error, true);
      return;
    }

    if (!selectedFile) {
      setResult('<p class="error">Please choose a .zip file.</p>');
      return;
    }
    if (!isZipFile(selectedFile)) {
      setResult('<p class="error">Please choose a .zip file.</p>');
      return;
    }

    const formData = new FormData();
    formData.set("slug", slug);
    formData.set("zip", selectedFile, selectedFile.name);

    upload(formData);
  });
})();
