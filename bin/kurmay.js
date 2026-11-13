#!/usr/bin/env node
// Kurmay komutu (npm paketi):
//   kurmay init [klasör]     çalışma klasörünü hazırlar: config.json + .claude/ (personalar, kurallar, beceriler, hook'lar)
//   kurmay update [klasör]   paket güncellendikten sonra .claude/ şablonlarını tazeler — senin değiştirdiğin dosyalara dokunmaz
//   kurmay serve             paneli açar (sunucu modu) — "kurmay" tek başına da aynı
//   kurmay "görev"           tek görev modu
// Ayar, personalar ve koşu kayıtları (runs/) komutun çalıştırıldığı klasörde durur; paket klasörüne yazılmaz.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const paket = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surum = JSON.parse(fs.readFileSync(path.join(paket, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
// Şablondan kopyalanan her dosyanın o anki parmak izi — update, dosyayı senin değiştirip
// değiştirmediğini buna bakarak anlar
const KAYIT = path.join(".claude", ".kurmay-sablon.json");

if (args[0] === "init") {
  init(path.resolve(args[1] ?? "."));
} else if (args[0] === "update") {
  update(path.resolve(args[1] ?? "."));
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(surum);
} else {
  // "serve" yalnızca okunaklılık için — orkestratör görev verilmezse zaten sunucu modunda açılır
  if (args[0] === "serve") process.argv.splice(2, 1);
  if (!args.includes("--config") && !fs.existsSync("config.json")) {
    console.error(
      "Bu klasörde config.json yok. Önce çalışma klasörünü hazırla:\n  kurmay init\n(ya da --config ile ayar dosyasının yolunu ver)",
    );
    process.exit(1);
  }
  await import(pathToFileURL(path.join(paket, "dist", "index.js")).href);
}

/** Paketteki şablonu hedef klasöre kopyalar; var olan dosyaların üstüne yazmaz */
function init(hedef) {
  fs.mkdirSync(hedef, { recursive: true });
  const kayit = kayitOku(hedef);
  const yazildi = [];
  const atlandi = [];
  for (const { goreli, kaynak } of sablonlar()) {
    const hedefDosya = path.join(hedef, goreli);
    if (fs.existsSync(hedefDosya)) {
      atlandi.push(goreli);
      continue;
    }
    kopyala(kaynak, hedefDosya);
    kayit.dosyalar[anahtar(goreli)] = izi(kaynak);
    yazildi.push(goreli);
  }
  const cfgHedef = path.join(hedef, "config.json");
  if (fs.existsSync(cfgHedef)) {
    atlandi.push("config.json");
  } else {
    // Paketteki ayar şablon olarak kullanılır; makineye özel hedef dizin boşaltılır
    const cfg = JSON.parse(fs.readFileSync(path.join(paket, "config.json"), "utf8"));
    cfg.targetDir = "";
    fs.writeFileSync(cfgHedef, JSON.stringify(cfg, null, 2) + "\n");
    yazildi.push("config.json");
  }
  kayitYaz(hedef, kayit);
  console.log(`Çalışma klasörü: ${hedef}`);
  if (yazildi.length) console.log(`  oluşturuldu: ${yazildi.length} dosya (config.json, .claude/…)`);
  if (atlandi.length) console.log(`  zaten vardı, dokunulmadı: ${atlandi.join(", ")}`);
  console.log(
    "\nSıradaki adım: config.json'da sağlayıcıyı ayarla (sunucu adresi, model, model listesi adresi, hedef dizin)" +
      "\nya da paneli aç ve ⚙ Ayarlar sayfasından gir:\n  kurmay serve",
  );
}

/**
 * Paket güncellendikten sonra çalışma klasöründeki şablonları tazeler:
 *  - klasörde olmayan dosya eklenir
 *  - kopyalandığından beri değiştirilmemiş dosya yeni sürümle değiştirilir
 *  - senin değiştirdiğin dosyaya dokunulmaz; yeni sürümü yanına "<ad>.yeni" olarak konur
 * config.json'a hiç dokunulmaz (yeni ayarların hepsinin varsayılanı var).
 * Parmak izi kaydı olmayan (eski) klasörde paketle aynı olmayan her dosya "değiştirilmiş"
 * sayılır — kimin değiştirdiği bilinemez, güvenli tarafta kalınır.
 */
function update(hedef) {
  if (!fs.existsSync(path.join(hedef, "config.json"))) {
    console.error(`${hedef} bir Kurmay çalışma klasörü değil (config.json yok). Yeni klasör için:\n  kurmay init`);
    process.exit(1);
  }
  const kayit = kayitOku(hedef);
  const eklendi = [];
  const guncellendi = [];
  const karar = [];
  let ayni = 0;
  for (const { goreli, kaynak } of sablonlar()) {
    const hedefDosya = path.join(hedef, goreli);
    const yeniDosya = hedefDosya + ".yeni";
    const k = anahtar(goreli);
    const paketIzi = izi(kaynak);
    if (!fs.existsSync(hedefDosya)) {
      kopyala(kaynak, hedefDosya);
      kayit.dosyalar[k] = paketIzi;
      eklendi.push(goreli);
      continue;
    }
    const yerelIzi = izi(hedefDosya);
    if (yerelIzi === paketIzi) {
      kayit.dosyalar[k] = paketIzi;
      ayni++;
      // Önceki update'in bıraktığı öneri artık gereksiz (yeni sürüm alınmış)
      if (fs.existsSync(yeniDosya)) fs.rmSync(yeniDosya);
      continue;
    }
    if (kayit.dosyalar[k] && kayit.dosyalar[k] === yerelIzi) {
      // Kopyalandığından beri değiştirilmemiş — şablon değişmiş, güvenle yenilenir
      kopyala(kaynak, hedefDosya);
      kayit.dosyalar[k] = paketIzi;
      guncellendi.push(goreli);
      continue;
    }
    // Senin değişikliğin (ya da bilinmiyor): dokunma, yenisini yanına koy
    kopyala(kaynak, yeniDosya);
    karar.push(goreli);
  }
  const onceki = kayit.surum;
  kayit.surum = surum;
  kayitYaz(hedef, kayit);

  console.log(`Çalışma klasörü: ${hedef}`);
  console.log(
    `  paket sürümü: ${surum}${onceki && onceki !== surum ? ` (klasör en son ${onceki} ile tazelenmişti)` : ""}`,
  );
  if (eklendi.length) console.log(`\n  ＋ eklendi (${eklendi.length}):\n${liste(eklendi)}`);
  if (guncellendi.length)
    console.log(`\n  ↻ güncellendi — sen değiştirmemiştin (${guncellendi.length}):\n${liste(guncellendi)}`);
  if (karar.length) {
    console.log(
      `\n  ✋ senin değiştirdiğin dosyalar — dokunulmadı, yeni sürümü yanına ".yeni" olarak kondu (${karar.length}):\n${liste(karar)}` +
        "\n    İkisini karşılaştır; yenisini istersen .yeni dosyasını asıl dosyanın yerine koy, istemezsen .yeni'yi sil." +
        "\n    (Sonraki update, asıl dosya yeni sürümle aynıysa .yeni'yi kendisi temizler.)",
    );
  }
  if (!eklendi.length && !guncellendi.length && !karar.length)
    console.log(`\n  Şablonlar zaten güncel (${ayni} dosya).`);
  console.log("\n  config.json'a dokunulmadı. Değişikliklerin geçerli olması için kurmay serve'ü yeniden başlat.");
}

/** Paketteki şablon dosyaları: {goreli: ".claude/agents/analist.md", kaynak: tam yol} */
function* sablonlar() {
  for (const alt of ["agents", "rules", "skills", "hooks"]) {
    const kaynakKlasor = path.join(paket, ".claude", alt);
    if (!fs.existsSync(kaynakKlasor)) continue;
    for (const dosya of dosyalar(kaynakKlasor)) {
      yield { goreli: path.join(".claude", alt, path.relative(kaynakKlasor, dosya)), kaynak: dosya };
    }
  }
}

function kopyala(kaynak, hedefDosya) {
  fs.mkdirSync(path.dirname(hedefDosya), { recursive: true });
  fs.copyFileSync(kaynak, hedefDosya);
}

/** İçeriğin parmak izi — satır sonu farkı (CRLF/LF) değişiklik sayılmaz */
function izi(dosya) {
  const metin = fs.readFileSync(dosya, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(metin).digest("hex");
}

/** Kayıt anahtarı her işletim sisteminde aynı olsun ("/" ayraçlı) */
function anahtar(goreli) {
  return goreli.split(path.sep).join("/");
}

function kayitOku(hedef) {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(hedef, KAYIT), "utf8"));
    if (k && typeof k.dosyalar === "object") return k;
  } catch {
    /* kayıt yok/bozuk — boş başla */
  }
  return { surum: undefined, dosyalar: {} };
}

function kayitYaz(hedef, kayit) {
  fs.mkdirSync(path.join(hedef, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(hedef, KAYIT),
    JSON.stringify(
      {
        aciklama: "kurmay init/update parmak izleri — elle düzenleme",
        surum: kayit.surum ?? surum,
        dosyalar: kayit.dosyalar,
      },
      null,
      2,
    ) + "\n",
  );
}

function liste(dizi) {
  return dizi.map((d) => `     ${d}`).join("\n");
}

function* dosyalar(klasor) {
  for (const girdi of fs.readdirSync(klasor, { withFileTypes: true })) {
    const tam = path.join(klasor, girdi.name);
    if (girdi.isDirectory()) yield* dosyalar(tam);
    else yield tam;
  }
}
