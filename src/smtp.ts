import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { trustedRoots } from "./tfs.js";

/**
 * Bağımlılıksız SMTP istemcisi — gece denetiminin sabah özetini gönderir. Desteklenen:
 * STARTTLS (587, düz bağlanıp şifrelemeye geçer), baştan şifreli TLS (465), şifresiz (25, yalnızca
 * iç ağ aktarıcısı); kimlik AUTH PLAIN / LOGIN ya da kimliksiz. NTLM / Kerberos (yalnızca Windows
 * kimliği isteyen Exchange) DESTEKLENMEZ — o durumda kimliksiz iç aktarıcı ya da parolalı bir
 * gönderim hesabı gerekir. Kurum kök sertifikası işletim sisteminin deposundan okunur (TFS ile aynı).
 */

export interface SmtpOptions {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  user?: string;
  password?: string;
  insecureTls?: boolean;
  /** Her adımın süre sınırı (varsayılan 60 sn) */
  timeoutMs?: number;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

interface Reply {
  code: number;
  lines: string[];
}

/** Ağ hatalarının Türkçesi */
function netError(e: NodeJS.ErrnoException, host: string, port: number): SmtpError {
  const yer = `${host}:${port}`;
  switch (e.code) {
    case "ECONNREFUSED":
      return new SmtpError(
        `e-posta sunucusuna bağlanılamadı (${yer} bağlantıyı reddetti) — adres ve bağlantı noktasını denetle`,
      );
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new SmtpError(`e-posta sunucusunun adı çözülemedi: ${host}`);
    case "ETIMEDOUT":
      return new SmtpError(`e-posta sunucusu yanıt vermedi (${yer}) — güvenlik duvarı ya da bağlantı noktası olabilir`);
    case "ECONNRESET":
      return new SmtpError(
        `e-posta sunucusu bağlantıyı kesti (${yer}) — güvenlik ayarı (STARTTLS / TLS) sunucuyla uyuşmuyor olabilir`,
      );
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return new SmtpError(
        `e-posta sunucusunun sertifikası doğrulanamadı (${e.code}) — kurum kök sertifikası bu bilgisayarda yüklü değilse "Sertifikayı doğrulama"yı aç`,
      );
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "ERR_SSL_PACKET_LENGTH_TOO_LONG":
      return new SmtpError(
        `güvenlik ayarı e-posta sunucusuyla uyuşmuyor (${yer}) — bu bağlantı noktası şifresiz ya da STARTTLS bekliyor olabilir (genelde 587 → STARTTLS, 465 → TLS)`,
      );
    default:
      if (/wrong version number|packet length too long/i.test(e.message))
        return new SmtpError(
          `güvenlik ayarı e-posta sunucusuyla uyuşmuyor (${yer}) — bu bağlantı noktası şifresiz ya da STARTTLS bekliyor olabilir (genelde 587 → STARTTLS, 465 → TLS)`,
        );
      return new SmtpError(`e-posta sunucusu: ${e.message}`);
  }
}

/** Satır satır SMTP yanıtı okuyan bağlantı (STARTTLS'te alttaki soket değişir) */
class Conn {
  private buf = "";
  private lines: string[] = [];
  private waiting?: { resolve: (r: Reply) => void; reject: (e: Error) => void };
  private queue: Reply[] = [];
  private failed?: Error;
  sock!: net.Socket;

  constructor(
    sock: net.Socket,
    private readonly o: SmtpOptions,
  ) {
    this.attach(sock);
  }

  private readonly onData = (d: Buffer) => {
    this.buf += d.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      if (m && m[2] === " ") {
        const r = { code: Number(m[1]), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = undefined;
          w.resolve(r);
        } else this.queue.push(r);
      } else if (!m && line.trim()) {
        // Sunucu SMTP konuşmuyor (ör. TLS bekleyen bağlantı noktasına düz bağlanıldı)
        this.fail(new SmtpError(`e-posta sunucusu beklenmeyen yanıt verdi: ${line.slice(0, 120)}`));
      }
    }
  };
  private readonly onError = (e: Error) => this.fail(netError(e as NodeJS.ErrnoException, this.o.host, this.o.port));
  private readonly onClose = () => this.fail(new SmtpError("e-posta sunucusu bağlantıyı kapattı"));
  private readonly onTimeout = () => {
    this.fail(
      new SmtpError(`e-posta sunucusu ${Math.round((this.o.timeoutMs ?? 60_000) / 1000)} sn içinde yanıt vermedi`),
    );
    this.sock.destroy();
  };

  attach(sock: net.Socket): void {
    this.sock = sock;
    sock.on("data", this.onData);
    sock.on("error", this.onError);
    sock.on("close", this.onClose);
    sock.setTimeout(this.o.timeoutMs ?? 60_000, this.onTimeout);
  }

  detach(): net.Socket {
    const s = this.sock;
    s.off("data", this.onData);
    s.off("error", this.onError);
    s.off("close", this.onClose);
    s.setTimeout(0);
    return s;
  }

  private fail(e: Error): void {
    this.failed ??= e;
    const w = this.waiting;
    this.waiting = undefined;
    w?.reject(this.failed);
  }

  read(): Promise<Reply> {
    const r = this.queue.shift();
    if (r) return Promise.resolve(r);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }

  async cmd(line: string, expect: number[], what: string): Promise<Reply> {
    this.sock.write(line + "\r\n");
    const r = await this.read();
    if (!expect.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${r.lines.join(" ").slice(0, 300)}`, r.code);
    return r;
  }
}

function tlsOptions(o: SmtpOptions): tls.ConnectionOptions {
  return {
    servername: net.isIP(o.host) ? undefined : o.host,
    rejectUnauthorized: !o.insecureTls,
    ...(o.insecureTls ? {} : { ca: trustedRoots() }),
  };
}

function connect(o: SmtpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s =
      o.security === "tls"
        ? tls.connect({ host: o.host, port: o.port, ...tlsOptions(o) }, () => done())
        : net.connect({ host: o.host, port: o.port }, () => done());
    const t = setTimeout(() => {
      s.destroy();
      reject(netError(Object.assign(new Error("zaman aşımı"), { code: "ETIMEDOUT" }), o.host, o.port));
    }, o.timeoutMs ?? 30_000);
    function done() {
      clearTimeout(t);
      s.off("error", fail);
      resolve(s);
    }
    function fail(e: Error) {
      clearTimeout(t);
      reject(netError(e as NodeJS.ErrnoException, o.host, o.port));
    }
    s.once("error", fail);
  });
}

function startTls(plain: net.Socket, o: SmtpOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: plain, ...tlsOptions(o) }, () => {
      s.off("error", fail);
      resolve(s);
    });
    function fail(e: Error) {
      reject(netError(e as NodeJS.ErrnoException, o.host, o.port));
    }
    s.once("error", fail);
  });
}

/** Adresin yalnızca e-posta kısmı ("Kurmay <kurmay@kurum>" → kurmay@kurum) */
export const bareAddress = (a: string) => a.replace(/^.*<([^>]+)>\s*$/, "$1").trim();

/** İletiyi gönderir (data: başlıklarıyla tam MIME iletisi, CRLF). Sunucunun son yanıtını döner. */
export async function sendMail(
  o: SmtpOptions,
  env: { from: string; to: string[]; data: Buffer },
): Promise<{ response: string; accepted: string[]; rejected: string[] }> {
  if (!env.to.length) throw new SmtpError("alıcı yok");
  const conn = new Conn(await connect(o), o);
  const ehloName = os.hostname().replace(/[^\w.-]/g, "") || "kurmay";
  try {
    await conn.read().then((r) => {
      if (r.code !== 220) throw new SmtpError(`e-posta sunucusu karşılamadı: ${r.code} ${r.lines.join(" ")}`, r.code);
    });
    let caps = await conn.cmd(`EHLO ${ehloName}`, [250], "EHLO").catch(async (e) => {
      // Çok eski sunucu: EHLO bilmiyor
      if (e instanceof SmtpError && e.code && e.code >= 500) return conn.cmd(`HELO ${ehloName}`, [250], "HELO");
      throw e;
    });
    const has = (k: string) => caps.lines.some((l) => l.toUpperCase().startsWith(k));
    if (o.security === "starttls") {
      if (!has("STARTTLS"))
        throw new SmtpError(
          'e-posta sunucusu STARTTLS desteklemiyor — güvenliği "TLS" (465) ya da iç ağdaysa "şifresiz" seç',
        );
      await conn.cmd("STARTTLS", [220], "STARTTLS");
      conn.attach(await startTls(conn.detach(), o));
      caps = await conn.cmd(`EHLO ${ehloName}`, [250], "EHLO");
    }
    if (o.user) {
      const auth = caps.lines.find((l) => l.toUpperCase().startsWith("AUTH"))?.toUpperCase() ?? "";
      if (!auth)
        throw new SmtpError(
          o.security === "none"
            ? "e-posta sunucusu şifresiz bağlantıda kimlik doğrulamaya izin vermiyor — güvenliği STARTTLS ya da TLS seç"
            : "e-posta sunucusu kimlik doğrulama sunmuyor — kullanıcı adını boş bırakıp kimliksiz dene",
        );
      const pass = o.password ?? "";
      try {
        if (/\bPLAIN\b/.test(auth)) {
          await conn.cmd(
            `AUTH PLAIN ${Buffer.from(`\0${o.user}\0${pass}`).toString("base64")}`,
            [235],
            "kimlik doğrulama",
          );
        } else if (/\bLOGIN\b/.test(auth)) {
          await conn.cmd("AUTH LOGIN", [334], "kimlik doğrulama");
          await conn.cmd(Buffer.from(o.user).toString("base64"), [334], "kimlik doğrulama");
          await conn.cmd(Buffer.from(pass).toString("base64"), [235], "kimlik doğrulama");
        } else {
          throw new SmtpError(
            `e-posta sunucusu yalnızca desteklenmeyen kimlik yöntemleri sunuyor (${auth.replace(/^AUTH[ =]/, "")}) — ` +
              "kimliksiz iç aktarıcı ya da parolalı bir gönderim hesabı gerekir",
          );
        }
      } catch (e) {
        if (e instanceof SmtpError && e.code === 535)
          throw new SmtpError("e-posta sunucusu kullanıcı adını ya da parolayı kabul etmedi", 535);
        throw e;
      }
    }
    await conn.cmd(`MAIL FROM:<${bareAddress(env.from)}>`, [250], "gönderen");
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const rcpt of env.to) {
      try {
        await conn.cmd(`RCPT TO:<${bareAddress(rcpt)}>`, [250, 251], `alıcı ${rcpt}`);
        accepted.push(rcpt);
      } catch (e) {
        if (!(e instanceof SmtpError) || !e.code) throw e;
        rejected.push(rcpt);
      }
    }
    if (!accepted.length)
      throw new SmtpError(`e-posta sunucusu alıcıların hiçbirini kabul etmedi (${rejected.join(", ")})`);
    await conn.cmd("DATA", [354], "ileti");
    // Nokta doldurma: satır başındaki "." çiftlenir; ileti CRLF.CRLF ile biter
    const body = env.data.toString("utf8").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    conn.sock.write(body.endsWith("\r\n") ? body : body + "\r\n");
    const r = await conn.cmd(".", [250], "ileti");
    void conn.cmd("QUIT", [221], "çıkış").catch(() => undefined);
    return { response: `${r.code} ${r.lines.join(" ")}`, accepted, rejected };
  } finally {
    setTimeout(() => conn.sock.destroy(), 1000).unref?.();
  }
}

// ── MIME ──────────────────────────────────────────────────────────────────

/** RFC 2047 kodlanmış sözcükler (≤ 42 bayt parça; harf ortasından bölünmez), satırlar katlanır */
export function encodedWords(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s) && s.length < 900) return s;
  const parcalar: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (cur && Buffer.byteLength(cur + ch, "utf8") > 42) {
      parcalar.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) parcalar.push(cur);
  return parcalar.map((p) => `=?UTF-8?B?${Buffer.from(p, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** "Ad <adres>" başlığında adın kodlanması */
function addressHeader(a: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(a);
  return m && m[1] ? `${encodedWords(m[1].replace(/^"|"$/g, ""))} <${m[2]}>` : bareAddress(a);
}

/** Gönderilecek ileti: düz metin + HTML (multipart/alternative), base64, CRLF */
export function buildMessage(m: { from: string; to: string[]; subject: string; text: string; html: string }): Buffer {
  const CRLF = "\r\n";
  const b64 = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/.{1,76}/g, "$&" + CRLF);
  const sinir = `kurmay-${crypto.randomBytes(8).toString("hex")}`;
  const domain = bareAddress(m.from).split("@")[1] || "kurmay";
  const lines = [
    `From: ${addressHeader(m.from)}`,
    `To: ${m.to.map(addressHeader).join(",\r\n ")}`,
    `Subject: ${encodedWords(m.subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "X-Mailer: Kurmay",
    `Content-Type: multipart/alternative; boundary="${sinir}"`,
    "",
    `--${sinir}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.text),
    `--${sinir}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.html),
    `--${sinir}--`,
    "",
  ];
  return Buffer.from(lines.join(CRLF), "utf8");
}
