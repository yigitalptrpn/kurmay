import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildAgentEnv } from "./config.js";
import { reviewVerdictJsonSchema, ReviewVerdictSchema, type ProviderConfig, type ReviewVerdict } from "./types.js";

/**
 * Teftiş'in serbest metin raporundan karar nesnesi çıkarır.
 *
 * - Anthropic + ANTHROPIC_API_KEY tanımlıysa: doğrudan API + structured output;
 *   şema API tarafında zorlanır, geçersiz JSON gelmesi imkânsızdır.
 * - Diğer durumlarda (Claude Code oturumu veya Ollama): Agent SDK ile JSON
 *   istenir, Zod ile doğrulanır; uymazsa hata mesajıyla bir kez yeniden denenir.
 */
export async function extractVerdict(
  reviewText: string,
  cfg: ProviderConfig,
  abortController?: AbortController,
): Promise<ReviewVerdict> {
  const key = cfg.provider === "anthropic" ? (cfg.apiKey ?? process.env.ANTHROPIC_API_KEY) : undefined;
  return key
    ? extractWithStructuredOutput(reviewText, cfg, key, abortController)
    : extractWithAgentSdk(reviewText, cfg, abortController);
}

function buildExtractionPrompt(reviewText: string): string {
  return [
    "Aşağıda bir kod inceleme raporu var. Rapordan karar nesnesini çıkar:",
    "- approved: rapor nihai kararda ONAYLANDI diyorsa true, REDDEDİLDİ diyorsa false.",
    "  Karar satırı yoksa: medium/high önem dereceli sorun varsa false, yoksa true.",
    "- issues: raporda listelenen her sorun (dosya, açıklama, önem derecesi).",
    "- summary: raporun 1-2 cümlelik özeti.",
    "",
    "--- RAPOR ---",
    reviewText,
  ].join("\n");
}

// ── Yol 1: Doğrudan API + structured output (Anthropic + API key) ──

async function extractWithStructuredOutput(
  reviewText: string,
  cfg: ProviderConfig,
  apiKey: string,
  abortController?: AbortController,
): Promise<ReviewVerdict> {
  const client = new Anthropic({ apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  const response = await client.messages.parse(
    {
      model: cfg.model ?? "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: buildExtractionPrompt(reviewText) }],
      output_config: { format: zodOutputFormat(ReviewVerdictSchema) },
    },
    // Durdur butonu bu çağrıyı da kessin
    abortController ? { signal: abortController.signal } : undefined,
  );

  if (!response.parsed_output) {
    throw new Error("Teftiş kararı ayrıştırılamadı (parsed_output boş)");
  }
  return response.parsed_output;
}

// ── Yol 2: Agent SDK'nin yerleşik structured output'u (Claude Code oturumu veya
//    Ollama; API key gerekmez). Şema uyumunu SDK zorlar ve gerekirse kendisi
//    yeniden dener; Zod ayrıştırması yalnızca TypeScript tipi kazanmak için. ──

async function extractWithAgentSdk(
  reviewText: string,
  cfg: ProviderConfig,
  abortController?: AbortController,
): Promise<ReviewVerdict> {
  const env = buildAgentEnv(cfg);
  const model = cfg.model;

  for await (const message of query({
    prompt: buildExtractionPrompt(reviewText),
    options: {
      allowedTools: [],
      permissionMode: "default",
      // Durdur butonu bu çağrıyı da kessin (bkz. extractWithStructuredOutput)
      ...(abortController ? { abortController } : {}),
      // maxTurns kısıtı KOYMA: SDK, şemaya uymayan çıktıyı ek turlarla kendisi
      // düzeltir; tek turda kesilirse structured_output boş kalır (yaşandı)
      outputFormat: {
        type: "json_schema",
        schema: reviewVerdictJsonSchema(),
      },
      ...(env ? { env } : {}),
      ...(model ? { model } : {}),
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success" && message.structured_output !== undefined) {
        const parsed = ReviewVerdictSchema.safeParse(message.structured_output);
        if (parsed.success) return parsed.data;
        throw new Error(`Teftiş kararı şemaya uymadı: ${parsed.error.message}`);
      }
      throw new Error(`Teftiş kararı çıkarılamadı: ${message.subtype}`);
    }
  }

  throw new Error("Teftiş kararı çıkarılamadı: sonuç mesajı gelmedi");
}
