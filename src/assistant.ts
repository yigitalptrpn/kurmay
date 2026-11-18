import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHeaders, httpError, netError, speechBase } from "./speech.js";

/**
 * Sesli asistan: sabit komut listesi yetmeyince cümle modele gider; model adım adım araç seçer
 * (panel komutu, klasörü Dosya Gezgini'nde açma, dosya okuma/yazma, silme, komut çalıştırma…).
 * Kontrol kodda: model yalnızca bir sonraki adımı JSON olarak söyler, aracı Kurmay çalıştırır.
 * Okuma ve düzenleme sormadan yapılır; silme, komut çalıştırma ve çalıştırılabilir dosya açma
 * önce kullanıcıya sorulur (panel onaylar). Bilgisayar araçları yalnızca panel aynı bilgisayardan
 * açıldıysa kullanılır (sunucu kontrol eder). Araç çağırma (tool call) yerine yapılandırılmış
 * JSON kullanılır — sunucuda araç ayrıştırıcısı açık olmasa da küçük modelle çalışsın.
 */

const STEP_TIMEOUT_MS = 30_000;
const MAX_STEPS = 8;
const RESULT_MAX = 4000;
const READ_MAX_BYTES = 200_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PENDING_TTL_MS = 3 * 60_000;
const HISTORY_MAX = 8;

const TOOLS = [
  "panel_komutu",
  "klasoru_ac",
  "ac",
  "listele",
  "oku",
  "yaz",
  "klasor_olustur",
  "tasi",
  "sil",
  "komut_calistir",
  "bitti",
] as const;
type Tool = (typeof TOOLS)[number];
/** Bilgisayara dokunan araçlar — panel başka bilgisayardan açıldıysa kapalı */
const COMPUTER_TOOLS = new Set<Tool>([
  "klasoru_ac",
  "ac",
  "listele",
  "oku",
  "yaz",
  "klasor_olustur",
  "tasi",
  "sil",
  "komut_calistir",
]);
/** Açılınca program çalıştırabilen dosyalar — açmadan önce sorulur */
const EXECUTABLE =
  /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msc|lnk|scr|cpl|reg|hta|jar|sh|command|app)$/i;

interface Step {
  dusunce: string;
  arac: Tool;
  yol: string;
  hedef: string;
  icerik: string;
  komut: string;
  cevap: string;
}
type Msg = { role: "system" | "user" | "assistant"; content: string };

export interface AssistantRequest {
  text: string;
  /** Önceki konuşma (panelden): kullanıcı cümleleri ve asistanın yaptıkları — "sil" gibi göndermeler için */
  history?: Array<{ rol: string; metin: string }>;
  /** "Bulunduğun dizin": panelde görünen oturumun hedef dizini */
  dir?: string;
  /** Panelin sabit komut kalıpları (panel_komutu için) */
  patterns: string[];
}
export type AssistantReply =
  | { ok: false; error: string; done: string[] }
  | { ok: true; kind: "komut"; command: string; done: string[] }
  | { ok: true; kind: "cevap"; reply: string; done: string[] }
  | { ok: true; kind: "onay"; id: string; question: string; done: string[] };

interface Pending {
  messages: Msg[];
  step: Step;
  dir: string;
  local: boolean;
  done: string[];
  steps: number;
  expires: number;
}

export interface AssistantConn {
  url: string;
  token?: string;
  model: string;
  userPrompt?: string;
}

const kisalt = (s: string, n = RESULT_MAX) =>
  s.length > n ? s.slice(0, n) + `\n… (${s.length - n} karakter daha)` : s;

export class Assistant {
  private pending = new Map<string, Pending>();

  /** Yeni cümle: model adım adım çalışır; soru gerekirse durur ve onay kimliği döner */
  async start(conn: AssistantConn, req: AssistantRequest, local: boolean): Promise<AssistantReply> {
    const dir = req.dir && fs.existsSync(req.dir) ? path.resolve(req.dir) : os.homedir();
    const messages: Msg[] = [{ role: "system", content: systemPrompt(dir, local, req.patterns, conn.userPrompt) }];
    for (const h of (req.history ?? []).slice(-HISTORY_MAX)) {
      const metin = String(h.metin ?? "").slice(0, 1500);
      if (metin) messages.push({ role: h.rol === "asistan" ? "assistant" : "user", content: metin });
    }
    messages.push({ role: "user", content: req.text.replace(/\s+/g, " ").trim().slice(0, 1000) });
    return this.loop(conn, { messages, dir, local, done: [], steps: 0 });
  }

  /** Kullanıcı soruya cevap verdi: evetse araç çalışır, değilse modele söylenir; döngü sürer */
  async answer(conn: AssistantConn, id: string, yes: boolean): Promise<AssistantReply> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: "Bu soru artık geçerli değil (süresi doldu). Yeniden söyle.", done: [] };
    this.pending.delete(id);
    if (yes) {
      const r = await runTool(p.step, p.dir);
      p.done.push(r.summary);
      p.messages.push({ role: "user", content: `Araç sonucu (${p.step.arac}):\n${kisalt(r.result)}` });
    } else {
      p.messages.push({
        role: "user",
        content: `Kullanıcı bu işi ONAYLAMADI (${p.step.arac}). Yapılmadı. Başka bir şey deneme; kısa bir cevapla bitir.`,
      });
    }
    return this.loop(conn, p);
  }

  private async loop(
    conn: AssistantConn,
    st: { messages: Msg[]; dir: string; local: boolean; done: string[]; steps: number },
  ): Promise<AssistantReply> {
    while (st.steps < MAX_STEPS) {
      st.steps++;
      const r = await askStep(conn, st.messages);
      if (!r.ok) return { ok: false, error: r.error, done: st.done };
      const step = r.step;
      st.messages.push({ role: "assistant", content: JSON.stringify(step) });
      if (step.arac === "bitti") return { ok: true, kind: "cevap", reply: step.cevap.trim(), done: st.done };
      if (step.arac === "panel_komutu") {
        const komut = step.komut.trim();
        if (!komut) return { ok: true, kind: "cevap", reply: step.cevap.trim(), done: st.done };
        return { ok: true, kind: "komut", command: komut, done: st.done };
      }
      if (COMPUTER_TOOLS.has(step.arac) && !st.local) {
        st.messages.push({
          role: "user",
          content:
            "Araç sonucu: bilgisayar araçları kapalı (panel başka bilgisayardan açılmış). Kullanıcıya kısaca söyle.",
        });
        continue;
      }
      const soru = needsConfirm(step, st.dir);
      if (soru) {
        this.sweep();
        const id = randomUUID();
        this.pending.set(id, { ...st, step, expires: Date.now() + PENDING_TTL_MS });
        return { ok: true, kind: "onay", id, question: soru, done: st.done };
      }
      const res = await runTool(step, st.dir);
      st.done.push(res.summary);
      st.messages.push({ role: "user", content: `Araç sonucu (${step.arac}):\n${kisalt(res.result)}` });
    }
    return { ok: true, kind: "cevap", reply: "Çok adım sürdü, burada durdum.", done: st.done };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id);
  }
}

function systemPrompt(dir: string, local: boolean, patterns: string[], userPrompt?: string): string {
  const plat = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return [
    "Sen Kurmay'ın sesli asistanısın. Kullanıcı sana Türkçe konuşur; isteğini yerine getirmek için adım adım araç kullanırsın.",
    `Bilgisayar: ${plat}. Bulunduğun dizin (kullanıcı "burası", "bulunduğun dizin", "bu klasör" derse bu): ${dir}`,
    `Kullanıcının ev klasörü: ${os.homedir()}. Bugün: ${new Date().toLocaleDateString("tr-TR")}.`,
    "",
    "HER yanıtında yalnızca BİR adım yaz, şu JSON biçiminde:",
    '{"dusunce": "...", "arac": "...", "yol": "", "hedef": "", "icerik": "", "komut": "", "cevap": ""}',
    "Kullanmadığın alanları boş bırak. Aracın sonucunu bir sonraki mesajda görürsün, sonra karar verirsin.",
    "",
    "Araçlar:",
    "- panel_komutu: isteğin Kurmay panelinin kendi komutuysa (aşağıdaki listeden) 'komut' alanına kalıbı aynen yaz (<...> yerlerini doldur). Bu son adımdır.",
    ...(local
      ? [
          "- klasoru_ac: 'yol'daki klasörü Dosya Gezgini'nde açar (dosya verilirse içinde bulunduğu klasörü açıp dosyayı seçer).",
          "- ac: 'yol'daki dosyayı ya da web adresini varsayılan programla açar.",
          "- listele: 'yol'daki klasörün içindekileri listeler.",
          "- oku: 'yol'daki metin dosyasını okur.",
          "- yaz: 'icerik'i 'yol'daki dosyaya yazar (yoksa oluşturur, varsa üzerine yazar).",
          "- klasor_olustur: 'yol'da klasör oluşturur.",
          "- tasi: 'yol'u 'hedef'e taşır ya da adını değiştirir.",
          "- sil: 'yol'daki dosyayı ya da klasörü siler.",
          `- komut_calistir: 'komut'u ${plat === "Windows" ? "cmd" : "kabuk"} ile bulunduğun dizinde çalıştırır; çıktısını görürsün.`,
        ]
      : [
          "(Bilgisayar araçları kapalı: panel başka bir bilgisayardan açılmış. Yalnızca panel_komutu ve bitti kullanılabilir.)",
        ]),
    "- bitti: iş bitti ya da yapılacak bir şey yok. 'cevap'a kullanıcıya söylenecek kısa sonucu yaz.",
    "",
    "Kurallar:",
    "- Göreli yollar bulunduğun dizine göredir. Yolları tam yaz.",
    "- Silme, komut çalıştırma ve program açma işlerini kullanıcıya SEN sorma; aracı seç, Kurmay kendisi sorar.",
    "- Kullanıcı önceki konuşmaya gönderme yapıyorsa ('onu sil', 'oraya git') önceki mesajlardaki yolu kullan.",
    "- Bilmediğin bir dosya yolunu tahmin etme: önce listele.",
    "- 'cevap' en fazla iki kısa cümle, sade Türkçe; sesli okunacak, madde işareti ve emoji kullanma.",
    "- Selam, teşekkür ya da sohbetse doğrudan bitti ile kısa cevap ver.",
    "- Cümle sana değil başka birine söylenmiş ya da yarım bir konuşma gibiyse bitti ile cevabı boş bırak.",
    "- Kod yazma, görev planlama gibi büyük işler senin işin değil: kullanıcıya 'görev …' diye söylemesini öner.",
    "",
    "Panel komut kalıpları:",
    ...patterns.slice(0, 120).map((p) => `- ${p}`),
    ...(userPrompt?.trim()
      ? ["", "Kullanıcının talimatları (cevabın üslubu için):", userPrompt.trim().slice(0, 1000)]
      : []),
  ].join("\n");
}

const STEP_SCHEMA = {
  type: "object",
  properties: {
    dusunce: { type: "string" },
    arac: { type: "string", enum: [...TOOLS] },
    yol: { type: "string" },
    hedef: { type: "string" },
    icerik: { type: "string" },
    komut: { type: "string" },
    cevap: { type: "string" },
  },
  required: ["dusunce", "arac", "yol", "hedef", "icerik", "komut", "cevap"],
  additionalProperties: false,
};

async function askStep(
  conn: AssistantConn,
  messages: Msg[],
): Promise<{ ok: true; step: Step } | { ok: false; error: string }> {
  const base = speechBase(conn.url);
  const body = (schema: boolean) => ({
    model: conn.model,
    temperature: 0,
    max_tokens: 1500,
    messages,
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "adim", schema: STEP_SCHEMA } } } : {}),
  });
  const ask = async (schema: boolean) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(conn.token) },
      body: JSON.stringify(body(schema)),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  };
  try {
    let r = await ask(true);
    if (!r.ok && r.status === 400 && /response_format|json_schema|guided/i.test(r.text)) r = await ask(false);
    if (!r.ok)
      return {
        ok: false,
        error:
          r.status === 404 ? `Model ya da sohbet ucu bulunamadı (404): "${conn.model}".` : httpError(r.status, r.text),
      };
    let content = "";
    try {
      const j = JSON.parse(r.text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const c = j.choices?.[0]?.message?.content;
      if (typeof c === "string") content = c;
    } catch {
      /* aşağıda */
    }
    const m = /\{[\s\S]*\}/.exec(content);
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(m ? m[0] : content) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "Modelin yanıtı okunamadı." };
    }
    const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
    const arac = s("arac") as Tool;
    if (!TOOLS.includes(arac)) return { ok: false, error: `Model bilinmeyen bir iş seçti: "${s("arac")}".` };
    return {
      ok: true,
      step: {
        dusunce: s("dusunce"),
        arac,
        yol: s("yol"),
        hedef: s("hedef"),
        icerik: s("icerik"),
        komut: s("komut"),
        cevap: s("cevap"),
      },
    };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/** "~/x", "x" (bulunduğun dizine göre), tırnaklı yol → tam yol */
function resolvePath(p: string, dir: string): string {
  let t = p.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!t) return dir;
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) t = path.join(os.homedir(), t.slice(1));
  return path.resolve(dir, t);
}

/** Sorulması gereken adım için soru metni; gerekmiyorsa "" */
function needsConfirm(step: Step, dir: string): string {
  if (step.arac === "sil") {
    const p = resolvePath(step.yol, dir);
    let ne: string;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) ne = `klasörü (içinde ${fs.readdirSync(p).length} öğe)`;
      else ne = "dosyası";
    } catch {
      return ""; // yok — araç "bulunamadı" der
    }
    const kutu = process.platform === "win32" ? " Geri Dönüşüm Kutusu'na gidecek." : " Geri alınamaz.";
    return `${p} ${ne} silinsin mi?${kutu}`;
  }
  if (step.arac === "komut_calistir") return `Şu komut çalıştırılsın mı? ${step.komut.trim()}`;
  if (step.arac === "ac" && !/^https?:\/\//i.test(step.yol.trim()) && EXECUTABLE.test(step.yol.trim()))
    return `${resolvePath(step.yol, dir)} programı açılsın mı?`;
  if (step.arac === "tasi") {
    const hedef = resolvePath(step.hedef, dir);
    if (fs.existsSync(hedef)) return `${hedef} zaten var. Üzerine taşınsın mı?`;
  }
  return "";
}

/** Aracı çalıştırır: modele giden sonuç + panelde görünen kısa özet */
async function runTool(step: Step, dir: string): Promise<{ result: string; summary: string }> {
  const p = resolvePath(step.yol, dir);
  const hata = (e: unknown) => {
    const err = e as NodeJS.ErrnoException;
    const neden =
      err.code === "ENOENT"
        ? "bulunamadı"
        : err.code === "EACCES" || err.code === "EPERM"
          ? "izin yok"
          : err.code === "EBUSY"
            ? "başka bir program kullanıyor"
            : err.message || String(e);
    return { result: `HATA: ${neden}`, summary: `⚠ ${aracAdi(step.arac)} olmadı (${p}): ${neden}` };
  };
  try {
    switch (step.arac) {
      case "klasoru_ac": {
        const st = fs.statSync(p);
        await openInFileManager(p, st.isFile());
        return { result: `Açıldı: ${p}`, summary: `📂 Klasör açıldı: ${p}` };
      }
      case "ac": {
        const hedef = /^https?:\/\//i.test(step.yol.trim()) ? step.yol.trim() : p;
        if (hedef === p) fs.statSync(p);
        await openDefault(hedef);
        return { result: `Açıldı: ${hedef}`, summary: `↗ Açıldı: ${hedef}` };
      }
      case "listele": {
        const ents = fs
          .readdirSync(p, { withFileTypes: true })
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "tr"));
        const lines = ents.slice(0, 200).map((e) => (e.isDirectory() ? e.name + "/" : e.name));
        return {
          result: `${p} içinde ${ents.length} öğe:\n${lines.join("\n")}${ents.length > 200 ? "\n…" : ""}`,
          summary: `📋 Listelendi: ${p} (${ents.length} öğe)`,
        };
      }
      case "oku": {
        const st = fs.statSync(p);
        if (st.isDirectory()) return { result: "HATA: bu bir klasör, listele kullan", summary: `⚠ ${p} bir klasör` };
        const buf = Buffer.alloc(Math.min(st.size, READ_MAX_BYTES));
        const fd = fs.openSync(p, "r");
        try {
          fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (buf.includes(0)) return { result: "HATA: metin dosyası değil", summary: `⚠ ${p} metin dosyası değil` };
        return { result: buf.toString("utf8"), summary: `📖 Okundu: ${p}` };
      }
      case "yaz": {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const vardi = fs.existsSync(p);
        fs.writeFileSync(p, step.icerik);
        return { result: `Yazıldı: ${p}`, summary: `✏️ ${vardi ? "Değiştirildi" : "Oluşturuldu"}: ${p}` };
      }
      case "klasor_olustur": {
        fs.mkdirSync(p, { recursive: true });
        return { result: `Oluşturuldu: ${p}`, summary: `📁 Klasör oluşturuldu: ${p}` };
      }
      case "tasi": {
        const h = resolvePath(step.hedef, dir);
        fs.mkdirSync(path.dirname(h), { recursive: true });
        fs.renameSync(p, h);
        return { result: `Taşındı: ${p} → ${h}`, summary: `↪ Taşındı: ${p} → ${h}` };
      }
      case "sil": {
        fs.statSync(p);
        await removePath(p);
        return {
          result: `Silindi: ${p}`,
          summary: `🗑 Silindi: ${p}${process.platform === "win32" ? " (Geri Dönüşüm Kutusu'nda)" : ""}`,
        };
      }
      case "komut_calistir": {
        const r = await runCommand(step.komut, dir);
        return {
          result: `Çıkış kodu ${r.code ?? "?"}${r.timedOut ? " (süre doldu, durduruldu)" : ""}\n${r.output}`,
          summary: `▶ Komut çalıştı (${r.code === 0 ? "başarılı" : `çıkış kodu ${r.code ?? "?"}`}): ${step.komut.trim()}`,
        };
      }
      default:
        return { result: "HATA: bilinmeyen araç", summary: "" };
    }
  } catch (e) {
    return hata(e);
  }
}

const aracAdi = (a: Tool) =>
  ({
    klasoru_ac: "Klasör açma",
    ac: "Açma",
    listele: "Listeleme",
    oku: "Okuma",
    yaz: "Yazma",
    klasor_olustur: "Klasör oluşturma",
    tasi: "Taşıma",
    sil: "Silme",
    komut_calistir: "Komut",
  })[a as string] ?? a;

/** Programı ayrık başlatır, hemen döner (pencere açılınca beklemez) */
function launch(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false, env: env ?? process.env });
    c.once("error", reject);
    c.once("spawn", () => {
      c.unref();
      resolve();
    });
  });
}

function openInFileManager(p: string, isFile: boolean): Promise<void> {
  if (process.platform === "win32") return launch("explorer.exe", isFile ? [`/select,${p}`] : [p]);
  if (process.platform === "darwin") return launch("open", isFile ? ["-R", p] : [p]);
  return launch("xdg-open", [isFile ? path.dirname(p) : p]);
}
function openDefault(target: string): Promise<void> {
  if (process.platform === "win32") return launch("explorer.exe", [target]);
  if (process.platform === "darwin") return launch("open", [target]);
  return launch("xdg-open", [target]);
}

/** Windows'ta Geri Dönüşüm Kutusu'na (yol ortam değişkeniyle — komut satırında tırnak sorunu olmasın) */
async function removePath(p: string): Promise<void> {
  if (process.platform !== "win32") {
    fs.rmSync(p, { recursive: true, force: false });
    return;
  }
  const isDir = fs.statSync(p).isDirectory();
  const ps =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? "DeleteDirectory" : "DeleteFile"}($env:KURMAY_SIL, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], path.dirname(p), {
    ...process.env,
    KURMAY_SIL: p,
  });
  if (r.code !== 0 || fs.existsSync(p)) throw new Error(r.output.trim() || "silinemedi");
}

function runCommand(command: string, cwd: string) {
  return process.platform === "win32"
    ? // UTF-8 kod sayfası: Türkçe çıktı bozulmasın; /s + dış tırnak = komut olduğu gibi
      runProcess("cmd.exe", ["/d", "/s", "/c", `"chcp 65001>nul & ${command}"`], cwd, process.env, true)
    : runProcess("/bin/sh", ["-c", command], cwd, process.env);
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  verbatim = false,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const c = spawn(cmd, args, { cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim });
    const add = (d: Buffer) => {
      if (out.length < RESULT_MAX * 4) out += d.toString("utf8");
    };
    c.stdout?.on("data", add);
    c.stderr?.on("data", add);
    const t = setTimeout(() => {
      timedOut = true;
      c.kill();
    }, COMMAND_TIMEOUT_MS);
    c.once("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, output: e.message, timedOut });
    });
    c.once("close", (code) => {
      clearTimeout(t);
      resolve({ code, output: kisalt(out.trim()), timedOut });
    });
  });
}
