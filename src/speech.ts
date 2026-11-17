import { readSecret, writeSecret } from "./tfsSettings.js";
import type { SpeechConfig } from "./types.js";

/**
 * Sesle görev yazma: panelde mikrofonla alınan kayıt model sunucusundaki (vLLM) ses tanıma
 * modeline (OpenAI uyumlu `/v1/audio/transcriptions`) gönderilir, çıkan metin görev kutusuna yazılır.
 * İstek tarayıcıdan değil sunucudan gider (başka adrese istek / http-https sorunu olmaz, anahtar
 * tarayıcıya hiç gitmez). Ek bağımlılık yok: Node'un yerleşik fetch + FormData'sı.
 *
 * Erişim anahtarı config.json'da DURMAZ (TFS anahtarı gibi `.gizli/ses.json`, ya da ortam değişkeni).
 */

export const SPEECH_TOKEN_ENV = "KURMAY_SES_TOKEN";
/** Kaydın en fazla boyutu: 16 kHz tek kanal WAV ≈ 32 KB/sn → 25 MB ≈ 13 dakika */
export const SPEECH_MAX_BYTES = 25 * 1024 * 1024;
/** Uzun kayıtta sunucunun yanıtı uzun sürebilir */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

export function readSpeechToken(configRoot: string): { token?: string; source?: "ortam" | "dosya" } {
  const v = process.env[SPEECH_TOKEN_ENV]?.trim();
  if (v) return { token: v, source: "ortam" };
  const token = readSecret(configRoot, "ses");
  return token ? { token, source: "dosya" } : {};
}

export function writeSpeechToken(configRoot: string, token: string | null): void {
  writeSecret(configRoot, "ses", token);
}

/** Panel ve Ayarlar için durum — anahtarın kendisi yok */
export function speechView(s: SpeechConfig | undefined, configRoot: string) {
  const tok = readSpeechToken(configRoot);
  return {
    ready: !!s?.url,
    url: s?.url ?? "",
    model: s?.model ?? "",
    language: s?.language ?? "tr",
    prompt: s?.prompt ?? "",
    hasToken: !!tok.token,
    tokenSource: tok.source ?? "",
    tokenEnv: tok.source === "ortam" ? SPEECH_TOKEN_ENV : "",
    tokenHint: tok.token ? tok.token.slice(-4) : "",
  };
}

/** "http://sunucu:8000/v1/" → "http://sunucu:8000" — kullanıcı /v1 ile de yazabilir */
export function speechBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

const authHeaders = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** Sunucunun hata metnini kısaltır (JSON ise içindeki mesajı alır) */
function serverText(body: string): string {
  let t = body.trim();
  try {
    const j = JSON.parse(t) as { message?: unknown; detail?: unknown; error?: { message?: unknown } | string };
    const m =
      typeof j.error === "object" && j.error?.message !== undefined
        ? j.error.message
        : (j.message ?? j.detail ?? j.error);
    if (typeof m === "string" && m.trim()) t = m.trim();
  } catch {
    /* düz metin */
  }
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

/** HTTP hatasını sade Türkçe açıklamaya çevirir; sunucunun kendi metni sona eklenir */
function httpError(status: number, body: string): string {
  const raw = serverText(body);
  const tail = raw ? ` Sunucunun yanıtı: ${raw}` : "";
  if (status === 401 || status === 403)
    return `Sunucu isteği kabul etmedi (${status}): erişim anahtarı eksik ya da yanlış.${tail}`;
  if (status === 404) {
    return `Sunucuda ses tanıma bulunamadı (404). Adresi ve model adını kontrol et; sunucuda yüklü model bir ses tanıma modeli olmalı.${tail}`;
  }
  if (status === 413) return `Kayıt sunucu için çok büyük (413). Daha kısa kayıt dene.${tail}`;
  if (/audio|librosa|soundfile/i.test(raw)) {
    return `Sunucu sesi işleyemedi (${status}). Sunucuda ses desteği eksik olabilir (vllm[audio] paketi).${tail}`;
  }
  if (status === 503 || status === 502 || status === 504)
    return `Sunucu şu an meşgul ya da kapalı (${status}). Biraz sonra yeniden dene.${tail}`;
  return `Sunucu hata verdi (${status}).${tail}`;
}

/** Bağlantı/zaman aşımı hatası → Türkçe */
function netError(e: unknown, base: string): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `Sunucu zamanında yanıt vermedi (${base}).`;
  const code = err?.cause?.code;
  if (code) return `Sunucuya bağlanılamadı (${code}): ${base}`;
  return `Sunucuya bağlanılamadı: ${base} (${err?.cause?.message ?? err?.message ?? String(e)})`;
}

/** Bağlantıyı dene: GET /v1/models → yüklü modeller */
export async function probeSpeech(
  url: string,
  token?: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const base = speechBase(url);
  if (!/^https?:\/\/\S+$/i.test(base)) return { ok: false, error: "Adres http:// ya da https:// ile başlamalı." };
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await r.text();
    if (!r.ok) return { ok: false, error: httpError(r.status, body) };
    let models: string[] = [];
    try {
      const j = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
      models = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      /* liste okunamadı ama sunucu yanıt verdi */
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/** Ses kaydını metne çevirir */
export async function transcribe(
  s: SpeechConfig,
  token: string | undefined,
  audio: Buffer,
  mime: string,
): Promise<{ ok: boolean; text?: string; error?: string; seconds?: number }> {
  const base = speechBase(s.url);
  const form = new FormData();
  const ext = /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /mp4|m4a/.test(mime) ? "m4a" : "wav";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/wav" }), `kayit.${ext}`);
  if (s.model) form.append("model", s.model);
  const lang = s.language ?? "tr";
  if (lang && lang !== "auto") form.append("language", lang); // "auto": dili model kendisi bulur
  if (s.prompt?.trim()) form.append("prompt", s.prompt.trim());
  form.append("response_format", "json");
  form.append("temperature", "0");
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: authHeaders(token),
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const body = await r.text();
    const seconds = (Date.now() - t0) / 1000;
    if (!r.ok) return { ok: false, error: httpError(r.status, body), seconds };
    let text = body;
    try {
      const j = JSON.parse(body) as { text?: unknown };
      if (typeof j.text === "string") text = j.text;
    } catch {
      /* düz metin yanıt */
    }
    return { ok: true, text: text.trim(), seconds };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}
