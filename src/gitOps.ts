import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { okunusBul } from "./okunus.js";
import { git, GitError, repoAt } from "./tfsGit.js";

/**
 * Panelden, Git sayfasından (ui/git.html) ve sesle git işleri: hedef dizindeki depoların durumu,
 * checkout (sunucudaki son hâline çekerek), pull, fetch, merge, yeni branch, commit + push,
 * stash / stash pop / stash listesi, merge edilmiş branch'lerin temizliği.
 *
 * Her değiştiren iş İKİ ADIMLIDIR: önce plan (ne olacağı depo depo hesaplanır, hiçbir şey
 * değişmez), kullanıcı onaylayınca uygula. Sesle yanlış bir komut eşleşse bile ne olacağı
 * görülmeden hiçbir şey olmaz. Güvenli varsayılanlar: zorlama yok, güncelleme yalnızca
 * hızlı ileri (fast-forward), dal hiçbir yerde yoksa kendiliğinden açılmaz. Checkout'ta commit
 * edilmemiş değişikliği olan depo için kullanıcı seçer: yanında götür / stash'te bırak / atla
 * (seçim gelmezse atla). Merge çakışırsa geri alınır.
 */

export type GitOpKind =
  | "dal"
  | "guncelle"
  | "fetch"
  | "merge"
  | "yeniDal"
  | "kaydet"
  | "sakla"
  | "geriGetir"
  | "stashAl"
  | "stashSil"
  | "temizle";

/** Checkout'ta değişikliği olan depo için seçenekler */
export type DirtyChoice = "gotur" | "birak" | "atla";
const DIRTY_CHOICES: DirtyChoice[] = ["gotur", "birak", "atla"];

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

export interface GitStashInfo {
  ref: string;
  message: string;
  /** Oluşturulma zamanı (ms) */
  at: number;
  files: string[];
}

export interface GitPlanRequest {
  dir: string;
  op: GitOpKind;
  /** Depo adı (gevşek eşleşir); yoksa tüm depolar */
  repo?: string;
  /** Depo adları (tam ad; Git sayfasındaki seçim) — repo'dan önce gelir */
  repos?: string[];
  branch?: string;
  message?: string;
  /** Checkout'tan sonra sunucudaki son hâline çek (varsayılan açık) */
  pull?: boolean;
  /** stashAl / stashSil: "stash@{n}" */
  stash?: string;
}
export interface GitPlanItem {
  repo: string;
  /** Uygulanacak mı (false = atlanacak / zaten öyle) */
  run: boolean;
  text: string;
  /** Checkout: commit edilmemiş değişiklik sayısı — kullanıcı `choices`'tan seçer */
  dirty?: number;
  choices?: DirtyChoice[];
  /** Temizlik: silinebilecek branch'ler — kullanıcı seçer (varsayılan hepsi) */
  branches?: string[];
}
export type GitPlanReply =
  | { ok: true; id: string; op: GitOpKind; title: string; items: GitPlanItem[]; runs: number }
  | { ok: false; error: string; candidates?: string[] };
export interface GitResult {
  repo: string;
  ok: boolean;
  text: string;
  /** Kullanıcının seçimiyle atlandı */
  skipped?: boolean;
}
export interface GitApplyOptions {
  /** Checkout: depo adı → değişiklikler ne olsun */
  choices?: Record<string, string>;
  /** Temizlik: depo adı → silinecek branch'ler */
  select?: Record<string, string[]>;
}

/** Yalnızca planlanan işin uygulama verisi */
interface Step {
  repo: GitRepoInfo;
  branch?: string;
  /** Dal yerelde yok, uzaktakinden açılacak */
  fromRemote?: boolean;
  files?: string[];
  /** Checkout: planda commit edilmemiş değişiklik vardı (seçim istenir) */
  dirty?: boolean;
  /** Checkout: zaten o branch'te, yalnızca son hâline çekilecek */
  same?: boolean;
  /** merge / temizle: karşılaştırılan ref (origin/develop) */
  ref?: string;
  /** temizle: silinebilecek branch'ler */
  branches?: string[];
  /** stashAl / stashSil: stash'in commit kimliği (sıra numarası arada kayabilir) */
  stashHash?: string;
}
interface Pending {
  op: GitOpKind;
  message?: string;
  pull?: boolean;
  steps: Step[];
  title: string;
  expires: number;
}

const PENDING_TTL_MS = 5 * 60_000;
const NET_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 60_000;
/** Temizlikte asla silinmeyen branch'ler */
const KORUNAN = new Set(["main", "master", "develop", "development", "trunk"]);

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

/** Git'in stash mesajına eklediği "On main: " / "WIP on main: " önekini atar */
const stashMsg = (s: string) => s.replace(/^(WIP )?on [^:]+: /i, "");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const liste = (xs: string[], n = 8) => xs.slice(0, n).join(", ") + (xs.length > n ? ` +${xs.length - n}` : "");

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

  /** Depo depo stash listesi (en fazla 20 stash, her birinin dosyaları) */
  async stashes(
    targetDir: string,
  ): Promise<Array<{ name: string; dir: string; stashes: GitStashInfo[]; error?: string }>> {
    const list = await this.repos(targetDir);
    return Promise.all(
      list.map(async (r) => {
        try {
          // Zaman sayı olarak (saniye): git'in "3 hours ago" metni İngilizce, sayfa Türkçe yazar
          const out = await git(r.dir, ["stash", "list", "--format=%gd%x1f%gs%x1f%ct"]);
          const rows = out
            .split("\n")
            .filter(Boolean)
            .slice(0, 20)
            .map((l) => {
              const [ref, message, when] = l.split("\x1f");
              return { ref, message: stashMsg(message ?? ""), at: Number(when) * 1000 || 0, files: [] as string[] };
            });
          await Promise.all(
            rows.map(async (s) => {
              s.files = (
                await git(r.dir, ["stash", "show", "--name-only", "--include-untracked", s.ref]).catch(() =>
                  git(r.dir, ["stash", "show", "--name-only", s.ref]).catch(() => ""),
                )
              )
                .split("\n")
                .filter(Boolean);
            }),
          );
          return { name: r.name, dir: r.dir, stashes: rows };
        } catch (e) {
          return { name: r.name, dir: r.dir, stashes: [], error: errText(e) };
        }
      }),
    );
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
      base.error = errText(e);
    }
    return base;
  }

  /** Depo seçimi: tam adlar (Git sayfası) ya da gevşek eşleşen tek ad (ses); birden çok aday varsa liste döner */
  private pickRepos(
    all: GitRepoInfo[],
    q?: string,
    names?: string[],
  ): { repos: GitRepoInfo[] } | { error: string; candidates?: string[] } {
    if (names?.length) {
      const want = new Set(names);
      const hits = all.filter((r) => want.has(r.name));
      return hits.length ? { repos: hits } : { error: "Seçilen depolar bu dizinde bulunamadı." };
    }
    if (!q?.trim()) return { repos: all };
    const n = norm(q.replace(/\b(repo|depo)\w*\b/gi, ""));
    if (!n) return { repos: all };
    for (const f of [(x: string) => x === n, (x: string) => x.startsWith(n), (x: string) => x.includes(n)]) {
      const hits = all.filter((r) => f(norm(r.name)));
      if (hits.length === 1) return { repos: hits };
      if (hits.length > 1)
        return { error: `“${q}” birden çok depoya uyuyor.`, candidates: hits.map((r) => r.name).slice(0, 5) };
    }
    // Okunuşa göre: İngilizce ad Türkçe söylenmiş olabilir ("ordır servis" → order-service)
    const o = okunusBul(
      q.replace(/\b(repo|depo)\w*\b/gi, ""),
      all.map((r) => r.name),
    );
    if (o.ad) return { repos: all.filter((r) => r.name === o.ad) };
    if (o.adaylar) return { error: `“${q}” birden çok depoya benziyor.`, candidates: o.adaylar };
    return { error: `“${q}” adında depo yok (bu dizinde ${all.length} depo var — listesi için “git durumu” de).` };
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
    // Okunuşa göre ("divelop" → develop, "fiçır 132" → feature/132)
    return okunusBul(q0, repo.branches).ad;
  }

  private async hasRef(dir: string, ref: string): Promise<boolean> {
    try {
      await git(dir, ["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  private localBranch(dir: string, b: string): Promise<boolean> {
    return this.hasRef(dir, `refs/heads/${b}`);
  }

  /** a..b arasındaki commit sayısı (okunamazsa 0) */
  private async count(dir: string, range: string): Promise<number> {
    try {
      return Number(await git(dir, ["rev-list", "--count", range])) || 0;
    } catch {
      return 0;
    }
  }

  /** Karşılaştırma ref'i: sunucudaki branch (origin/develop), yoksa local branch */
  private async compareRef(r: GitRepoInfo, b: string): Promise<string | undefined> {
    if (r.remote && (await this.hasRef(r.dir, `refs/remotes/${r.remote}/${b}`))) return `${r.remote}/${b}`;
    if (await this.localBranch(r.dir, b)) return b;
    return undefined;
  }

  /** Depoları paralel fetch eder; hata veren depo için sebebi döner (ağ yoksa son bilinen hâl kullanılır) */
  private async fetchAll(repos: GitRepoInfo[]): Promise<Map<string, string>> {
    const errs = new Map<string, string>();
    await Promise.all(
      repos
        .filter((r) => !r.error && r.remote)
        .map(async (r) => {
          try {
            await git(r.dir, ["fetch", "--prune", r.remote], {
              env: await this.envFor(r),
              timeoutMs: FETCH_TIMEOUT_MS,
            });
          } catch (e) {
            errs.set(r.name, errText(e));
          }
        }),
    );
    return errs;
  }

  async plan(req: GitPlanRequest): Promise<GitPlanReply> {
    if (!req.dir || !fs.existsSync(req.dir)) return { ok: false, error: "Dizin bulunamadı." };
    let all = await this.status(req.dir);
    if (!all.length) return { ok: false, error: `Bu dizinde git deposu yok: ${req.dir}` };
    const pick = this.pickRepos(all, req.repo, req.repos);
    if ("error" in pick) return { ok: false, error: pick.error, candidates: pick.candidates };
    /** fetch sonrası durum yeniden okunur — seçim aynı kalır */
    const refetch = async () => {
      all = await this.status(req.dir);
      const again = this.pickRepos(all, req.repo, req.repos);
      if ("repos" in again) pick.repos = again.repos;
    };
    const items: GitPlanItem[] = [];
    const steps: Step[] = [];
    const skip = (r: GitRepoInfo, text: string) => items.push({ repo: r.name, run: false, text });
    const add = (s: Step, text: string, extra: Partial<GitPlanItem> = {}) => {
      steps.push(s);
      items.push({ repo: s.repo.name, run: true, text, ...extra });
    };
    let title: string;
    const branchQ = (req.branch ?? "").trim();
    const message = (req.message ?? "").trim();
    const pull = req.pull !== false;

    switch (req.op) {
      case "dal": {
        if (!branchQ) return { ok: false, error: "Hangi branch'e geçileceğini söyle." };
        title = `Checkout: “${spokenBranch(branchQ)}”${pull ? " · sunucudaki son hâliyle" : ""}`;
        // Son hâline çekilecekse hepsi, değilse yalnızca dalı bulunamayan depolar fetch edilir
        const toFetch = pick.repos.filter((r) => !r.error && r.remote && (pull || !this.matchBranch(r, branchQ)));
        const fetchErr = toFetch.length ? await this.fetchAll(toFetch) : new Map<string, string>();
        if (toFetch.length) await refetch();
        for (const r of pick.repos) {
          if (r.error) {
            skip(r, `okunamadı: ${r.error}`);
            continue;
          }
          const fe = fetchErr.get(r.name) ? ` · fetch yapılamadı, son bilinen hâl kullanılıyor` : "";
          const b = this.matchBranch(r, branchQ);
          if (!b) {
            skip(r, `“${branchQ}” branch'i yok (sunucuda da bulunamadı)${fe}`);
            continue;
          }
          if (r.branch === b) {
            if (pull && r.upstream && r.behind)
              add(
                { repo: r, branch: b, same: true },
                `zaten ${b} branch'inde · ${r.behind} yeni commit çekilecek${r.ahead ? ` · ${r.ahead} push edilmemiş commit'in var — fast-forward olmazsa olduğu gibi kalır` : ""}${fe}`,
              );
            else skip(r, `zaten ${b} branch'inde${r.behind ? "" : pull && r.upstream ? ", güncel" : ""}${fe}`);
            continue;
          }
          const local = await this.localBranch(r.dir, b);
          let note = "";
          if (!local) note = " (sunucudaki branch'ten açılacak)";
          else if (r.remote && (await this.hasRef(r.dir, `refs/remotes/${r.remote}/${b}`))) {
            const behind = await this.count(r.dir, `${b}..${r.remote}/${b}`);
            const ahead = await this.count(r.dir, `${r.remote}/${b}..${b}`);
            if (pull && behind) note += ` · ${behind} yeni commit çekilecek`;
            if (ahead)
              note += ` · local'de ${ahead} push edilmemiş commit var — fast-forward olmazsa olduğu gibi kalır`;
          }
          const s: Step = { repo: r, branch: b, fromRemote: !local };
          if (r.dirty)
            add({ ...s, dirty: true }, `${r.branch} → ${b}${note}${fe} · ${r.dirty} commit edilmemiş değişiklik var`, {
              dirty: r.dirty,
              choices: DIRTY_CHOICES,
            });
          else add(s, `${r.branch} → ${b}${note}${fe}`);
        }
        break;
      }
      case "guncelle":
        title = "Pull (yalnızca fast-forward)";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (r.branch === "HEAD") skip(r, "bir branch'te değil — atlanacak");
          else if (!r.upstream) skip(r, `${r.branch} branch'inin sunucuda karşılığı yok — atlanacak`);
          else
            add(
              { repo: r },
              `${r.branch} ← ${r.upstream}${r.ahead ? ` · ${r.ahead} push edilmemiş commit'in var` : ""}${r.dirty ? ` · ${r.dirty} commit edilmemiş değişiklik (çakışırsa durur)` : ""}`,
            );
        }
        break;
      case "fetch":
        title = "Fetch (branch'te kalınır, yalnızca sunucudaki son durum alınır)";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (!r.remote) skip(r, "uzak depo yok");
          else add({ repo: r }, `${r.remote} fetch edilecek`);
        }
        break;
      case "merge": {
        const src = spokenBranch(branchQ || "develop");
        title = `Merge: ${src} → bulunduğun branch`;
        const fetchErr = await this.fetchAll(pick.repos);
        await refetch();
        for (const r of pick.repos) {
          if (r.error) {
            skip(r, `okunamadı: ${r.error}`);
            continue;
          }
          const fe = fetchErr.get(r.name) ? " · fetch yapılamadı, son bilinen hâl kullanılıyor" : "";
          const b = this.matchBranch(r, src);
          const ref = b && (await this.compareRef(r, b));
          if (!b || !ref) skip(r, `“${src}” branch'i yok${fe}`);
          else if (r.branch === "HEAD") skip(r, "bir branch'te değil — atlanacak");
          else if (r.branch === b) skip(r, `zaten ${b} branch'inde — güncellemek için Pull kullan`);
          else if (r.dirty) skip(r, `${r.dirty} commit edilmemiş değişiklik var — önce commit et ya da stash'le`);
          else {
            const n = await this.count(r.dir, `HEAD..${ref}`);
            if (!n) skip(r, `${r.branch}, ${ref} içindeki her şeyi zaten içeriyor${fe}`);
            else add({ repo: r, ref }, `${ref} → ${r.branch}: ${n} commit gelecek (çakışırsa geri alınır)${fe}`);
          }
        }
        break;
      }
      case "yeniDal": {
        const name = spokenBranch(branchQ);
        if (!name) return { ok: false, error: "Yeni branch'in adını söyle." };
        try {
          await git(pick.repos[0].dir, ["check-ref-format", "--branch", name]);
        } catch {
          return { ok: false, error: `“${name}” geçerli bir branch adı değil.` };
        }
        title = `New branch: ${name}`;
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (r.branches.includes(name))
            skip(r, `${name} branch'i zaten var — atlanacak (geçmek için “… branch'ine checkout yap” de)`);
          else add({ repo: r, branch: name }, `${r.branch} branch'inden ${name} açılıp ona geçilecek`);
        }
        break;
      }
      case "kaydet": {
        if (!message) return { ok: false, error: "Commit mesajını söyle (… mesaj …) ya da kutuya yaz." };
        title = `Commit + Push: “${message}”`;
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
            skip(r, "bir branch'te değil — atlanacak");
            continue;
          }
          const files = await this.dirtyList(r.dir);
          add(
            { repo: r, files },
            `${files.length} dosya → ${r.branch}${r.remote ? (r.upstream ? ` → ${r.upstream}` : ` → ${r.remote}/${r.branch} (yeni)`) : " (uzak depo yok, yalnızca kaydedilir)"}: ${liste(files)}`,
          );
        }
        break;
      }
      case "sakla":
        title = "Stash";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (!r.dirty) skip(r, "değişiklik yok");
          else add({ repo: r }, `${r.dirty} değişiklik stash'lenecek`);
        }
        break;
      case "geriGetir":
        title = "Stash pop";
        for (const r of pick.repos) {
          if (r.error) skip(r, `okunamadı: ${r.error}`);
          else if (!r.stash) skip(r, "stash yok");
          else add({ repo: r }, `son stash geri getirilecek${r.stash > 1 ? ` (${r.stash} stash var)` : ""}`);
        }
        break;
      case "stashAl":
      case "stashSil": {
        const ref = (req.stash ?? "").trim();
        if (!/^stash@\{\d+\}$/.test(ref)) return { ok: false, error: "Hangi stash olduğunu seç." };
        if (pick.repos.length !== 1) return { ok: false, error: "Stash için tek bir depo seç." };
        const r = pick.repos[0];
        let hash: string, msg: string;
        try {
          hash = await git(r.dir, ["rev-parse", ref]);
          msg = stashMsg(await git(r.dir, ["log", "-1", "--format=%s", ref]));
        } catch {
          return { ok: false, error: `${r.name} deposunda ${ref} bulunamadı — listeyi yenile.` };
        }
        if (req.op === "stashAl") {
          title = `Stash geri getir: ${ref}`;
          add(
            { repo: r, stashHash: hash },
            `“${msg}” geri getirilecek, stash listeden çıkar${r.dirty ? ` · ${r.dirty} commit edilmemiş değişiklik var — çakışırsa stash yerinde kalır` : ""}`,
          );
        } else {
          title = `Stash sil: ${ref}`;
          add({ repo: r, stashHash: hash }, `“${msg}” KALICI olarak silinecek — geri alınamaz`);
        }
        break;
      }
      case "temizle": {
        const base = spokenBranch(branchQ || "develop");
        title = `Eski branch temizliği: ${base} içine merge edilmiş local branch'ler`;
        await this.fetchAll(pick.repos);
        await refetch();
        for (const r of pick.repos) {
          if (r.error) {
            skip(r, `okunamadı: ${r.error}`);
            continue;
          }
          const b = this.matchBranch(r, base);
          const ref = b && (await this.compareRef(r, b));
          if (!b || !ref) {
            skip(r, `“${base}” branch'i yok`);
            continue;
          }
          const merged = (await git(r.dir, ["branch", "--merged", ref, "--format=%(refname:short)"]).catch(() => ""))
            .split("\n")
            .map((x) => x.trim())
            .filter((x) => x && x !== r.branch && x !== b && !KORUNAN.has(x));
          if (!merged.length) skip(r, `silinecek branch yok (${ref} içine merge edilmiş başka local branch yok)`);
          else
            add(
              { repo: r, ref, branches: merged },
              `${merged.length} local branch ${ref} içine merge edilmiş: ${liste(merged)}`,
              { branches: merged },
            );
        }
        break;
      }
      default:
        return { ok: false, error: "bilinmeyen git işi" };
    }
    this.sweep();
    const id = randomUUID();
    this.pending.set(id, { op: req.op, message, pull, steps, title, expires: Date.now() + PENDING_TTL_MS });
    return { ok: true, id, op: req.op, title, items, runs: steps.length };
  }

  async apply(id: string, o: GitApplyOptions = {}): Promise<{ ok: boolean; error?: string; results: GitResult[] }> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: "Bu onayın süresi doldu — yeniden iste.", results: [] };
    this.pending.delete(id);
    const results: GitResult[] = [];
    for (const s of p.steps) {
      try {
        const r = await this.run(p, s, o);
        results.push(typeof r === "string" ? { repo: s.repo.name, ok: true, text: r } : { repo: s.repo.name, ...r });
      } catch (e) {
        results.push({ repo: s.repo.name, ok: false, text: errText(e) });
      }
    }
    return { ok: true, results };
  }

  private async run(p: Pending, s: Step, o: GitApplyOptions): Promise<string | Omit<GitResult, "repo">> {
    const d = s.repo.dir;
    switch (p.op) {
      case "dal":
        return this.runCheckout(p, s, o);
      case "guncelle": {
        const before = await git(d, ["rev-parse", "HEAD"]);
        await git(d, ["pull", "--ff-only"], { env: await this.envFor(s.repo), timeoutMs: NET_TIMEOUT_MS });
        const after = await git(d, ["rev-parse", "HEAD"]);
        if (before === after) return "zaten güncel";
        const n = await git(d, ["rev-list", "--count", `${before}..${after}`]).catch(() => "?");
        return `${n} yeni commit alındı`;
      }
      case "fetch": {
        await git(d, ["fetch", "--prune", s.repo.remote], {
          env: await this.envFor(s.repo),
          timeoutMs: NET_TIMEOUT_MS,
        });
        try {
          const [ahead, behind] = (await git(d, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]))
            .split(/\s+/)
            .map(Number);
          if (!ahead && !behind) return "fetch yapıldı · branch güncel";
          return `fetch yapıldı${behind ? ` · sunucuda ${behind} yeni commit var (Pull ile alınır)` : ""}${ahead ? ` · ${ahead} push edilmemiş commit'in var` : ""}`;
        } catch {
          return "fetch yapıldı";
        }
      }
      case "merge": {
        if ((await this.dirtyList(d)).length)
          throw new GitError("bu arada commit edilmemiş değişiklik oluştu — merge yapılmadı");
        const n = await this.count(d, `HEAD..${s.ref}`);
        try {
          await git(d, ["merge", "--no-edit", s.ref!]);
        } catch (e) {
          const files = await this.conflicts(d);
          await git(d, ["merge", "--abort"]).catch(() => {});
          throw new GitError(
            files.length
              ? `çakışma çıktı (${liste(files, 5)}) — merge geri alındı, branch'e dokunulmadı`
              : `merge yapılamadı, geri alındı: ${errText(e)}`,
            { cause: e },
          );
        }
        return `${s.ref} merge edildi · ${n} commit geldi`;
      }
      case "yeniDal":
        await git(d, ["checkout", "-b", s.branch!]);
        return `${s.branch} branch'i açıldı, checkout yapıldı`;
      case "kaydet": {
        await git(d, ["add", "-A"]);
        const [subject, ...body] = (p.message ?? "").split(/\r?\n/);
        const args = ["commit", "-m", subject];
        if (body.join("\n").trim()) args.push("-m", body.join("\n").trim());
        await git(d, args);
        const commit = (await git(d, ["rev-parse", "--short", "HEAD"])).trim();
        if (!s.repo.remote) return `commit edildi (${commit}) — uzak depo yok, push yapılmadı`;
        const branch = await git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
        try {
          await git(d, ["push", ...(s.repo.upstream ? [] : ["-u"]), s.repo.remote, `HEAD:refs/heads/${branch}`], {
            env: await this.envFor(s.repo),
            timeoutMs: NET_TIMEOUT_MS,
          });
        } catch (e) {
          throw new GitError(`commit edildi (${commit}) ama push yapılamadı: ${errText(e)}`, { cause: e });
        }
        return `commit edildi (${commit}) ve push yapıldı → ${s.repo.remote}/${branch}`;
      }
      case "sakla":
        await git(d, ["stash", "push", "-u", "-m", `Kurmay ${new Date().toLocaleString("tr-TR")}`]);
        return "değişiklikler stash'lendi";
      case "geriGetir":
        try {
          await git(d, ["stash", "pop"]);
        } catch (e) {
          throw new GitError(`stash pop çakıştı — değişiklikler stash'te kaldı, elle çözmen gerek: ${errText(e)}`, {
            cause: e,
          });
        }
        return "stash geri getirildi";
      case "stashAl":
      case "stashSil": {
        // Plan ile onay arasında sıra numarası kaymış olabilir: commit kimliğinden bulunur
        const ref = await this.stashRef(d, s.stashHash!);
        if (!ref) throw new GitError("bu stash artık yok — listeyi yenile");
        if (p.op === "stashSil") {
          await git(d, ["stash", "drop", ref]);
          return `${ref} silindi`;
        }
        try {
          await git(d, ["stash", "pop", ref]);
        } catch (e) {
          const files = await this.conflicts(d);
          throw new GitError(
            files.length
              ? `çakışma çıktı (${liste(files, 5)}) — çakışan dosyaları düzelt; stash listede duruyor`
              : `stash geri getirilemedi, listede duruyor: ${errText(e)}`,
            { cause: e },
          );
        }
        return `${ref} geri getirildi`;
      }
      case "temizle": {
        const want = o.select?.[s.repo.name];
        const sel = (want ?? s.branches ?? []).filter((b) => s.branches?.includes(b));
        if (!sel.length) return { ok: true, skipped: true, text: "seçilen branch yok — dokunulmadı" };
        const silinen: string[] = [];
        const kalan: string[] = [];
        for (const b of sel) {
          try {
            // Bu arada yeni commit almış olabilir: hâlâ tamamen merge edilmişse silinir
            await git(d, ["merge-base", "--is-ancestor", b, s.ref!]);
            await git(d, ["branch", "-D", b]);
            silinen.push(b);
          } catch {
            kalan.push(b);
          }
        }
        const text =
          (silinen.length ? `${silinen.length} branch silindi: ${liste(silinen)}` : "branch silinmedi") +
          (kalan.length ? ` · silinmedi (artık tamamen merge edilmiş değil ya da kullanımda): ${liste(kalan)}` : "");
        return { ok: !kalan.length, text };
      }
    }
  }

  /** Checkout: değişiklikler kullanıcının seçimine göre stash'lenir; sonra sunucudaki son hâline fast-forward */
  private async runCheckout(p: Pending, s: Step, o: GitApplyOptions): Promise<string | Omit<GitResult, "repo">> {
    const d = s.repo.dir;
    const raw = s.dirty ? o.choices?.[s.repo.name] : undefined;
    const choice: DirtyChoice | undefined = s.dirty
      ? DIRTY_CHOICES.includes(raw as DirtyChoice)
        ? (raw as DirtyChoice)
        : "atla"
      : undefined;
    if (choice === "atla") return { ok: true, skipped: true, text: "atlandı — değişikliklere ve branch'e dokunulmadı" };
    if (s.same) return this.fastForward(d);
    const dirtyNow = (await this.dirtyList(d)).length > 0;
    // Plan temizdi ama onaya kadar değişiklik oluştu: seçim sorulmadığı için dokunulmaz
    if (dirtyNow && !s.dirty) throw new GitError("bu arada commit edilmemiş değişiklik oluştu — checkout yapılmadı");
    let stashed = false;
    if (dirtyNow) {
      const before = await git(d, ["rev-parse", "-q", "--verify", "refs/stash"]).catch(() => "");
      await git(d, ["stash", "push", "-u", "-m", `Kurmay: ${s.repo.branch} → ${s.branch} checkout öncesi`]);
      stashed = (await git(d, ["rev-parse", "-q", "--verify", "refs/stash"]).catch(() => "")) !== before;
    }
    try {
      if (s.fromRemote) await git(d, ["checkout", "-b", s.branch!, "--track", `${s.repo.remote}/${s.branch}`]);
      else await git(d, ["checkout", s.branch!]);
    } catch (e) {
      if (stashed) await git(d, ["stash", "pop"]).catch(() => {});
      throw new GitError(`checkout yapılamadı${stashed ? ", değişiklikler geri kondu" : ""}: ${errText(e)}`, {
        cause: e,
      });
    }
    const parts = [`${s.branch} branch'ine checkout yapıldı`];
    if (p.pull && !s.fromRemote) parts.push(await this.fastForward(d));
    if (stashed && choice === "gotur") {
      try {
        await git(d, ["stash", "pop"]);
        parts.push("değişiklikler yeni branch'e taşındı");
      } catch (e) {
        const files = await this.conflicts(d);
        throw new GitError(
          `${parts.join(" · ")} — ama değişiklikler uygulanırken çakışma çıktı${files.length ? ` (${liste(files, 5)})` : `: ${errText(e)}`}. Çakışan dosyaları düzelt; değişikliklerin bir kopyası stash'te duruyor.`,
          { cause: e },
        );
      }
    } else if (stashed) parts.push("değişiklikler stash'te bırakıldı (stash@{0})");
    return parts.join(" · ");
  }

  /** Bulunulan branch'i sunucudaki karşılığına hızlı ileri sarar (fetch önceden yapıldı; ağ gerekmez) */
  private async fastForward(d: string): Promise<string> {
    try {
      await git(d, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      return "sunucuda karşılığı yok, çekilecek bir şey yok";
    }
    const n = await this.count(d, "HEAD..@{u}");
    if (!n) return "sunucudaki hâliyle aynı";
    try {
      await git(d, ["merge", "--ff-only", "@{u}"]);
      return `${n} yeni commit çekildi`;
    } catch {
      return "sunucudaki hâlinden ayrışmış — fast-forward yapılmadı, local commit'ler olduğu gibi duruyor";
    }
  }

  private async conflicts(d: string): Promise<string[]> {
    return (await git(d, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
  }

  private async stashRef(d: string, hash: string): Promise<string | undefined> {
    const out = await git(d, ["stash", "list", "--format=%gd%x1f%H"]).catch(() => "");
    for (const l of out.split("\n")) {
      const [ref, h] = l.split("\x1f");
      if (h === hash) return ref;
    }
    return undefined;
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
