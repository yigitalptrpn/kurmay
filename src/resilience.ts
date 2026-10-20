import { isContextFullError } from "./context.js";
import type { LimitsConfig, ProviderConfig, RetryConfig } from "./types.js";

/**
 * Bağlantı dayanıklılığı: model sunucusu (ör. yük altındaki vLLM) 503, zaman
 * aşımı, akış kopması gibi hatalar verdiğinde ajanın işine devam etmesi.
 *
 * İki katman var:
 * 1. Claude Code'un kendi içi (CLI): tek istek için 503/429/5xx/zaman aşımı/
 *    bağlantı kopmasını süreç kapanmadan yeniden dener (CLAUDE_CODE_MAX_RETRIES,
 *    varsayılan 10), akış ortasında kopan yanıtı akışsız istekle tamamlar.
 *    Bize yalnızca "system/api_retry" mesajı gelir.
 * 2. Bizim dış katmanımız (runAgent executeWithRetry): CLI pes edince hata bize
 *    "hata sonucu" olarak gelir; ajan oturumu SÜRDÜRÜLEREK (resume) yeniden
 *    çalıştırılır — baştan başlamaz. Varsayılan sınırsız.
 *
 * Ayarlar canlıdır: Ayarlar sayfasından değişince (setLiveResilience) o an
 * bekleyen/çalışan ajanların bir sonraki denemesi yeni değerleri kullanır.
 */

/** Varsayılanlar — config'te verilmeyen alan bunları alır */
export const RETRY_DEFAULTS = {
  enabled: true,
  maxAttempts: 0, // 0 = sınırsız
  permanentMaxAttempts: 5,
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  jitter: true,
  stallTimeoutMs: 300_000,
} as const;

export type RetrySettings = { -readonly [K in keyof typeof RETRY_DEFAULTS]: (typeof RETRY_DEFAULTS)[K] extends boolean ? boolean : number };

/**
 * Claude Code'un kendi akış bekçisinin alt sınırı (CLAUDE_STREAM_IDLE_TIMEOUT_MS,
 * kurulu CLI'de max(değer, 300000)). Sahte API ile doğrulandı: akış takılınca tam
 * 300 sn'de devreye girip yanıtı akışsız istekle süreç kapanmadan tamamlıyor.
 * Bu yüzden takılma süresi >= bu değerse iş CLI'ye bırakılır (ortam değişkeni),
 * altındaysa kendi bekçimiz denemeyi keser ve konuşmayı sürdürür.
 */
export const CLI_STALL_MIN_MS = 300_000;

/** Ayarlar sayfasının değiştirebildiği alanlar (POST /resilience) */
export const RESILIENCE_RETRY_KEYS = [
  "enabled", "maxAttempts", "permanentMaxAttempts", "initialDelayMs", "maxDelayMs", "jitter", "stallTimeoutMs",
] as const;
export const RESILIENCE_LIMIT_KEYS = [
  "apiTimeoutMs", "apiMaxRetries", "contextTokens", "compactPercent", "maxOutputTokens",
] as const;

/** Servis açıkken Ayarlar'dan gelen güncel değerler (yoksa koşunun config kopyası geçerli) */
let live: { retry?: RetryConfig; limits?: LimitsConfig } | undefined;

/** Ayarlar değişince (ve açılışta) çağrılır — çalışan koşular da bunu görür */
export function setLiveResilience(cfg: Pick<ProviderConfig, "retry" | "limits">): void {
  live = { retry: cfg.retry, limits: cfg.limits };
}

/** Geçerli yeniden deneme ayarları: canlı değer > koşunun config'i > varsayılan */
export function retrySettings(fallback?: RetryConfig): RetrySettings {
  const r = (live ? live.retry : fallback) ?? {};
  return {
    enabled: r.enabled ?? RETRY_DEFAULTS.enabled,
    maxAttempts: r.maxAttempts ?? RETRY_DEFAULTS.maxAttempts,
    permanentMaxAttempts: r.permanentMaxAttempts ?? RETRY_DEFAULTS.permanentMaxAttempts,
    initialDelayMs: r.initialDelayMs ?? RETRY_DEFAULTS.initialDelayMs,
    maxDelayMs: r.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs,
    jitter: r.jitter ?? RETRY_DEFAULTS.jitter,
    stallTimeoutMs: r.stallTimeoutMs ?? RETRY_DEFAULTS.stallTimeoutMs,
  };
}

/** Ajanın ortam değişkenleri için config: sınırlar (zaman aşımı, iç deneme, takılma) canlı değerden */
export function withLiveResilience(cfg: ProviderConfig): ProviderConfig {
  return live ? { ...cfg, limits: live.limits, retry: live.retry } : cfg;
}

/**
 * n. bekleme (0'dan başlar): ilk bekleme her adımda ikiye katlanır, tavanı
 * aşmaz. Rastgele dağıtma açıksa sürenin yarısı sabit, yarısı rastgele —
 * aynı anda kopan istemciler sunucuya aynı saniyede geri yüklenmesin.
 */
export function backoffDelay(step: number, s: RetrySettings): number {
  const cap = Math.max(s.initialDelayMs, s.maxDelayMs);
  const base = Math.min(s.initialDelayMs * 2 ** Math.min(step, 30), cap);
  return Math.round(s.jitter ? base / 2 + Math.random() * (base / 2) : base);
}

/** Akış takıldı: yanıt akmaya başladıktan sonra belirlenen süre boyunca veri gelmedi */
export class StallError extends Error {
  constructor(public readonly ms: number) {
    super(`yanıt akışı takıldı: ${Math.round(ms / 1000)} sn boyunca veri gelmedi`);
    this.name = "StallError";
  }
}

/**
 * Hata türü:
 * - transient: geçici (sunucu meşgul, zaman aşımı, bağlantı) — sınırsız denenir
 * - permanent: kalıcı görünen (yetki, model yok, istek reddedildi) — üst üste
 *   deneme sınırına tabi
 * - lost_session: sürdürülecek konuşma bulunamadı — yeni konuşmayla denenir
 * - context_full: modelin bağlam penceresi doldu — konuşma özetlenir, olmazsa yeni konuşma
 */
export type ErrorKind = "transient" | "permanent" | "lost_session" | "context_full";

export interface ClassifiedError {
  kind: ErrorKind;
  /** Panelde görünen Türkçe sebep */
  reason: string;
  status?: number;
  /** Altyapı kaynaklı (sunucu meşgul, ağ, zaman aşımı): isteğin içeriğiyle ilgisi
   *  yok, beklemek yeter. Yoksa hata bu isteğe/konuşmaya özgü olabilir (500, 400,
   *  tanınmayan) — tekrarlıyorsa konuşma bozuk sayılır (runAgent) */
  infra?: boolean;
}

/** Sunucunun "meşgulüm / zaman aşımı" kodları — metinleri bağlam hatası sayılmaz
 *  (ör. 429 "too many tokens per minute") */
const BUSY_STATUSES = [408, 429, 503, 529];
/** İsteğin içeriğinden bağımsız, altyapı kaynaklı durum kodları */
const INFRA_STATUSES = [408, 409, 429, 502, 503, 504, 529];

/** Claude Code'un hata kodu (assistant.error / api_retry.error) → Türkçe sebep */
const API_ERROR_NAMES: Record<string, string> = {
  server_error: "sunucu hatası",
  overloaded: "sunucu aşırı yüklü",
  rate_limit: "istek sınırı aşıldı",
  authentication_failed: "kimlik doğrulama başarısız",
  oauth_org_not_allowed: "kimlik doğrulama başarısız",
  billing_error: "hesap/ödeme hatası",
  invalid_request: "istek reddedildi",
  model_not_found: "model bulunamadı",
  max_output_tokens: "çıktı sınırı aşıldı",
  unknown: "bağlantı hatası",
};

/** Kalıcı sayılan Claude Code hata kodları */
const PERMANENT_API_ERRORS = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error", "invalid_request", "model_not_found",
]);

/** HTTP durum kodu → Türkçe sebep */
export function statusReason(status: number): string {
  if (status === 503) return "sunucu meşgul (503)";
  if (status === 529) return "sunucu aşırı yüklü (529)";
  if (status === 502 || status === 504) return `ağ geçidi hatası (${status})`;
  if (status === 429) return "istek sınırı aşıldı (429)";
  if (status === 408) return "zaman aşımı (408)";
  if (status === 409) return "çakışma (409)";
  if (status === 401 || status === 403) return `yetki hatası (${status})`;
  if (status === 404) return "model ya da adres bulunamadı (404)";
  if (status === 413) return "istek çok büyük (413)";
  if (status >= 500) return `sunucu hatası (${status})`;
  if (status >= 400) return `istek reddedildi (${status})`;
  return `hata (${status})`;
}

/** Bir api_retry / hata kaydının Türkçe sebebi (durum kodu varsa o, yoksa hata kodu) */
export function apiErrorReason(status: number | null | undefined, apiError?: string): string {
  if (status) return statusReason(status);
  return (apiError && API_ERROR_NAMES[apiError]) || "bağlantı hatası";
}

/**
 * Hatayı sınıflandırır. Kaynaklar: Claude Code'un mesaj metni ("API Error: 503 …",
 * "Request timed out", "Unable to connect to API (ECONNRESET)", "No conversation
 * found …") ve son assistant mesajındaki hata kodu. Sahte vLLM benzeri sunucuyla
 * her biri üretilip doğrulandı. Tanınmayan her şey GEÇİCİ sayılır: amaç işin
 * devam etmesi — yanlışlıkla kalıcı saymak akışı düşürür.
 */
export function classifyError(err: unknown, apiError?: string): ClassifiedError {
  if (err instanceof StallError) {
    return { kind: "transient", infra: true, reason: `akış takıldı (${Math.round(err.ms / 1000)} sn veri gelmedi)` };
  }
  const msg = err instanceof Error ? err.message : String(err);

  if (/No conversation found/i.test(msg)) {
    return { kind: "lost_session", reason: "sürdürülecek konuşma bulunamadı" };
  }

  // Durum kodu: "API Error: 503 …", "Request rejected (429)", "API Error: 401 …"
  const m = /API Error:\s*(\d{3})\b/.exec(msg) ?? /\((\d{3})\)/.exec(msg);
  const code = m ? Number(m[1]) : undefined;
  const status = code && code >= 100 && code < 600 ? code : undefined;

  // vLLM "This model's maximum context length is …" (400) — Claude Code bunu tanımıyor,
  // sıradan 400 sanıyor; aynı konuşmayı tekrar göndermek hep aynı hatayı verir.
  // Meşgul kodlarında aranmaz: istek sınırı metni bağlam doldu sanılıp konuşma özetlenmesin
  if (!(status && BUSY_STATUSES.includes(status)) && isContextFullError(msg)) {
    return { kind: "context_full", reason: "bağlam penceresi doldu" };
  }

  if (status) {
    const permanent = [400, 401, 403, 404, 413, 422].includes(status);
    return {
      kind: permanent ? "permanent" : "transient",
      reason: statusReason(status),
      status,
      ...(INFRA_STATUSES.includes(status) ? { infra: true } : {}),
    };
  }

  if (/timed? ?out|timeout|ETIMEDOUT/i.test(msg)) return { kind: "transient", infra: true, reason: "zaman aşımı (yanıt gelmedi)" };
  // Önce kopma: Claude Code ECONNRESET'i de "Unable to connect to API (ECONNRESET)" diye yazıyor
  if (/ECONNRESET|socket hang up|EPIPE|terminated|premature|aborted|Connection error|network/i.test(msg)) {
    return { kind: "transient", infra: true, reason: "bağlantı koptu" };
  }
  if (/ECONNREFUSED|Unable to connect|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return { kind: "transient", infra: true, reason: "sunucuya bağlanılamadı" };
  }
  if (/overloaded/i.test(msg)) return { kind: "transient", infra: true, reason: "sunucu aşırı yüklü" };

  if (apiError) {
    return {
      kind: PERMANENT_API_ERRORS.has(apiError) ? "permanent" : "transient",
      reason: API_ERROR_NAMES[apiError] ?? "bağlantı hatası",
      ...(apiError === "rate_limit" || apiError === "overloaded" ? { infra: true } : {}),
    };
  }
  // Bütçe/tur sınırı gibi ajanın kendi sınırları — tekrar denemek aynı yere çıkar
  if (/error_max_turns|error_max_budget/i.test(msg)) return { kind: "permanent", reason: "ajan sınırına ulaşıldı" };
  return { kind: "transient", reason: "beklenmeyen hata" };
}

/**
 * Yeniden denemede gönderilen kısa devam mesajı. Sahte API ile doğrulandı:
 * istek sunucuya gitmeden önce görev metni konuşma kaydına yazılmış oluyor —
 * resume'da görevi TEKRAR göndermek modele aynı görevi iki kez verir (yerel
 * modelleri şaşırtıyordu). Görev konuşmada varsa bu mesaj gider.
 */
export const CONTINUE_PROMPT =
  "Model sunucusuyla bağlantı kesildiği için yanıtın yarıda kaldı. Görevin yukarıda, " +
  "bu konuşmada duruyor — tekrar gönderilmedi. Kaldığın yerden devam et: tamamladığın " +
  "adımları ve araç çağrılarını tekrarlama, yarıda kalan işi bitir ve sonucunu istenen biçimde ver.";

/** Devam mesajı zaten gitmiş ve arada model hiç yanıt verememişse: uzun metin birikmesin */
export const CONTINUE_PROMPT_SHORT = "Devam et.";
