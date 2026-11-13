import fs from "node:fs";
import path from "node:path";
import type { TfsConnection } from "./tfs.js";
import type { TfsConfig } from "./types.js";

/**
 * TFS erişim anahtarının (PAT) saklanması. config.json'da DURMAZ: o dosya depoda
 * izlenebiliyor (git'e gitme riski) ve Ayarlar sayfası /config-data ile onu olduğu gibi
 * tarayıcıya veriyor. Anahtar çalışma klasöründe `.gizli/tfs.json`'da tutulur — klasörün
 * kendi .gitignore'u ("*") olduğu için hiçbir git deposuna girmez; POSIX'te yalnızca
 * sahibi okuyabilir (0600). Ortam değişkeni (Docker, betik) dosyadan önce gelir.
 * Panel anahtarı hiç görmez: yalnızca "kayıtlı mı" ve son 4 karakteri döner.
 */

export const TOKEN_ENVS = ["KURMAY_TFS_TOKEN", "AZURE_DEVOPS_PAT"] as const;

const secretDir = (configRoot: string) => path.join(configRoot, ".gizli");
const secretFile = (configRoot: string) => path.join(secretDir(configRoot), "tfs.json");

export function readTfsToken(configRoot: string): { token?: string; source?: "ortam" | "dosya"; env?: string } {
  for (const env of TOKEN_ENVS) {
    const v = process.env[env]?.trim();
    if (v) return { token: v, source: "ortam", env };
  }
  try {
    const j = JSON.parse(fs.readFileSync(secretFile(configRoot), "utf8")) as { token?: unknown };
    if (typeof j.token === "string" && j.token.trim()) return { token: j.token.trim(), source: "dosya" };
  } catch {
    /* yok */
  }
  return {};
}

/** Anahtarı kaydeder (null = siler) */
export function writeTfsToken(configRoot: string, token: string | null): void {
  const dir = secretDir(configRoot);
  const file = secretFile(configRoot);
  if (token === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Klasör hiçbir depoya girmesin (çalışma klasörü bir git deposunun içinde olabilir)
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# Kurmay'ın gizli ayarları — depoya girmez\n*\n");
  fs.writeFileSync(file, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // var olan dosyada mode yazılmaz
  } catch {
    /* Windows */
  }
}

/** TFS modu kullanıma hazır mı: açık + adres + proje + anahtar */
export function tfsReady(t: TfsConfig | undefined, configRoot: string): boolean {
  return !!(t?.enabled && t.url && t.project && readTfsToken(configRoot).token);
}

/** Bağlantı (anahtar dahil) — eksikse undefined. over: Ayarlar'da henüz kaydedilmemiş değerlerle deneme */
export function tfsConnection(
  t: TfsConfig | undefined,
  configRoot: string,
  over: Partial<Pick<TfsConnection, "url" | "project" | "token" | "insecureTls" | "caFile">> = {},
): TfsConnection | undefined {
  const url = (over.url ?? t?.url ?? "").trim().replace(/\/+$/, "");
  const project = (over.project ?? t?.project ?? "").trim();
  const token = over.token?.trim() || readTfsToken(configRoot).token;
  if (!url || !token) return undefined;
  const caFile = (over.caFile ?? t?.caFile ?? "").trim();
  return {
    url,
    project,
    token,
    ...((over.insecureTls ?? t?.insecureTls) ? { insecureTls: true } : {}),
    ...(caFile ? { caFile: path.resolve(configRoot, caFile) } : {}),
  };
}

/** Panel ve Ayarlar için durum — anahtarın kendisi yok */
export function tfsView(t: TfsConfig | undefined, configRoot: string) {
  const tok = readTfsToken(configRoot);
  return {
    enabled: !!t?.enabled,
    url: t?.url ?? "",
    project: t?.project ?? "",
    writeBack: t?.writeBack ?? "ask",
    insecureTls: !!t?.insecureTls,
    caFile: t?.caFile ?? "",
    hasToken: !!tok.token,
    /** dosya | ortam (ortamdaysa Ayarlar'dan değiştirilemez) */
    tokenSource: tok.source ?? "",
    tokenEnv: tok.env ?? "",
    /** Anahtarın son 4 karakteri — hangi anahtarın kayıtlı olduğu anlaşılsın */
    tokenHint: tok.token ? tok.token.slice(-4) : "",
    ready: tfsReady(t, configRoot),
  };
}
