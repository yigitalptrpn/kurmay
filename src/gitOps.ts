import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git, GitError, repoAt } from "./tfsGit.js";

/**
 * Panelden ve sesle git işleri: hedef dizindeki depoların durumu, dala geçme, güncelleme,
 * yeni dal, kaydet ve gönder, değişiklikleri saklama / geri getirme.
 *
 * Her değiştiren iş İKİ ADIMLIDIR: önce plan (ne olacağı depo depo hesaplanır, hiçbir şey
 * değişmez), kullanıcı onaylayınca uygula. Sesle yanlış bir komut eşleşse bile ne olacağı
 * görülmeden hiçbir şey olmaz. Güvenli varsayılanlar: zorlama yok, güncelleme yalnızca
 * hızlı ileri (fast-forward), kaydedilmemiş değişikliği olan depoda dal değiştirilmez (atlanır),
 * dal hiçbir yerde yoksa kendiliğinden açılmaz.
 */

export type GitOpKind = "dal" | "guncelle" | "yeniDal" | "kaydet" | "sakla" | "geriGetir";

export interface GitRepoInfo {
  name: string;
  dir: string;
  remote: string;
  branch: string;
  dirty: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  stash: number;
  branches: string[];
  error?: string;
}

export interface GitPlanRequest {
  dir: string;
  op: GitOpKind;
  /** Depo adı (gevşek eşleşir); yoksa tüm depolar */
  repo?: string;
  branch?: string;
  message?: string;
}
export interface GitPlanItem {
  repo: string;
  /** Uygulanacak mı (false = atlanacak / zaten öyle) */
  run: boolean;
  text: string;
}
export type GitPlanReply =
  | { ok: true; id: string; title: string; items: GitPlanItem[]; runs: number }
  | { ok: false; error: string; candidates?: string[] };
export interface GitResult {
  repo: string;
  ok: boolean;
  text: string;
}

/** Yalnızca planlanan işin uygulama verisi */
interface Step {
  repo: GitRepoInfo;
  branch?: string;
  /** Dal yerelde yok, uzaktakinden açılacak */
  fromRemote?: boolean;
  files?: string[];
}
interface Pending {
  op: GitOpKind;
  message?: string;
  steps: Step[];
  title: string;
  expires: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const NET_TIMEOUT_MS = 300_000;

/** Sesle söylenen dal adı: "feature eğik çizgi 132" / "feature slash 132" → "feature/132";
 *  bilinen önekten sonraki boşluk da eğik çizgi sayılır ("feature 132" → "feature/132") */
export function spokenBranch(q: string): string {
  let t = q
    .trim()
    .replace(/\s*(eğik\s*çizgi|egik\s*cizgi|ters\s*eğik\s*çizgi|slash|bölü|bolu|taksim)\s*/gi, "/")
    .replace(/\s*(tire|kısa\s*çizgi|kisa\s*cizgi)\s*/gi, "-");
  t = t.replace(
    /^(feature|feat|bugfix|bug|hotfix|fix|release|task|story)\s+/i,
    (_, p: string) => p.toLowerCase() + "/",
  );
  return t.replace(/\s+/g, "-");
}

/** Türkçe harfleri sadeleştirip harf/rakam dışını atar: "Feature / 132" → "feature132" */
const norm = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9]/g, "");

export class GitOps {
  private pending = new Map<string, Pending>();

  /** env: uzak depo adresine göre kimlik ortamı (TFS sunucusundaysa erişim anahtarı) */
  constructor(private env: (remoteUrl: string) => Promise<Record<string, string>>) {}

  /** Hedef dizin bir depoysa o + bir alt düzeydeki depolar */
  async repos(targetDir: string): Promise<Array<{ name: string; dir: string; remote: string; remoteUrl: string }>> {
    const dirs = [targetDir];
    try {
      for (const e of fs.readdirSync(targetDir, { withFileTypes: true }))
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          dirs.push(path.join(targetDir, e.name));
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const out: Array<{ name: string; dir: string; remote: string; remoteUrl: string }> = [];
    const found = await Promise.all(dirs.map((d) => repoAt(d)));
    for (const r of found) {
      if (!r || seen.has(r.root)) continue;
      seen.add(r.root);
      out.push({ name: path.basename(r.root), dir: r.root, remote: r.remote, remoteUrl: r.remoteUrl });
    }
    return out;
  }

  async status(targetDir: string): Promise<GitRepoInfo[]> {
    const list = await this.repos(targetDir);
    return Promise.all(list.map((r) => this.info(r)));
  }

  private async info(r: { name: string; dir: string; remote: string }): Promise<GitRepoInfo> {
    const base: GitRepoInfo = {
      name: r.name,
      dir: r.dir,
      remote: r.remote,
      branch: "",
      dirty: 0,
      stash: 0,
      branches: [],
    };
    try {
      const [st, refs, stash] = await Promise.all([
        git(r.dir, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], { raw: true }),
        git(r.dir, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads",
          ...(r.remote ? [`refs/remotes/${r.remote}`] : []),
        ]),
        git(r.dir, ["stash", "list"]).catch(() => ""),
      ]);
      for (const l of st.split("\0")) {
        if (l.startsWith("# branch.head ")) base.branch = l.slice(14);
        else if (l.startsWith("# branch.upstream ")) base.upstream = l.slice(18);
        else if (l.startsWith("# branch.ab ")) {
          const m = /\+(\d+) -(\d+)/.exec(l);
          if (m) [base.ahead, base.behind] = [Number(m[1]), Number(m[2])];
        } else if (/^[12u?] /.test(l)) base.dirty++;
      }
      if (base.branch === "(detached)") base.branch = "HEAD";
      const names = new Set<string>();
      for (const ref of refs.split("\n").filter(Boolean)) {
        if (ref.startsWith("refs/heads/")) names.add(ref.slice(11));
        else {
          const n = ref.slice(`refs/remotes/${r.remote}/`.length);
          if (n && n !== "HEAD") names.add(n);
        }
      }
      base.branches = [...names].sort().slice(0, 300);
      base.stash = stash ? stash.split("\n").filter(Boolean).length : 0;
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
    return base;
  }

  /** Depo adını gevşek eşler: tam > başı > içinde; birden çok aday varsa liste döner */
  private pickRepos(
    all: GitRepoInfo[],
    q?: string,
  ): { repos: GitRepoInfo[] } | { error: string; candidates?: string[] } {
    if (!q?.trim()) return { repos: all };
    const n = norm(q.replace(/\b(repo|depo)\w*\b/gi, ""));
    if (!n) return { repos: all };
    for (const f of [(x: string) => x === n, (x: string) => x.startsWith(n), (x: string) => x.includes(n)]) {
      const hits = all.filter((r) => f(norm(r.name)));
      if (hits.length === 1) return { repos: hits };
      if (hits.length > 1) return { error: `“${q}” birden çok depoya uyuyor.`, candidates: hits.map((r) => r.name) };
    }
    return { error: `“${q}” adında depo yok.`, candidates: all.map((r) => r.name) };
  }

  /** Dal adını depodaki dallarla eşler (söylenen "feature 132" → "feature/132") */
  private matchBranch(repo: GitRepoInfo, q0: string): string | undefined {
    const q = spokenBranch(q0);
    const exact = repo.branches.find((b) => b === q);
    if (exact) return exact;
    const n = norm(q);
    if (!n) return undefined;
    const eq = repo.branches.filter((b) => norm(b) === n);
    if (eq.length === 1) return eq[0];
    if (n.length >= 3) {
      const inc = repo.branches.filter((b) => norm(b).includes(n));
      if (inc.length === 1) return inc[0];
    }
    return undefined;
  }

  private async localBranch(dir: string, b: string): Promise<boolean> {
    try {
      await git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]);
      return true;
    } catch {
      return false;
    }
  }

  async plan(req: GitPlanRequest): Promise<GitPlanReply> {
    if (!req.dir || !fs.existsSync(req.dir)) return { ok: false, error: "Dizin bulunamadı." };
    let all = await this.status(req.dir);
    if (!all.length) return { ok: false, error: `Bu dizinde git deposu yok: ${req.dir}` };
    const pick = this.pickRepos(all, req.repo);
    if ("error" in pick) return { ok: false, error: pick.error, candidates: pick.candidates };
    const items: GitPlanItem[] = [];
    const steps: Step[] = [];
    const skip = (r: GitRepoInfo, text: string) => items.push({ repo: r.name, run: false, text });
    const add = (s: Step, text: string) => {
      steps.push(s);
      items.push({ repo: s.repo.name, run: true, text });
    };
    let title: string;
    const branchQ = (req.branch ?? "").trim();
    const message = (req.message ?? "").trim();

    switch (req.op) {
      case "dal": {
        if (!branchQ) return { ok: false, error: "Hangi dala geçileceğini söyle." };
        title = `“${spokenBranch(branchQ)}” dalına geçiş`;
        // Yerelde ve son getirmede bulunamayan dal için uzak depoyu bir kez getir (yalnızca bilgi günceller)
        const missing = pick.repos.filter((r) => !r.error && r.remote && !this.matchBranch(r, branchQ));
        if (missing.length) {
          await Promise.all(
            missing.map(async (r) => {
              try {
                await git(r.dir, ["fetch", "--prune", r.remote], { env: await this.envFor(r), timeoutMs: 30_000 });
              } catch {
                /* ağ yoksa son bilinen dallarla devam */
              }
            }),
          );
          all = await this.status(req.dir);
          const again = this.pickRepos(all, req.repo);
          if ("repos" in again) pick.repos = again.repos;
        }
        for (const r of pick.repos) {
          if (r.error) {
            skip(r, `okunamadı: ${r.error}`);
            continue;
          }
          const b = this.matchBranch(r, branchQ);
          if (!b) skip(r, `“${branchQ}” dalı yok (sunucuda da bulunamadı) — atlanacak`);
          else if (r.branch === b) skip(r, `zaten ${b} dalında`);
          else if (r.dirty) skip(r, `${r.dirty} kaydedilmemiş değişiklik var — atlanacak (önce kaydet ya da sakla)`);
          else {
            const local = await this.localBranch(r.dir, b);
            add(
              { repo: r, branch: b, fromRemote: !local },
              `${r.branch} → ${b}${local ? "" : " (sunucudaki daldan açılacak)"}`,
            );
          }
        }
        break;
      }
      case "guncelle":
        title = "Sunucudan güncelleme (yalnızca hızlı ileri)";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (r.branch === "HEAD") skip(r, "bir dalda değil — atlanacak");
          else if (!r.upstream) skip(r, `${r.branch} dalının sunucuda karşılığı yok — atlanacak`);
          else
            add(
              { repo: r },
              `${r.branch} ← ${r.upstream}${r.ahead ? ` · ${r.ahead} gönderilmemiş kaydın var` : ""}${r.dirty ? ` · ${r.dirty} kaydedilmemiş değişiklik (çakışırsa durur)` : ""}`,
            );
        }
        break;
      case "yeniDal": {
        const name = spokenBranch(branchQ);
        if (!name) return { ok: false, error: "Yeni dalın adını söyle." };
        try {
          await git(pick.repos[0].dir, ["check-ref-format", "--branch", name]);
        } catch {
          return { ok: false, error: `“${name}” geçerli bir dal adı değil.` };
        }
        title = `Yeni dal: ${name}`;
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (r.branches.includes(name))
            skip(r, `${name} dalı zaten var — atlanacak (geçmek için “dalına geç” de)`);
          else add({ repo: r, branch: name }, `${r.branch} dalından ${name} açılıp ona geçilecek`);
        }
        break;
      }
      case "kaydet": {
        if (!message) return { ok: false, error: "Kayıt mesajını söyle (… mesaj …) ya da kutuya yaz." };
        title = `Kaydet ve gönder: “${message}”`;
        for (const r of pick.repos) {
          if (r.error) {
            skip(r, `okunamadı: ${r.error}`);
            continue;
          }
          if (!r.dirty) {
            skip(r, "değişiklik yok");
            continue;
          }
          if (r.branch === "HEAD") {
            skip(r, "bir dalda değil — atlanacak");
            continue;
          }
          const files = await this.dirtyList(r.dir);
          const list = files.slice(0, 8).join(", ") + (files.length > 8 ? ` +${files.length - 8}` : "");
          add(
            { repo: r, files },
            `${files.length} dosya → ${r.branch}${r.remote ? (r.upstream ? ` → ${r.upstream}` : ` → ${r.remote}/${r.branch} (yeni)`) : " (uzak depo yok, yalnızca kaydedilir)"}: ${list}`,
          );
        }
        break;
      }
      case "sakla":
        title = "Değişiklikleri sakla (stash)";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (!r.dirty) skip(r, "değişiklik yok");
          else add({ repo: r }, `${r.dirty} değişiklik saklanacak`);
        }
        break;
      case "geriGetir":
        title = "Saklanan değişiklikleri geri getir";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (!r.stash) skip(r, "saklanmış değişiklik yok");
          else add({ repo: r }, `en son saklanan geri getirilecek${r.stash > 1 ? ` (${r.stash} kayıt var)` : ""}`);
        }
        break;
      default:
        return { ok: false, error: "bilinmeyen git işi" };
    }
    this.sweep();
    const id = randomUUID();
    this.pending.set(id, { op: req.op, message, steps, title, expires: Date.now() + PENDING_TTL_MS });
    return { ok: true, id, title, items, runs: steps.length };
  }

  async apply(id: string): Promise<{ ok: boolean; error?: string; results: GitResult[] }> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: "Bu onayın süresi doldu — yeniden iste.", results: [] };
    this.pending.delete(id);
    const results: GitResult[] = [];
    for (const s of p.steps) {
      try {
        results.push({ repo: s.repo.name, ok: true, text: await this.run(p, s) });
      } catch (e) {
        results.push({ repo: s.repo.name, ok: false, text: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok: true, results };
  }

  private async run(p: Pending, s: Step): Promise<string> {
    const d = s.repo.dir;
    switch (p.op) {
      case "dal": {
        // Plan ile onay arasında değişiklik yapılmış olabilir — yine dokunma
        if ((await this.dirtyList(d)).length)
          throw new GitError("bu arada kaydedilmemiş değişiklik oluştu — geçilmedi");
        if (s.fromRemote) await git(d, ["checkout", "-b", s.branch!, "--track", `${s.repo.remote}/${s.branch}`]);
        else await git(d, ["checkout", s.branch!]);
        return `${s.branch} dalına geçildi`;
      }
      case "guncelle": {
        const before = await git(d, ["rev-parse", "HEAD"]);
        await git(d, ["pull", "--ff-only"], { env: await this.envFor(s.repo), timeoutMs: NET_TIMEOUT_MS });
        const after = await git(d, ["rev-parse", "HEAD"]);
        if (before === after) return "zaten güncel";
        const n = await git(d, ["rev-list", "--count", `${before}..${after}`]).catch(() => "?");
        return `${n} yeni kayıt alındı`;
      }
      case "yeniDal":
        await git(d, ["checkout", "-b", s.branch!]);
        return `${s.branch} dalı açıldı, ona geçildi`;
      case "kaydet": {
        await git(d, ["add", "-A"]);
        const [subject, ...body] = (p.message ?? "").split(/\r?\n/);
        const args = ["commit", "-m", subject];
        if (body.join("\n").trim()) args.push("-m", body.join("\n").trim());
        await git(d, args);
        const commit = (await git(d, ["rev-parse", "--short", "HEAD"])).trim();
        if (!s.repo.remote) return `kaydedildi (${commit}) — uzak depo yok, gönderilmedi`;
        const branch = await git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
        try {
          await git(d, ["push", ...(s.repo.upstream ? [] : ["-u"]), s.repo.remote, `HEAD:refs/heads/${branch}`], {
            env: await this.envFor(s.repo),
            timeoutMs: NET_TIMEOUT_MS,
          });
        } catch (e) {
          throw new GitError(`kaydedildi (${commit}) ama gönderilemedi: ${e instanceof Error ? e.message : String(e)}`);
        }
        return `kaydedildi (${commit}) ve gönderildi → ${s.repo.remote}/${branch}`;
      }
      case "sakla":
        await git(d, ["stash", "push", "-u", "-m", `Kurmay ${new Date().toLocaleString("tr-TR")}`]);
        return "değişiklikler saklandı";
      case "geriGetir":
        try {
          await git(d, ["stash", "pop"]);
        } catch (e) {
          throw new GitError(
            `geri getirilirken çakıştı — değişiklikler saklı kaldı, elle çözmen gerek: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return "saklanan değişiklikler geri getirildi";
    }
  }

  private async dirtyList(dir: string): Promise<string[]> {
    const out = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"], { raw: true });
    return out
      .split("\0")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3));
  }

  private async envFor(r: { dir: string; remote: string }): Promise<Record<string, string>> {
    if (!r.remote) return {};
    try {
      return await this.env(await git(r.dir, ["remote", "get-url", r.remote]));
    } catch {
      return {};
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id);
  }
}
