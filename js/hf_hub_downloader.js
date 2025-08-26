import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  const { style, ...rest } = attrs || {};
  if (rest) Object.assign(n, rest);
  if (style && typeof style === "object") Object.assign(n.style, style);
  for (const c of children) n.append(c);
  return n;
}

// Inject CSS for indeterminate bar (scoped + forced blue)
(function ensureIndeterminateStyle() {
  let style = document.getElementById("hf-indeterminate-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "hf-indeterminate-style";
  style.textContent = `
@keyframes hfIndeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
/* Scoped to our wrapper */
.az-hf-hub-downloader .hf-track {
  position: relative !important;
  height: 12px !important;
  background: #222 !important;
  border-radius: 6px !important;
  overflow: hidden !important;
  width: 100% !important;
}
.az-hf-hub-downloader .hf-bar {
  position: absolute !important;
  inset: 0 auto 0 0 !important;
  width: 36% !important;
  border-radius: 6px !important;
  animation: hfIndeterminate 1.1s linear infinite !important;
  background: #0084ff !important;   /* force the blue */
  opacity: 0.95 !important;
}
`;
  document.head.appendChild(style);
})();

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // ====== UI (DOM) ======
    const wrap = el("div", {
      className: "az-hf-hub-downloader",  // scope for CSS
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        width: "100%",
        padding: "10px",
        boxSizing: "border-box",
      }
    });

    const repoInput = el("input", {
      type: "text",
      placeholder: "Repository ID (e.g. runwayml/stable-diffusion-v1-5)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const fileInput = el("input", {
      type: "text",
      placeholder: "Filename (e.g. model.safetensors)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const tokenInput = el("input", {
      type: "text",
      placeholder: "Secret Token, if any",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const destInput = el("input", {
      type: "text",
      placeholder: "Destination folder (e.g. ./models)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    // === Dropdown overlay anchored to destInput (append to body, not inside wrap) ===
    const dropdown = el("div", {
      style: {
        position: "fixed",
        background: "#222",
        border: "1px solid #555",
        display: "none",
        maxHeight: "200px",
        overflowY: "auto",
        fontSize: "12px",
        borderRadius: "6px",
        boxShadow: "0 8px 16px rgba(0,0,0,.35)",
        zIndex: "999999",
        minWidth: "180px"
      }
    });
    document.body.appendChild(dropdown);

    // helper to place overlay under the input
    const placeDropdown = () => {
      const r = destInput.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top  = `${r.bottom + 2}px`;
      dropdown.style.width = `${r.width}px`;
    };

    // Append inputs (do NOT append dropdown here; it's body-level)
    wrap.append(repoInput, tokenInput, fileInput, destInput);

    // Indeterminate progress bar
    const progressTrack = el("div", { className: "hf-track", style: { display: "none" } });
    const progressIndet = el("div", { className: "hf-bar" });
    progressTrack.append(progressIndet);

    const statusText = el("div", {
      style: { fontSize: "12px", color: "#ccc", minHeight: "16px", textAlign: "center" },
      textContent: "Ready"
    });

    const buttonRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "center" } });
    const downloadBtn = el("button", { textContent: "Download", style: { padding: "6px 12px", cursor: "pointer" } });
    const stopBtn = el("button", { textContent: "Stop", disabled: true, style: { padding: "6px 12px", cursor: "pointer" } });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(progressTrack, statusText, buttonRow);

    // ================= folder autocomplete logic =================
    let items = [];
    let active = -1;
    let debounceTimer = null;
    const normalizePath = (p) => (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const joinPath = (a, b) => normalizePath((a?.endsWith("/") ? a : a + "/") + (b || ""));

    const renderDropdown = () => {
      dropdown.innerHTML = "";
      if (!items.length) { dropdown.style.display = "none"; active = -1; return; }

      items.forEach((it, idx) => {
        const row = document.createElement("div");
        row.textContent = it.name;
        Object.assign(row.style, {
          padding: "6px 10px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          background: idx === active ? "#444" : "transparent",
          userSelect: "none"
        });

        row.onmouseenter = () => { active = idx; renderDropdown(); };
        const choose = () => {
          const chosen = normalizePath(it.path);
          destInput.value = chosen;
          node.properties.dest_dir = chosen;
          items = []; active = -1;
          dropdown.style.display = "none";
          scheduleFetch(); // show next level immediately
        };
        // fire before blur; keep focus
        row.addEventListener("pointerdown", (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });
        row.addEventListener("mousedown",   (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });

        dropdown.appendChild(row);
      });

      placeDropdown();                 // anchor to input
      dropdown.style.display = "block";
    };

    const scheduleFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchChildren, 180);
    };

    async function fetchChildren() {
      const raw = destInput.value.trim();
      if (!raw) { items = []; renderDropdown(); return; }
      const val = normalizePath(raw);
      try {
        const resp = await api.fetchApi(`/az/listdir?path=${encodeURIComponent(val)}`);
        const data = await resp.json();
        if (data?.ok && Array.isArray(data.folders)) {
          items = data.folders.map(f => ({
            name: f.name,
            path: joinPath(data.root || val, f.name)
          }));
        } else {
          items = [];
        }
        active = items.length ? 0 : -1;
        renderDropdown();
      } catch {
        items = [];
        renderDropdown();
      }
    }

    // typing
    destInput.addEventListener("input", () => {
      const raw = destInput.value;
      const prevStart = destInput.selectionStart;
      const normalized = normalizePath(raw);
      if (normalized !== raw) {
        const delta = normalized.length - raw.length;
        destInput.value = normalized;
        const pos = Math.max(0, (prevStart||0) + delta);
        destInput.setSelectionRange(pos, pos);
      }
      node.properties.dest_dir = normalized;
      placeDropdown();
      scheduleFetch();
    });

    destInput.addEventListener("focus", () => { placeDropdown(); scheduleFetch(); });

    // keyboard nav
    destInput.addEventListener("keydown", (e) => {
      if (dropdown.style.display !== "block" || !items.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = (active+1) % items.length; renderDropdown(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = (active-1+items.length) % items.length; renderDropdown(); }
      else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        const it = items[active];
        destInput.value = normalizePath(it.path);
        node.properties.dest_dir = destInput.value;
        items = []; active = -1; dropdown.style.display = "none";
        scheduleFetch();
      } else if (e.key === "Escape") {
        dropdown.style.display = "none"; items=[]; active=-1;
      }
    });

    // hide shortly after blur so clicks register
    const hideDropdownSoon = () => setTimeout(()=> { dropdown.style.display = "none"; }, 120);
    destInput.addEventListener("blur", hideDropdownSoon);

    const onScroll = () => {if (dropdown.style.display === "block" && document.body.contains(destInput)) {placeDropdown(); }};
    const onResize = () => {if (dropdown.style.display === "block") placeDropdown();};
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    // Add DOM widget with fixed min height (unchanged)
    const MIN_W = 460;
    const MIN_H = 230;
    node.addDOMWidget("hf_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => MIN_H
    });

    // ====== Size fixes (unchanged except original logic) ======
    const MAX_H = 300;
    node.size = [
      Math.max(node.size?.[0] || MIN_W, MIN_W),
      Math.max(node.size?.[1] || MIN_H, MIN_H),
    ];
    const prevOnResize = node.onResize;
    node.onResize = function() {
      this.size[0] = Math.max(this.size[0], MIN_W);
      this.size[1] = Math.min(Math.max(this.size[1], MIN_H), MAX_H);
      if (prevOnResize) prevOnResize.apply(this, arguments);
    };

    // ====== State ======
    node.gid = null;
    node._pollInterval = null;
    node._pollCount = 0;

    function showBar(on) {
      progressTrack.style.display = on ? "block" : "none"; // force block
    }
    function setButtons(running) {
      downloadBtn.disabled = !!running;
      stopBtn.disabled = !running;
    }
    function stopPolling() {
      if (node._pollInterval) {
        clearInterval(node._pollInterval);
        node._pollInterval = null;
      }
    }
    function resetToIdle(msg = "Ready") {
      setButtons(false);
      showBar(false);
      statusText.textContent = msg;
      node.gid = null;
      stopPolling();
      node._pollCount = 0;
    }

    function startPolling() {
      stopPolling();
      node._pollCount = 0;
      node._pollInterval = setInterval(async () => {
        if (!node.gid || node._pollCount > 200) {
          resetToIdle("Ready");
          return;
        }
        node._pollCount++;
        try {
          const res = await fetch(`/hf/status?gid=${encodeURIComponent(node.gid)}`, { method: "GET" });
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const st = await res.json();
          if (st.error) {
            resetToIdle(`Error: ${st.error}`);
            return;
          }
          const state = st.state || st.status;
          if (state === "starting" || state === "running") {
            statusText.textContent = st.msg || "Download started...";
            showBar(true);
            setButtons(true);
            return;
          }
          if (state === "done" || state === "complete") {
            statusText.textContent = st.msg ? `✅ ${st.msg}` : "✅ File download complete";
            showBar(false);
            setButtons(false);
            node.gid = null;
            stopPolling();
            return;
          }
          if (state === "stopped") {
            resetToIdle(st.msg || "Stopped.");
            return;
          }
          if (state === "error") {
            resetToIdle(st.msg ? `Error: ${st.msg}` : "Error.");
            return;
          }
        } catch (e) {
          console.warn("Status poll failed:", e);
          if (node._pollCount > 10) {
            resetToIdle(`Error: ${e.message}`);
          }
        }
      }, 1000);
    }

    // ====== Buttons ======
    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();
      const token_input = tokenInput.value.trim();
      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill all fields";
        showBar(false);
        return;
      }
      setButtons(true);
      statusText.textContent = "Starting download...";
      showBar(false);
      try {
        const res = await fetch("/hf/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_id, filename, dest_dir, token_input, })
        });
        if (!res.ok) throw new Error(`Start ${res.status}`);
        const out = await res.json();
        if (out.error) {
          resetToIdle(`Error: ${out.error}`);
          return;
        }
        node.gid = out.gid;
        statusText.textContent = "Download started...";
        showBar(true);
        startPolling();
      } catch (e) {
        resetToIdle(`Failed to start: ${e.message}`);
      }
    };

    stopBtn.onclick = async () => {
      if (!node.gid) {
        resetToIdle("Stopped.");
        return;
      }
      try {
        await fetch("/hf/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gid: node.gid })
        });
        resetToIdle("Stopped.");
      } catch (e) {
        resetToIdle(`Error stopping: ${e.message}`);
      }
    };

    // ====== Init ======
    node.size[0] = Math.max(node.size[0], MIN_W);
    resetToIdle("Ready");

    // Cleanup
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      // existing cleanup
      stopPolling();
      if (wrap && wrap.parentNode) wrap.remove();

      // new: remove listeners and the body overlay
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      try { dropdown.remove(); } catch {}

      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
