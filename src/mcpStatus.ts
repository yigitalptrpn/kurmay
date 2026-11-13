import { query, type McpServerConfig, type McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { activeMcpServers, buildAgentEnv } from "./config.js";
import type { McpServerJson, ProviderConfig } from "./types.js";

/** Eklentinin sunduğu bir araç (panelde araç listesi) */
export interface McpToolInfo {
  /** Kısa ad ("mcp__<sunucu>__" öneki atılmış) */
  name: string;
  /** Sunucunun verdiği açıklama (sunucunun dilinde, çevrilmez) */
  description?: string;
  /** Sunucuya göre yalnızca okur / değişiklik yapabilir */
  readOnly?: boolean;
  destructive?: boolean;
  /** Parametreler (yalnızca eklentiye doğrudan sorulunca — listMcpTools) */
  params?: Array<{ name: string; type?: string; description?: string; required?: boolean }>;
}

/** Bir eklentinin bilinen son durumu (paneldeki durum ışığı bunu gösterir) */
export interface McpLight {
  name: string;
  /** connected | failed | needs-auth | pending | disabled | unknown (henüz denenmedi) */
  status: string;
  error?: string;
  /** Bağlanınca sunucunun sunduğu araç sayısı */
  tools?: number;
  /** Araçların kendisi (ad, açıklama) — yalnızca panelin araç listesi için; olaylara konmaz */
  toolList?: McpToolInfo[];
  /** Sunucunun kendini tanıttığı ad ve sürüm */
  version?: string;
  /** Son bilginin zamanı (ISO) */
  at?: string;
  /** Bilgi nereden geldi: servisin yoklaması mı, bir ajan koşusu mu */
  source?: "yoklama" | "ajan";
}

/** SDK durum listesini sade biçime çevirir */
export function toLights(list: McpServerStatus[]): Array<Omit<McpLight, "at" | "source">> {
  const prefix = (server: string) => `mcp__${server}__`;
  return list.map((s) => ({
    name: s.name,
    status: s.status,
    ...(s.error ? { error: s.error } : {}),
    ...(s.tools
      ? {
          tools: s.tools.length,
          toolList: s.tools.map((t) => ({
            name: t.name.startsWith(prefix(s.name)) ? t.name.slice(prefix(s.name).length) : t.name,
            ...(t.description ? { description: t.description } : {}),
            ...(t.annotations?.readOnly ? { readOnly: true } : {}),
            ...(t.annotations?.destructive ? { destructive: true } : {}),
          })),
        }
      : {}),
    ...(s.serverInfo ? { version: `${s.serverInfo.name} ${s.serverInfo.version}` } : {}),
  }));
}

/**
 * Eklentilerin son bilinen durumu — tüm oturumlar için ortak, bellekte. Ajan
 * koşuları (runAgent) ve servis yoklaması (probeMcp) burayı günceller.
 */
class McpStatusStore {
  private last = new Map<string, McpLight>();
  probing: Promise<void> | null = null;
  probeError?: string;

  update(servers: Array<Omit<McpLight, "at" | "source">>, source: "yoklama" | "ajan"): void {
    const at = new Date().toISOString();
    for (const s of servers) this.last.set(s.name, { ...s, at, source });
  }

  /** Config'teki sunucular sırasıyla: kapalıysa "disabled", hiç denenmediyse "unknown" */
  snapshot(cfg: ProviderConfig): McpLight[] {
    return Object.entries(cfg.mcpServers ?? {}).map(([name, server]) => {
      if (server.disabled) return { name, status: "disabled" };
      return this.last.get(name) ?? { name, status: "unknown" };
    });
  }
}

export const mcpStatus = new McpStatusStore();

/**
 * Eklentileri model çağrısı yapmadan yoklar: Claude Code süreci boş bir girdiyle
 * açılır (prompt hiç gelmez → API'ye istek gitmez), sunucular bağlanınca durum
 * sorulur, süreç kapatılır. Sahte API ile doğrulandı: sıfır istek, ~1-2 sn.
 * Aynı anda tek yoklama koşar; ikinci çağrı ilkini bekler.
 */
export function probeMcp(cfg: ProviderConfig, cwd: string): Promise<void> {
  if (mcpStatus.probing) return mcpStatus.probing;
  const servers = activeMcpServers(cfg);
  if (!servers) return Promise.resolve();
  clearMcpToolCache(); // araç ayrıntıları da tazelensin
  mcpStatus.probing = (async () => {
    const ac = new AbortController();
    // Bilinçli olarak hiçbir şey üretmeyen girdi: istem gitmez, model çağrılmaz (yalnızca eklentiler bağlanır)
    // eslint-disable-next-line require-yield
    async function* bosGirdi(): AsyncGenerator<never> {
      await new Promise((r) => ac.signal.addEventListener("abort", r, { once: true }));
    }
    const env = buildAgentEnv(cfg);
    const q = query({
      prompt: bosGirdi(),
      options: {
        cwd,
        abortController: ac,
        allowedTools: [],
        strictMcpConfig: true,
        mcpServers: servers as Record<string, McpServerConfig>,
        ...(env ? { env } : {}),
      },
    });
    // Mesajlar okunmazsa süreç tıkanabilir — arka planda boşalt
    void (async () => {
      try {
        for await (const _ of q) {
          /* yoklamada mesaj beklenmez */
        }
      } catch {
        /* kapatınca "aborted" atar */
      }
    })();
    try {
      let list: McpServerStatus[] = [];
      for (let i = 0; i < 60; i++) {
        list = await q.mcpServerStatus();
        if (!list.some((s) => s.status === "pending")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      mcpStatus.update(toLights(list), "yoklama");
      mcpStatus.probeError = undefined;
    } catch (e) {
      mcpStatus.probeError = e instanceof Error ? e.message : String(e);
    } finally {
      ac.abort();
      mcpStatus.probing = null;
    }
  })();
  return mcpStatus.probing;
}

/**
 * Eklentinin araçlarını açıklama ve parametreleriyle getirir. Claude Code'un durum
 * bilgisi yalnızca araç adlarını veriyor (açıklama yok — denendi), bu yüzden eklentiye
 * resmi istemciyle doğrudan bağlanılıp tools/list sorulur, sonra bağlantı kapatılır.
 * Model çağrısı yapmaz. Sonuç bellekte tutulur (araçlar sık değişmez); yoklama
 * (probeMcp) önbelleği boşaltır.
 */
const toolCache = new Map<string, McpToolInfo[]>();

export function clearMcpToolCache(): void {
  toolCache.clear();
}

export async function listMcpTools(name: string, server: McpServerJson, cwd: string): Promise<McpToolInfo[]> {
  const cached = toolCache.get(name);
  if (cached) return cached;
  const client = new Client({ name: "kurmay", version: "1.0.0" });
  const transport =
    "url" in server
      ? server.type === "sse"
        ? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
        : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
      : new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          cwd,
          env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
          stderr: "ignore",
        });
  const timer = setTimeout(() => void client.close().catch(() => {}), 20_000);
  try {
    await client.connect(transport);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        const schema = (t.inputSchema ?? {}) as {
          properties?: Record<string, { type?: unknown; description?: unknown }>;
          required?: string[];
        };
        const params = Object.entries(schema.properties ?? {}).map(([pname, p]) => ({
          name: pname,
          ...(typeof p?.type === "string" ? { type: p.type } : {}),
          ...(typeof p?.description === "string" && p.description ? { description: p.description } : {}),
          ...(schema.required?.includes(pname) ? { required: true } : {}),
        }));
        tools.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.annotations?.readOnlyHint ? { readOnly: true } : {}),
          ...(t.annotations?.destructiveHint ? { destructive: true } : {}),
          ...(params.length ? { params } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    toolCache.set(name, tools);
    return tools;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
