import fs from "node:fs";
import path from "node:path";
import { extractText } from "./docText.js";

/**
 * Görevle birlikte panele yapıştırılan / sürüklenen dosyalar (görsel, PDF, metin,
 * belge…). `runs/ekler/<oturum>/` altına kaydedilir; ajanlara görev metninin
 * sonunda tam yollarıyla bildirilir, ajan Read aracıyla açar. Sahte API ile
 * doğrulandı: hedef dizin dışındaki dosyayı da Read okuyor; görseli Claude Code
 * modele `image` bloğu olarak gönderiyor — yani görsel ancak model görsel
 * destekliyse işe yarar (yalnızca metin anlayan modelde sunucu isteği reddeder).
 * Dosya istemin içine gömülmüyor: her ajan (Analist, Saha Timi, Teftiş) görevi aynı
 * metinle alıyor, konuşma kaydı da şişmiyor. PDF ve Word belgelerinin metni ayrıca
 * çıkarılıp yanına `.txt` yazılır (src/docText.ts) — Read PDF'i Anthropic'e özgü
 * `document` bloğu olarak gönderiyor, vLLM bunu tanımaz; .docx'i hiç okuyamaz.
 */

export const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Panelde küçük resim olarak gösterilen (ve tarayıcıda satır içi açılan) görseller */
const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export interface FileInput {
  name: string;
  data: Buffer;
}

/** Kaydedilmiş ek: diskteki ad + ajanın okuyacağı tam yol + kullanıcının verdiği ad */
export interface Attachment {
  name: string;
  path: string;
  original: string;
  /** PDF/Word belgesinden çıkarılan metnin dosyası (çıkarılabildiyse) */
  textPath?: string;
}

const TR: Record<string, string> = { ç: "c", Ç: "C", ğ: "g", Ğ: "G", ı: "i", İ: "I", ö: "o", Ö: "O", ş: "s", Ş: "S", ü: "u", Ü: "U" };

/** Dosya adını güvenli hale getirir (yol ayırıcı, boşluk, özel karakter yok; uzantı korunur) */
function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"))
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR[c])
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._]+/, "");
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(base)!;
  return ((m[1] || "dosya").slice(0, 60) + (m[2] ?? "")).toLowerCase();
}

/** POST /task gövdesindeki `files` alanını doğrular: [{name, data(base64 ya da data: adresi)}] */
export function parseFiles(value: unknown): { files: FileInput[]; error?: string } {
  if (value === undefined || value === null) return { files: [] };
  if (!Array.isArray(value)) return { files: [], error: "ekler liste olmalı" };
  if (value.length > MAX_FILES) return { files: [], error: `en fazla ${MAX_FILES} dosya eklenebilir` };
  const files: FileInput[] = [];
  for (const item of value) {
    const o = (item ?? {}) as { name?: unknown; data?: unknown };
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "dosya";
    let data = typeof o.data === "string" ? o.data : "";
    const m = /^data:[^,]*;base64,/.exec(data);
    if (m) data = data.slice(m[0].length);
    const buf = Buffer.from(data, "base64");
    if (buf.length === 0) return { files: [], error: `dosya boş: ${name}` };
    if (buf.length > MAX_FILE_BYTES) return { files: [], error: `dosya çok büyük: ${name} (en fazla ${MAX_FILE_BYTES / 1024 / 1024} MB)` };
    files.push({ name, data: buf });
  }
  return { files };
}

/** Dosyaları oturumun ek klasörüne yazar (adın önüne zaman damgası — aynı ad çakışmasın) */
export function saveFiles(runsDir: string, sessionId: string, files: FileInput[]): Attachment[] {
  if (files.length === 0) return [];
  const dir = path.join(runsDir, "ekler", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return files.map((f, i) => {
    const name = `${stamp}-${i + 1}-${safeName(f.name)}`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, f.data);
    const text = extractText(name, f.data);
    if (!text) return { name, path: file, original: f.name };
    const textPath = `${file}.txt`;
    fs.writeFileSync(textPath, text);
    return { name, path: file, original: f.name, textPath };
  });
}

/** Ajanlara giden görev metninin sonuna eklenen bölüm */
export function attachmentSection(atts: Attachment[]): string {
  if (atts.length === 0) return "";
  return (
    `\n\n# Ekler\nKullanıcı görevle birlikte ${atts.length} dosya verdi. Read aracıyla aç ve incele — ` +
    "görev bunlara atıf yapıyor olabilir:\n" +
    atts
      .map((a) =>
        `- ${a.path} (kullanıcının verdiği ad: ${a.original})` +
        (a.textPath ? `\n  Metni çıkarıldı — belgeyi değil bunu oku: ${a.textPath}` : ""),
      )
      .join("\n")
  );
}

/**
 * GET /ekler/<oturum>/<dosya> — yalnızca ek klasöründeki dosyalar (yol enjeksiyonu
 * reddedilir). Görseller satır içi, diğerleri indirme olarak verilir (HTML/SVG gibi
 * dosyalar panelin adresinde çalışmasın).
 */
export function resolveAttachment(
  runsDir: string,
  sessionId: string,
  name: string,
): { file: string; type: string; inline: boolean } | undefined {
  if (!/^[\w-]+$/.test(sessionId) || !/^[\w][\w.-]*$/.test(name)) return undefined;
  const file = path.join(runsDir, "ekler", sessionId, name);
  if (!fs.existsSync(file)) return undefined;
  const type = IMAGE_EXT[path.extname(name).slice(1).toLowerCase()];
  return type ? { file, type, inline: true } : { file, type: "application/octet-stream", inline: false };
}

