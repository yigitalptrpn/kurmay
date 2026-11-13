import { spawn } from "node:child_process";
import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { HookConfig } from "./types.js";

/**
 * Bir komut-hook'unu SDK HookCallback'ine çevirir. Hook girdisi (tool_name,
 * tool_input, session_id ...) stdin'e JSON verilir; komutun çıkışı yorumlanır:
 *   exit 2  → aracı ENGELLE (stderr/stdout = gerekçe)
 *   exit 0  → izin ver; stdout geçerli JSON ise doğrudan hook çıktısı olarak aktar
 *   diğer   → engellemeyen hata (uyarı loglanır, akış sürer)
 */
function commandHook(command: string, timeoutSec: number, cwd: string): HookCallback {
  return (input, _toolUseId, opts) =>
    new Promise<HookJSONOutput>((resolve) => {
      const child = spawn(command, { cwd, shell: true, signal: opts?.signal });
      let out = "",
        err = "";
      const timer = setTimeout(() => child.kill(), Math.max(1, timeoutSec) * 1000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ continue: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 2) {
          resolve({ decision: "block", reason: err.trim() || out.trim() || "hook tarafından engellendi" });
          return;
        }
        if (code === 0) {
          const s = out.trim();
          if (s.startsWith("{")) {
            try {
              resolve(JSON.parse(s) as HookJSONOutput);
              return;
            } catch {
              /* düz metin */
            }
          }
          resolve({ continue: true });
          return;
        }
        console.warn(`⚠ hook komutu "${command}" çıkış kodu ${code}: ${err.trim()}`);
        resolve({ continue: true });
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
}

/**
 * Config'teki hook tanımlarını SDK'nin `hooks` yapısına derler
 * (olay → [{ matcher, hooks:[callback] }]). Hook yoksa undefined döner.
 */
export function buildHooks(
  hooks: HookConfig[] | undefined,
  cwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!hooks || hooks.length === 0) return undefined;
  const map: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const h of hooks) {
    const event = h.event as HookEvent;
    (map[event] ??= []).push({
      ...(h.matcher ? { matcher: h.matcher } : {}),
      hooks: [commandHook(h.command, h.timeout ?? 60, cwd)],
    });
  }
  return map;
}
