// Klasör seçici — panel (index.html) ve ayar sayfası (config.html) ortak kullanır.
// Tarayıcı, işletim sisteminin klasör penceresinden seçilen klasörün TAM YOLUNU
// sayfaya vermez; bu yüzden klasörleri sunucu listeler (GET /browse) ve burada
// Gezgin benzeri bir pencerede gezilir. Kütüphanesiz; renkler theme.css'ten.
//
//   const yol = await openDirPicker(baslangicDizini);   // vazgeçilirse null
(function () {
  const css = `
.dp { border:none; padding:0; width:min(640px, calc(100vw - 32px)); max-height:calc(100vh - 48px);
  background:var(--md-surface-container); color:var(--text); border-radius:var(--md-shape-lg); box-shadow:var(--md-elev-3); }
.dp::backdrop { background:rgba(0,0,0,.45); }
.dp-in { display:flex; flex-direction:column; gap:10px; padding:18px 20px; max-height:calc(100vh - 48px); }
.dp-h { font:var(--md-type-title-md); }
.dp-addr { display:flex; gap:6px; }
.dp-addr input { flex:1; min-width:0; font-family:var(--font-mono) !important; font-size:13px; }
.dp-addr button, .dp-roots button { min-height:auto; padding:6px 12px; font-size:13px; }
.dp-roots { display:flex; gap:6px; flex-wrap:wrap; }
.dp-list { flex:1; min-height:160px; max-height:min(52vh, 420px); overflow:auto; border:1px solid var(--border);
  border-radius:var(--md-shape-sm); background:var(--md-surface-container-lowest); }
.dp-item { display:flex; align-items:center; gap:9px; width:100%; text-align:left; border:none !important; border-radius:0 !important;
  min-height:38px; padding:7px 12px; font:var(--md-type-body-md); background:transparent; color:var(--text); }
.dp-item + .dp-item { border-top:1px solid var(--border) !important; }
.dp-item:hover { background:var(--blueBg); }
.dp-item .nm { overflow-wrap:anywhere; }
.dp-empty { padding:14px; font-size:13px; color:var(--muted); }
.dp-err { font-size:12.5px; color:var(--red); min-height:0; }
.dp-foot { display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap; }
.dp-cur { flex:1 1 100%; min-width:0; font:12.5px var(--font-mono); color:var(--muted); overflow-wrap:anywhere; }
`;
  let dlg, state, done;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function build() {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    dlg = document.createElement("dialog");
    dlg.className = "dp";
    dlg.innerHTML = `<div class="dp-in">
      <div class="dp-h">Klasör seç</div>
      <div class="dp-addr">
        <button type="button" data-act="up" title="Üst klasör" aria-label="Üst klasör">↑</button>
        <input type="text" data-el="addr" spellcheck="false" aria-label="Klasör yolu" placeholder="Yolu yazıp Enter'a bas">
      </div>
      <div class="dp-roots" data-el="roots"></div>
      <div class="dp-list" data-el="list" role="listbox" aria-label="Alt klasörler"></div>
      <div class="dp-err" data-el="err"></div>
      <div class="dp-foot">
        <span class="dp-cur" data-el="cur"></span>
        <button type="button" data-act="cancel">Vazgeç</button>
        <button type="button" class="primary" data-act="pick">Bu klasörü seç</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    const el = (n) => dlg.querySelector(`[data-el="${n}"]`);
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) return close(null); // pencere dışına tıklama
      const b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.go) return go(b.dataset.go);
      if (b.dataset.act === "up" && state && state.parent) return go(state.parent);
      if (b.dataset.act === "cancel") return close(null);
      if (b.dataset.act === "pick" && state) return close(state.dir);
    });
    el("addr").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); go(el("addr").value); }
    });
    dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(null); }); // Esc
    dlg.el = el;
  }

  function join(dir, name) {
    const sep = state && state.sep || "/";
    return dir.endsWith(sep) ? dir + name : dir + sep + name;
  }

  async function go(dir) {
    const el = dlg.el;
    el("err").textContent = "";
    let data;
    try {
      data = await (await fetch("/browse?dir=" + encodeURIComponent(dir || ""))).json();
    } catch {
      el("err").textContent = "Klasörler alınamadı — servis çalışıyor mu?";
      return;
    }
    state = data;
    el("addr").value = data.dir;
    el("cur").textContent = data.dir;
    el("err").textContent = data.error || "";
    dlg.querySelector('[data-act="up"]').disabled = !data.parent;
    const roots = (data.roots || []).map((r) => `<button type="button" data-go="${esc(r)}">💽 ${esc(r)}</button>`);
    if (data.home) roots.push(`<button type="button" data-go="${esc(data.home)}">🏠 Kullanıcı klasörü</button>`);
    el("roots").innerHTML = roots.join("");
    el("list").innerHTML = data.dirs.length
      ? data.dirs.map((n) => `<button type="button" class="dp-item" role="option" data-go="${esc(join(data.dir, n))}"><span>📁</span><span class="nm">${esc(n)}</span></button>`).join("")
      : `<div class="dp-empty">Bu klasörde alt klasör yok.</div>`;
    el("list").scrollTop = 0;
  }

  function close(value) {
    if (dlg.open) dlg.close();
    const d = done;
    done = null;
    if (d) d(value);
  }

  window.openDirPicker = function (start) {
    if (!dlg) build();
    if (done) close(null);
    return new Promise((resolve) => {
      done = resolve;
      dlg.showModal();
      go(start || "");
    });
  };
})();
