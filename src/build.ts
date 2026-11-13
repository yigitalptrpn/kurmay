import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./events.js";
import type { CommandNodeConfig } from "./types.js";

export interface BuildResult {
  ok: boolean;
  /** Build edilen repolar (parent önce, sonra servisler) */
  order: string[];
  /** ok=false ise başarısız olan repo */
  failedModule?: string;
  /** ok=false ise geri bildirim için toplanan build çıktısının sonu */
  log?: string;
}

/**
 * Değişen dosya yollarından hangi repoların dokunulduğunu çıkarır: her dosyanın
 * targetDir altındaki EN ÜST klasörü o dosyanın reposudur. targetDir dışındaki
 * dosyalar yok sayılır. (Yıldız topoloji: repo = üst dizindeki klasör.)
 */
export function changedRepos(changedFiles: string[], targetDir: string): Set<string> {
  const repos = new Set<string>();
  for (const file of changedFiles) {
    const rel = path.relative(targetDir, path.resolve(targetDir, file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // targetDir dışı
    const top = rel.split(/[\\/]/)[0];
    if (top) repos.add(top);
  }
  return repos;
}

/** targetDir'in doğrudan alt dizinlerini (repolar) listeler */
function allRepos(targetDir: string): string[] {
  try {
    return fs
      .readdirSync(targetDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Build sırasını belirler: parent değiştiyse önce parent, sonra değişen servisler.
 * rebuildAllOnParentChange açıksa ve parent değiştiyse tüm servis repoları eklenir.
 * Her repo için { name, command } döner (parent'ın komutu farklı olabilir).
 */
export function buildPlan(
  node: CommandNodeConfig,
  changed: Set<string>,
  targetDir: string,
): { name: string; command: string }[] {
  const parentName = node.parent?.path;
  const parentChanged = parentName != null && changed.has(parentName);

  // Servis repoları: değişenler (parent hariç) — ya da parent değişip "hepsini
  // yeniden build et" açıksa targetDir'deki tüm repolar (parent hariç)
  let services: string[];
  if (parentChanged && node.rebuildAllOnParentChange) {
    services = allRepos(targetDir).filter((r) => r !== parentName);
  } else {
    services = [...changed].filter((r) => r !== parentName);
  }

  const plan: { name: string; command: string }[] = [];
  if (parentChanged) {
    plan.push({ name: parentName!, command: node.parent!.command ?? node.command });
  }
  for (const svc of services) plan.push({ name: svc, command: node.command });
  return plan;
}

const MAX_LOG_TAIL = 6000; // hata geri bildiriminde tutulacak çıktı sonu (karakter)

/** Tek bir reponun build komutunu kendi dizininde çalıştırır */
function runOne(module: string, command: string, cwd: string, bus: EventBus): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    bus.emit({ type: "build_module_started", module, command });
    let tail = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      bus.emit({ type: "build_output", module, text });
      tail = (tail + text).slice(-MAX_LOG_TAIL);
    };

    // shell:true → Windows'ta cmd, POSIX'te sh; "mvn clean install" PATH'ten bulunur
    const child = spawn(command, { cwd, shell: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      tail = (tail + `\n[spawn hatası] ${err.message}`).slice(-MAX_LOG_TAIL);
      resolve({ code: -1, tail });
    });
    child.on("close", (code) => resolve({ code: code ?? -1, tail }));
  });
}

/**
 * Build koşusu (deterministik). Değişen dosyalardan repoları otomatik çıkarır,
 * parent'ı (değişmişse) öne alır ve sırayla build eder. İlk hata koşuyu durdurur;
 * başarısız repo ve log geri döner (saha ajanına geri bildirim olur).
 */
export async function runBuild(
  node: CommandNodeConfig,
  changedFiles: string[],
  targetDir: string,
  bus: EventBus,
): Promise<BuildResult> {
  const plan = buildPlan(node, changedRepos(changedFiles, targetDir), targetDir);
  const order = plan.map((p) => p.name);

  bus.emit({ type: "build_started", order });
  for (const { name, command } of plan) {
    const cwd = path.resolve(targetDir, name);
    const { code, tail } = await runOne(name, command, cwd, bus);
    if (code !== 0) {
      bus.emit({ type: "build_failed", module: name, code });
      return { ok: false, order, failedModule: name, log: tail };
    }
    bus.emit({ type: "build_module_finished", module: name });
  }

  bus.emit({ type: "build_finished", order });
  return { ok: true, order };
}
