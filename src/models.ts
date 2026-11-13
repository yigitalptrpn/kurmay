/** Panelde seçilebilecek tek bir model */
export interface ModelInfo {
  /** Config'e yazılacak ve SDK'ye geçecek kimlik */
  id: string;
  /** Görünen ad (API vermezse id) */
  name: string;
  /** Bağlam penceresi, token (vLLM `max_model_len` vb.) — API vermezse yok */
  contextLength?: number;
}

/** Model listesinden okunan bağlam pencereleri — her liste çekilişinde güncellenir */
const contextByModel = new Map<string, number>();
let contextFetchedAt = 0;
/** Başarıyla alınmış listede görülen model kimlikleri — listede olup sınırı yazmayan model için tekrar çekilmez */
const seenModels = new Set<string>();
let contextFetching: Promise<void> | null = null;

/** Modelin bilinen bağlam penceresi (listede yoksa ya da liste çekilmediyse undefined) */
export function modelContextLength(model?: string): number | undefined {
  return model ? contextByModel.get(model) : undefined;
}

/**
 * Modelin bağlam penceresi henüz bilinmiyorsa model listesini çeker. Bir kez
 * öğrenilen pencere unutulmaz ve bir daha çekilmez (sınırlar değişmiyor). Liste
 * alınamazsa (ör. model sunucusu meşgul, 503) hata yutulur, en erken 10 sn sonra
 * yeniden denenir — o arada elle girilen değer (limits.contextTokens) geçerli.
 * Aynı anda tek istek.
 */
export async function refreshModelContext(url: string | undefined, apiKey?: string, model?: string): Promise<void> {
  if (!url || (model ? contextByModel.has(model) || seenModels.has(model) : seenModels.size > 0)) return;
  if (Date.now() - contextFetchedAt < 10_000) return;
  if (!contextFetching) {
    contextFetching = fetchModels(url, apiKey)
      .then(
        () => undefined,
        () => {
          contextFetchedAt = Date.now();
        },
      ) // hatada da sık sık denenmesin
      .finally(() => {
        contextFetching = null;
      });
  }
  await contextFetching;
}

/**
 * Config'teki "modelsUrl" adresine GET atıp kullanılabilir modelleri döner.
 * API anahtarı başlıkta gider; hangi şemayı beklediğini bilmediğimiz için hem
 * `Authorization: Bearer` (OpenAI uyumlu / LiteLLM / vLLM) hem `x-api-key`
 * (Anthropic) gönderilir — sunucu tanımadığını yok sayar.
 *
 * Yanıt biçimi de sağlayıcıya göre değişir; şu üçü tanınır:
 *   { data: [{ id, display_name? | name? }] }   OpenAI / Anthropic
 *   { models: [{ name | model | id }] }          Ollama /api/tags
 *   [ "id", ... ] veya [{ id | name }, ...]      düz liste
 */
export async function fetchModels(url: string, apiKey?: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers["x-api-key"] = apiKey;
  }

  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`model listesi alınamadı: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }

  const json = (await res.json()) as unknown;
  const obj = json as { data?: unknown; models?: unknown };
  const list = Array.isArray(json)
    ? json
    : Array.isArray(obj?.data)
      ? obj.data
      : Array.isArray(obj?.models)
        ? obj.models
        : null;
  if (!list) throw new Error("model listesi tanınmayan biçimde (data[] / models[] / dizi bekleniyordu)");

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  // Bağlam penceresinin alan adı sunucuya göre değişir: vLLM max_model_len,
  // OpenRouter/LM Studio context_length / max_context_length, diğerleri context_window
  const CONTEXT_KEYS = ["max_model_len", "context_length", "max_context_length", "context_window", "max_input_tokens"];
  for (const item of list) {
    let id: string | undefined;
    let name: string | undefined;
    let contextLength: number | undefined;
    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const pick = (...keys: string[]) =>
        keys.map((k) => o[k]).find((v) => typeof v === "string" && v) as string | undefined;
      id = pick("id", "model", "name");
      name = pick("display_name", "name");
      const ctx = CONTEXT_KEYS.map((k) => o[k]).find((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
      if (typeof ctx === "number") contextLength = Math.floor(ctx);
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name ?? id, ...(contextLength ? { contextLength } : {}) });
  }
  // Bağlam pencerelerini hatırla (ajan koşuları ve panel buradan okur). Silinmez,
  // yalnızca eklenir/güncellenir: yük altında liste bir kez sınır alanı olmadan
  // dönerse (farklı ayarlı bir sunucu/ağ geçidi) bilinen pencere unutulmasın
  for (const m of models) {
    seenModels.add(m.id);
    if (m.contextLength) contextByModel.set(m.id, m.contextLength);
  }
  contextFetchedAt = Date.now();
  return models;
}
