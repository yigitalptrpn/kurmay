// Kurmay — tema seçimi (panel, Ayarlar ve Aç/Kapat sayfaları ortak; /theme.js).
// <head>'de, stil hesaplanmadan ÖNCE yüklenir: kayıtlı temayı <html data-theme>'e yazar —
// aksi halde sayfa bir an yanlış temayla gelip (flash) sonra düzelirdi. Kayıt yoksa OS
// tercihi: koyu → Radar, açık → Gizli Evrak. Sayfa açılınca her .tswitch kutusuna renk
// örneklerini koyar; tema adları ekranda YAZMAZ (kullanıcı isteği), yalnızca ekran
// okuyucu etiketi olarak durur. Renkler/yazı tipleri theme.css'te, temaların panel
// karakteri (doku, köşe, damga) index.html sonundaki [data-theme=…] kurallarında.
(function () {
  // Sıra = seçicideki sıra. Yeni tema: theme.css'e renkler + .tsw örneği, burada bir satır
  var THEMES = [
    { id: "evrak", ad: "Gizli Evrak" },
    { id: "radar", ad: "Radar" },
    { id: "harita", ad: "Harita" },
    { id: "karargah", ad: "Karargâh" },
    { id: "sade", ad: "Sade" },
    { id: "gece", ad: "Gece" },
  ];
  // Eski kayıtlar: açık/koyu ve kaldırılan temalar (Lacivert 2026-10-13'te kaldırıldı)
  var ESKI = { dark: "radar", teskilat: "radar", lacivert: "radar", light: "evrak" };
  var root = document.documentElement;
  function gecerli(t) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === t) return true;
    return false;
  }

  var t;
  try { t = localStorage.getItem("kurmay-theme") || localStorage.getItem("yaver-theme"); } catch (e) {}
  if (t && ESKI[t]) t = ESKI[t];
  if (!gecerli(t)) {
    try { t = matchMedia("(prefers-color-scheme: dark)").matches ? "radar" : "evrak"; } catch (e) { t = "evrak"; }
  }
  root.dataset.theme = t;

  function isaretle() {
    var bs = document.querySelectorAll(".tsw");
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].dataset.t === root.dataset.theme;
      bs[i].classList.toggle("on", on);
      bs[i].setAttribute("aria-checked", on ? "true" : "false");
    }
  }
  function sec(id) {
    root.dataset.theme = id;
    try { localStorage.setItem("kurmay-theme", id); } catch (e) {}
    isaretle();
  }
  function kur() {
    var kutular = document.querySelectorAll(".tswitch");
    for (var k = 0; k < kutular.length; k++) {
      kutular[k].innerHTML = "";
      THEMES.forEach(function (th) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "tsw";
        b.dataset.t = th.id;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", th.ad);
        b.addEventListener("click", function () { sec(th.id); });
        kutular[k].appendChild(b);
      });
    }
    isaretle();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", kur);
  else kur();
  // Başka sekmede (panel ↔ Ayarlar) tema değişince bu sekme de uysun
  window.addEventListener("storage", function (e) {
    if (e.key === "kurmay-theme" && gecerli(e.newValue)) {
      root.dataset.theme = e.newValue;
      isaretle();
    }
  });
})();
