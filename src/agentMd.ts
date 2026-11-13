import path from "node:path";
import matter from "gray-matter";

/**
 * Persona (.claude/agents/*.md) dosyasını panelden düzenlemek için yardımcılar.
 * Panel varsayılan olarak yalnızca talimat metnini (gövde) ve kısa açıklamayı
 * değiştirir; ön bölüm (name, output şeması) METİN OLARAK aynen korunur —
 * YAML'ı yeniden yazdırmak biçimi/yorumları bozar ve git'te gereksiz fark üretir.
 */

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface AgentMdParts {
  /** Ön bölümün iç metni (--- satırları hariç); yoksa null */
  front: string | null;
  /** Talimat metni (ön bölümden sonrası, baştaki boş satırlar atılmış) */
  body: string;
  /** Dosya CRLF kullanıyor mu (Windows) — yazarken korunur */
  crlf: boolean;
}

export function splitAgentMd(raw: string): AgentMdParts {
  const crlf = raw.includes("\r\n");
  const text = raw.replace(/\r\n/g, "\n");
  const m = FRONT.exec(text);
  if (!m) return { front: null, body: text.replace(/^\n+/, ""), crlf };
  return { front: m[1], body: text.slice(m[0].length).replace(/^\n+/, ""), crlf };
}

/** Ön bölümdeki tek satırlık "description:" değeri (tırnaklıysa tırnaksız) */
export function frontDescription(front: string | null): string {
  const line = front?.match(/^description:[ \t]*(.*)$/m)?.[1]?.trim() ?? "";
  if (/^".*"$/.test(line)) {
    try {
      return JSON.parse(line) as string;
    } catch {
      return line.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(line)) return line.slice(1, -1).replace(/''/g, "'");
  return line;
}

/**
 * Yeni gövde + açıklamayla dosya metnini kurar. Ön bölüm aynen kalır; yalnızca
 * açıklama DEĞİŞTİYSE "description:" satırı yeniden yazılır (çift tırnaklı —
 * iki nokta, # gibi YAML'ı bozan karakterler güvende kalsın).
 */
export function composeAgentMd(prev: AgentMdParts, body: string, description: string, fallbackName: string): string {
  let front = prev.front;
  const desc = description.replace(/\s+/g, " ").trim();
  if (front === null) {
    front = `name: ${fallbackName}\ndescription: ${JSON.stringify(desc)}`;
  } else if (desc !== frontDescription(front)) {
    const line = `description: ${JSON.stringify(desc)}`;
    front = /^description:/m.test(front)
      ? front.replace(/^description:.*$/m, line)
      : /^name:.*$/m.test(front)
        ? front.replace(/^name:.*$/m, (n) => `${n}\n${line}`)
        : `${line}\n${front}`;
  }
  const text = `---\n${front}\n---\n\n${body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s*$/, "")}\n`;
  return prev.crlf ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Kaydetmeden önce dosya metnini doğrular: ön bölüm geçerli YAML olmalı ve
 * "output" varsa bir nesne (şema) olmalı. Hata varsa Türkçe mesaj, yoksa null.
 */
export function checkAgentMd(text: string): string | null {
  let data: Record<string, unknown>;
  try {
    data = matter(text).data;
  } catch (e) {
    // Ayrıştırıcının mesajı İngilizce — ekranda yalnızca satır numarası (dosyadaki, --- satırı dahil)
    const line = (e as { mark?: { line?: number } }).mark?.line;
    return `Üst bölüm (--- arası) okunamadı${typeof line === "number" ? ` — ${line + 2}. satırın çevresine bak` : ""}; yazım bozuk`;
  }
  if (
    data.output !== undefined &&
    (typeof data.output !== "object" || data.output === null || Array.isArray(data.output))
  ) {
    return "Üst bölümdeki çıktı şeması bir nesne olmalı";
  }
  return null;
}

/**
 * Panelden gelen dosya yolunu güvenle çözer: yalnızca <kök>/.claude/agents
 * altındaki .md dosyaları (../ ile dışarı çıkılamaz). Geçersizse null.
 */
export function resolveAgentMd(configRoot: string, file: string): string | null {
  const dir = path.resolve(configRoot, ".claude", "agents");
  const abs = path.resolve(configRoot, file);
  if (path.dirname(abs) !== dir || !abs.endsWith(".md")) return null;
  return abs;
}
