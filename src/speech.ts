import type { SpeechConfig } from "./types.js";

/**
 * Sesle görev yazma: panelde mikrofonla alınan kayıt model sunucusundaki (vLLM) ses tanıma
 * modeline (OpenAI uyumlu `/v1/audio/transcriptions`) gönderilir, çıkan metin görev kutusuna yazılır.
 * Adres ve anahtar genel bağlantıdan (Ayarlar → Bağlantı) gelir — ajanlarla aynı sunucu.
 * İstek tarayıcıdan değil sunucudan gider (anahtar tarayıcıya hiç gitmez). Ek bağımlılık yok.
 */

/** Kaydın en fazla boyutu: 16 kHz tek kanal WAV ≈ 32 KB/sn → 25 MB ≈ 13 dakika */
export const SPEECH_MAX_BYTES = 25 * 1024 * 1024;
/** Uzun kayıtta sunucunun yanıtı uzun sürebilir */
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

/** Genel bağlantı (Ayarlar → Bağlantı): ajanların da kullandığı sunucu adresi ve anahtarı */
export interface GeneralConnection {
  baseUrl?: string;
  apiKey?: string;
}
/** Genel bağlantı: ayar dosyası, yoksa ortam değişkeni (Kurmay'ı ortamla yönlendirenler için) */
export function generalConnection(g: GeneralConnection): { url: string; token?: string } {
  const url = (g.baseUrl || process.env.ANTHROPIC_BASE_URL || "").trim();
  const token = (g.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "").trim();
  return { url, ...(token ? { token } : {}) };
}
/** Eski kayıtlarda `enabled` yok — o zamanlar adres yazılıysa açıktı */
export const speechEnabled = (s: SpeechConfig | undefined) => !!s && (s.enabled ?? !!s.url);

/** Panel ve Ayarlar için durum — anahtarın kendisi yok */
export function speechView(s: SpeechConfig | undefined, g: GeneralConnection) {
  const conn = generalConnection(g);
  const enabled = speechEnabled(s);
  return {
    enabled,
    ready: enabled && !!conn.url,
    generalUrl: conn.url,
    model: s?.model ?? "",
    language: s?.language ?? "tr",
    commandModel: s?.commandModel ?? "",
    ttsModel: s?.ttsModel ?? "",
    ttsVoice: s?.ttsVoice ?? "",
    computer: !!s?.computer,
    terms: s?.terms ?? "",
    fixDictation: !!s?.fixDictation,
  };
}

/** "http://sunucu:8000/v1/" → "http://sunucu:8000" — kullanıcı /v1 ile de yazabilir */
export function speechBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export const authHeaders = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

/** Sunucunun hata metnini kısaltır (JSON ise içindeki mesajı alır) */
function serverText(body: string): string {
  let t = body.trim();
  try {
    const j = JSON.parse(t) as { message?: unknown; detail?: unknown; error?: { message?: unknown } | string };
    const m =
      typeof j.error === "object" && j.error?.message !== undefined
        ? j.error.message
        : (j.message ?? j.detail ?? j.error);
    if (typeof m === "string" && m.trim()) t = m.trim();
  } catch {
    /* düz metin */
  }
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

/** HTTP hatasını sade Türkçe açıklamaya çevirir; sunucunun kendi metni sona eklenir */
export function httpError(status: number, body: string): string {
  const raw = serverText(body);
  const tail = raw ? ` Sunucunun yanıtı: ${raw}` : "";
  if (status === 401 || status === 403)
    return `Sunucu isteği kabul etmedi (${status}): erişim anahtarı eksik ya da yanlış.${tail}`;
  if (status === 404) {
    return `Sunucuda ses tanıma bulunamadı (404). Adresi ve model adını kontrol et; sunucuda yüklü model bir ses tanıma modeli olmalı.${tail}`;
  }
  if (status === 413) return `Kayıt sunucu için çok büyük (413). Daha kısa kayıt dene.${tail}`;
  if (/audio|librosa|soundfile/i.test(raw)) {
    return `Sunucu sesi işleyemedi (${status}). Sunucuda ses desteği eksik olabilir (vllm[audio] paketi).${tail}`;
  }
  if (status === 503 || status === 502 || status === 504)
    return `Sunucu şu an meşgul ya da kapalı (${status}). Biraz sonra yeniden dene.${tail}`;
  return `Sunucu hata verdi (${status}).${tail}`;
}

/** Bağlantı/zaman aşımı hatası → Türkçe */
export function netError(e: unknown, base: string): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `Sunucu zamanında yanıt vermedi (${base}).`;
  const code = err?.cause?.code;
  if (code) return `Sunucuya bağlanılamadı (${code}): ${base}`;
  return `Sunucuya bağlanılamadı: ${base} (${err?.cause?.message ?? err?.message ?? String(e)})`;
}

/** Bağlantıyı dene: GET /v1/models → yüklü modeller */
export async function probeSpeech(
  url: string,
  token?: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const base = speechBase(url);
  if (!/^https?:\/\/\S+$/i.test(base)) return { ok: false, error: "Adres http:// ya da https:// ile başlamalı." };
  try {
    const r = await fetch(`${base}/v1/models`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await r.text();
    if (!r.ok) return { ok: false, error: httpError(r.status, body) };
    let models: string[] = [];
    try {
      const j = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
      models = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    } catch {
      /* liste okunamadı ama sunucu yanıt verdi */
    }
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/** Ses kaydını metne çevirir */
export async function transcribe(
  s: SpeechConfig & { url: string },
  token: string | undefined,
  audio: Buffer,
  mime: string,
  /** Uzun kayıt parça parça gönderilirken önceki parçanın metni — model cümleyi oradan sürdürür */
  previous?: string,
  /** Sözlük: Ayarlar'daki terimler + panelin verdiği depo/dal/dosya adları (yanlış duymayı azaltır) */
  terms?: string,
): Promise<{ ok: boolean; text?: string; error?: string; seconds?: number }> {
  const base = speechBase(s.url);
  const form = new FormData();
  const ext = /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /mp4|m4a/.test(mime) ? "m4a" : "wav";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/wav" }), `kayit.${ext}`);
  if (s.model) form.append("model", s.model);
  const lang = s.language ?? "tr";
  if (lang && lang !== "auto") form.append("language", lang); // "auto": dili model kendisi bulur
  // İpucu: sözlük (terimler) başta, önceki metin sonda — model ipucunun yalnızca son ~224 jetonunu
  // kullanır, en önemlisi (cümlenin devamı) sonda kalsın; toplam 600 karakterle sınırlı
  const prev = previous?.replace(/\s+/g, " ").trim().slice(-330) ?? "";
  const sozluk =
    terms
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 600 - prev.length - 2) ?? "";
  const prompt = [sozluk, prev].filter(Boolean).join(". ").slice(-600);
  if (prompt) form.append("prompt", prompt);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: authHeaders(token),
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    const body = await r.text();
    const seconds = (Date.now() - t0) / 1000;
    if (!r.ok) return { ok: false, error: httpError(r.status, body), seconds };
    let text = body;
    try {
      const j = JSON.parse(body) as { text?: unknown };
      if (typeof j.text === "string") text = j.text;
    } catch {
      /* düz metin yanıt */
    }
    return { ok: true, text: text.trim(), seconds };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/** Komut anlamada yanıt beklenmez gibi kısa olmalı — sesli kullanımda uzun bekleme işe yaramaz */
const UNDERSTAND_TIMEOUT_MS = 20_000;

/**
 * Sesli komut: sabit listede bulunamayan cümleyi modele verir, model cümleyi verilen komut
 * kalıplarından BİRİNE çevirir ("bugün bana ne iş var" → "bana atananları göster"), uymuyorsa "yok".
 * Model kendisi iş YAPMAZ: dönen cümle panelde yine sabit listeyle eşlenir, tutmazsa hiçbir şey olmaz;
 * geri alınamayan işler panelde yine sorulur. Küçük, hızlı model yeter (ör. Gemma 4B).
 * OpenAI uyumlu /v1/chat/completions; yanıt biçimi şemayla zorlanır (vLLM yapılandırılmış çıktı),
 * sunucu şemayı kabul etmezse şemasız bir kez daha denenir ve metindeki JSON okunur.
 */
export async function understandCommand(
  url: string,
  token: string | undefined,
  model: string,
  text: string,
  patterns: string[],
  userPrompt?: string,
): Promise<{ ok: boolean; command?: string; reply?: string; error?: string; seconds?: number }> {
  const base = speechBase(url);
  const sentence = text.replace(/\s+/g, " ").trim().slice(0, 500);
  const list = patterns
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 120);
  if (!sentence || !list.length) return { ok: false, error: "geçersiz istek" };
  const system =
    "Sen bir yazılım panelinin sesli komut çözücüsüsün. Kullanıcının Türkçe cümlesini aşağıdaki komut " +
    "kalıplarından tam olarak BİRİNE çevir. Kalıptaki <...> yerlerine cümledeki değeri yaz (sayıları rakamla). " +
    "Kalıbın kelimelerini değiştirme. Cümle hiçbir kalıba açıkça uymuyorsa, sohbet ya da başka bir konuşmaysa " +
    'komut olarak "yok" yaz. Yeni komut uydurma, tahmin yürütme.\n\n' +
    'Komut "yok" ise ve cümle sana söylenmiş bir selam, teşekkür, soru ya da sohbetse "cevap" alanına kısa, ' +
    "sıcak, sade Türkçe bir cevap yaz (en fazla iki kısa cümle; sesli okunacak, madde işareti ve emoji kullanma). " +
    "Ne yapabildiğini sorarsa kalıplardan bir iki örnek ver. Görevler, kod, pull request'ler ya da work item'lar " +
    "hakkında bilgi UYDURMA — bilmiyorsan ilgili komutu söylemesini öner. Cümle başka birine söylenmiş ya da " +
    'yarım bir konuşma gibiyse "cevap" boş kalsın. Komut bulduysan "cevap" boş kalsın.\n\nKomut kalıpları:\n' +
    list.map((p) => `- ${p}`).join("\n") +
    (userPrompt?.trim()
      ? `\n\nKullanıcının talimatları (cevabın üslubu için):\n${userPrompt.trim().slice(0, 1000)}`
      : "") +
    '\n\nYalnızca şu biçimde JSON yaz: {"komut": "...", "cevap": "..."}';
  const body = (schema: boolean) => ({
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: sentence },
    ],
    ...(schema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "komut",
              schema: {
                type: "object",
                properties: { komut: { type: "string" }, cevap: { type: "string" } },
                required: ["komut", "cevap"],
                additionalProperties: false,
              },
            },
          },
        }
      : {}),
  });
  const t0 = Date.now();
  const ask = async (schema: boolean) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body(schema)),
      signal: AbortSignal.timeout(UNDERSTAND_TIMEOUT_MS),
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  };
  try {
    let r = await ask(true);
    // Şemayı tanımayan sunucu: şemasız bir kez daha
    if (!r.ok && r.status === 400 && /response_format|json_schema|guided/i.test(r.text)) r = await ask(false);
    const seconds = (Date.now() - t0) / 1000;
    if (!r.ok) {
      const e = httpError(r.status, r.text);
      return {
        ok: false,
        error: r.status === 404 ? `Model ya da sohbet ucu bulunamadı (404): "${model}".` : e,
        seconds,
      };
    }
    let content = "";
    try {
      const j = JSON.parse(r.text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const c = j.choices?.[0]?.message?.content;
      if (typeof c === "string") content = c;
    } catch {
      /* aşağıda boş içerik */
    }
    // İçerik JSON değilse (şemasız yanıt) metindeki ilk {...} denenir
    let command = "";
    let reply = "";
    const m = /\{[\s\S]*\}/.exec(content);
    try {
      const j = JSON.parse(m ? m[0] : content) as { komut?: unknown; cevap?: unknown };
      if (typeof j.komut === "string") command = j.komut;
      if (typeof j.cevap === "string") reply = j.cevap.replace(/\s+/g, " ").trim().slice(0, 400);
    } catch {
      command = content;
    }
    command = command
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["“]|["”]$/g, "");
    if (!command && !reply) return { ok: false, error: "Model boş yanıt verdi.", seconds };
    const none = !command || /^yok\.?$/i.test(command);
    return { ok: true, command: none ? "" : command, reply: none ? reply : "", seconds };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/**
 * Görev yazdırırken ses tanımanın çıktısını modelle düzeltir (Ayarlar → "Görev metnini modelle düzelt"):
 * yanlış duyulmuş kelimeler (özellikle teknik terimler), noktalama, büyük harf. Anlam değişmesin diye
 * sıkı talimat + uzunluk denetimi; şüpheli sonuçta özgün metin döner (changed:false).
 */
export async function fixDictation(
  url: string,
  token: string | undefined,
  model: string,
  text: string,
  terms?: string,
): Promise<{ ok: boolean; text?: string; changed?: boolean; error?: string; seconds?: number }> {
  const base = speechBase(url);
  const src = text.trim().slice(0, 6000);
  if (!src) return { ok: false, error: "Düzeltilecek metin yok." };
  const system =
    "Sen ses tanıma çıktısını düzelten bir yardımcısın. Aşağıdaki metin bir yazılımcının Türkçe konuşmasından " +
    "otomatik olarak yazıya çevrildi; bir yazılım geliştirme görevi anlatıyor. Yalnızca şunları düzelt: yanlış " +
    "duyulmuş kelimeler (özellikle teknik terimler, sınıf, dosya, dal ve depo adları — aşağıdaki listeye bak), " +
    "noktalama, büyük-küçük harf, Türkçe yazım. Anlamı DEĞİŞTİRME, cümle ekleme ya da çıkarma, özetleme, " +
    "görevi yapma ya da cevaplama, İngilizce terimleri Türkçeye çevirme. Emin olmadığın yeri olduğu gibi bırak." +
    (terms?.trim() ? `\n\nBu projede geçen terimler: ${terms.trim().slice(0, 1500)}` : "") +
    '\n\nYalnızca şu biçimde JSON yaz: {"metin": "..."}';
  const body = (schema: boolean) => ({
    model,
    temperature: 0,
    max_tokens: Math.min(4000, Math.ceil(src.length / 2) + 200),
    messages: [
      { role: "system", content: system },
      { role: "user", content: src },
    ],
    ...(schema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "duzeltme",
              schema: {
                type: "object",
                properties: { metin: { type: "string" } },
                required: ["metin"],
                additionalProperties: false,
              },
            },
          },
        }
      : {}),
  });
  const t0 = Date.now();
  const ask = async (schema: boolean) => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body(schema)),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  };
  try {
    let r = await ask(true);
    if (!r.ok && r.status === 400 && /response_format|json_schema|guided/i.test(r.text)) r = await ask(false);
    const seconds = (Date.now() - t0) / 1000;
    if (!r.ok) return { ok: false, error: httpError(r.status, r.text), seconds };
    let content = "";
    try {
      const c = (JSON.parse(r.text) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
        ?.content;
      if (typeof c === "string") content = c;
    } catch {
      /* aşağıda */
    }
    let out = "";
    const m = /\{[\s\S]*\}/.exec(content);
    try {
      const j = JSON.parse(m ? m[0] : content) as { metin?: unknown };
      if (typeof j.metin === "string") out = j.metin.trim();
    } catch {
      out = "";
    }
    // Şüpheli sonuç (boş, çok kısa/uzun — model özetlemiş ya da cevap yazmış olabilir): özgünü koru
    const oran = out.length / src.length;
    if (!out || oran < 0.6 || oran > 1.5) return { ok: true, text: src, changed: false, seconds };
    return { ok: true, text: out, changed: out !== src, seconds };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}

/** Okunacak tek parçanın en fazla uzunluğu (panel metni ~220 karakterlik parçalara böler) */
export const SAY_MAX_CHARS = 1000;
const SAY_TIMEOUT_MS = 60_000;

/**
 * Sesli yanıt: metni sunucudaki metinden ses üreten modele okutur (OpenAI uyumlu /v1/audio/speech —
 * ör. vLLM'de çalışan bir ses modeli). Dönen ses panelde çalınır; alınamazsa panel tarayıcının sesine döner.
 */
export async function synthesize(
  url: string,
  token: string | undefined,
  model: string,
  voice: string | undefined,
  text: string,
): Promise<{ ok: true; audio: Buffer; mime: string; seconds: number } | { ok: false; error: string }> {
  const base = speechBase(url);
  const input = text.replace(/\s+/g, " ").trim().slice(0, SAY_MAX_CHARS);
  if (!input) return { ok: false, error: "okunacak metin yok" };
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ model, input, ...(voice ? { voice } : {}), response_format: "wav" }),
      signal: AbortSignal.timeout(SAY_TIMEOUT_MS),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      const body = buf.toString("utf8");
      if (r.status === 404)
        return { ok: false, error: `Sunucuda metinden ses üretme ucu ya da "${model}" modeli bulunamadı (404).` };
      return { ok: false, error: httpError(r.status, body) };
    }
    const mime = (r.headers.get("content-type") || "audio/wav").split(";")[0].trim();
    if (!/^audio\//i.test(mime) && !/octet-stream/i.test(mime)) {
      return { ok: false, error: `Sunucu ses yerine "${mime}" döndü: ${serverText(buf.toString("utf8"))}` };
    }
    if (!buf.length) return { ok: false, error: "Sunucu boş ses döndü." };
    return {
      ok: true,
      audio: buf,
      mime: /octet-stream/i.test(mime) ? "audio/wav" : mime,
      seconds: (Date.now() - t0) / 1000,
    };
  } catch (e) {
    return { ok: false, error: netError(e, base) };
  }
}
