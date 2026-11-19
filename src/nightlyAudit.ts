import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { SecurityAuditRunner } from "./securityAudit.js";
import {
  countBySeverity,
  type SecurityFinding,
  type SecurityReport,
  type SecurityReportStore,
} from "./securityReport.js";
import type { Severity } from "./securityReport.js";
import type { TfsConnection } from "./tfs.js";
import { authEnv, git, repoAt } from "./tfsGit.js";
import type { AgentDefinition, AppConfig, NightlyAuditConfig } from "./types.js";

/**
 * Gece güvenlik denetimi (kullanıcı isteği 2026-11-19: "gece 12'de otomatik başlayıp tüm
 * repolarda güvenlik denetçisini çalıştıran bir özellik"). Ayarlar'daki kök klasörün altındaki
 * git depoları her gece bulunur (hariç tutulanlar dışında — yeni depo kendiliğinden girer) ve
 * SIRAYLA denetlenir. Denetlenen, sunucudaki ana dalın son hâlidir: depo önce güncellenir
 * (git fetch), ana dalın son kaydı `git archive` ile geçici bir klasöre çıkarılır, denetçi orada
 * çalışır. Geliştiricinin çalışma kopyasına (dal, yarım değişiklikler) hiç dokunulmaz.
 *
 * Koşu kaydı runs/gece/kosular/<id>.json — her adımda yazılır; servis yeniden başlarsa yarıda
 * kalan koşu aynı gecenin penceresi içindeyse kalan depolarla sürdürülür. Bitiş saatinden
 * sonra yeni depo denetimi başlamaz (sürmekte olan biter), kalanlar "süre doldu" olur.
 * Sabah özeti: koşu kaydı (/guvenlik sayfası) + isteğe bağlı e-posta; kritik/yüksek bulgular
 * için TFS iş öğesi (src/nightlyTfs.ts). İkisi de dışarıdan verilir (deps).
 */

export type NightlyRepoStatus = "waiting" | "preparing" | "running" | "done" | "failed" | "timeout" | "cancelled";
export type NightlyRunStatus = "running" | "finished" | "stopped" | "cancelled" | "failed" | "interrupted";

/** Özette ve e-postada gösterilen bulgu (kritik ve yüksek) */
export interface NightlyHighlight {
  severity: Severity;
  title: string;
  file: string;
  line?: number;
  cwe?: string;
  /** Önceki geceki denetimde yoktu */
  isNew?: boolean;
  /** Bulgunun parmak izi (iş öğesi eşleştirmesi) */
  key: string;
  /** Bağlı TFS iş öğesi: yeni açıldı ya da zaten açıktı */
  workItem?: { id: number; url?: string; existing: boolean };
}

export interface NightlyRepo {
  /** Köke göre göreli yol ("/" ayraçlı) — görünen ad ve hariç tutma anahtarı */
  name: string;
  path: string;
  status: NightlyRepoStatus;
  startedAt?: string;
  finishedAt?: string;
  /** Denetlenen dal ("origin/main") ve kayıt */
  ref?: string;
  commit?: string;
  /** Sunucudan güncellendi mi; güncellenemediyse sebep (eldeki son hâl denetlendi) */
  fetched?: boolean;
  fetchError?: string;
  jobId?: string;
  reportId?: string;
  risk?: string;
  counts?: Record<Severity, number>;
  findings?: number;
  /** Önceki geceye göre yeni bulgu sayısı (ilk denetimde yok) */
  newFindings?: number;
  firstAudit?: boolean;
  highlights?: NightlyHighlight[];
  /** Makineden bağımsız depo kimliği (parmak izlerinde) */
  key?: string;
  /** Bu depo için açılan ya da zaten açık olan TFS iş öğeleri */
  workItems?: Array<{ id: number; url?: string; key: string; severity: Severity; title: string; existing: boolean }>;
  workItemError?: string;
  error?: string;
}

export interface NightlyRun {
  id: string;
  trigger: "zamanlama" | "elle";
  /** Zamanlanmış koşunun gecesi (YYYY-AA-GG, başlama tarihi) */
  window?: string;
  startedAt: string;
  finishedAt?: string;
  status: NightlyRunStatus;
  root: string;
  /** Bu saatten sonra yeni depo denetimi başlamaz */
  deadline?: string;
  /** Yarıda kalıp sürdürüldüyse kaç kez */
  resumed?: number;
  repos: NightlyRepo[];
  /** Hariç tutulup denetlenmeyen depolar */
  excluded?: string[];
  workItems?: { enabled: boolean; created: number; existing: number; error?: string };
  email?: { ok: boolean; at: string; to: string[]; error?: string };
  error?: string;
}

export interface FoundRepo {
  name: string;
  path: string;
}

/** Depo aranırken girilmeyen klasörler (üretilmiş/dış kaynak) — gizli klasörler de atlanır */
const SKIP_DIRS = new Set(["node_modules", "target", "build", "dist", "vendor", "bin", "obj", "out", "packages"]);

/**
 * Kök klasörün altındaki git depoları (en fazla `depth` kat). Kökün kendisi depoysa yalnızca o.
 * Bir depo bulununca içine girilmez (alt modüller, iç içe kopyalar sayılmaz).
 */
export function findRepos(root: string, depth = 2): FoundRepo[] {
  const rootAbs = path.resolve(root);
  const isRepo = (d: string) => fs.existsSync(path.join(d, ".git"));
  if (isRepo(rootAbs)) return [{ name: path.basename(rootAbs) || rootAbs, path: rootAbs }];
  const out: FoundRepo[] = [];
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "tr"));
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const p = path.join(dir, e.name);
      if (isRepo(p)) out.push({ name: path.relative(rootAbs, p).split(path.sep).join("/"), path: p });
      else if (level < depth) walk(p, level + 1);
    }
  };
  walk(rootAbs, 1);
  return out;
}

// ── Parmak izi ────────────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşüâîû]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" })[c]!)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Deponun makineden bağımsız kimliği: uzak adres (kimlik bilgisi ve .git'siz), yoksa yerel ad */
export function repoKey(remoteUrl: string, name: string): string {
  const u = remoteUrl
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return u || `yerel:${name.toLowerCase()}`;
}

/**
 * Bulgunun parmak izi: depo + dosya + açık türü (CWE, yoksa sadeleşmiş başlık). Satır numarası
 * ve önem girmez (geceden geceye kayabilir). Yapay zekâ başlığı farklı yazarsa iz değişir —
 * CWE varken buna dayanıklı.
 */
export function findingKey(repo: string, f: Pick<SecurityFinding, "file" | "cwe" | "title">): string {
  const file = f.file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const kind = f.cwe ? f.cwe.toUpperCase().replace(/[^A-Z0-9-]/g, "") : fold(f.title);
  return crypto.createHash("sha1").update(`${repo}|${file}|${kind}`).digest("hex").slice(0, 12);
}

// ── Ana dalın anlık görüntüsü ─────────────────────────────────────────────

/** Ana dalın adayları (uzak deponun HEAD'i bilinmiyorsa sırayla) */
const MAIN_BRANCHES = ["main", "master", "develop", "trunk"];

export interface PreparedRepo {
  ref: string;
  commit: string;
  fetched: boolean;
  fetchError?: string;
  key: string;
}

/** Depoyu günceller (fetch) ve denetlenecek kaydı bulur. Çalışma kopyasına dokunmaz. */
export async function prepareRepo(
  repo: FoundRepo,
  conn: TfsConnection | undefined,
  signal?: AbortSignal,
): Promise<PreparedRepo> {
  const info = await repoAt(repo.path);
  if (!info) throw new Error("git deposu okunamadı");
  let fetched = false;
  let fetchError: string | undefined;
  if (info.remote) {
    const env = await authEnv(conn, info.remoteUrl);
    try {
      await git(info.root, ["fetch", "--quiet", info.remote], { env, timeoutMs: 180_000, signal });
      fetched = true;
    } catch (e) {
      if (signal?.aborted) throw e;
      fetchError = e instanceof Error ? e.message : String(e);
      // TFS anahtarı reddedildiyse (kod okuma yetkisi yok) kullanıcının kendi git kimliğiyle bir kez daha
      if (Object.keys(env).length) {
        try {
          await git(info.root, ["fetch", "--quiet", info.remote], { timeoutMs: 180_000, signal });
          fetched = true;
          fetchError = undefined;
        } catch (e2) {
          if (signal?.aborted) throw e2;
          fetchError = e2 instanceof Error ? e2.message : String(e2);
        }
      }
    }
  }
  const has = (ref: string) =>
    git(info.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
      () => true,
      () => false,
    );
  let ref: string | undefined;
  if (info.remote) {
    try {
      ref = await git(info.root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${info.remote}/HEAD`]);
    } catch {
      /* uzak deponun HEAD'i yerelde yok (eski klon) */
    }
    if (ref && !(await has(ref))) ref = undefined;
    for (const b of MAIN_BRANCHES) {
      if (ref) break;
      if (await has(`refs/remotes/${info.remote}/${b}`)) ref = `${info.remote}/${b}`;
    }
  }
  for (const b of MAIN_BRANCHES) {
    if (ref) break;
    if (await has(`refs/heads/${b}`)) ref = b;
  }
  ref ??= "HEAD";
  const commit = await git(info.root, ["rev-parse", `${ref}^{commit}`]);
  return {
    ref,
    commit,
    fetched,
    ...(fetchError ? { fetchError } : {}),
    key: repoKey(info.remoteUrl, repo.name),
  };
}

/** Kaydın dosyalarını klasöre çıkarır (`git archive` → kendi tar çözücümüz; harici araç gerekmez) */
export async function archiveTo(repoDir: string, commit: string, dest: string, signal?: AbortSignal): Promise<number> {
  fs.mkdirSync(dest, { recursive: true });
  const p = spawn("git", ["archive", "--format=tar", commit], {
    cwd: repoDir,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  const onAbort = () => p.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  p.stderr.on("data", (d: Buffer) => {
    if (stderr.length < 2000) stderr += d.toString();
  });
  try {
    const [files, code] = await Promise.all([
      extractTar(p.stdout, dest),
      new Promise<number | null>((resolve, reject) => {
        p.on("error", reject);
        p.on("close", resolve);
      }),
    ]);
    if (signal?.aborted) throw new Error("iptal edildi");
    if (code !== 0) throw new Error(`git archive: ${stderr.trim().split("\n").pop() || `çıkış kodu ${code}`}`);
    return files;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * tar akışını klasöre açar (ustar + pax uzun ad). Güvenlik: bağlantılar (symlink/hardlink)
 * atlanır, kök dışına çıkan ya da mutlak yollar atlanır. Yazılamayan dosya (Windows'ta geçersiz
 * ad) atlanır. Dönen: yazılan dosya sayısı.
 */
export function extractTar(stream: Readable, dest: string): Promise<number> {
  const root = path.resolve(dest);
  return new Promise((resolve, reject) => {
    let pending: Buffer = Buffer.alloc(0);
    let files = 0;
    let ended = false;
    // Sıradaki başlığın adı (pax "path" / GNU "L" kaydından)
    let longName: string | undefined;
    // Veri okunan kayıt: yazılacak dosya (fd) ya da toplanacak üst veri (pax/L)
    let cur: { remaining: number; pad: number; fd?: number; collect?: Buffer[]; kind?: "pax" | "L" } | undefined;

    const str = (b: Buffer, from: number, len: number) =>
      b
        .subarray(from, from + len)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
    const octal = (b: Buffer, from: number, len: number) => {
      if (b[from] & 0x80) {
        // GNU büyük boyut (ikili)
        let n = 0;
        for (let i = from + 1; i < from + len; i++) n = n * 256 + b[i];
        return n;
      }
      const s = str(b, from, len).trim();
      return s ? parseInt(s, 8) : 0;
    };
    const target = (name: string): string | undefined => {
      const clean = name.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
      if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean)) return undefined;
      if (clean.split("/").some((seg) => seg === ".." || seg.includes(":"))) return undefined;
      const full = path.resolve(root, clean);
      return full === root || full.startsWith(root + path.sep) ? full : undefined;
    };
    const finishEntry = () => {
      if (!cur) return;
      if (cur.fd !== undefined) {
        try {
          fs.closeSync(cur.fd);
        } catch {
          /* kapandı */
        }
        files++;
      } else if (cur.collect) {
        const data = Buffer.concat(cur.collect).toString("utf8");
        if (cur.kind === "L") longName = data.replace(/\0[\s\S]*$/, "");
        else {
          // pax kayıtları: "<uzunluk> anahtar=değer\n"
          for (const m of data.matchAll(/^\d+ ([^=]+)=(.*)$/gm)) if (m[1] === "path") longName = m[2];
        }
      }
    };
    const header = (h: Buffer): boolean => {
      if (h.every((x) => x === 0)) return false; // arşiv sonu
      const type = String.fromCharCode(h[156] || 48);
      const size = octal(h, 124, 12);
      const prefix = str(h, 257, 6).startsWith("ustar") ? str(h, 345, 155) : "";
      const name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
      if (type !== "x" && type !== "L") longName = undefined;
      cur = { remaining: size, pad: (512 - (size % 512)) % 512 };
      if (type === "x" || type === "L") {
        cur.collect = [];
        cur.kind = type === "x" ? "pax" : "L";
      } else if (type === "0" || type === "7") {
        const full = target(name);
        if (full) {
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            cur.fd = fs.openSync(full, "w");
          } catch {
            /* yazılamayan ad — atla */
          }
        }
      } else if (type === "5") {
        const full = target(name);
        if (full)
          try {
            fs.mkdirSync(full, { recursive: true });
          } catch {
            /* atla */
          }
      }
      // g (genel pax), 1/2 (bağlantı) ve diğerleri: veri atlanır
      return true;
    };
    const pump = () => {
      for (;;) {
        if (ended) return;
        if (!cur) {
          if (pending.length < 512) return;
          const h = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (!header(h)) {
            ended = true;
            return;
          }
          continue;
        }
        if (cur.remaining > 0) {
          if (!pending.length) return;
          const n = Math.min(cur.remaining, pending.length);
          const part = pending.subarray(0, n);
          if (cur.fd !== undefined) {
            try {
              fs.writeSync(cur.fd, part);
            } catch {
              try {
                fs.closeSync(cur.fd);
              } catch {
                /* */
              }
              cur.fd = undefined;
            }
          } else if (cur.collect) cur.collect.push(Buffer.from(part));
          cur.remaining -= n;
          pending = pending.subarray(n);
          if (cur.remaining > 0) return;
        }
        if (cur.pad > 0) {
          if (!pending.length) return;
          const n = Math.min(cur.pad, pending.length);
          cur.pad -= n;
          pending = pending.subarray(n);
          if (cur.pad > 0) return;
        }
        finishEntry();
        cur = undefined;
      }
    };
    stream.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      try {
        pump();
      } catch (e) {
        reject(e);
        stream.destroy();
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      if (cur?.fd !== undefined)
        try {
          fs.closeSync(cur.fd);
        } catch {
          /* */
        }
      resolve(files);
    });
  });
}

// ── Zaman penceresi ───────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Yerel tarih anahtarı YYYY-AA-GG */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const at = (base: Date, hhmm: string, dayOffset = 0) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
};

/** Ayardaki bitiş saati: yoksa 07:00, null = sınır yok */
export const stopAtOf = (n: NightlyAuditConfig | undefined) => (n?.stopAt === undefined ? "07:00" : n.stopAt);

/**
 * Şu an hangi gecenin penceresi içindeyiz: [başlama, bitiş). Bitiş saati yoksa pencere bir
 * sonraki başlamaya kadar sürer (kaçırılan koşu açılışta yapılır). Bitiş saati varsa pencere
 * dışında açılan Kurmay o gecenin koşusunu YAPMAZ (mesai saatinde model sunucusu yorulmasın).
 */
export function windowAt(
  now: Date,
  time: string,
  stopAt: string | null,
): { key: string; start: Date; end: Date } | undefined {
  for (const off of [0, -1]) {
    const start = at(now, time, off);
    let end: Date;
    if (stopAt) {
      end = at(start, stopAt);
      if (end <= start) end.setDate(end.getDate() + 1);
    } else end = new Date(start.getTime() + 24 * 3600_000);
    if (now >= start && now < end) return { key: dayKey(start), start, end };
  }
  return undefined;
}

/** Bir sonraki zamanlanmış başlama */
export function nextStart(now: Date, time: string): Date {
  const t = at(now, time);
  return t > now ? t : at(now, time, 1);
}

// ── Koşucu ────────────────────────────────────────────────────────────────

export interface NightlyDeps {
  /** Canlı ayar (Ayarlar'dan değişebilir) */
  cfg: () => AppConfig;
  runsDir: string;
  audits: SecurityAuditRunner;
  store: SecurityReportStore;
  /** Denetçi ajan (akıştaki denetçi ya da geçici tanım) */
  agent: () => AgentDefinition | { error: string };
  /** Model seçili mi (yoksa koşu başlamaz) */
  modelMissing: () => boolean;
  /** Denetim başına ayar kopyası (canlı değişiklikler süren denetimi etkilemesin) */
  snapshot: () => AppConfig;
  /** Aynı anda çalışan görev sınırında yer var mı (panel görevleri + denetimler) */
  slotFree: () => boolean;
  /** TFS sunucusundaki depoların güncellenmesi için bağlantı (yoksa kullanıcının git kimliği) */
  tfsConn: () => TfsConnection | undefined;
  /** Kritik/yüksek bulgular için iş öğesi (ayarda açıksa) — highlights'a iş öğesini yazar */
  workItems?: (run: NightlyRun, repo: NightlyRepo, report: SecurityReport) => Promise<void>;
  /** Sabah özeti e-postası (ayarda açıksa) */
  email?: (run: NightlyRun) => Promise<{ ok: boolean; to: string[]; error?: string } | undefined>;
  /** Koşu durumu değişti (sayfa yoklar; panel bildirimi için) */
  onChange?: () => void;
}

/** Yarıda kalmış koşuda yeniden denetlenecek durumlar */
const UNFINISHED: NightlyRepoStatus[] = ["waiting", "preparing", "running"];
/** Saklanan koşu kaydı sayısı */
const RUN_KEEP = 60;
/** Özette depo başına tutulan kritik/yüksek bulgu */
const HIGHLIGHT_KEEP = 20;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class NightlyAuditor {
  private current?: { run: NightlyRun; ac: AbortController };
  private timer?: ReturnType<typeof setInterval>;
  private readonly dir: string;

  constructor(private readonly d: NightlyDeps) {
    this.dir = path.join(d.runsDir, "gece");
    this.recover();
  }

  /** Zamanlayıcıyı başlatır (30 sn'de bir bakar — uyku/saat değişikliğine dayanıklı) */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 3_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ── Kayıtlar ────────────────────────────────────────────────────────────

  private runsPath = () => path.join(this.dir, "kosular");
  private statePath = () => path.join(this.dir, "durum.json");
  private lastPath = () => path.join(this.dir, "son-bulgular.json");

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  private save(run: NightlyRun): void {
    try {
      this.writeJson(path.join(this.runsPath(), `${run.id}.json`), run);
    } catch (e) {
      console.error(`⚠ Gece denetimi kaydı yazılamadı: ${msg(e)}`);
    }
    this.d.onChange?.();
  }

  /** Koşu kayıtları, en yeni önce */
  list(limit = 30): NightlyRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.runsPath()).filter((n) => /^gece-[\w-]+\.json$/.test(n));
    } catch {
      return [];
    }
    names.sort().reverse();
    const out: NightlyRun[] = [];
    for (const n of names.slice(0, limit)) {
      if (this.current && n === `${this.current.run.id}.json`) out.push(this.current.run);
      else {
        const r = this.readJson<NightlyRun | null>(path.join(this.runsPath(), n), null);
        if (r?.id) out.push(r);
      }
    }
    return out;
  }

  get(id: string): NightlyRun | undefined {
    if (!/^gece-[\w-]+$/.test(id)) return undefined;
    if (this.current?.run.id === id) return this.current.run;
    return this.readJson<NightlyRun | undefined>(path.join(this.runsPath(), `${id}.json`), undefined);
  }

  running(): NightlyRun | undefined {
    return this.current?.run;
  }

  /** Bir sonraki zamanlanmış başlama (kapalıysa yok) */
  next(): string | undefined {
    const n = this.d.cfg().nightlyAudit;
    if (!n?.enabled || !n.root) return undefined;
    return nextStart(new Date(), n.time ?? "00:00").toISOString();
  }

  /** Açılışta: yarıda kalmış koşu "yarıda kaldı" olur (pencere içindeyse tick sürdürür); eski kopyalar silinir */
  private recover(): void {
    for (const r of this.list(5)) {
      if (r.status === "running") {
        r.status = "interrupted";
        this.save(r);
      }
    }
    try {
      fs.rmSync(path.join(this.dir, "kopya"), { recursive: true, force: true });
    } catch {
      /* Windows'ta açık dosya — sonra */
    }
    // Eski kayıtlar
    try {
      const names = fs
        .readdirSync(this.runsPath())
        .filter((n) => /^gece-[\w-]+\.json$/.test(n))
        .sort()
        .reverse();
      for (const n of names.slice(RUN_KEEP)) fs.rmSync(path.join(this.runsPath(), n), { force: true });
    } catch {
      /* yok */
    }
  }

  // ── Zamanlama ───────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.current) return;
    const n = this.d.cfg().nightlyAudit;
    if (!n?.enabled || !n.root) return;
    const stopAt = stopAtOf(n);
    const w = windowAt(new Date(), n.time ?? "00:00", stopAt);
    if (!w) return;
    const state = this.readJson<{ lastWindow?: string; since?: string }>(this.statePath(), {});
    if (state.lastWindow === w.key) {
      // Bu gecenin koşusu başladı; servis yeniden başladıysa yarıda kalanı sürdür
      const last = this.list(5).find((r) => r.window === w.key && r.trigger === "zamanlama");
      if (last?.status === "interrupted") {
        last.resumed = (last.resumed ?? 0) + 1;
        last.status = "running";
        for (const r of last.repos) if (UNFINISHED.includes(r.status)) r.status = "waiting";
        console.log(`\n🌙 Gece güvenlik denetimi yarıda kalmıştı — kalan depolarla sürüyor`);
        await this.execute(last);
      }
      return;
    }
    // Zamanlama kurulmadan (açılmadan / saat değişmeden) önce başlamış gece "kaçırılmış" sayılmaz —
    // ilk koşu ayarlanan saatte olur (bitiş sınırı yokken dünün penceresi bugüne uzanıyordu)
    if (!state.since) {
      this.writeJson(this.statePath(), { ...state, since: new Date().toISOString() });
      return;
    }
    if (w.start.getTime() < Date.parse(state.since)) return;
    this.writeJson(this.statePath(), { ...state, lastWindow: w.key });
    await this.execute(this.newRun("zamanlama", n, stopAt ? w.end : undefined, w.key));
  }

  private newRun(trigger: NightlyRun["trigger"], n: NightlyAuditConfig, deadline?: Date, window?: string): NightlyRun {
    const now = new Date();
    return {
      id: `gece-${now
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
      trigger,
      ...(window ? { window } : {}),
      startedAt: now.toISOString(),
      status: "running",
      root: path.resolve(n.root ?? ""),
      ...(deadline ? { deadline: deadline.toISOString() } : {}),
      repos: [],
    };
  }

  /** Zamanlama değişti (açıldı, saat ya da bitiş değişti): o andan önce başlamış gece kaçırılmış sayılmaz */
  scheduleChanged(): void {
    const state = this.readJson<Record<string, unknown>>(this.statePath(), {});
    try {
      this.writeJson(this.statePath(), { ...state, since: new Date().toISOString() });
    } catch (e) {
      console.error(`⚠ Gece denetimi durumu yazılamadı: ${msg(e)}`);
    }
  }

  /** Elle başlatma (Ayarlar / güvenlik sayfası): bitiş saati uygulanmaz */
  runNow(): { ok: boolean; error?: string; run?: NightlyRun } {
    if (this.current) return { ok: false, error: "Gece denetimi zaten sürüyor" };
    const n = this.d.cfg().nightlyAudit;
    if (!n?.root) return { ok: false, error: "Önce Ayarlar'da depoların bulunduğu kök klasörü seç" };
    if (!fs.existsSync(n.root)) return { ok: false, error: `kök klasör bulunamadı: ${n.root}` };
    if (this.d.modelMissing())
      return { ok: false, error: "Model seçilmedi — izleme panelindeki listeden bir model seç" };
    const run = this.newRun("elle", n);
    void this.execute(run);
    return { ok: true, run };
  }

  /** Süren koşuyu durdurur: denetlenmekte olan depo kesilir, kalanlar denetlenmez */
  cancel(): boolean {
    if (!this.current) return false;
    this.current.ac.abort();
    for (const r of this.current.run.repos) if (r.jobId && r.status === "running") this.d.audits.cancel(r.jobId);
    return true;
  }

  // ── Koşu ────────────────────────────────────────────────────────────────

  private async execute(run: NightlyRun): Promise<void> {
    const ac = new AbortController();
    this.current = { run, ac };
    const n = this.d.cfg().nightlyAudit ?? {};
    try {
      if (!run.repos.length) {
        if (!fs.existsSync(run.root)) throw new Error(`kök klasör bulunamadı: ${run.root}`);
        const exclude = new Set((n.exclude ?? []).map((x) => x.toLowerCase()));
        const found = findRepos(run.root);
        run.repos = found
          .filter((r) => !exclude.has(r.name.toLowerCase()))
          .map((r) => ({ name: r.name, path: r.path, status: "waiting" as const }));
        const ex = found.filter((r) => exclude.has(r.name.toLowerCase())).map((r) => r.name);
        if (ex.length) run.excluded = ex;
        if (!found.length) throw new Error(`kök klasörde git deposu bulunamadı: ${run.root}`);
      }
      if (this.d.modelMissing()) throw new Error("Model seçilmedi — izleme panelindeki listeden bir model seç");
      const agent = this.d.agent();
      if ("error" in agent) throw new Error(agent.error);
      this.save(run);
      console.log(
        `\n🌙 Gece güvenlik denetimi başladı: ${run.repos.filter((r) => r.status === "waiting").length} depo (${run.root})`,
      );
      for (const repo of run.repos) {
        if (repo.status !== "waiting") continue;
        if (ac.signal.aborted) break;
        if (run.deadline && Date.now() >= Date.parse(run.deadline)) break;
        // Aynı anda çalışan görev sınırı: yer açılana kadar bekle
        while (!this.d.slotFree() && !ac.signal.aborted) {
          if (run.deadline && Date.now() >= Date.parse(run.deadline)) break;
          await sleep(15_000, ac.signal);
        }
        if (ac.signal.aborted || (run.deadline && Date.now() >= Date.parse(run.deadline))) break;
        await this.auditRepo(run, repo, agent, ac.signal);
      }
      for (const r of run.repos) {
        if (r.status !== "waiting") continue;
        r.status = ac.signal.aborted ? "cancelled" : "timeout";
      }
      run.status = ac.signal.aborted
        ? "cancelled"
        : run.repos.some((r) => r.status === "timeout")
          ? "stopped"
          : "finished";
    } catch (e) {
      run.status = ac.signal.aborted ? "cancelled" : "failed";
      run.error = msg(e);
      console.error(`⚠ Gece güvenlik denetimi düştü: ${run.error}`);
    }
    run.finishedAt = new Date().toISOString();
    this.save(run);
    // Sabah özeti e-postası: biten ya da süresi dolan koşuda (durdurulanda gönderilmez)
    if ((run.status === "finished" || run.status === "stopped" || run.status === "failed") && this.d.email) {
      try {
        const r = await this.d.email(run);
        if (r) run.email = { ok: r.ok, at: new Date().toISOString(), to: r.to, ...(r.error ? { error: r.error } : {}) };
      } catch (e) {
        run.email = { ok: false, at: new Date().toISOString(), to: [], error: msg(e) };
      }
      if (run.email && !run.email.ok) console.error(`⚠ Sabah özeti e-postası gönderilemedi: ${run.email.error}`);
      this.save(run);
    }
    const done = run.repos.filter((r) => r.status === "done").length;
    console.log(`🌙 Gece güvenlik denetimi bitti: ${done}/${run.repos.length} depo denetlendi (${run.status})`);
    this.current = undefined;
    this.d.onChange?.();
  }

  private async auditRepo(
    run: NightlyRun,
    repo: NightlyRepo,
    agent: AgentDefinition,
    signal: AbortSignal,
  ): Promise<void> {
    repo.status = "preparing";
    repo.startedAt = new Date().toISOString();
    for (const k of [
      "error",
      "fetchError",
      "reportId",
      "risk",
      "counts",
      "findings",
      "highlights",
      "workItems",
      "workItemError",
      "newFindings",
      "firstAudit",
    ] as const)
      delete repo[k];
    this.save(run);
    // Sabit yol (koşu kimliği yok): ajanın konuşma kayıtları her gece yeni bir proje klasörüne düşmesin
    const snap = path.join(this.dir, "kopya", repo.name.replace(/[^\w.-]+/g, "_"));
    try {
      const p = await prepareRepo({ name: repo.name, path: repo.path }, this.d.tfsConn(), signal);
      Object.assign(repo, {
        ref: p.ref,
        commit: p.commit.slice(0, 10),
        fetched: p.fetched,
        ...(p.fetchError ? { fetchError: p.fetchError } : {}),
      });
      repo.key = p.key;
      fs.rmSync(snap, { recursive: true, force: true });
      await archiveTo(repo.path, p.commit, snap, signal);
      repo.status = "running";
      const job = this.d.audits.start(snap, agent, this.d.snapshot(), {
        displayDir: repo.path,
        task: `Gece denetimi: ${repo.name}`,
        nightly: { run: run.id, repo: repo.name, ref: p.ref, commit: p.commit.slice(0, 10) },
      });
      repo.jobId = job.id;
      this.save(run);
      const fin = await this.d.audits.wait(job.id);
      if (fin?.status !== "finished" || !fin.reportId) {
        repo.status = fin?.status === "cancelled" || signal.aborted ? "cancelled" : "failed";
        if (fin?.error) repo.error = fin.error;
        return;
      }
      const report = this.d.store.get(fin.reportId);
      repo.reportId = fin.reportId;
      repo.risk = fin.risk;
      repo.findings = fin.findings;
      repo.status = "done";
      if (report) {
        this.compare(repo, report, p.key);
        if (this.d.workItems) {
          try {
            await this.d.workItems(run, repo, report);
          } catch (e) {
            repo.workItemError = msg(e);
          }
        }
      }
    } catch (e) {
      repo.status = signal.aborted ? "cancelled" : "failed";
      repo.error = msg(e);
      console.error(`⚠ Gece denetimi (${repo.name}): ${repo.error}`);
    } finally {
      repo.finishedAt = new Date().toISOString();
      try {
        fs.rmSync(snap, { recursive: true, force: true });
      } catch {
        /* Windows: açık dosya — açılışta temizlenir */
      }
      this.save(run);
    }
  }

  /** Önceki geceyle karşılaştırma: yeni bulgular, özet için kritik/yüksek bulgular */
  private compare(repo: NightlyRepo, report: SecurityReport, key: string): void {
    const last = this.readJson<Record<string, { keys: string[]; at: string }>>(this.lastPath(), {});
    const prev = last[key] ? new Set(last[key].keys) : undefined;
    const keys = report.findings.map((f) => findingKey(key, f));
    repo.counts = countBySeverity(report.findings);
    if (prev) repo.newFindings = keys.filter((k) => !prev.has(k)).length;
    else repo.firstAudit = true;
    repo.highlights = report.findings
      .map((f, i) => ({ f, k: keys[i] }))
      .filter(({ f }) => f.severity === "critical" || f.severity === "high")
      .slice(0, HIGHLIGHT_KEEP)
      .map(({ f, k }) => ({
        severity: f.severity,
        title: f.title,
        file: f.file,
        ...(f.line ? { line: f.line } : {}),
        ...(f.cwe ? { cwe: f.cwe } : {}),
        ...(prev && !prev.has(k) ? { isNew: true } : {}),
        key: k,
      }));
    last[key] = { keys: [...new Set(keys)], at: new Date().toISOString() };
    try {
      this.writeJson(this.lastPath(), last);
    } catch {
      /* karşılaştırma bir sonraki gece eksik kalır */
    }
  }
}
