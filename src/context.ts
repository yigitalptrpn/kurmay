import { modelContextLength } from "./models.js";
import type { ProviderConfig } from "./types.js";

/**
 * Bağlam penceresi hesapları. Pencere model listesinden (vLLM `max_model_len`)
 * okunur, yoksa Ayarlar'daki elle girilen değer (limits.contextTokens) geçerli.
 *
 * DİKKAT — yanıt payı: Claude Code her istekte yanıt için `max_tokens=32000`
 * istiyor (sahte API ile ölçüldü; pencereden bağımsız, CLAUDE_CODE_MAX_OUTPUT_TOKENS
 * değiştirir). vLLM "girdi + istenen yanıt" toplamını max_model_len ile kıyaslar,
 * yani asıl duvar `pencere − yanıt payı`. Doluluk bu kullanılabilir sınıra göre.
 */

/** Claude Code'un yanıt için istediği varsayılan token (max_tokens) */
export const DEFAULT_OUTPUT_RESERVE = 32_000;
/** Otomatik özetleme eşiği varsayılanı (kullanılabilir bağlamın yüzdesi) */
export const DEFAULT_COMPACT_PERCENT = 75;
/** Özetleme olmazsa bu doluluğun üstünde konuşma sürdürülmez, yenisi açılır */
export const FORCE_NEW_PERCENT = 95;

export interface ContextInfo {
  /** Modelin bağlam penceresi */
  window: number;
  /** Kullanılabilir sınır (pencere − yanıt payı) */
  limit: number;
}

/** Modelin bağlam penceresi ve kullanılabilir sınırı; bilinmiyorsa undefined */
export function contextInfo(model: string | undefined, cfg: ProviderConfig): ContextInfo | undefined {
  const window = modelContextLength(model) ?? cfg.limits?.contextTokens;
  if (!window || window <= 0) return undefined;
  const reserve = cfg.limits?.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE;
  // Yanıt payı pencerenin büyük kısmını kaplıyorsa sunucu isteneni kırpıyor demektir
  // (kırpmasaydı model hiç çalışmazdı) — o durumda tüm pencere kullanılabilir sayılır
  const limit = window - reserve >= window * 0.25 ? window - reserve : window;
  return { window, limit };
}

/** Özetleme eşiği (yüzde, 0 = kapalı) */
export function compactPercent(cfg: ProviderConfig): number {
  return cfg.limits?.compactPercent ?? DEFAULT_COMPACT_PERCENT;
}

/** Bir model yanıtının kullanım bilgisinden konuşmanın boyutu: girdi (önbellek dahil) + yanıt */
export function tokensOfUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
  return total > 0 ? total : undefined;
}

/**
 * Sunucunun "bağlam doldu" hatası mı. vLLM iki biçimde yazar: "This model's maximum
 * context length is …" (girdi + istenen yanıt sığmıyor) ve "The decoder prompt (length …)
 * is longer than the maximum model length of …" (girdi tek başına sığmıyor). Anthropic
 * "prompt is too long" / "exceed context limit", OpenAI "context_length_exceeded".
 * Gevşek ifadeler ("too many tokens", yalın "context window") istek sınırı ya da başka
 * hata metinlerinde de geçtiği için YOK — yanlış eşleşme konuşmayı boşuna özetletiyordu.
 */
export function isContextFullError(message: string): boolean {
  return /maximum context length|maximum model length|context length|context[ _-]?(?:window|limit)[ _-]?exceeded|exceeds? (?:the )?(?:available )?context (?:window|limit|size)|prompt is too long|input is too long|context_length_exceeded/i.test(message);
}
