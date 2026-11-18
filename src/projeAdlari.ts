import { readdir } from "node:fs/promises";
import path from "node:path";
import { okunus } from "./okunus.js";

/**
 * Projedeki kod dosyalarının adları (uzantısız: PaymentController, order-repository…) — sesle yazılan
 * metinde Türkçe okunuşla geçen sınıf/dosya adlarını bulmak için. Ekranda gösterilmez; yalnızca ses
 * tanıma sözlüğüne ve metin düzeltme modeline aday olarak gider. Dizin başına 5 dk önbellekte.
 */
const KOD =
  /\.(java|kt|kts|scala|groovy|ts|tsx|js|jsx|mjs|vue|svelte|cs|vb|fs|py|go|rs|rb|php|swift|m|cpp|cc|c|h|hpp|sql|xml|yml|yaml|proto|graphql)$/i;
const ATLA = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  "vendor",
  "coverage",
  "venv",
  "__pycache__",
  "packages",
  "runs",
  "tmp",
  "temp",
  "logs",
]);
const EN_COK_DOSYA = 40000;
const SURE_MS = 4000;
const ONBELLEK_MS = 5 * 60 * 1000;

type Ad = { ad: string; k: string };
const onbellek = new Map<string, { zaman: number; adlar: Promise<Ad[]> }>();

async function tara(kok: string): Promise<Ad[]> {
  const t0 = Date.now();
  const adlar = new Map<string, string>();
  const kuyruk = [kok];
  let sayi = 0;
  while (kuyruk.length && sayi < EN_COK_DOSYA && Date.now() - t0 < SURE_MS) {
    const dir = kuyruk.shift()!;
    let girdiler;
    try {
      girdiler = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const g of girdiler) {
      if (g.name.startsWith(".")) continue;
      if (g.isDirectory()) {
        if (!ATLA.has(g.name.toLowerCase())) kuyruk.push(path.join(dir, g.name));
      } else if (KOD.test(g.name)) {
        sayi++;
        const ad = g.name.replace(/\.[^.]+$/, "").replace(/\.(test|spec|d)$/i, "");
        if (ad.length >= 4 && !adlar.has(ad)) adlar.set(ad, okunus(ad));
      }
    }
  }
  return [...adlar].map(([ad, k]) => ({ ad, k }));
}

export function projeAdlari(dir: string): Promise<Ad[]> {
  const kok = path.resolve(dir);
  const o = onbellek.get(kok);
  if (o && Date.now() - o.zaman < ONBELLEK_MS) return o.adlar;
  const adlar = tara(kok);
  onbellek.set(kok, { zaman: Date.now(), adlar });
  return adlar;
}
