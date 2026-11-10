/* HA Browser panel: tabs, address bar and bookmarks around sandboxed proxy iframes. */
const PANEL_VERSION = "0.1.6";
const LS_TABS = "ha_browser_tabs_v1";
const LS_BM = "ha_browser_bookmarks_v1";
const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation";

const STYLE = `
:host { display:block; height:100%; background:var(--primary-background-color); color:var(--primary-text-color); }
.root { display:flex; flex-direction:column; height:100%; }
button { font:inherit; color:inherit; background:none; border:0; cursor:pointer; border-radius:8px;
  display:inline-flex; align-items:center; justify-content:center; min-width:36px; height:36px; padding:0 6px; }
button:hover { background:var(--secondary-background-color); }
.tabs { display:flex; align-items:center; gap:4px; padding:6px 8px 0; background:var(--app-header-background-color, var(--card-background-color)); overflow-x:auto; }
.tablist { display:flex; gap:2px; flex:1; min-width:0; }
.tab { display:flex; align-items:center; gap:6px; max-width:200px; min-width:90px; flex:0 1 200px; height:34px; padding:0 4px 0 10px;
  border-radius:8px 8px 0 0; background:var(--secondary-background-color); cursor:pointer; font-size:13px; }
.tab.active { background:var(--primary-background-color); font-weight:500; }
.tab .t { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tab button { min-width:22px; height:22px; border-radius:50%; font-size:14px; }
.bar { display:flex; align-items:center; gap:2px; padding:6px 8px; border-bottom:1px solid var(--divider-color); }
.omni { flex:1; min-width:0; height:36px; border-radius:18px; border:1px solid var(--divider-color); padding:0 16px;
  background:var(--card-background-color); color:inherit; font:inherit; outline:none; }
.omni:focus { border-color:var(--primary-color); }
.progress { height:2px; background:transparent; } .progress.on { background:var(--primary-color); animation:pulse 1s infinite alternate; }
@keyframes pulse { from{opacity:.25} to{opacity:1} }
.content { position:relative; flex:1; min-height:0; }
iframe { position:absolute; inset:0; width:100%; height:100%; border:0; background:#fff; }
iframe.hidden, .home.hidden { display:none; }
.home { position:absolute; inset:0; overflow:auto; padding:32px 16px; box-sizing:border-box; }
.home h2 { text-align:center; font-weight:400; margin:0 0 4px; }
.home p { text-align:center; color:var(--secondary-text-color); margin:0 0 24px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px; max-width:900px; margin:0 auto; }
.bm { position:relative; flex-direction:column; height:88px; background:var(--card-background-color); border:1px solid var(--divider-color); gap:4px; }
.bm .ic { width:32px; height:32px; border-radius:50%; background:var(--primary-color); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:600; }
.bm .l { font-size:12px; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bm .rm { position:absolute; top:2px; right:2px; min-width:20px; height:20px; font-size:12px; opacity:.5; }
.root { padding-bottom:env(safe-area-inset-bottom); box-sizing:border-box; }
.dbg { height:40%; display:flex; flex-direction:column; border-top:1px solid var(--divider-color); background:var(--card-background-color); }
.dbg.hidden { display:none; }
.dbghead { display:flex; gap:4px; padding:4px 8px; border-bottom:1px solid var(--divider-color); }
.dbghead button { font-size:12px; height:28px; padding:0 10px; border:1px solid var(--divider-color); }
.dbglog { flex:1; margin:0; overflow:auto; font:11px/1.4 monospace; white-space:pre-wrap; word-break:break-all; padding:6px 8px; user-select:text; }
.menu { display:none; }
:host([narrow]) .menu { display:inline-flex; }
`;

class HaBrowserPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tabs = [];
    this._active = null;
    this._session = null;
    this._hass = null;
    this._nextId = 1;
    this._logs = [];
    this._onMessage = this._onMessage.bind(this);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }
  set narrow(v) { v ? this.setAttribute("narrow", "") : this.removeAttribute("narrow"); }
  set panel(_p) {}

  connectedCallback() { window.addEventListener("message", this._onMessage); }
  disconnectedCallback() {
    window.removeEventListener("message", this._onMessage);
    clearInterval(this._keepalive);
    if (this._ro) this._ro.disconnect();
    clearInterval(this._watchdog);
  }

  // ---------------------------------------------------------------- setup
  async _init() {
    const $ = this.shadowRoot;
    $.innerHTML = `<style>${STYLE}</style>
      <div class="root">
        <div class="tabs">
          <button class="menu" data-act="menu" title="Menu"><ha-icon icon="mdi:menu"></ha-icon></button>
          <div class="tablist"></div>
          <button data-act="newtab" title="New tab"><ha-icon icon="mdi:plus"></ha-icon></button>
        </div>
        <div class="bar">
          <button data-act="back" title="Back"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
          <button data-act="forward" title="Forward"><ha-icon icon="mdi:arrow-right"></ha-icon></button>
          <button data-act="reload" title="Reload"><ha-icon icon="mdi:refresh"></ha-icon></button>
          <button data-act="home" title="Home"><ha-icon icon="mdi:home-outline"></ha-icon></button>
          <input class="omni" spellcheck="false" autocapitalize="off" autocomplete="off"
                 placeholder="Search or enter address">
          <button data-act="bookmark" title="Bookmark this page"><ha-icon icon="mdi:star-outline"></ha-icon></button>
          <button data-act="debug" title="Diagnostics"><ha-icon icon="mdi:bug-outline"></ha-icon></button>
        </div>
        <div class="progress"></div>
        <div class="content"><div class="home"></div><div class="frames"></div></div>
        <div class="dbg hidden">
          <div class="dbghead">
            <button data-act="diagnose">Diagnose page (10s)</button>
            <button data-act="dbgcopy">Copy</button>
            <button data-act="dbgclear">Clear</button>
            <button data-act="debug">Close</button>
          </div>
          <pre class="dbglog"></pre>
        </div>
      </div>`;
    this._tabList = $.querySelector(".tablist");
    this._omni = $.querySelector(".omni");
    this._home = $.querySelector(".home");
    this._frames = $.querySelector(".frames");
    this._progress = $.querySelector(".progress");
    this._content = $.querySelector(".content");
    this._dbg = $.querySelector(".dbg");
    this._dbgLog = $.querySelector(".dbglog");
    this._log("info", `panel v${PANEL_VERSION} | ${navigator.userAgent.slice(0, 100)}`);
    this._watchdog = setInterval(() => this._checkFrozen(), 3000);
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._tabs.forEach((t) => t.fitW && this._fit(t)));
      this._ro.observe(this._content);
    }

    $.querySelector(".root").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (b) this._action(b.dataset.act);
    });
    this._omni.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._go(this._omni.value);
    });
    this._omni.addEventListener("focus", () => this._omni.select());

    try {
      await this._refreshSession();
    } catch (err) {
      this._home.textContent = "HA Browser could not start: " + (err && err.message ? err.message : err);
      return;
    }
    this._restore();
    this._keepalive = setInterval(() => this._refreshSession().catch(() => {}), 4 * 60 * 1000);
  }

  async _refreshSession() {
    const old = this._session ? this._session.token : undefined;
    const req = { type: "ha_browser/session" };
    if (old) req.token = old;
    const s = await this._hass.callWS(req);
    this._session = s;
    if (old && old !== s.token) {
      // Session expired server-side: re-point every live tab at the new token.
      this._tabs.forEach((t) => t.url && (t.iframe.src = this._src(t.url)));
    }
  }

  // ---------------------------------------------------------------- helpers
  _src(real) {
    const u = new URL(real);
    const p = `${this._session.prefix}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
    return this._hass.hassUrl ? this._hass.hassUrl(p) : p;
  }

  _normalize(input) {
    input = (input || "").trim();
    if (!input) return null;
    if (/^https?:\/\//i.test(input)) return input;
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[\w.-]+:\d+/.test(input)) return null; // other schemes
    const host = input.split(/[/?#]/)[0].replace(/:\d+$/, "");
    const looksLikeHost =
      !/\s/.test(input) &&
      (/^localhost$/i.test(host) || /^\[[0-9a-f:]+\]$/i.test(host) || /^[\w-]+(\.[\w-]+)+$/.test(host));
    if (looksLikeHost) {
      const lan = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[.*\]|[^.]+\.(local|lan|home|internal))$/i.test(host);
      return (lan ? "http://" : "https://") + input;
    }
    return this._session.search_url.replace("%s", encodeURIComponent(input));
  }

  _validUrl(u) {
    try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch (_) { return false; }
  }

  _tab(id) { return this._tabs.find((t) => t.id === id); }
  _activeTab() { return this._tab(this._active); }

  _bookmarks() {
    try { return JSON.parse(localStorage.getItem(LS_BM)) || []; } catch (_) { return []; }
  }
  _saveBookmarks(list) { try { localStorage.setItem(LS_BM, JSON.stringify(list)); } catch (_) {} }

  _persist() {
    try {
      localStorage.setItem(LS_TABS, JSON.stringify({
        active: this._tabs.findIndex((t) => t.id === this._active),
        tabs: this._tabs.map((t) => ({ url: t.url, title: t.title })),
      }));
    } catch (_) {}
  }

  _restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_TABS)); } catch (_) {}
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      saved.tabs.forEach((t) => this._newTab(t.url && this._validUrl(t.url) ? t.url : null, t.title, false));
      const act = this._tabs[saved.active] || this._tabs[0];
      this._activate(act.id);
    } else {
      this._newTab(this._session.home_url || null);
    }
  }

  // ---------------------------------------------------------------- tabs
  _newTab(url, title = "", activate = true) {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", SANDBOX);
    iframe.setAttribute("allow", "fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.classList.add("hidden");
    const tab = { id: this._nextId++, url: null, title, iframe };
    iframe.addEventListener("load", () => {
      if (this._active === tab.id) this._progress.classList.remove("on");
    });
    this._frames.appendChild(iframe);
    this._tabs.push(tab);
    if (url) this._load(tab, url);
    if (activate) this._activate(tab.id);
    else this._renderTabs();
    return tab;
  }

  _closeTab(id) {
    const i = this._tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this._tabs[i].iframe.remove();
    this._tabs.splice(i, 1);
    if (!this._tabs.length) { this._newTab(this._session.home_url || null); return; }
    if (this._active === id) this._activate(this._tabs[Math.min(i, this._tabs.length - 1)].id);
    else { this._renderTabs(); this._persist(); }
  }

  _activate(id) {
    this._active = id;
    this._tabs.forEach((t) => t.iframe.classList.toggle("hidden", t.id !== id || !t.url));
    this._renderTabs();
    this._renderHome();
    this._syncOmni();
    this._progress.classList.remove("on");
    this._persist();
  }

  _load(tab, real) {
    if (!this._validUrl(real)) return;
    this._unfit(tab);
    tab.hb = 0;
    tab.frozen = false;
    tab.url = real;
    tab.title = "";
    tab.iframe.src = this._src(real);
    if (this._active === tab.id) {
      tab.iframe.classList.remove("hidden");
      this._progress.classList.add("on");
    }
    this._renderTabs();
    this._renderHome();
    this._syncOmni();
    this._persist();
  }

  _go(input) {
    const url = this._normalize(input);
    const tab = this._activeTab();
    if (url && tab) { this._load(tab, url); this._omni.blur(); }
  }

  _cmd(cmd) {
    const tab = this._activeTab();
    if (tab && tab.url && tab.iframe.contentWindow) {
      tab.iframe.contentWindow.postMessage({ __hb_cmd: 1, cmd }, "*");
    }
  }

  _action(act) {
    const tab = this._activeTab();
    switch (act) {
      case "menu": this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true })); break;
      case "newtab": this._newTab(null); this._omni.focus(); break;
      case "back": this._cmd("back"); break;
      case "forward": this._cmd("forward"); break;
      case "reload":
        if (tab && tab.url) { this._progress.classList.add("on"); this._cmd("reload"); setTimeout(() => {
          // No shim in the page (e.g. non-HTML)? Fall back to a hard reload.
          if (this._progress.classList.contains("on") && tab.iframe.src) tab.iframe.src = this._src(tab.url);
        }, 1500); }
        break;
      case "home":
        if (!tab) break;
        if (this._session.home_url) this._load(tab, this._session.home_url);
        else { tab.url = null; tab.title = ""; tab.iframe.src = "about:blank"; this._activate(tab.id); this._omni.focus(); }
        break;
      case "bookmark": this._toggleBookmark(); break;
      case "debug": this._dbg.classList.toggle("hidden"); break;
      case "diagnose": this._diagnose(); break;
      case "dbgclear": this._logs = []; this._dbgLog.textContent = ""; break;
      case "dbgcopy":
        if (navigator.clipboard) navigator.clipboard.writeText(this._logs.join("\n")).catch(() => {});
        break;
    }
  }

  // ---------------------------------------------------------------- messages from pages
  _onMessage(e) {
    const d = e.data;
    if (!d || d.__hb !== 1) return;
    const tab = this._tabs.find((t) => t.iframe.contentWindow === e.source);
    if (!tab) return; // only trust our own frames
    if (d.type === "log") { this._log(String(d.level).slice(0, 10), `[${this._host(tab)}] ${String(d.msg).slice(0, 500)}`); return; }
    if (d.type === "hb") { tab.hb = Date.now(); return; }
    if (d.type === "size") { this._onSize(tab, Number(d.w)); return; }
    if (d.type === "reset") { this._unfit(tab); return; }
    if (d.type === "nav" && typeof d.url === "string" && this._validUrl(d.url)) {
      tab.url = d.url;
      tab.title = typeof d.title === "string" ? d.title.slice(0, 200) : "";
      this._renderTabs();
      if (this._active === tab.id) { this._syncOmni(); this._progress.classList.remove("on"); }
      this._persist();
    } else if (d.type === "open" && typeof d.url === "string" && this._validUrl(d.url)) {
      this._newTab(d.url);
    }
  }

  // ---------------------------------------------------------------- diagnostics + fit
  _host(tab) { try { return new URL(tab.url).host; } catch (_) { return "?"; } }

  _log(level, msg) {
    this._logs.push(`[${level}] ${msg}`);
    if (this._logs.length > 300) this._logs.shift();
    if (this._dbgLog) {
      this._dbgLog.textContent = this._logs.join("\n");
      this._dbgLog.scrollTop = this._dbgLog.scrollHeight;
    }
  }

  async _diagnose() {
    this._dbg.classList.remove("hidden");
    const tab = this._activeTab();
    if (!tab || !tab.url) { this._log("diag", "No page loaded in this tab."); return; }
    this._log("diag", "Waiting 10s for the page to settle. Keep this tab open, then tap Copy...");
    await new Promise((res) => setTimeout(res, 10000));
    const r0 = tab.iframe.getBoundingClientRect();
    this._log("diag", `frame ${Math.round(r0.width)}x${Math.round(r0.height)}, hidden=${tab.iframe.classList.contains("hidden")}, fitW=${tab.fitW || 0}`);
    this._log("diag", `Fetching ${tab.url} through the proxy...`);
    try {
      const r = await fetch(this._src(tab.url), { credentials: "omit" });
      const text = await r.text();
      const m = /<title[^>]*>([^<]*)/i.exec(text);
      this._log("diag", `HTTP ${r.status}, ${r.headers.get("content-type") || "?"}, ${text.length} chars, title: ${m ? m[1].trim().slice(0, 80) : "(none)"}, shim injected: ${text.includes('"prefix"') ? "yes" : "no"}`);
      this._log("diag", "start of body: " + text.replace(/\s+/g, " ").slice(0, 300));
    } catch (err) {
      this._log("diag", "fetch failed: " + (err && err.message ? err.message : err));
    }
    await this._trace();
  }

  async _trace() {
    try {
      const { items } = await this._hass.callWS({ type: "ha_browser/debug", token: this._session.token });
      const pending = items.filter((i) => i.ms === null);
      const bad = items.filter((i) => i.ms !== null && (i.e || (i.s !== null && i.s >= 400) || i.s === null));
      this._log("diag", `proxy: ${items.length} recent requests, ${pending.length} in flight, ${bad.length} failed`);
      const line = (i) => `${i.ms === null ? "PENDING " + (i.age / 1000).toFixed(1) + "s" : i.ms + "ms"} ${i.s || "-"} ${i.m} ${i.u}${i.e ? "  ERR: " + i.e : ""}`;
      pending.slice(0, 15).forEach((i) => this._log("diag", line(i)));
      bad.slice(-15).forEach((i) => this._log("diag", line(i)));
      items.filter((i) => i.ms !== null).sort((a, b) => b.ms - a.ms).slice(0, 5)
        .forEach((i) => this._log("diag", "slow: " + line(i)));
    } catch (err) {
      this._log("diag", "trace unavailable: " + (err && err.message ? err.message : err));
    }
  }

  _checkFrozen() {
    const now = Date.now();
    this._tabs.forEach((t) => {
      if (!t.url || !t.hb) return;
      const gap = now - t.hb;
      if (gap > 7000 && !t.frozen) {
        t.frozen = true;
        this._log("FROZEN", `[${this._host(t)}] no heartbeat for ${Math.round(gap / 1000)}s: the page's JavaScript is blocked (busy loop or synchronous request) or has crashed`);
        this._dbg.classList.remove("hidden");
        this._trace();
      } else if (gap < 4000 && t.frozen) {
        t.frozen = false;
        this._log("info", `[${this._host(t)}] page is responsive again`);
      }
    });
  }

  // Scale pages that are wider than the panel so they fit without sideways scrolling.
  _onSize(tab, w) {
    if (!Number.isFinite(w) || w < 200 || w > 6000) return;
    if (tab.fitW && w <= tab.fitW * 1.02) return; // already fitted
    const cw = this._content.clientWidth;
    if (!tab.fitW && !(w > cw * 1.05)) return;    // no horizontal overflow
    tab.fitW = w;
    this._fit(tab);
  }

  _fit(tab) {
    const cw = this._content.clientWidth, ch = this._content.clientHeight;
    if (!tab.fitW || !cw) return;
    if (tab.fitW <= cw * 1.02) { this._unfit(tab); return; }
    const scale = Math.max(cw / tab.fitW, 0.35);
    tab.iframe.style.cssText =
      `right:auto;bottom:auto;width:${cw / scale}px;height:${ch / scale}px;transform:scale(${scale});transform-origin:0 0;`;
  }

  _unfit(tab) { tab.fitW = 0; tab.iframe.style.cssText = ""; }

  // ---------------------------------------------------------------- rendering
  _renderTabs() {
    this._tabList.textContent = "";
    this._tabs.forEach((t) => {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === this._active ? " active" : "");
      const label = document.createElement("span");
      label.className = "t";
      label.textContent = t.title || (t.url ? new URL(t.url).host : "New tab");
      const close = document.createElement("button");
      close.textContent = "\u00d7";
      close.title = "Close tab";
      close.addEventListener("click", (ev) => { ev.stopPropagation(); this._closeTab(t.id); });
      el.append(label, close);
      el.addEventListener("click", () => this._activate(t.id));
      el.addEventListener("auxclick", (ev) => { if (ev.button === 1) this._closeTab(t.id); });
      this._tabList.appendChild(el);
    });
  }

  _syncOmni() {
    const tab = this._activeTab();
    if (this.shadowRoot.activeElement !== this._omni) this._omni.value = tab && tab.url ? tab.url : "";
    const star = this.shadowRoot.querySelector('[data-act="bookmark"] ha-icon');
    const on = tab && tab.url && this._bookmarks().some((b) => b.url === tab.url);
    if (star) star.setAttribute("icon", on ? "mdi:star" : "mdi:star-outline");
  }

  _toggleBookmark() {
    const tab = this._activeTab();
    if (!tab || !tab.url) return;
    let list = this._bookmarks();
    if (list.some((b) => b.url === tab.url)) list = list.filter((b) => b.url !== tab.url);
    else list.push({ url: tab.url, title: tab.title || new URL(tab.url).host });
    this._saveBookmarks(list);
    this._syncOmni();
    this._renderHome();
  }

  _renderHome() {
    const tab = this._activeTab();
    const show = !tab || !tab.url;
    this._home.classList.toggle("hidden", !show);
    if (!show) return;
    this._home.textContent = "";
    const h = document.createElement("h2");
    h.textContent = "HA Browser";
    const p = document.createElement("p");
    p.textContent = "Type an address or search above. Pages are fetched by your Home Assistant server.";
    this._home.append(h, p);
    const grid = document.createElement("div");
    grid.className = "grid";
    this._bookmarks().forEach((b) => {
      const el = document.createElement("button");
      el.className = "bm";
      const ic = document.createElement("div");
      ic.className = "ic";
      ic.textContent = (b.title || "?").trim().charAt(0).toUpperCase();
      const l = document.createElement("div");
      l.className = "l";
      l.textContent = b.title;
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.textContent = "\u00d7";
      rm.title = "Remove bookmark";
      rm.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._saveBookmarks(this._bookmarks().filter((x) => x.url !== b.url));
        this._renderHome();
      });
      el.append(ic, l, rm);
      el.addEventListener("click", () => this._load(this._activeTab(), b.url));
      grid.appendChild(el);
    });
    this._home.appendChild(grid);
  }
}

customElements.define("ha-browser-panel", HaBrowserPanel);
