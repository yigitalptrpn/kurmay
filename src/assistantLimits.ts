import type { AppConfig, AssistantLimitsConfig, AssistantPerm } from "./types.js";

/** Asistanın etkin sınırları (config.json "assistant" + eski `speech.computer` uyumu) */
export interface AssistantLimits {
  computer: { read: AssistantPerm; write: AssistantPerm; delete: false | "ask"; run: false | "ask" };
  confirm: "degisiklik" | "hep" | "hic";
  maxSteps: number;
  mcpMs: number;
  commandMs: number;
}

export const ASSISTANT_DEFAULTS = { maxSteps: 8, mcpMs: 120_000, commandMs: 60_000 };
const SURE_EN_AZ = 5_000;
const SURE_EN_FAZLA = 10 * 60_000;

export function assistantLimits(cfg: AppConfig): AssistantLimits {
  const a = cfg.assistant ?? {};
  // "assistant.computer" yoksa eski kutu: açıksa okuma/yazma serbest, silme/komut sorarak
  const eski = !!cfg.speech?.computer;
  const c = a.computer ?? {};
  return {
    computer: {
      read: c.read ?? eski,
      write: c.write ?? eski,
      delete: c.delete ?? (eski ? "ask" : false),
      run: c.run ?? (eski ? "ask" : false),
    },
    confirm: a.confirm ?? "degisiklik",
    maxSteps: a.maxSteps ?? ASSISTANT_DEFAULTS.maxSteps,
    mcpMs: a.timeouts?.mcpMs ?? ASSISTANT_DEFAULTS.mcpMs,
    commandMs: a.timeouts?.commandMs ?? ASSISTANT_DEFAULTS.commandMs,
  };
}

/** Eklenti asistana açık mı: kendi ayarı varsa o, yoksa genel Aç/Kapat */
export function assistantMcpEnabled(cfg: AppConfig, name: string): boolean {
  const own = cfg.assistant?.mcp?.[name]?.enabled;
  if (own !== undefined) return own;
  return !cfg.mcpServers?.[name]?.disabled;
}

const isPerm = (v: unknown) => typeof v === "boolean" || v === "ask";

/** config.json "assistant" doğrulaması — hata metni Türkçe */
export function checkAssistantLimits(v: unknown): void {
  const e = (m: string) => new Error(`ayar dosyası: "assistant${m}`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw e(`" bir nesne olmalı (verilen: ${JSON.stringify(v)})`);
  const a = v as Record<string, unknown>;
  if (a.mcp !== undefined) {
    if (!a.mcp || typeof a.mcp !== "object" || Array.isArray(a.mcp)) throw e(`.mcp" eklenti adı → ayar nesnesi olmalı`);
    for (const [ad, m] of Object.entries(a.mcp as Record<string, unknown>)) {
      if (!m || typeof m !== "object" || Array.isArray(m)) throw e(`.mcp.${ad}" bir nesne olmalı`);
      const o = m as Record<string, unknown>;
      for (const k of ["enabled", "readOnly"])
        if (o[k] !== undefined && typeof o[k] !== "boolean") throw e(`.mcp.${ad}.${k}" true/false olmalı`);
      if (o.tools !== undefined && (!Array.isArray(o.tools) || o.tools.some((t) => typeof t !== "string")))
        throw e(`.mcp.${ad}.tools" araç adlarının listesi olmalı`);
    }
  }
  if (a.computer !== undefined) {
    const c = a.computer as Record<string, unknown>;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw e(`.computer" bir nesne olmalı`);
    for (const k of ["read", "write"])
      if (c[k] !== undefined && !isPerm(c[k])) throw e(`.computer.${k}" true, false ya da "ask" olmalı`);
    for (const k of ["delete", "run"])
      if (c[k] !== undefined && c[k] !== false && c[k] !== "ask")
        throw e(`.computer.${k}" false ya da "ask" olmalı (silme ve komut hep sorulur)`);
  }
  if (a.confirm !== undefined && !["degisiklik", "hep", "hic"].includes(a.confirm as string))
    throw e(`.confirm" "degisiklik", "hep" ya da "hic" olmalı`);
  if (
    a.maxSteps !== undefined &&
    (!Number.isInteger(a.maxSteps) || (a.maxSteps as number) < 1 || (a.maxSteps as number) > 20)
  )
    throw e(`.maxSteps" 1 ile 20 arasında tam sayı olmalı`);
  if (a.timeouts !== undefined) {
    const t = a.timeouts as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw e(`.timeouts" bir nesne olmalı`);
    for (const k of ["mcpMs", "commandMs"]) {
      const x = t[k];
      if (x !== undefined && (!Number.isInteger(x) || (x as number) < SURE_EN_AZ || (x as number) > SURE_EN_FAZLA))
        throw e(`.timeouts.${k}" 5 sn ile 10 dk arasında (milisaniye) olmalı`);
    }
  }
}

export type { AssistantLimitsConfig };
