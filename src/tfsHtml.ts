/**
 * TFS (Azure DevOps Server) zengin metin alanları HTML'dir: Açıklama, Kabul kriterleri,
 * Yeniden üretme adımları, Sistem bilgisi, tartışma yorumları. Ajanlara ham HTML vermek
 * yerine okunur Markdown'a çevrilir (kütüphanesiz): yerel model etiket gürültüsüyle
 * bağlam doldurmasın, panel de aynı metni kendi Markdown çizicisiyle (önce her şeyi
 * kaçışlayarak) gösterebilsin — TFS'ten gelen HTML panelde ASLA olduğu gibi çizilmez.
 *
 * Kapsanan: satır/paragraf (TFS her satırı <div> yapar), kalın/italik/üstü çizili,
 * satır içi kod ve <pre>, başlıklar, iç içe listeler, tablolar (Excel/Word'den yapıştırılan),
 * alıntı, yatay çizgi, bağlantılar (@bahsetme ve #123 iş öğesi bağlantıları sadeleşir),
 * görseller (çağıranın verdiği karşılıkla — ör. indirilen ekin adı), HTML varlıkları
 * (&nbsp; &ccedil; &#8217; …), Word yapıştırma kalıntıları (<o:p>, koşullu yorumlar).
 * Amaç kusursuz dönüşüm değil, içeriğin kaybolmadan okunur kalması.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  laquo: "«", raquo: "»", times: "×", divide: "÷", plusmn: "±", deg: "°", para: "¶", sect: "§",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒", lArr: "⇐", le: "≤", ge: "≥", ne: "≠",
  ccedil: "ç", Ccedil: "Ç", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", scedil: "ş", Scedil: "Ş",
  gbreve: "ğ", Gbreve: "Ğ", Idot: "İ", inodot: "ı", imath: "ı", iuml: "ï", Iuml: "Ï",
  acirc: "â", Acirc: "Â", icirc: "î", Icirc: "Î", ucirc: "û", Ucirc: "Û", auml: "ä", Auml: "Ä",
  eacute: "é", Eacute: "É", egrave: "è", aacute: "á", agrave: "à", oacute: "ó", uacute: "ú", szlig: "ß",
  shy: "", zwj: "", zwnj: "", lrm: "", rlm: "",
};

/** HTML varlıklarını çözer (adlandırılmış + &#123; + &#x7B;) */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code === 0xa0) return " ";
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? m;
  });
}

/** Öznitelik değeri (çift/tek tırnaklı ya da tırnaksız) */
function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

export interface HtmlToMarkdownOptions {
  /** Görselin yerine yazılacak metin (src: özgün adres). Verilmezse "[görsel: ad]". */
  image?: (src: string, alt: string) => string;
}

interface ListCtx {
  ordered: boolean;
  n: number;
}

interface TableCtx {
  rows: string[][];
  row: string[] | null;
}

/** Hücre/bağlantı/alıntı içeriği ayrı tamponda toplanır, kapanınca dönüştürülüp üst tampona yazılır */
interface Frame {
  kind: "root" | "cell" | "link" | "quote";
  buf: string;
  href?: string;
}

const BLOCK = new Set([
  "div", "p", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption",
  "address", "center", "form", "fieldset", "dl", "dt", "dd", "details", "summary",
]);
const SKIP_CONTENT = new Set(["script", "style", "head", "title", "xml", "template", "noscript", "svg", "math"]);

/**
 * HTML → Markdown. Hatalı/eksik kapanmış etiketlere dayanıklıdır (TFS'teki içerik çoğu
 * zaman Word/Outlook/tarayıcıdan yapıştırılmıştır).
 */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): string {
  if (!html) return "";
  // Etiketsiz metin: düz metin ya da Markdown biçimli alan/yorum (yeni sunucularda alan Markdown'a
  // çevrilebiliyor) — boşlukları HTML gibi birleştirip satır yapısını bozmadan olduğu gibi bırak
  if (!/<[a-zA-Z!/][^>]*>/.test(html)) return decodeEntities(html.replace(/\r\n?/g, "\n")).trim();
  let src = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[(?:if|endif)[^\]]*\]>/gi, "") // Word koşullu yorumları
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  // İçeriği atlanacak etiketler (stil, betik, Word'ün xml'i)
  for (const tag of SKIP_CONTENT) src = src.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");

  const frames: Frame[] = [{ kind: "root", buf: "" }];
  const top = () => frames[frames.length - 1];
  const lists: ListCtx[] = [];
  const tables: TableCtx[] = [];
  /** Satır içi biçim işaretleri: açıldığı andaki tampon uzunluğu (boş biçim yazılmasın) */
  const marks: Array<{ tag: string; mark: string; at: number; frame: Frame }> = [];
  let pre = 0;
  let codeInline = 0;
  /** Madde işareti yazıldı, maddenin metni henüz başlamadı — blok açılışı yeni satır açmasın */
  let itemOpen = false;

  const write = (s: string) => {
    if (!s) return;
    top().buf += s;
    if (/\S/.test(s)) itemOpen = false;
  };
  const inCell = () => frames.some((f) => f.kind === "cell");
  /** Satır başında değilsek yeni satıra geç (madde işaretinin hemen ardından değilse) */
  const newline = () => {
    const f = top();
    if (inCell()) {
      if (f.buf && !/\s$/.test(f.buf)) f.buf += " ";
      return;
    }
    if (itemOpen) return;
    if (f.buf && !f.buf.endsWith("\n")) f.buf += "\n";
  };
  /** Paragraf arası: boş satır */
  const blankLine = () => {
    const f = top();
    if (inCell()) return newline();
    if (itemOpen) return;
    if (!f.buf) return;
    if (!f.buf.endsWith("\n")) f.buf += "\n";
    if (!f.buf.endsWith("\n\n")) f.buf += "\n";
  };
  const indent = () => "  ".repeat(Math.max(0, lists.length - 1));

  const openMark = (tag: string, mark: string) => {
    marks.push({ tag, mark, at: top().buf.length, frame: top() });
    write(mark);
  };
  const closeMark = (tag: string) => {
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].tag !== tag) continue;
      const m = marks.splice(i, 1)[0];
      const f = m.frame;
      if (f !== top()) return; // başka tampona taşmış (bozuk iç içelik) — işareti kapatma
      const inner = f.buf.slice(m.at + m.mark.length);
      if (!inner.trim()) {
        // Boş biçim ("****") yazılmasın
        f.buf = f.buf.slice(0, m.at) + inner;
        return;
      }
      // "**metin **" → "**metin** " (Markdown'da kapanış boşluktan önce olmalı)
      const trail = /\s+$/.exec(inner)?.[0] ?? "";
      f.buf = f.buf.slice(0, f.buf.length - trail.length) + m.mark + trail;
      return;
    }
  };

  const closeCell = () => {
    const t = tables[tables.length - 1];
    if (!t || top().kind !== "cell") return;
    const cell = frames.pop()!;
    const text = cell.buf.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
    (t.row ??= []).push(text);
  };
  const closeRow = () => {
    const t = tables[tables.length - 1];
    if (!t) return;
    if (top().kind === "cell") closeCell();
    if (t.row && t.row.length) t.rows.push(t.row);
    t.row = null;
  };
  const closeTable = () => {
    const t = tables.pop();
    if (!t) return;
    // Tablo içinde kalmış hücre/satır
    while (top().kind === "cell") {
      const cell = frames.pop()!;
      (t.row ??= []).push(cell.buf.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"));
    }
    if (t.row && t.row.length) t.rows.push(t.row);
    const rows = t.rows.filter((r) => r.some((c) => c));
    if (!rows.length) return;
    // İç içe tablo: dış tablonun hücresine düz metin olarak yazılır
    if (inCell()) {
      write(rows.map((r) => r.join(" · ")).join(" / "));
      return;
    }
    const cols = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => [...r, ...Array(cols - r.length).fill("")]);
    // Tek sütunlu "tablo" (düzen için kullanılmış) — satır satır yaz
    if (cols === 1) {
      blankLine();
      write(norm.map((r) => r[0]).join("\n"));
      blankLine();
      return;
    }
    const line = (r: string[]) => `| ${r.map((c) => c || " ").join(" | ")} |`;
    blankLine();
    write([line(norm[0]), `| ${Array(cols).fill("---").join(" | ")} |`, ...norm.slice(1).map(line)].join("\n"));
    blankLine();
  };

  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|(<)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [, close, rawTag, attrs = "", text, lt] = m;
    if (text !== undefined || lt !== undefined) {
      const t = decodeEntities(text ?? lt ?? "");
      if (pre) write(t.replace(/\r\n?/g, "\n"));
      else {
        const collapsed = t.replace(/[\s\u00a0]+/g, " ");
        // Satır başındaki boşluk yazılmaz
        const f = top();
        if (/^ /.test(collapsed) && (!f.buf || /[\n ]$/.test(f.buf))) write(collapsed.slice(1));
        else write(collapsed);
      }
      continue;
    }
    if (rawTag.includes(":")) continue; // <o:p>, <v:shape>… Word kalıntıları
    const tag = rawTag.toLowerCase();
    const isClose = close === "/";

    switch (tag) {
      case "br":
        if (pre) write("\n");
        else if (inCell()) write(" ");
        else {
          itemOpen = false;
          top().buf += "\n";
        }
        break;
      case "hr":
        blankLine();
        write("---");
        blankLine();
        break;
      case "p":
        blankLine();
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        if (isClose) blankLine();
        else {
          blankLine();
          // Alanın kendi başlığı (## Açıklama) altında: başlıklar bir kademe aşağıda
          if (!inCell()) write("#".repeat(Math.min(4, 2 + Number(tag[1]))) + " ");
        }
        break;
      case "b":
      case "strong":
        if (pre) break;
        if (isClose) closeMark(tag);
        else openMark(tag, "**");
        break;
      case "i":
      case "em":
        if (pre) break;
        if (isClose) closeMark(tag);
        else openMark(tag, "*");
        break;
      case "s":
      case "strike":
      case "del":
        if (pre) break;
        if (isClose) closeMark(tag);
        else openMark(tag, "~~");
        break;
      case "code":
      case "kbd":
      case "samp":
      case "tt":
        if (pre) break;
        if (isClose) {
          if (codeInline > 0) {
            codeInline--;
            closeMark(tag);
          }
        } else {
          codeInline++;
          openMark(tag, "`");
        }
        break;
      case "pre":
        if (isClose) {
          if (pre > 0) {
            pre--;
            if (!top().buf.endsWith("\n")) top().buf += "\n";
            top().buf += "```";
            blankLine();
          }
        } else {
          blankLine();
          top().buf += "```\n";
          pre++;
        }
        break;
      case "ul":
      case "ol":
        if (isClose) {
          lists.pop();
          if (!lists.length) blankLine();
          else newline();
        } else {
          if (!lists.length) blankLine();
          else newline();
          const start = Number(attr(attrs, "start"));
          lists.push({ ordered: tag === "ol", n: Number.isFinite(start) && start > 0 ? start - 1 : 0 });
        }
        break;
      case "li":
        if (isClose) {
          newline();
          break;
        }
        {
          const l = lists[lists.length - 1];
          if (inCell()) {
            write(l?.ordered ? ` ${++l.n}. ` : " • ");
            break;
          }
          const f = top();
          if (f.buf && !f.buf.endsWith("\n")) f.buf += "\n";
          f.buf += indent() + (l ? (l.ordered ? `${++l.n}. ` : "- ") : "- ");
          itemOpen = true;
        }
        break;
      case "blockquote":
        if (isClose) {
          if (top().kind !== "quote") break;
          const q = frames.pop()!;
          const body = q.buf.replace(/\n{3,}/g, "\n\n").trim();
          if (body) {
            blankLine();
            write(body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
            blankLine();
          }
        } else {
          frames.push({ kind: "quote", buf: "" });
        }
        break;
      case "table":
        if (isClose) closeTable();
        else {
          if (!inCell()) blankLine();
          tables.push({ rows: [], row: null });
        }
        break;
      case "tr":
        if (!tables.length) {
          newline();
          break;
        }
        if (isClose) closeRow();
        else {
          closeRow();
          tables[tables.length - 1].row = [];
        }
        break;
      case "td":
      case "th":
        if (!tables.length) {
          write(" ");
          break;
        }
        if (isClose) closeCell();
        else {
          if (top().kind === "cell") closeCell();
          tables[tables.length - 1].row ??= [];
          frames.push({ kind: "cell", buf: "" });
        }
        break;
      case "thead":
      case "tbody":
      case "tfoot":
      case "colgroup":
      case "col":
      case "caption":
        break;
      case "a":
        if (isClose) {
          if (top().kind !== "link") break;
          const l = frames.pop()!;
          const label = l.buf.replace(/\s+/g, " ").trim();
          const href = l.href ?? "";
          // @bahsetme ve #123 iş öğesi bağlantıları: yalnızca metin (adres ajan için gürültü)
          if (!label) write(/^https?:\/\//i.test(href) ? href : "");
          else if (/^[@#]/.test(label) || !/^(https?:|mailto:)/i.test(href) || href === label) write(label);
          else write(`[${label}](${href})`);
        } else {
          frames.push({ kind: "link", buf: "", href: attr(attrs, "href") });
        }
        break;
      case "img": {
        const s = attr(attrs, "src") ?? "";
        const alt = attr(attrs, "alt") ?? attr(attrs, "title") ?? "";
        const text = opts.image ? opts.image(s, alt) : `[görsel${alt ? `: ${alt}` : ""}]`;
        if (text) write(text);
        break;
      }
      default:
        if (BLOCK.has(tag)) {
          if (tag === "dd" && !isClose) {
            newline();
            write("  ");
            break;
          }
          newline();
        }
      // span, font, u, sup, sub… etiketi yok sayılır, metni kalır
    }
  }

  // Kapanmamış biçim işaretleri (bozuk HTML): açılış işareti silinir — "**" ortada kalmasın
  for (let i = marks.length - 1; i >= 0; i--) {
    const { frame: f, at, mark } = marks[i];
    if (f.buf.slice(at, at + mark.length) === mark) f.buf = f.buf.slice(0, at) + f.buf.slice(at + mark.length);
  }
  // Kapanmamış yapılar: tablolar, hücreler, bağlantılar, alıntılar üst tampona katılır
  while (tables.length) closeTable();
  while (frames.length > 1) {
    const f = frames.pop()!;
    top().buf += f.buf;
  }
  if (pre) top().buf += "\n```";

  return frames[0].buf
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML'deki görsellerin adresleri (sırasıyla, tekrarsız) */
export function imageSources(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const s = attr(m[1], "src");
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Satır içi: **kalın**, *italik*, `kod`, [metin](http…) → HTML (önce kaçışlanır) */
function inlineHtml(s: string): string {
  return escHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * TFS'e yazılacak yorumun HTML'i: panelde düzenlenen düz metinden (Markdown'ın küçük bir
 * alt kümesi). TFS tartışma alanı HTML ister; her satır <div>, "- " maddeleri liste,
 * boş satır paragraf arası. Her şey kaçışlanır — etiket yalnızca buradan üretilir.
 */
export function textToTfsHtml(text: string): string {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) {
      (list ??= []).push(inlineHtml(item[1]));
      continue;
    }
    flush();
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    if (head) out.push(`<div><b>${inlineHtml(head[1])}</b></div>`);
    else out.push(line.trim() ? `<div>${inlineHtml(line)}</div>` : "<div><br></div>");
  }
  flush();
  // Baştaki/sondaki boş satırlar
  while (out[0] === "<div><br></div>") out.shift();
  while (out[out.length - 1] === "<div><br></div>") out.pop();
  return out.join("");
}
