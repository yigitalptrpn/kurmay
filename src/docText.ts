import zlib from "node:zlib";

/**
 * Belge eklerinin metni (bağımlılıksız, en iyi çaba): PDF ve Word (.docx).
 *
 * Neden: Claude Code'un Read aracı PDF'i modele Anthropic'e özgü `document` bloğu
 * olarak gönderiyor (sahte API ile görüldü) — vLLM gibi sunucular bunu tanımaz,
 * istek reddedilir; .docx ise ikili (zip) dosya, Read okuyamaz. Ek kaydedilirken
 * metni çıkarılıp yanına `.txt` yazılır, ajan onu okur.
 *
 * Sınırlar: taranmış (görüntü) PDF'te metin yoktur; şifreli PDF, gömülü yazı tipinin
 * ToUnicode tablosu olmayan PDF'te harfler bozuk çıkabilir. Çıkan metin çok kısaysa
 * undefined döner — ajan o zaman yalnızca asıl dosyayı görür.
 */
export function extractText(name: string, data: Buffer): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  try {
    const text = ext === "pdf" ? pdfText(data) : ext === "docx" ? docxText(data) : undefined;
    return text && text.replace(/\s/g, "").length >= 20 ? text : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────── PDF ─────────────────────────

interface PdfObj {
  dict: string;
  stream?: Buffer;
}

/** Sıkıştırılmış akışı açar; bozuk/eksik veride elde edilebilen kadarını */
function inflate(buf: Buffer): Buffer {
  try {
    return zlib.inflateSync(buf);
  } catch {
    return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
}

function decodeStream(dict: string, raw: Buffer): Buffer | undefined {
  if (/\/Filter\s*(?:\[\s*)?\/FlateDecode/.test(dict)) {
    if (/\/Filter\s*\[\s*\/FlateDecode\s*\/\w/.test(dict)) return undefined; // zincirli süzgeç — desteklenmiyor
    return inflate(raw);
  }
  return /\/Filter/.test(dict) ? undefined : raw;
}

/** Tüm nesneleri (nesne akışlarının içindekiler dahil) okur */
function pdfObjects(buf: Buffer): Map<number, PdfObj> {
  const s = buf.toString("latin1");
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) break;
    let body = s.slice(start, end);
    let stream: Buffer | undefined;
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dataStart = start + si + (body.slice(si).startsWith("stream\r\n") ? 8 : 7);
      const es = s.lastIndexOf("endstream", end);
      const dict = body.slice(0, si);
      const len = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
      const dataEnd = len ? dataStart + Number(len[1]) : es;
      stream = decodeStream(dict, buf.subarray(dataStart, Math.min(dataEnd, es)));
      body = dict;
    }
    objs.set(Number(m[1]), { dict: body, ...(stream ? { stream } : {}) });
    re.lastIndex = end;
  }
  // Nesne akışları (PDF 1.5+: Word/LibreOffice çıktıları yazı tiplerini burada tutar)
  for (const o of [...objs.values()]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const text = o.stream.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[i * 2];
      const off = first + head[i * 2 + 1];
      const next = i + 1 < n ? first + head[i * 2 + 3] : text.length;
      if (!objs.has(num)) objs.set(num, { dict: text.slice(off, next) });
    }
  }
  return objs;
}

const refNum = (s: string | undefined): number | undefined => {
  const m = s ? /^\s*(\d+)\s+\d+\s+R/.exec(s) : null;
  return m ? Number(m[1]) : undefined;
};

/** Sözlükte anahtarın değeri: dolaysız `<<…>>`/`[…]` ya da başvuru `n 0 R` (çözülür) */
function dictValue(objs: Map<number, PdfObj>, dict: string, key: string): string | undefined {
  const i = dict.search(new RegExp(`/${key}(?![\\w])`));
  if (i < 0) return undefined;
  let rest = dict.slice(i + key.length + 1).trimStart();
  const ref = refNum(rest);
  if (ref !== undefined) return objs.get(ref)?.dict;
  const open = rest.startsWith("<<") ? "<<" : rest.startsWith("[") ? "[" : "";
  if (!open) return rest.split(/[\s/>\]]/)[0];
  const close = open === "<<" ? ">>" : "]";
  let depth = 0;
  for (let j = 0; j < rest.length; j++) {
    if (rest.startsWith(open, j)) depth++, (j += open.length - 1);
    else if (rest.startsWith(close, j) && --depth === 0) return rest.slice(0, j + close.length);
  }
  return rest;
}

interface FontMap {
  bytes: number;
  map: Map<number, string>;
}

/** ToUnicode CMap: kod → Unicode */
function parseCMap(text: string): FontMap {
  const map = new Map<number, string>();
  const hexStr = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = cs[1].length / 2;
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hexStr(m[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[4]) {
        const base = hexStr(m[4]);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + c - lo));
      } else {
        const items = [...(m[5] ?? "").matchAll(/<([0-9a-fA-F]+)>/g)];
        items.forEach((it, k) => map.set(lo + k, hexStr(it[1])));
      }
    }
  }
  return { bytes, map };
}

/** WinAnsi'de latin1'den farklı olan 0x80–0x9F aralığı (tırnak, tire…) */
const WIN_ANSI: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x84: "„", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™",
};

function decodeBytes(bytes: number[], font: FontMap | undefined): string {
  if (font && font.map.size) {
    let out = "";
    for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
      let code = 0;
      for (let k = 0; k < font.bytes; k++) code = (code << 8) | bytes[i + k];
      out += font.map.get(code) ?? "";
    }
    return out;
  }
  return bytes.map((b) => WIN_ANSI[b] ?? String.fromCharCode(b)).join("");
}

/** İçerik akışındaki metin işleçlerini okur */
function contentText(src: string, fonts: Map<string, FontMap>): string {
  let out = "";
  let font: FontMap | undefined;
  let fontSize = 12;
  // Konum: üreticiler metni farklı yerleştiriyor (LibreOffice her parçayı ayrı BT…Td ile
  // mutlak, Chromium Tm + göreli Td). Satır = y değişimi; aynı satırda tahmini metin
  // sonunun ötesine sıçrama = boşluk (çok uzaksa tablo hücresi → sekme)
  let x = 0;
  let y = 0;
  let lineY: number | undefined; // en son yazılan metnin satırı
  let segX = 0; // son konumlanan parçanın başı
  let segChars = 0;
  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    if (lineY === undefined) return;
    if (Math.abs(y - lineY) > 0.5) nl();
    else {
      const gap = x - (segX + segChars * fontSize * 0.5);
      if (gap > fontSize && out && !/\s$/.test(out)) out += gap > 3 * fontSize ? "\t" : " ";
    }
  };
  const show = (t: string) => {
    if (!t) return;
    if (lineY === undefined || Math.abs(y - lineY) > 0.5 || x !== segX) {
      segX = x;
      segChars = 0;
    }
    lineY = y;
    out += t;
    segChars += t.length;
  };
  const stack: Array<string | number | number[] | Array<number[] | number>> = [];
  let i = 0;
  const readString = (): number[] => {
    const bytes: number[] = [];
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "\\") {
        const n = src[++i];
        const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (n in esc) bytes.push(esc[n]);
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(src[i + 1])) oct += src[++i];
          bytes.push(parseInt(oct, 8) & 255);
        } else if (n === "\r" || n === "\n") {
          if (n === "\r" && src[i + 1] === "\n") i++;
        } else bytes.push(n.charCodeAt(0));
      } else if (c === "(") depth++, bytes.push(40);
      else if (c === ")") {
        if (--depth > 0) bytes.push(41);
      } else bytes.push(c.charCodeAt(0));
      i++;
    }
    return bytes;
  };
  const readHex = (): number[] => {
    const end = src.indexOf(">", i);
    let h = src.slice(i + 1, end).replace(/\s/g, "");
    if (h.length % 2) h += "0";
    i = end + 1;
    const bytes: number[] = [];
    for (let k = 0; k < h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
    return bytes;
  };
  const nl = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === "%") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "(") stack.push(readString());
    else if (c === "<" && src[i + 1] !== "<") stack.push(readHex());
    else if (c === "[") {
      i++;
      const arr: Array<number[] | number> = [];
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "(") arr.push(readString());
        else if (src[i] === "<") arr.push(readHex());
        else if (/[-\d.]/.test(src[i])) {
          const m = /^-?\d*\.?\d+/.exec(src.slice(i, i + 32));
          if (m) arr.push(Number(m[0])), (i += m[0].length);
          else i++;
        } else i++;
      }
      i++;
      stack.push(arr);
    } else if (c === "/") {
      const m = /^\/[^\s/<>[\]()]+/.exec(src.slice(i, i + 128));
      stack.push(m ? m[0] : "/");
      i += m ? m[0].length : 1;
    } else if (/[-\d.]/.test(c)) {
      const m = /^-?\d*\.?\d+/.exec(src.slice(i, i + 32));
      if (m) stack.push(Number(m[0])), (i += m[0].length);
      else i++;
    } else if (src.startsWith("<<", i) || src.startsWith(">>", i)) i += 2;
    else {
      const m = /^[A-Za-z'"*]+/.exec(src.slice(i, i + 8));
      const op = m ? m[0] : c;
      i += op.length;
      if (op === "BI") {
        const ei = src.indexOf("EI", i);
        i = ei < 0 ? src.length : ei + 2; // satır içi görsel verisi atlanır
      } else if (op === "Tf") {
        const name = stack[stack.length - 2];
        const size = stack[stack.length - 1];
        font = typeof name === "string" ? fonts.get(name.slice(1)) : undefined;
        if (typeof size === "number" && size > 0) fontSize = size;
      } else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") nl();
        const str = stack[stack.length - 1];
        if (Array.isArray(str)) show(decodeBytes(str as number[], font));
      } else if (op === "TJ") {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          let t = "";
          for (const it of arr as Array<number[] | number>) {
            if (typeof it === "number") {
              if (it < -180 && !t.endsWith(" ")) t += " "; // geniş boşluk = kelime arası
            } else t += decodeBytes(it, font);
          }
          show(t);
        }
      } else if (op === "BT") {
        x = 0;
        y = 0;
      } else if (op === "Td" || op === "TD") {
        const [tx, ty] = stack.slice(-2);
        if (typeof tx === "number" && typeof ty === "number") moveTo(x + tx, y + ty);
      } else if (op === "Tm") {
        const [e, f] = stack.slice(-2);
        if (typeof e === "number" && typeof f === "number") moveTo(e, f);
      } else if (op === "T*") {
        nl();
        lineY = undefined;
      }
      stack.length = 0;
    }
  }
  return out;
}

function pdfText(buf: Buffer): string | undefined {
  const objs = pdfObjects(buf);
  if ([...objs.values()].some((o) => /\/Encrypt\b/.test(o.dict))) return undefined;
  const cmaps = new Map<number, FontMap>();
  const fontOf = (dict: string | undefined): Map<string, FontMap> => {
    const res = new Map<string, FontMap>();
    const fdict = dict ? dictValue(objs, dict, "Font") : undefined;
    if (!fdict) return res;
    for (const m of fdict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fobj = objs.get(Number(m[2]));
      const tu = fobj ? refNum(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(fobj.dict)?.[1]) : undefined;
      if (tu === undefined) continue;
      if (!cmaps.has(tu)) {
        const s = objs.get(tu)?.stream;
        if (s) cmaps.set(tu, parseCMap(s.toString("latin1")));
      }
      const cm = cmaps.get(tu);
      if (cm) res.set(m[1], cm);
    }
    return res;
  };
  // Sayfalar katalogdaki sayfa ağacının sırasıyla
  const pages: PdfObj[] = [];
  const walk = (num: number | undefined, inherited: string | undefined, depth: number) => {
    const o = num !== undefined ? objs.get(num) : undefined;
    if (!o || depth > 50) return;
    const res = dictValue(objs, o.dict, "Resources") ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      for (const k of (dictValue(objs, o.dict, "Kids") ?? "").matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), res, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) {
      pages.push({ dict: o.dict + (res && !/\/Resources/.test(o.dict) ? `\n/Resources ${res}` : "") });
    }
  };
  const root = [...objs.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  walk(refNum(/\/Pages\s+(\d+\s+\d+\s+R)/.exec(root?.dict ?? "")?.[1]), undefined, 0);
  const parts: string[] = [];
  pages.forEach((p, n) => {
    const fonts = fontOf(dictValue(objs, p.dict, "Resources"));
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(p.dict)?.[1] ?? "";
    const src = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)]
      .map((r) => objs.get(Number(r[1]))?.stream?.toString("latin1") ?? "")
      .join("\n");
    const text = contentText(src, fonts).replace(/ {2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) parts.push(pages.length > 1 ? `--- sayfa ${n + 1} ---\n${text}` : text);
  });
  return parts.join("\n\n") || undefined;
}

// ───────────────────────── DOCX ─────────────────────────

/** Zip arşivinden tek bir dosyayı okur (merkezi dizinden) */
function unzipEntry(buf: Buffer, wanted: string): Buffer | undefined {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return undefined;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lname = buf.readUInt16LE(local + 26);
      const lextra = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + size);
      return method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : undefined;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e] ?? m);

function docxText(buf: Buffer): string | undefined {
  const xml = unzipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) return undefined;
  const body = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t") // tablo: hücreler sekmeyle, satırlar satır sonuyla
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "") // silinmiş (izlenen değişiklik) metin
    .replace(/<[^>]+>/g, "");
  return unxml(body).replace(/\n\t/g, "\t").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || undefined;
}
