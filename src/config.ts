import fs from "node:fs";
import path from "node:path";
import { CLI_STALL_MIN_MS } from "./resilience.js";
import { EFFORT_LEVELS, isCommandNode, isFanoutNode, type AppConfig, type EffortSetting, type McpServerJson, type ProviderConfig } from "./types.js";

/**
 * Tek config dosyasını yükler ve doğrular: sağlayıcı bilgileri (adres, token,
 * model), hedef dizin ve iş akışı grafı hepsi aynı dosyadadır.
 */
export function loadAppConfig(configPath: string): AppConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config dosyası bulunamadı: ${resolved}`);
  }

  const cfg = JSON.parse(fs.readFileSync(resolved, "utf8")) as AppConfig;

  // Hook komutlarında "${configDir}" = bu config dosyasının klasörü. Hook ajanın
  // çalışma dizininde (hedef proje) çalıştığı için göreli yol kırılıyor, mutlak yol da
  // makineye özel kalıyordu (npm paketiyle her kurulumda farklı). Yalnızca bellekte
  // çözülür; dosyaya yazan uçlar ham dosyayı okuduğu için yer tutucu korunur.
  const configDir = path.dirname(resolved).replace(/\\/g, "/");
  for (const node of Object.values(cfg.workflow?.agents ?? {})) {
    for (const hook of (node as { hooks?: Array<{ command?: unknown }> }).hooks ?? []) {
      if (typeof hook.command === "string") hook.command = hook.command.split("${configDir}").join(configDir);
    }
  }

  // Boş bırakılan ("") alanlar tanımsız sayılır — config şablonunda alanların
  // görünür kalması için boş string'e izin veriyoruz
  for (const key of ["baseUrl", "apiKey", "model", "modelsUrl", "targetDir"] as const) {
    if (cfg[key] === "") delete cfg[key];
  }
  if ((cfg.effort as string | undefined) === "") delete cfg.effort;
  if (cfg.effort !== undefined && !isEffort(cfg.effort)) {
    throw new Error(`config: "effort" şunlardan biri olmalı: ${EFFORT_LEVELS.join(", ")} (verilen: ${JSON.stringify(cfg.effort)})`);
  }

  if (cfg.provider !== "anthropic" && cfg.provider !== "ollama") {
    throw new Error('config: "provider" alanı "anthropic" veya "ollama" olmalı');
  }

  if (cfg.provider === "ollama") {
    if (!cfg.baseUrl) cfg.baseUrl = "http://localhost:11434";
    if (!cfg.apiKey) cfg.apiKey = "ollama"; // Ollama değeri umursamaz ama boş bırakılamaz
    // Model boş olabilir: sunucu modunda panelden sonradan seçilir (modelMissing).
    // Koşu ancak model seçilince başlar — orada kontrol ediliyor, burada değil.
  }

  // Sınırlar sayı olmalı — hatalı değer env'e "NaN" olarak sızmasın
  for (const [key, value] of Object.entries(cfg.limits ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`config: "limits.${key}" negatif olmayan bir sayı olmalı (verilen: ${JSON.stringify(value)})`);
    }
  }
  // Claude Code 15'in üstünü uyarıyla 15'e indiriyor — sessiz kırpma yerine açık hata
  const icDeneme = cfg.limits?.apiMaxRetries;
  if (icDeneme !== undefined && (!Number.isInteger(icDeneme) || icDeneme > 15)) {
    throw new Error(`config: "limits.apiMaxRetries" 0 ile 15 arasında bir tam sayı olmalı (verilen: ${JSON.stringify(icDeneme)})`);
  }
  const esik = cfg.limits?.compactPercent;
  if (esik !== undefined && esik > 100) {
    throw new Error(`config: "limits.compactPercent" 0 ile 100 arasında olmalı (verilen: ${JSON.stringify(esik)})`);
  }

  // Yeniden deneme ayarları: "enabled"/"jitter" mantıksal, diğerleri negatif olmayan sayı
  for (const [key, value] of Object.entries(cfg.retry ?? {})) {
    if (key === "enabled" || key === "jitter") {
      if (typeof value !== "boolean") {
        throw new Error(`config: "retry.${key}" true/false olmalı (verilen: ${JSON.stringify(value)})`);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`config: "retry.${key}" negatif olmayan bir sayı olmalı (verilen: ${JSON.stringify(value)})`);
    }
  }

  for (const [key, ne] of [["disabledSkills", "beceri"], ["disabledRules", "kural"]] as const) {
    const list = cfg[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((s) => typeof s !== "string"))) {
      throw new Error(`config: "${key}" ${ne} adlarından oluşan bir liste olmalı (verilen: ${JSON.stringify(list)})`);
    }
  }
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    if (server.disabled !== undefined && typeof server.disabled !== "boolean") {
      throw new Error(`config: "mcpServers.${name}.disabled" true/false olmalı (verilen: ${JSON.stringify(server.disabled)})`);
    }
  }

  if (cfg.maxParallelRuns !== undefined && (!Number.isInteger(cfg.maxParallelRuns) || cfg.maxParallelRuns < 1)) {
    throw new Error(`config: "maxParallelRuns" 1 veya daha büyük bir tam sayı olmalı (verilen: ${JSON.stringify(cfg.maxParallelRuns)})`);
  }

  if (!cfg.workflow?.entry || !cfg.workflow.agents) {
    throw new Error('config: "workflow" bölümü eksik ("entry" ve "agents" alanları zorunlu)');
  }
  for (const [key, node] of Object.entries(cfg.workflow.agents)) {
    const effort = (node as { effort?: unknown }).effort;
    if (effort === "") delete (node as { effort?: unknown }).effort;
    else if (effort !== undefined && !isEffort(effort)) {
      throw new Error(`config: "${key}.effort" şunlardan biri olmalı: ${EFFORT_LEVELS.join(", ")} (verilen: ${JSON.stringify(effort)})`);
    }
  }
  if (!cfg.workflow.agents[cfg.workflow.entry]) {
    throw new Error(`config: workflow.entry "${cfg.workflow.entry}" agents içinde tanımlı değil`);
  }
  if (!cfg.workflow.maxCycles) cfg.workflow.maxCycles = 5;
  const autoForward = cfg.workflow.autoForwardPlan;
  if (autoForward !== undefined && typeof autoForward !== "boolean") {
    throw new Error(`config: "workflow.autoForwardPlan" true/false olmalı (verilen: ${JSON.stringify(autoForward)})`);
  }

  // Ajanların tools listesindeki mcp__ araçları tanımlı bir sunucuya işaret etmeli
  for (const [key, node] of Object.entries(cfg.workflow.agents)) {
    const type = (node as { type?: unknown }).type;
    if (type !== undefined && type !== "agent" && type !== "command" && type !== "fanout") {
      throw new Error(
        `config: "${key}" düğümünün tipi ${JSON.stringify(type)} tanınmıyor (agent | command | fanout)` +
          (type === "parallel" ? ' — paralel inceleme kaldırıldı; tek teftiş düğümü için "verdict" kullan' : ""),
      );
    }
    const sr = (node as { securityReport?: unknown }).securityReport;
    if (sr !== undefined && typeof sr !== "boolean") {
      throw new Error(`config: "${key}.securityReport" true/false olmalı (verilen: ${JSON.stringify(sr)})`);
    }
    if (node.disabled !== undefined && typeof node.disabled !== "boolean") {
      throw new Error(`config: "${key}.disabled" true/false olmalı (verilen: ${JSON.stringify(node.disabled)})`);
    }
    if (isCommandNode(node)) {
      if (typeof node.command !== "string" || !node.command.trim()) {
        throw new Error(`config: "${key}" komut düğümü için "command" (build komutu) zorunlu`);
      }
      continue; // komut düğümünün tools listesi yok
    }
    if (isFanoutNode(node)) {
      const mc = node.maxConcurrency;
      if (mc !== undefined && (!Number.isInteger(mc) || mc < 0)) {
        throw new Error(`config: "${key}.maxConcurrency" negatif olmayan bir tam sayı olmalı (verilen: ${JSON.stringify(mc)})`);
      }
      continue; // fanout da bir kapı; çoğalttığı ajanın araçları kendi düğümünde kontrol edilir
    }
    for (const tool of node.tools) {
      if (tool.startsWith("mcp__")) {
        const serverName = tool.slice(5).split("__")[0];
        if (!cfg.mcpServers?.[serverName]) {
          throw new Error(
            `config: "${key}" ajanı "${tool}" aracını istiyor ama "${serverName}" mcpServers içinde tanımlı değil`,
          );
        }
      }
    }
  }

  return cfg;
}

/**
 * Ajan koşusuna verilecek MCP sunucuları: kapalılar çıkarılır, "disabled" alanı
 * SDK'ye gitmez (Claude Code'un sunucu şemasında yok). Hiç açık sunucu yoksa undefined.
 */
export function activeMcpServers(cfg: ProviderConfig): Record<string, McpServerJson> | undefined {
  const active: Record<string, McpServerJson> = {};
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    if (server.disabled) continue;
    const { disabled: _, ...rest } = server;
    active[name] = rest as McpServerJson;
  }
  return Object.keys(active).length > 0 ? active : undefined;
}

/** Kapalı MCP sunucularının adları */
export function disabledMcpServers(cfg: ProviderConfig): string[] {
  return Object.entries(cfg.mcpServers ?? {})
    .filter(([, s]) => s.disabled)
    .map(([name]) => name);
}

/** "mcp__<sunucu>" ya da "mcp__<sunucu>__<araç>" aracı kapalı bir sunucuya mı ait? */
export function isOffMcpTool(tool: string, offServers: readonly string[]): boolean {
  return tool.startsWith("mcp__") && offServers.includes(tool.slice(5).split("__")[0]);
}

/**
 * Koşu için model eksik mi? Ollama'da model zorunlu (Claude Code'un varsayılan
 * model adı Ollama'da yoktur). Config'te boş bırakılabilir — panelden seçilene
 * kadar görev başlatılmaz.
 */
/** Geçerli bir akıl yürütme derinliği mi (EFFORT_LEVELS) */
export function isEffort(v: unknown): v is EffortSetting {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export function modelMissing(cfg: ProviderConfig): boolean {
  return cfg.provider === "ollama" && !cfg.model;
}

/**
 * Agent SDK'nin başlattığı Claude Code sürecine geçirilecek ortam değişkenleri.
 * İki kaynak: baseUrl tanımlıysa sağlayıcı yönlendirmesi (örn. Ollama), ve
 * config'deki "limits" (maliyet/süre sınırları). Hiçbiri yoksa undefined döner
 * ve mevcut ortam aynen kullanılır (Anthropic varsayılanı).
 */
export function buildAgentEnv(cfg: ProviderConfig): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};

  if (cfg.baseUrl) {
    overrides.ANTHROPIC_BASE_URL = cfg.baseUrl;
    overrides.ANTHROPIC_AUTH_TOKEN = cfg.apiKey ?? "ollama";
    if (cfg.model) {
      overrides.ANTHROPIC_MODEL = cfg.model;
      // Claude Code'un iç işleri için kullandığı küçük model de yerelden gelsin
      overrides.ANTHROPIC_SMALL_FAST_MODEL = cfg.model;
    }
  }

  // Sınırlar sağlayıcıdan bağımsız uygulanır — verilmeyen alan SDK varsayılanında kalır
  const limits = cfg.limits;
  if (limits) {
    const map: Array<[number | undefined, string]> = [
      [limits.structuredOutputRetries, "MAX_STRUCTURED_OUTPUT_RETRIES"],
      [limits.apiTimeoutMs, "API_TIMEOUT_MS"],
      [limits.maxOutputTokens, "CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
      [limits.maxMcpOutputTokens, "MAX_MCP_OUTPUT_TOKENS"],
      [limits.maxThinkingTokens, "MAX_THINKING_TOKENS"],
      [limits.apiMaxRetries, "CLAUDE_CODE_MAX_RETRIES"],
      // Bağlam penceresi: runAgent modelin gerçek sınırını (model listesinden) buraya koyar
      [limits.contextTokens, "CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
    ];
    for (const [value, envName] of map) {
      if (value !== undefined) overrides[envName] = String(value);
    }
  }

  // Akış takılma süresi 5 dk ve üstüyse Claude Code'un kendi bekçisine verilir
  // (altını kendi bekçimiz yönetir — runAgent); varsayılan 5 dk zaten CLI'nin değeri
  const stall = cfg.retry?.stallTimeoutMs;
  if (stall !== undefined && stall > CLI_STALL_MIN_MS) overrides.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(stall);

  if (Object.keys(overrides).length === 0) return undefined;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, overrides);
  if (cfg.baseUrl) delete env.ANTHROPIC_API_KEY; // AUTH_TOKEN ile çakışmasın

  return env;
}
