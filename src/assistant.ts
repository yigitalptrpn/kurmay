import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASSISTANT_DEFAULTS, type AssistantLimits } from "./assistantLimits.js";
import type { McpToolInfo } from "./mcpStatus.js";
import type { AssistantPerm } from "./types.js";
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
const RESULT_MAX = 4000;
const READ_MAX_BYTES = 200_000;
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
  "eklenti_araci",
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
/** İzin grupları (Ayarlar → Asistan): okuma, yazma, silme, komut */
type PermKey = "read" | "write" | "delete" | "run";
type Perms = AssistantLimits["computer"];
const NO_PERMS: Perms = { read: false, write: false, delete: false, run: false };
function permOf(step: Step): PermKey | null {
  switch (step.arac) {
    case "klasoru_ac":
    case "listele":
    case "oku":
      return "read";
    case "ac":
      return !/^https?:\/\//i.test(step.yol.trim()) && EXECUTABLE.test(step.yol.trim()) ? "run" : "read";
    case "yaz":
    case "klasor_olustur":
    case "tasi":
      return "write";
    case "sil":
      return "delete";
    case "komut_calistir":
      return "run";
    default:
      return null;
  }
}
const PERM_ADI: Record<PermKey, string> = {
  read: "dosya okuma",
  write: "dosya yazma",
  delete: "silme",
  run: "komut çalıştırma",
};
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
  /** eklenti_araci: eklentinin adı, aracın adı, parametreler (JSON nesnesi metni) */
  eklenti: string;
  metot: string;
  girdi: string;
  cevap: string;
}
/** Asistan ekranında gösterilecek sonuç (eklenti çıktısı, dosya içeriği, komut çıktısı…) */
export interface AssistantOutput {
  title: string;
  text: string;
  error?: boolean;
}
/** Eklentilere köprü (index.ts kurar): bağlı eklentilerin araçları ve çağırma */
export interface McpBridge {
  tools(): Promise<Array<{ server: string; tool: McpToolInfo }>>;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
}
type McpList = Array<{ server: string; tool: McpToolInfo }>;
const OUTPUT_MAX = 20_000;
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
type ReplyBase = { done: string[]; outputs?: AssistantOutput[] };
export type AssistantReply =
  | ({ ok: false; error: string } & ReplyBase)
  | ({ ok: true; kind: "komut"; command: string } & ReplyBase)
  | ({ ok: true; kind: "cevap"; reply: string } & ReplyBase)
  | ({ ok: true; kind: "onay"; id: string; question: string } & ReplyBase);

interface LoopState {
  messages: Msg[];
  dir: string;
  local: boolean;
  done: string[];
  outputs: AssistantOutput[];
  mcp: McpList;
  steps: number;
  /** Bilgisayar izinleri (panel başka bilgisayardan açıldıysa hepsi kapalı) */
  perms: Perms;
}
interface Pending extends LoopState {
  step: Step;
  expires: number;
}

export interface AssistantConn {
  url: string;
  token?: string;
  model: string;
  userPrompt?: string;
  /** Bağlı eklentiler (yalnızca panel aynı bilgisayardan açıldıysa) */
  mcp?: McpBridge;
  /** Ayarlar → Asistan: izinler, ne zaman sorulur, adım ve süre sınırları */
  limits?: AssistantLimits;
}

const kisalt = (s: string, n = RESULT_MAX) =>
  s.length > n ? s.slice(0, n) + `\n… (${s.length - n} karakter daha)` : s;

export class Assistant {
  private pending = new Map<string, Pending>();

  /** Yeni cümle: model adım adım çalışır; soru gerekirse durur ve onay kimliği döner */
  async start(conn: AssistantConn, req: AssistantRequest, local: boolean): Promise<AssistantReply> {
    const dir = req.dir && fs.existsSync(req.dir) ? path.resolve(req.dir) : os.homedir();
    let mcp: McpList = [];
    if (conn.mcp) mcp = await conn.mcp.tools().catch(() => []);
    const perms = local && conn.limits ? conn.limits.computer : NO_PERMS;
    const messages: Msg[] = [{ role: "system", content: systemPrompt(dir, perms, req.patterns, conn.userPrompt, mcp) }];
    for (const h of (req.history ?? []).slice(-HISTORY_MAX)) {
      const metin = String(h.metin ?? "").slice(0, 1500);
      if (metin) messages.push({ role: h.rol === "asistan" ? "assistant" : "user", content: metin });
    }
    messages.push({ role: "user", content: req.text.replace(/\s+/g, " ").trim().slice(0, 1000) });
    return this.loop(conn, { messages, dir, local, done: [], outputs: [], mcp, steps: 0, perms });
  }

  /** Kullanıcı soruya cevap verdi: evetse araç çalışır, değilse modele söylenir; döngü sürer */
  async answer(conn: AssistantConn, id: string, yes: boolean): Promise<AssistantReply> {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: "Bu soru artık geçerli değil (süresi doldu). Yeniden söyle.", done: [] };
    this.pending.delete(id);
    if (yes) {
      await runStep(conn, p.step, p);
    } else {
      p.messages.push({
        role: "user",
        content: `Kullanıcı bu işi ONAYLAMADI (${p.step.arac}). Yapılmadı. Başka bir şey deneme; kısa bir cevapla bitir.`,
      });
    }
    return this.loop(conn, p);
  }

  private async loop(conn: AssistantConn, st: LoopState): Promise<AssistantReply> {
    const base = () => ({ done: st.done, outputs: st.outputs });
    const maxSteps = conn.limits?.maxSteps ?? ASSISTANT_DEFAULTS.maxSteps;
    while (st.steps < maxSteps) {
      st.steps++;
      const r = await askStep(conn, st.messages);
      if (!r.ok) return { ok: false, error: r.error, ...base() };
      const step = r.step;
      st.messages.push({ role: "assistant", content: JSON.stringify(step) });
      if (step.arac === "bitti") return { ok: true, kind: "cevap", reply: step.cevap.trim(), ...base() };
      if (step.arac === "panel_komutu") {
        const komut = step.komut.trim();
        if (!komut) return { ok: true, kind: "cevap", reply: step.cevap.trim(), ...base() };
        return { ok: true, kind: "komut", command: komut, ...base() };
      }
      if (step.arac === "eklenti_araci" && !conn.mcp) {
        st.messages.push({
          role: "user",
          content:
            "Araç sonucu: eklentiler kapalı (bağlı eklenti yok ya da panel başka bilgisayardan açılmış). Kullanıcıya kısaca söyle.",
        });
        continue;
      }
      if (COMPUTER_TOOLS.has(step.arac) && !st.local) {
        st.messages.push({
          role: "user",
          content:
            "Araç sonucu: bilgisayar araçları kapalı (panel başka bilgisayardan açılmış). Kullanıcıya kısaca söyle.",
        });
        continue;
      }
      const pk = permOf(step);
      const izin: AssistantPerm = pk ? st.perms[pk] : true;
      if (!izin) {
        st.done.push(`⛔ İzin yok: ${PERM_ADI[pk!]} (Ayarlar → Asistan)`);
        st.messages.push({
          role: "user",
          content: `Araç sonucu: ${PERM_ADI[pk!]} izni kapalı (Ayarlar → Asistan). Yapılmadı. Kullanıcıya kısaca söyle; başka yoldan deneme.`,
        });
        continue;
      }
      const confirm = conn.limits?.confirm ?? "degisiklik";
      const soru =
        step.arac === "eklenti_araci"
          ? mcpConfirm(step, st.mcp, confirm)
          : needsConfirm(step, st.dir) || (izin === "ask" || confirm === "hep" ? genericConfirm(step, st.dir) : "");
      if (soru) {
        this.sweep();
        const id = randomUUID();
        this.pending.set(id, { ...st, step, expires: Date.now() + PENDING_TTL_MS });
        return { ok: true, kind: "onay", id, question: soru, ...base() };
      }
      await runStep(conn, step, st);
    }
    return { ok: true, kind: "cevap", reply: "Çok adım sürdü, burada durdum.", ...base() };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id);
  }
}

/** Adımı çalıştırır: sonucu modele, özeti ve (varsa) çıktıyı ekrana */
async function runStep(conn: AssistantConn, step: Step, st: LoopState): Promise<void> {
  if (step.arac === "eklenti_araci") {
    const r = await runMcp(conn, step, st.mcp);
    st.done.push(r.summary);
    if (r.output) st.outputs.push(r.output);
    st.messages.push({ role: "user", content: `Araç sonucu (${step.eklenti} / ${step.metot}):\n${kisalt(r.result)}` });
    return;
  }
  const r = await runTool(step, st.dir, conn.limits?.commandMs ?? ASSISTANT_DEFAULTS.commandMs);
  st.done.push(r.summary);
  if (r.output) st.outputs.push(r.output);
  st.messages.push({ role: "user", content: `Araç sonucu (${step.arac}):\n${kisalt(r.result)}` });
}

const findMcp = (step: Step, mcp: McpList) =>
  mcp.find((m) => m.server === step.eklenti.trim() && m.tool.name === step.metot.trim());

/** Değişiklik yapabilen (salt okunur işaretli olmayan) eklenti araçları önce sorulur */
function mcpConfirm(step: Step, mcp: McpList, mode: AssistantLimits["confirm"] = "degisiklik"): string {
  const m = findMcp(step, mcp);
  if (!m || mode === "hic" || (m.tool.readOnly && mode !== "hep")) return "";
  const girdi = step.girdi.trim() && step.girdi.trim() !== "{}" ? ` Girdi: ${step.girdi.trim().slice(0, 300)}` : "";
  return `${m.server} eklentisinin “${m.tool.name}” aracı çalıştırılsın mı?${m.tool.destructive ? " Bu araç silme ya da geri alınamaz değişiklik yapabilir." : ""}${girdi}`;
}

async function runMcp(
  conn: AssistantConn,
  step: Step,
  mcp: McpList,
): Promise<{ result: string; summary: string; output?: AssistantOutput }> {
  const ad = `${step.eklenti.trim()} · ${step.metot.trim()}`;
  if (!conn.mcp) return { result: "HATA: eklentiler kapalı", summary: "⚠ Eklentiler kapalı" };
  if (!findMcp(step, mcp))
    return {
      result: `HATA: "${step.eklenti}" eklentisinde "${step.metot}" adında araç yok. Listedeki adları aynen kullan.`,
      summary: `⚠ Eklenti aracı bulunamadı: ${ad}`,
    };
  let args: Record<string, unknown> = {};
  const g = step.girdi.trim();
  if (g) {
    try {
      const v = JSON.parse(g) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("nesne değil");
      args = v as Record<string, unknown>;
    } catch {
      return {
        result: 'HATA: "girdi" geçerli bir JSON nesnesi değil. Örnek: {"ad": "değer"}',
        summary: `⚠ ${ad}: girdi okunamadı`,
      };
    }
  }
  const r = await conn.mcp.call(step.eklenti.trim(), step.metot.trim(), args);
  return {
    result: r.ok ? r.text : `HATA: ${r.text}`,
    summary: r.ok ? `🔌 ${ad}` : `⚠ ${ad} olmadı: ${r.text.slice(0, 200)}`,
    output: { title: ad, text: kisalt(r.text, OUTPUT_MAX), ...(r.ok ? {} : { error: true }) },
  };
}

/** Eklenti araçlarının modele giden listesi: ad, parametreler (* zorunlu), açıklama — uzunsa kısaltılır */
function mcpLines(mcp: McpList): string[] {
  const out: string[] = [];
  let len = 0;
  for (const { server, tool } of mcp) {
    const params = (tool.params ?? [])
      .map((p) => `${p.name}${p.required ? "*" : ""}${p.type ? ": " + p.type : ""}`)
      .join(", ");
    const desc = (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const line = `- ${server} / ${tool.name}(${params})${tool.readOnly ? " [salt okunur]" : ""}${desc ? ": " + desc : ""}`;
    if (len + line.length > 9000) {
      out.push(`- … (${mcp.length - out.length} araç daha, listede yer kalmadı)`);
      break;
    }
    out.push(line);
    len += line.length;
  }
  return out;
}

function systemPrompt(dir: string, perms: Perms, patterns: string[], userPrompt?: string, mcp: McpList = []): string {
  const plat = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return [
    "Sen Kurmay'ın sesli asistanısın. Kullanıcı sana Türkçe konuşur; isteğini yerine getirmek için adım adım araç kullanırsın.",
    `Bilgisayar: ${plat}. Bulunduğun dizin (kullanıcı "burası", "bulunduğun dizin", "bu klasör" derse bu): ${dir}`,
    `Kullanıcının ev klasörü: ${os.homedir()}. Bugün: ${new Date().toLocaleDateString("tr-TR")}.`,
    "",
    "HER yanıtında yalnızca BİR adım yaz, şu JSON biçiminde:",
    '{"dusunce": "...", "arac": "...", "yol": "", "hedef": "", "icerik": "", "komut": "", "eklenti": "", "metot": "", "girdi": "", "cevap": ""}',
    "Kullanmadığın alanları boş bırak. Aracın sonucunu bir sonraki mesajda görürsün, sonra karar verirsin.",
    "",
    "Araçlar:",
    "- panel_komutu: isteğin Kurmay panelinin kendi komutuysa (aşağıdaki listeden) 'komut' alanına kalıbı aynen yaz (<...> yerlerini doldur). Bu son adımdır.",
    ...(perms.read
      ? [
          "- klasoru_ac: 'yol'daki klasörü Dosya Gezgini'nde açar (dosya verilirse içinde bulunduğu klasörü açıp dosyayı seçer).",
          "- ac: 'yol'daki dosyayı ya da web adresini varsayılan programla açar.",
          "- listele: 'yol'daki klasörün içindekileri listeler.",
          "- oku: 'yol'daki metin dosyasını okur.",
        ]
      : []),
    ...(perms.write
      ? [
          "- yaz: 'icerik'i 'yol'daki dosyaya yazar (yoksa oluşturur, varsa üzerine yazar).",
          "- klasor_olustur: 'yol'da klasör oluşturur.",
          "- tasi: 'yol'u 'hedef'e taşır ya da adını değiştirir.",
        ]
      : []),
    ...(perms.delete ? ["- sil: 'yol'daki dosyayı ya da klasörü siler."] : []),
    ...(perms.run
      ? [
          `- komut_calistir: 'komut'u ${plat === "Windows" ? "cmd" : "kabuk"} ile bulunduğun dizinde çalıştırır; çıktısını görürsün.`,
        ]
      : []),
    ...(!perms.read && !perms.write && !perms.delete && !perms.run
      ? ["(Bilgisayar araçları kapalı. Yalnızca panel_komutu, eklenti araçları ve bitti kullanılabilir.)"]
      : []),
    ...(mcp.length
      ? [
          "- eklenti_araci: bağlı bir eklentinin aracını çağırır. 'eklenti'ye eklenti adını, 'metot'a aracın adını (aşağıdaki listeden aynen), 'girdi'ye parametreleri JSON nesnesi olarak yaz (parametre yoksa {}). Sonucu bir sonraki mesajda görürsün; sonuç kullanıcıya asistan ekranında da gösterilir.",
        ]
      : []),
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
    ...(mcp.length
      ? [
          "- Panel komutlarında olmayan bir bilgi ya da iş istenirse (ör. 'Ahmet'e atanmış işleri getir') uygun eklenti aracını kullan.",
          "- Eklenti sonucunu 'cevap'ta kısaca özetle (kaç kayıt, en önemlisi ne); ayrıntıyı tekrar etme, ekranda görünüyor.",
          "- Bir aracın hangi parametreyi istediğini bilmiyorsan listedeki parametre adlarını kullan; değer uydurma, kullanıcının söylediğini yaz.",
        ]
      : []),
    "",
    "Panel komut kalıpları:",
    ...patterns.slice(0, 120).map((p) => `- ${p}`),
    ...(mcp.length
      ? ["", "Eklenti araçları (eklenti / araç(parametreler, * zorunlu): açıklama):", ...mcpLines(mcp)]
      : []),
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
    eklenti: { type: "string" },
    metot: { type: "string" },
    girdi: { type: "string" },
    cevap: { type: "string" },
  },
  required: ["dusunce", "arac", "yol", "hedef", "icerik", "komut", "eklenti", "metot", "girdi", "cevap"],
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
        eklenti: s("eklenti"),
        metot: s("metot"),
        // Model girdiyi metin yerine nesne olarak da yazabilir
        girdi: typeof raw.girdi === "object" && raw.girdi ? JSON.stringify(raw.girdi) : s("girdi"),
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

/** İzin "sor" ya da "her işte sor" seçiliyse okuma/yazma işleri için soru */
function genericConfirm(step: Step, dir: string): string {
  const p = resolvePath(step.yol, dir);
  switch (step.arac) {
    case "klasoru_ac":
      return `${p} Dosya Gezgini'nde açılsın mı?`;
    case "ac":
      return `${/^https?:\/\//i.test(step.yol.trim()) ? step.yol.trim() : p} açılsın mı?`;
    case "listele":
      return `${p} klasörünün içi listelensin mi?`;
    case "oku":
      return `${p} dosyası okunsun mu?`;
    case "yaz":
      return `${p} dosyasına yazılsın mı?${fs.existsSync(p) ? " Dosya var, üzerine yazılacak." : ""}`;
    case "klasor_olustur":
      return `${p} klasörü oluşturulsun mu?`;
    case "tasi":
      return `${p} → ${resolvePath(step.hedef, dir)} taşınsın mı?`;
    default:
      return "";
  }
}

/** Aracı çalıştırır: modele giden sonuç + panelde görünen kısa özet */
async function runTool(
  step: Step,
  dir: string,
  commandMs: number,
): Promise<{ result: string; summary: string; output?: AssistantOutput }> {
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
        const text = `${p} içinde ${ents.length} öğe:\n${lines.join("\n")}${ents.length > 200 ? "\n…" : ""}`;
        return { result: text, summary: `📋 Listelendi: ${p} (${ents.length} öğe)`, output: { title: p, text } };
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
        const metin = buf.toString("utf8");
        return { result: metin, summary: `📖 Okundu: ${p}`, output: { title: p, text: kisalt(metin, OUTPUT_MAX) } };
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
        const r = await runCommand(step.komut, dir, commandMs);
        return {
          output: {
            title: step.komut.trim(),
            text: r.output || "(çıktı yok)",
            ...(r.code === 0 ? {} : { error: true }),
          },
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

function runCommand(command: string, cwd: string, timeoutMs: number) {
  return process.platform === "win32"
    ? // UTF-8 kod sayfası: Türkçe çıktı bozulmasın; /s + dış tırnak = komut olduğu gibi
      runProcess("cmd.exe", ["/d", "/s", "/c", `"chcp 65001>nul & ${command}"`], cwd, process.env, true, timeoutMs)
    : runProcess("/bin/sh", ["-c", command], cwd, process.env, false, timeoutMs);
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  verbatim = false,
  timeoutMs = ASSISTANT_DEFAULTS.commandMs,
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
    }, timeoutMs);
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
