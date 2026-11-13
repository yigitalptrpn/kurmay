import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Güvenlik raporunu PDF'e basmak — bağımlılık eklemeden: bilgisayarda kurulu Chromium tabanlı
 * tarayıcı (Edge, Chrome, Chromium) başsız açılıp rapor şablonunu (/guvenlik/rapor/<id>)
 * yazdırır. İnternet gerekmez; yazı tipleri ve veri Kurmay'ın kendi sunucusundan gelir.
 * Tarayıcı bulunamazsa sayfa tarayıcının yazdırma penceresine düşer ("PDF olarak kaydet").
 */

/** Yol ortam değişkeniyle verilebilir (ör. taşınabilir Chrome); yoksa bilinen kurulum yerleri */
export const BROWSER_ENV = "KURMAY_TARAYICI";

export function findBrowser(): string | undefined {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const fromEnv = process.env[BROWSER_ENV];
  if (fromEnv) return isFile(fromEnv) ? fromEnv : undefined;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    // Edge Windows'ta hep kurulu — önce o
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(base, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    const names = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
    ];
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const n of names) candidates.push(path.join(dir, n));
    }
  }
  return candidates.find(isFile);
}

/** Sayfayı başsız tarayıcıyla PDF'e basar; tarayıcının kendi başlık/altlığı kapalı (şablonun altlığı var) */
export async function printPdf(browser: string, url: string, timeoutMs = 90_000): Promise<Buffer> {
  // Ayrı profil: kullanıcının açık tarayıcısına devredilip PDF basılmadan çıkmasın
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurmay-pdf-"));
  const out = path.join(dir, "rapor.pdf");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    `--user-data-dir=${path.join(dir, "profil")}`,
    "--no-pdf-header-footer",
    "--print-to-pdf-no-header", // eski sürümlerdeki adı
    "--virtual-time-budget=15000", // yazı tipleri yüklenmeden basmasın
    `--print-to-pdf=${out}`,
  ];
  // Docker'da kök kullanıcıyla çalışır; Chromium kök kullanıcıda korumalı alan olmadan açılır
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  args.push(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      p.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error("tarayıcı PDF'i süresinde üretemedi"));
      }, timeoutMs);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`tarayıcı açılamadı: ${e.message}`));
      });
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) resolve();
        else
          reject(
            new Error(
              `tarayıcı PDF üretemedi (çıkış kodu ${code})${stderr ? ` — ${stderr.trim().split("\n").pop()}` : ""}`,
            ),
          );
      });
    });
    return fs.readFileSync(out);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows'ta tarayıcı dosyayı bir an tutabilir — geçici klasör sonra temizlenir */
    }
  }
}

/** İndirilecek dosyanın adı: guvenlik-raporu-<proje>-<tarih>.pdf (Türkçe harfler korunur) */
export function pdfFileName(r: { targetDir?: string; createdAt?: string }): string {
  const proje = (path.basename(r.targetDir ?? "") || "proje").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 60);
  const gun = (r.createdAt ?? new Date().toISOString()).slice(0, 10);
  return `guvenlik-raporu-${proje}-${gun}.pdf`;
}

/** Content-Disposition: eski istemciler için ASCII ad + UTF-8 ad (RFC 6266) */
export function attachmentHeader(name: string): string {
  const tr: Record<string, string> = {
    ç: "c",
    Ç: "C",
    ğ: "g",
    Ğ: "G",
    ı: "i",
    İ: "I",
    ö: "o",
    Ö: "O",
    ş: "s",
    Ş: "S",
    ü: "u",
    Ü: "U",
  };
  const ascii = name
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => tr[c])
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
