import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TfsConnection } from "./tfs.js";

/**
 * TFS PR akışının git tarafı (deterministik, ajan değil): PR'ın deposunu hedef dizinde
 * bulmak, PR dalında olunduğunu denetlemek / dala geçmek, ajanların değiştirdiği
 * dosyaları commit'leyip göndermek, PR farkını (diff) almak.
 *
 * Kimlik: uzak depo ayarlardaki TFS sunucusundaysa (aynı ana makine, http/https) TFS
 * erişim anahtarı git'e "http.extraHeader" olarak ORTAM DEĞİŞKENİYLE verilir
 * (GIT_CONFIG_COUNT/KEY/VALUE — git 2.31+); komut satırına yazılmaz, işlem listesinde
 * görünmez. Anahtarın "Kod — okuma ve yazma" kapsamı yoksa ya da git eskiyse kullanıcının
 * kendi git kimliği (Windows'ta kimlik yöneticisi) kullanılır. Hiçbir git komutu soru
 * sormaz (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never) — takılı kalmaz, hata verir.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

interface GitOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Çıktıyı kırpma (status --porcelain satırları boşlukla başlar) */
  raw?: boolean;
  /** Çıktı sınırı (diff büyük olabilir) */
  maxBuffer?: number;
}

export function git(cwd: string, args: string[], o: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        signal: o.signal,
        timeout: o.timeoutMs ?? 60_000,
        maxBuffer: o.maxBuffer ?? 20 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", ...(o.env ?? {}) },
      },
      (err, stdout, stderr) => {
        if (err) {
          if (o.signal?.aborted) return reject(new GitError("iptal edildi"));
          const msg = (String(stderr || "").trim() || err.message).split("\n").filter(Boolean).slice(-3).join(" ").trim();
          return reject(new GitError(`git ${args[0]}: ${msg}`));
        }
        resolve(o.raw ? String(stdout) : String(stdout).trim());
      },
    );
  });
}

let gitVersion: Promise<number[] | undefined> | undefined;
/** Kurulu git sürümü ([2, 43, 0]); git yoksa undefined */
function version(): Promise<number[] | undefined> {
  gitVersion ??= git(process.cwd(), ["--version"]).then(
    (v) => (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)),
    () => undefined,
  );
  return gitVersion;
}

/** Git kurulu mu */
export async function gitAvailable(): Promise<boolean> {
  return !!(await version());
}

/**
 * Uzak depo TFS sunucusundaysa anahtarı git'e ortam değişkeniyle veren ortam (yoksa boş).
 * GIT_CONFIG_COUNT git 2.31'de geldi; daha eskide anahtar verilmez (kullanıcının kimliği).
 */
export async function authEnv(c: TfsConnection | undefined, remoteUrl: string): Promise<Record<string, string>> {
  if (!c) return {};
  let remote: URL;
  let tfsHost: string;
  try {
    remote = new URL(remoteUrl);
    tfsHost = new URL(c.url).hostname.toLowerCase();
  } catch {
    return {}; // ssh ya da bozuk adres
  }
  if (!/^https?:$/.test(remote.protocol) || remote.hostname.toLowerCase() !== tfsHost) return {};
  const v = await version();
  if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 31)) return {};
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from(":" + c.token).toString("base64"),
  };
  if (c.insecureTls) {
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_1 = "http.sslVerify";
    env.GIT_CONFIG_VALUE_1 = "false";
  }
  return env;
}

/** Uzak depo adresindeki depo adı (…/_git/{depo}, ssh …/{depo}) — eşleştirme için, küçük harf */
export function repoNameFromRemote(remoteUrl: string): string | undefined {
  const u = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m = /\/_git\/([^/?#]+)$/i.exec(u) ?? /^(?:ssh:\/\/)?[^@]+@[^:/]+(?::\d+)?[:/](?:v3\/)?(?:[^/]+\/)*([^/]+)$/i.exec(u);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

export interface LocalRepo {
  /** Deponun kökü (mutlak) */
  dir: string;
  /** Hedef dizine göre ("." = hedef dizinin kendisi) */
  rel: string;
  remote: string;
  remoteUrl: string;
}

async function repoAt(dir: string): Promise<{ root: string; remote: string; remoteUrl: string } | undefined> {
  if (!fs.existsSync(path.join(dir, ".git"))) return undefined;
  try {
    const root = path.resolve(await git(dir, ["rev-parse", "--show-toplevel"]));
    const remotes = (await git(root, ["remote"])).split(/\s+/).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) return { root, remote: "", remoteUrl: "" };
    return { root, remote, remoteUrl: await git(root, ["remote", "get-url", remote]) };
  } catch {
    return undefined;
  }
}

/**
 * PR'ın deposunu hedef dizinde bulur: hedef dizinin kendisi ya da bir alt klasörü (mıntıka)
 * olabilir. Eşleşme: uzak adresteki depo adı, olmazsa klasör adı.
 */
export async function findRepo(targetDir: string, repoName: string): Promise<LocalRepo | undefined> {
  const want = repoName.toLowerCase();
  const candidates = [targetDir];
  try {
    for (const e of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") candidates.push(path.join(targetDir, e.name));
    }
  } catch {
    return undefined;
  }
  const found: Array<LocalRepo & { byName: boolean }> = [];
  for (const dir of candidates) {
    const r = await repoAt(dir);
    if (!r) continue;
    const byRemote = repoNameFromRemote(r.remoteUrl) === want;
    const byName = path.basename(r.root).toLowerCase() === want;
    if (!byRemote && !byName) continue;
    const rel = path.relative(targetDir, r.root).split(path.sep).join("/") || ".";
    const entry = { dir: r.root, rel, remote: r.remote, remoteUrl: r.remoteUrl, byName: !byRemote };
    if (byRemote) return entry;
    found.push(entry);
  }
  return found[0];
}

export const shortBranch = (ref: string) => ref.replace(/^refs\/heads\//, "");

export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Commit'lenmemiş değişiklik (izlenmeyen dosyalar dahil) var mı */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const out = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"], { raw: true });
  return out.split("\0").filter((l) => l.length > 3).map((l) => l.slice(3));
}

/** Yerel dalın uzaktaki dala göre durumu (getirmeden: son fetch'e göre) */
export async function aheadBehind(dir: string, remote: string, branch: string): Promise<{ ahead: number; behind: number } | undefined> {
  try {
    const [a, b] = (await git(dir, ["rev-list", "--left-right", "--count", `HEAD...${remote}/${branch}`])).split(/\s+/).map(Number);
    return { ahead: a, behind: b };
  } catch {
    return undefined;
  }
}

/**
 * PR'ın kaynak dalına geçer: getirir, yerel dal yoksa uzaktakinden açar, varsa geçip ileri
 * sarar (yalnızca hızlı ileri — birleştirme commit'i yapılmaz). Çalışma ağacı temiz değilse
 * hiçbir şeye dokunmaz.
 */
export async function checkoutPrBranch(repo: LocalRepo, branch: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const dirty = await dirtyFiles(repo.dir);
  if (dirty.length) {
    throw new GitError(
      `yerel kopyada kaydedilmemiş ${dirty.length} değişiklik var (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? "…" : ""}) — ` +
        "önce bunları kaydet ya da geri al; Kurmay kaydedilmemiş değişikliklerin üstünde dal değiştirmez",
    );
  }
  if (!repo.remote) throw new GitError("depoda sunucu bağlantısı (uzak depo) tanımlı değil");
  await git(repo.dir, ["fetch", repo.remote, `+refs/heads/${branch}:refs/remotes/${repo.remote}/${branch}`], { env, timeoutMs: 180_000, signal });
  const exists = await git(repo.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) {
    await git(repo.dir, ["checkout", branch], { signal });
    await git(repo.dir, ["merge", "--ff-only", `${repo.remote}/${branch}`], { signal }).catch((e: Error) => {
      throw new GitError(`yerel "${branch}" dalı sunucudakinden ayrılmış — iki dalı elle birleştirmen gerekiyor (${e.message})`);
    });
  } else {
    await git(repo.dir, ["checkout", "-b", branch, "--track", `${repo.remote}/${branch}`], { signal });
  }
  return git(repo.dir, ["rev-parse", "--short", "HEAD"]);
}

/** Yalnızca verilen dosyalardaki gerçek değişiklikler (dosya listede ama dokunulmamışsa atlanır) */
async function changedAmong(dir: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const dirty = await dirtyFiles(dir);
  return files.filter((f) => dirty.some((d) => d === f || d.startsWith(f.replace(/\/?$/, "/"))));
}

/**
 * Ajanların değiştirdiği dosyaları commit'ler ve gönderir. branch verilirse önce o adla yeni dal
 * açılır (PR açma); verilmezse bulunulan dala commit'lenir (PR yorumlarını ele alma). Kullanıcının
 * önceden sahneye aldığı başka dosyalar commit'e GİRMEZ (pathspec'li commit).
 */
export async function commitAndPush(
  repo: LocalRepo,
  files: string[],
  message: string,
  env: Record<string, string>,
  o: { newBranch?: string; signal?: AbortSignal } = {},
): Promise<{ branch: string; commit: string; files: string[] }> {
  const paths = await changedAmong(repo.dir, files);
  if (!paths.length) throw new GitError("gönderilecek değişiklik yok (dosyalar diskte değişmemiş)");
  if (!repo.remote) throw new GitError("depoda sunucu bağlantısı (uzak depo) tanımlı değil");
  if (o.newBranch) await git(repo.dir, ["checkout", "-b", o.newBranch], { signal: o.signal });
  const branch = o.newBranch ?? (await currentBranch(repo.dir));
  if (branch === "HEAD") throw new GitError("yerel kopya bir dalda değil (belirli bir kayda geçilmiş) — önce bir dala geç");
  await git(repo.dir, ["add", "-A", "--", ...paths], { signal: o.signal });
  const [subject, ...body] = message.trim().split(/\r?\n/);
  const args = ["commit", "-m", subject || "Kurmay değişikliği"];
  const rest = body.join("\n").trim();
  if (rest) args.push("-m", rest);
  await git(repo.dir, [...args, "--", ...paths], { signal: o.signal });
  const commit = await git(repo.dir, ["rev-parse", "HEAD"]);
  await pushBranch(repo, branch, env, { upstream: !!o.newBranch, signal: o.signal });
  return { branch, commit, files: paths };
}

const AUTH_FAIL = /authentication|401|403|denied|could not read|unauthorized|yetki|permission/i;

/**
 * Dalı gönderir. Önce TFS anahtarıyla (env doluysa); kimlik hatası alırsa (ör. anahtarın "Kod —
 * okuma ve yazma" kapsamı yok) kullanıcının kendi git kimliğiyle bir kez daha dener.
 */
export async function pushBranch(repo: LocalRepo, branch: string, env: Record<string, string>, o: { upstream?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const args = ["push", ...(o.upstream ? ["-u"] : []), repo.remote, `HEAD:refs/heads/${branch}`];
  try {
    await git(repo.dir, args, { env, timeoutMs: 300_000, signal: o.signal });
  } catch (e) {
    if (!Object.keys(env).length || !(e instanceof GitError) || !AUTH_FAIL.test(e.message)) throw e;
    try {
      await git(repo.dir, args, { timeoutMs: 300_000, signal: o.signal });
    } catch (e2) {
      throw new GitError(
        `gönderilemedi — TFS anahtarıyla da kendi git kimliğinle de kimlik reddedildi (anahtarın "Kod — okuma ve yazma" kapsamı var mı?): ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
  }
}

/** Uzak deponun varsayılan dalı (origin/HEAD), bilinmiyorsa undefined */
export async function defaultBranch(repo: LocalRepo): Promise<string | undefined> {
  try {
    const head = await git(repo.dir, ["symbolic-ref", "--short", `refs/remotes/${repo.remote}/HEAD`]);
    return head.startsWith(repo.remote + "/") ? head.slice(repo.remote.length + 1) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * PR'ın farkı (birleşik diff): hedef dalın ortak atasından kaynak dala. İki dal da getirilir.
 * Çok büyükse dosya başına kırpılır. Yerel depo yoksa çağıran REST'teki dosya listesine düşer.
 */
export async function prDiff(
  repo: LocalRepo,
  source: string,
  target: string,
  env: Record<string, string>,
  maxChars = 60_000,
  signal?: AbortSignal,
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  await git(
    repo.dir,
    ["fetch", repo.remote, `+refs/heads/${source}:refs/remotes/${repo.remote}/${source}`, `+refs/heads/${target}:refs/remotes/${repo.remote}/${target}`],
    { env, timeoutMs: 180_000, signal },
  );
  const range = `${repo.remote}/${target}...${repo.remote}/${source}`;
  const files = (await git(repo.dir, ["diff", "--name-only", range], { signal })).split("\n").filter(Boolean);
  let diff = await git(repo.dir, ["diff", "--no-color", "--unified=3", range], { signal, raw: true, maxBuffer: 100 * 1024 * 1024 });
  let truncated = false;
  if (diff.length > maxChars) {
    // Dosya başına eşit pay: hiçbir dosya tamamen kaybolmasın
    const parts = diff.split(/(?=^diff --git )/m);
    const per = Math.max(1500, Math.floor(maxChars / Math.max(1, parts.length)));
    diff = parts.map((p) => (p.length > per ? p.slice(0, per) + "\n… (bu dosyanın farkı kırpıldı)\n" : p)).join("");
    truncated = true;
  }
  return { diff, truncated, files };
}

/** Dosyanın yerel kopyasından satır aralığı (yorumun bağlamı için), numaralı */
export function fileLines(repo: LocalRepo, file: string, from: number, to: number, pad = 3): string | undefined {
  const abs = path.join(repo.dir, file.replace(/^\/+/, ""));
  let text: string;
  try {
    if (fs.statSync(abs).size > 2 * 1024 * 1024) return undefined;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const a = Math.max(1, from - pad);
  const b = Math.min(lines.length, Math.max(from, to) + pad);
  if (a > lines.length) return undefined;
  const w = String(b).length;
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(`${String(i).padStart(w)}${i >= from && i <= Math.max(from, to) ? " ▶" : "  "} ${lines[i - 1]}`);
  return out.join("\n");
}

/** Var olan bir depo klasörünü açar (kayıttaki yol) */
export async function openRepo(dir: string, targetDir: string): Promise<LocalRepo | undefined> {
  const r = await repoAt(dir);
  if (!r) return undefined;
  return { dir: r.root, rel: path.relative(targetDir, r.root).split(path.sep).join("/") || ".", remote: r.remote, remoteUrl: r.remoteUrl };
}

/** Uzak adresteki proje adı (…/{proje}/_git/{depo}); proje yazılmamışsa (…/{koleksiyon}/_git/{depo}) undefined */
export function projectFromRemote(remoteUrl: string): string | undefined {
  const m = /\/([^/]+)\/_git\/[^/?#]+\/?$/i.exec(remoteUrl.trim().replace(/\.git$/i, ""));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Değişen dosyaları git depolarına göre gruplar (depo kökü → depo içi yollar). Dosya
 * silinmişse var olan en yakın üst klasörden bakılır. Depoda olmayanlar ayrı döner.
 */
export async function groupByRepo(files: string[], cwd: string): Promise<{ repos: Map<string, string[]>; outside: string[] }> {
  const repos = new Map<string, string[]>();
  const outside: string[] = [];
  const cache = new Map<string, string | null>();
  for (const f of [...new Set(files)]) {
    const abs = path.resolve(cwd, f);
    let dir = path.dirname(abs);
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    let root = cache.get(dir);
    if (root === undefined) {
      root = await git(dir, ["rev-parse", "--show-toplevel"]).then((r) => path.resolve(r), () => null);
      cache.set(dir, root);
    }
    if (!root) {
      outside.push(f);
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!repos.has(root)) repos.set(root, []);
    if (!repos.get(root)!.includes(rel)) repos.get(root)!.push(rel);
  }
  return { repos, outside };
}

const TR: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u" };
/** Dal adı için kısa ASCII parça */
export function slug(text: string): string {
  return (
    text
      .replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR[c] ?? c)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "degisiklik"
  );
}

/** Yerelde ve uzakta olmayan dal adı (varsa sonuna -2, -3…) */
export async function uniqueBranch(repo: LocalRepo, base: string): Promise<string> {
  let name = base;
  for (let i = 2; i < 50; i++) {
    const local = await git(repo.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(() => true, () => false);
    const remote = repo.remote ? await git(repo.dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${repo.remote}/${name}`]).then(() => true, () => false) : false;
    if (!local && !remote) return name;
    name = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}
