// The one piece of client-side code in Bench Notes, served same-origin at
// GET /bench/static/bench.js (Access-gated, same as every other route here)
// and allowed by a page-specific CSP override (script-src 'self', still no
// inline script, still no third party) only on the pages that need it.
//
// Its whole job: get a file's bytes into R2 directly via PUT, with a
// progress bar, without ever making the Worker buffer them in memory — a
// large file buffered whole is exactly what crashed the original,
// server-only upload (Workers have a hard, unforgiving 128 MB isolate
// memory ceiling — see bench-working.js's own header). Once the bytes are
// safely in R2, every other field on the page still submits as a plain
// form POST, same as the rest of this app; this script never replaces that.
//
// Also handles live audio recording via MediaRecorder, for the "record or
// upload" note-per-document feature — a recording is just a Blob handed to
// the exact same upload path a chosen file would take.
export const BENCH_CLIENT_JS = `(function () {
  "use strict";

  function uploadBlob(file, onProgress) {
    return new Promise((resolve, reject) => {
      var blobId = crypto.randomUUID();
      var xhr = new XMLHttpRequest();
      xhr.open("PUT", "/bench/blobs/" + blobId);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name || "file"));
      xhr.upload.addEventListener("progress", function (e) {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener("load", function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ blobId: blobId, filename: file.name || "file", contentType: file.type || "application/octet-stream" });
        } else {
          var message = "Upload failed (" + xhr.status + ").";
          try {
            var parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.error) message = parsed.error;
          } catch (e) { /* not JSON — keep the generic message */ }
          reject(new Error(message));
        }
      });
      xhr.addEventListener("error", function () { reject(new Error("Upload failed — connection lost.")); });
      xhr.addEventListener("abort", function () { reject(new Error("Upload cancelled.")); });
      xhr.send(file);
    });
  }

  function showStatus(el, message, isError) {
    if (!el) return;
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
    el.className = "upload-status" + (isError ? " error" : "");
  }

  function wireBlobUploadForm(form) {
    var fileInput = form.querySelector("[data-blob-file]");
    var submitButton = form.querySelector('button[type="submit"]');
    var statusEl = form.querySelector("[data-upload-status]");
    var progressEl = form.querySelector("[data-upload-progress]");
    var idField = form.querySelector("[data-blob-id]");
    var nameField = form.querySelector("[data-blob-filename]");
    var typeField = form.querySelector("[data-blob-content-type]");
    if (!fileInput) return;
    var alreadyUploadedFor = null;

    form.addEventListener("submit", function (e) {
      var file = fileInput.files[0];
      // No file chosen at all is a valid submit for a form whose file input
      // isn't required (a text-only recording note) — let it POST normally.
      if (!file) return;
      if (idField.value && alreadyUploadedFor === file) return; // this exact file is already up
      e.preventDefault();
      submitButton.disabled = true;
      showStatus(statusEl, "Uploading " + file.name + "…", false);
      if (progressEl) { progressEl.style.display = "block"; progressEl.value = 0; }
      uploadBlob(file, function (frac) { if (progressEl) progressEl.value = frac; })
        .then(function (result) {
          idField.value = result.blobId;
          nameField.value = result.filename;
          typeField.value = result.contentType;
          alreadyUploadedFor = file;
          showStatus(statusEl, "Uploaded. Saving…", false);
          form.submit();
        })
        .catch(function (err) {
          submitButton.disabled = false;
          showStatus(statusEl, err.message, true);
        });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("form[data-blob-upload]"), wireBlobUploadForm);

  // Recording capture — a button[data-record] targeting a
  // form[data-blob-upload] by id, filling in that form's file input with
  // the recorded audio so the upload path above handles it exactly like a
  // chosen file. Record, stop, it uploads and submits. No editing, no
  // re-recording in place — stop and record again if it's wrong.
  Array.prototype.forEach.call(document.querySelectorAll("[data-record]"), function (button) {
    var targetForm = document.getElementById(button.getAttribute("data-record"));
    if (!targetForm) return;
    var fileInput = targetForm.querySelector("[data-blob-file]");
    var timerEl = targetForm.querySelector("[data-record-timer]");
    var statusEl = targetForm.querySelector("[data-upload-status]");
    var mediaRecorder = null;
    var chunks = [];
    var startedAt = 0;
    var timerHandle = null;

    function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

    button.addEventListener("click", function () {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        chunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.addEventListener("dataavailable", function (e) { if (e.data.size > 0) chunks.push(e.data); });
        mediaRecorder.addEventListener("stop", function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          stopTimer();
          button.textContent = "● Record";
          var mimeType = mediaRecorder.mimeType || "audio/webm";
          var blob = new Blob(chunks, { type: mimeType });
          var ext = mimeType.indexOf("mp4") !== -1 ? "m4a" : "webm";
          var file = new File([blob], "recording-" + Date.now() + "." + ext, { type: mimeType });
          var dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          targetForm.querySelector('button[type="submit"]').click();
        });
        mediaRecorder.start();
        startedAt = Date.now();
        button.textContent = "⏹ Stop";
        if (timerEl) {
          timerHandle = setInterval(function () {
            var secs = Math.floor((Date.now() - startedAt) / 1000);
            var m = Math.floor(secs / 60);
            var s = secs % 60;
            timerEl.textContent = (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
          }, 250);
        }
      }).catch(function (err) {
        showStatus(statusEl, "Couldn't access the microphone: " + err.message, true);
      });
    });
  });
})();
`;
