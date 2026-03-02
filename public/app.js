const form = document.getElementById("analyze-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");

const statusLine = document.getElementById("status-line");

const resultCard = document.getElementById("result-card");
const resultContent = document.getElementById("result-content");

const errorCard = document.getElementById("error-card");
const errorMessage = document.getElementById("error-message");

const toggleDebugBtn = document.getElementById("toggle-debug-btn");
const debugPanel = document.getElementById("debug-panel");
const debugPre = document.getElementById("debug-pre");

let lastResult = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();
  if (!url) return;

  setLoading(true);
  hideError();
  hideResult();

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(data?.details || data?.error || `HTTP ${res.status}`);
    }

    lastResult = data;
    renderResult(data);
  } catch (err) {
    showError(String(err?.message || err || "Erro desconhecido"));
  } finally {
    setLoading(false);
  }
});

toggleDebugBtn.addEventListener("click", () => {
  if (debugPanel.classList.contains("hidden")) {
    debugPanel.classList.remove("hidden");
    toggleDebugBtn.textContent = "Ocultar debug";
  } else {
    debugPanel.classList.add("hidden");
    toggleDebugBtn.textContent = "Mostrar debug";
  }
});

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  urlInput.disabled = isLoading;

  statusLine.classList.remove("hidden");
  statusLine.classList.toggle("loading", isLoading);
  statusLine.textContent = isLoading ? "Analisando URL..." : "Pronto.";
}

function hideResult() {
  resultCard.classList.add("hidden");
  resultContent.innerHTML = "";
  debugPanel.classList.add("hidden");
  debugPre.textContent = "";
  toggleDebugBtn.classList.add("hidden");
  toggleDebugBtn.textContent = "Mostrar debug";
}

function hideError() {
  errorCard.classList.add("hidden");
  errorMessage.textContent = "";
}

function showError(msg) {
  errorCard.classList.remove("hidden");
  errorMessage.textContent = msg;
}

function renderResult(out) {
  resultCard.classList.remove("hidden");

  const status = String(out?.status || "UNKNOWN");
  const reason = out?.reason || "";
  const inputUrl = out?.inputUrl || "";
  const found = out?.found;
  const ambiguous = out?.ambiguous;
  const debug = out?.debug;
  const meta = out?.meta;

  const badgeClass =
    status === "FOUND"
      ? "found"
      : status === "AMBIGUOUS"
      ? "ambiguous"
      : status === "NOTFOUND"
      ? "notfound"
      : "rejected";

  let html = `
    <div class="result-status">
      <span class="badge ${badgeClass}">${escapeHtml(status)}</span>
      <span>${statusLabel(status)}</span>
    </div>

    <div class="meta-block">
      <div class="meta-line"><strong>URL:</strong> ${linkify(inputUrl)}</div>
      ${reason ? `<div class="meta-line"><strong>Motivo:</strong> ${escapeHtml(reason)}</div>` : ""}
    </div>
  `;

  if (status === "FOUND" && found) {
    html += `
      <hr />
      <div class="meta-block">
        <div class="meta-line"><strong>Page ID:</strong> ${escapeHtml(found.pageId || "")}</div>
        <div class="meta-line"><strong>Título:</strong> ${escapeHtml(found.title || "(sem título)")}</div>
        ${
          found.pageUrl
            ? `<div class="meta-line"><strong>Notion:</strong> ${linkify(found.pageUrl)}</div>`
            : ""
        }
      </div>
    `;
  }

  if (status === "AMBIGUOUS" && ambiguous?.pageIds?.length) {
    html += `
      <hr />
      <div class="meta-block">
        <div class="meta-line"><strong>Candidatos:</strong></div>
        <ul class="candidates">
          ${ambiguous.pageIds.map((id) => `<li>${escapeHtml(String(id))}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  if (meta) {
    html += `
      <hr />
      <div class="meta-block">
        <div class="meta-line"><strong>Meta:</strong> ${escapeHtml(JSON.stringify(meta))}</div>
      </div>
    `;
  }

  resultContent.innerHTML = html;

  if (debug) {
    debugPre.textContent = JSON.stringify(debug, null, 2);
    toggleDebugBtn.classList.remove("hidden");
  }
}

function statusLabel(status) {
  switch (status) {
    case "FOUND":
      return "Match encontrado";
    case "AMBIGUOUS":
      return "Ambiguidade detectada";
    case "NOTFOUND":
      return "Nenhum match confiável";
    case "REJECTED_404":
      return "URL rejeitada";
    default:
      return "Resultado";
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function linkify(url) {
  const safe = escapeHtml(url);
  if (!safe) return "";
  return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a>`;
}