// Loaded via WEB_DIRECTORY from this custom node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/** ---------- small helpers ---------- */
function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i];
}
function fmtETA(s) {
  if (s == null) return "—";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
const normalizePath = (p) => (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
function joinPath(base, seg) {
  base = normalizePath(base || "");
  seg  = normalizePath(seg || "");
  if (!base) return seg;
  if (!seg) return base;
  return (base.endsWith("/") ? base : base + "/") + seg;
}

/** ---------- extension ---------- */
app.registerExtension({
  name: "comfyui.aria2.downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Aria2Downloader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      this.properties = this.properties || {};
      this.properties.url = this.properties.url || "";
      this.properties.token = this.properties.token || "";
      this.properties.dest_dir = normalizePath(this.properties.dest_dir || "");
      this.serialize_widgets = true;

      // --- Destination input with dropdown (portaled to body) ---
      const container = document.createElement("div");
      Object.assign(container.style,{ position:"relative", width:"100%" });

      const destInput = document.createElement("input");
      destInput.type="text";
      destInput.placeholder="Destination folder (e.g. C:/Users/you/Downloads or ~/models)";
      Object.assign(destInput.style,{
        width:"100%", height:"26px", padding:"2px 8px",
        border:"1px solid #444", borderRadius:"6px",
        background:"var(--comfy-input-bg, #2a2a2a)", color:"#ddd",
        boxSizing:"border-box", outline:"none"
      });
      destInput.value = this.properties.dest_dir;

      // PORTAL: dropdown in document.body to avoid canvas clipping
      const dropdown = document.createElement("div");
      Object.assign(dropdown.style,{
        position:"fixed",
        background:"#222", border:"1px solid #555",
        zIndex:"999999", display:"none", maxHeight:"200px",
        overflowY:"auto", fontSize:"12px", borderRadius:"6px",
        minWidth:"180px", boxShadow:"0 8px 16px rgba(0,0,0,.35)"
      });
      document.body.appendChild(dropdown);

      const placeDropdown = () => {
        const r = destInput.getBoundingClientRect();
        dropdown.style.left = `${r.left}px`;
        dropdown.style.top  = `${r.bottom + 2}px`;
        dropdown.style.width = `${r.width}px`;
      };

      container.appendChild(destInput);
      const destWidget = this.addDOMWidget("dest_dir","Destination",container);
      destWidget.computeSize = () => [this.size[0]-20, 34];

      let items = [];
      let active = -1;
      let debounceTimer = null;

      const renderDropdown = () => {
        dropdown.innerHTML = "";
        if (!items.length) { dropdown.style.display = "none"; active = -1; return; }

        items.forEach((it, idx)=>{
          const row = document.createElement("div");
          row.textContent = it.name;
          Object.assign(row.style,{
            padding:"6px 10px", cursor:"pointer", whiteSpace:"nowrap",
            background: idx===active ? "#444" : "transparent",
            userSelect: "none"
          });

          row.onmouseenter = ()=>{ active = idx; renderDropdown(); };

          const choose = () => {
            const chosen = normalizePath(it.path);
            destInput.value = chosen;
            this.properties.dest_dir = chosen;
            items = []; active = -1;
            dropdown.style.display="none";
            scheduleFetch(); // show next level immediately
          };

          // use pointerdown so it fires before blur; also prevent default
          row.addEventListener("pointerdown", (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });
          row.addEventListener("mousedown",   (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });

          dropdown.appendChild(row);
        });

        placeDropdown();
        dropdown.style.display = "block";
      };

      const scheduleFetch = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchChildren, 180);
      };

      const fetchChildren = async () => {
        const raw = destInput.value.trim();
        if (!raw) { items = []; renderDropdown(); return; }
        const val = normalizePath(raw);
        try{
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
          items = []; renderDropdown();
        }
      };

      // Replace "\" -> "/" as you type, maintain caret, and fetch
      destInput.addEventListener("input", ()=>{
        const raw = destInput.value;
        const prevStart = destInput.selectionStart;
        const normalized = normalizePath(raw);
        if (normalized !== raw) {
          const delta = normalized.length - raw.length;
          destInput.value = normalized;
          const pos = Math.max(0, (prevStart||0) + delta);
          destInput.setSelectionRange(pos, pos);
        }
        this.properties.dest_dir = normalized;
        placeDropdown();
        scheduleFetch();
      });

      destInput.addEventListener("focus", ()=>{ placeDropdown(); scheduleFetch(); });

      // keyboard navigation
      destInput.addEventListener("keydown", (e)=>{
        if (dropdown.style.display !== "block" || !items.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); active = (active+1) % items.length; renderDropdown(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = (active-1+items.length) % items.length; renderDropdown(); }
        else if (e.key === "Enter") {
          if (active >= 0) {
            e.preventDefault();
            const it = items[active];
            const chosen = normalizePath(it.path);
            destInput.value = chosen;
            this.properties.dest_dir = chosen;
            items = []; active = -1; dropdown.style.display="none";
            scheduleFetch();
          }
        } else if (e.key === "Escape") {
          dropdown.style.display="none"; items=[]; active=-1;
        }
      });

      const hideDropdownSoon = () => { setTimeout(()=>{ dropdown.style.display="none"; }, 120); };
      destInput.addEventListener("blur", hideDropdownSoon);
      const onScroll = () => hideDropdownSoon();
      const onResize = () => hideDropdownSoon();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);

      // --- Inputs (URL + button) ---
      //this.addWidget("text", "URL", this.properties.url, v => this.properties.url = v ?? "");
      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.placeholder = "URL";
      Object.assign(urlInput.style, {
        width:"100%", height:"26px", padding:"2px 8px",
        border:"1px solid #444", borderRadius:"6px",
        background:"var(--comfy-input-bg, #2a2a2a)", color:"#ddd",
        boxSizing:"border-box", outline:"none"
          });
      urlInput.value = this.properties.url || "";  // optional prefill
      const urlWidget = this.addDOMWidget("url", "URL", urlInput);
      urlWidget.computeSize = () => [this.size[0] - 20, 34];

      const tokenInput = document.createElement("input");
      tokenInput.type = "text";
      tokenInput.placeholder = "SECRET TOKEN";
      Object.assign(tokenInput.style, {
        width:"100%", height:"26px", padding:"8px 8px",
        border:"1px solid #444", borderRadius:"6px",
        background:"var(--comfy-input-bg, #2a2a2a)", color:"#ddd",
        boxSizing:"border-box", outline:"none"
          });
      tokenInput.value = this.properties.token || "";  // optional prefill
      const tokenInputWidget = this.addDOMWidget("token", "TOKEN", tokenInput);
      tokenInputWidget.computeSize = () => [this.size[0] - 20, 34];

      const spacer = this.addWidget("info", "", "");
      spacer.computeSize = () => [this.size[0] - 20, 10];

      // --- State for progress view ---
      this.gid = null;
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._pollTimer = null;
      this._filename = "";
      this._filepath = "";

      // Download button (no queue)
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;

        const url = (urlInput.value || "").trim();
        const dest = (this.properties.dest_dir || "").trim();
        if (!url) { this._status = "Missing URL"; this.setDirtyCanvas(true); return; }

        this._status = "Starting…";
        this._progress = 0;
        this._speed = 0;
        this._eta = null;
        this._filename = "";
        this._filepath = "";
        this.setDirtyCanvas(true);

        let resp, data;
        try {
          resp = await api.fetchApi("/aria2/start", {
            method: "POST",
            body: JSON.stringify({ url, dest_dir: dest, token: (tokenInput.value || "").trim() }),
          });
          data = await resp.json();
        } catch {
          this._status = "Error (network)";
          this.setDirtyCanvas(true);
          return;
        }

        if (!resp.ok || data?.error) {
          this._status = `Error: ${data?.error || resp.status}`;
          this.setDirtyCanvas(true);
          return;
        }

        this.gid = data.gid;
        this._status = "Active";
        this.setDirtyCanvas(true);

        const poll = async () => {
          if (!this.gid) return;
          let sResp, s;
          try {
            sResp = await api.fetchApi(`/aria2/status?gid=${encodeURIComponent(this.gid)}`);
            s = await sResp.json();
          } catch {
            this._pollTimer = setTimeout(poll, 700);
            return;
          }

          if (s?.error) {
            this._status = `Error: ${s.error}`;
            this.gid = null;
            this.setDirtyCanvas(true);
            return;
          }

          this._status = s.status || "active";
          this._progress = s.percent ?? 0;
          this._speed = s.downloadSpeed ?? 0;
          this._eta = s.eta ?? null;

          if (s.filename) this._filename = s.filename;
          if (s.filepath) this._filepath = s.filepath;

          this.setDirtyCanvas(true);

          if (["complete", "error", "removed"].includes(this._status)) {
            this.gid = null;
            return;
          }
          this._pollTimer = setTimeout(poll, 500);
        };

        poll();
      });

      // Canvas size & progress UI
      this.size = [460, 300];
      this.onDrawForeground = (ctx) => {
        const pad = 10;
        const w = this.size[0] - pad * 2;
        const barH = 14;
        const yBar = this.size[1] - pad - barH - 4;

        // Status
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#bbb";
        const meta = `Status: ${this._status}   •   Speed: ${fmtBytes(this._speed)}/s   •   ETA: ${fmtETA(this._eta)}`;
        ctx.fillText(meta, pad, yBar - 26);

        // Filename/path
        if (this._filename || this._filepath) {
          const show = this._filepath || this._filename;
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText(`Saved as: ${show}`, pad, yBar - 10);
        }

        // Bar outline
        const radius = 7;
        ctx.lineWidth = 1; ctx.strokeStyle = "#666";
        ctx.beginPath();
        ctx.moveTo(pad + radius, yBar);
        ctx.lineTo(pad + w - radius, yBar);
        ctx.quadraticCurveTo(pad + w, yBar, pad + w, yBar + radius);
        ctx.lineTo(pad + w, yBar + barH - radius);
        ctx.quadraticCurveTo(pad + w, yBar + barH, pad + w - radius, yBar + barH);
        ctx.lineTo(pad + radius, yBar + barH);
        ctx.quadraticCurveTo(pad, yBar + barH, pad, yBar + barH - radius);
        ctx.lineTo(pad, yBar + radius);
        ctx.quadraticCurveTo(pad, yBar, pad + radius, yBar);
        ctx.closePath();
        ctx.stroke();

        // Fill
        const pct = Math.max(0, Math.min(100, this._progress || 0));
        const fillW = Math.round((w * pct) / 100);
        ctx.save();
        ctx.beginPath();
        ctx.rect(pad + 1, yBar + 1, Math.max(0, fillW - 2), barH - 2);
        const g = ctx.createLinearGradient(pad, yBar, pad, yBar + barH);
        g.addColorStop(0, "#9ec7ff");
        g.addColorStop(1, "#4b90ff");
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();

        // % label
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#111";
        ctx.fillText(`${pct.toFixed(0)}%`, pad + w / 2, yBar + barH / 2);
      };

      // Cleanup
      const oldRemoved = this.onRemoved;
      this.onRemoved = function () {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        // remove dropdown + listeners
        if (dropdown && dropdown.parentNode) dropdown.parentNode.removeChild(dropdown);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        if (oldRemoved) oldRemoved.apply(this, arguments);
      };

      // If prefilled, show suggestions right away
      if (destInput.value) setTimeout(()=>destInput.dispatchEvent(new Event("input")), 50);

      return r;
    };
  },
});









