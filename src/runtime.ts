import fs from "node:fs";
import path from "node:path";
import type { ApprovalResult, ScheduleOutcome, WebApprovalChannel } from "./approval.js";
import { EventBus, type TimedEvent } from "./events.js";

/** Oturumun panelde görünen durumu (son olaydan türetilir) */
export type SessionStatus =
  | "idle" // hiç koşmadı / geçmiş
  | "running"
  | "approval" // kullanıcı onayı bekliyor
  | "scheduled" // zamanlanmış başlangıç/devam bekliyor
  | "finished"
  | "failed"
  | "cancelled";

/** Bir olayın oturum durumuna etkisi (etkisi yoksa undefined) */
function statusAfter(e: TimedEvent, prev: SessionStatus): SessionStatus | undefined {
  switch (e.type) {
    case "workflow_started":
    case "approval_resolved":
    case "run_resumed":
      return "running";
    case "approval_required":
      return "approval";
    case "run_scheduled":
      return "scheduled";
    case "workflow_finished":
      // Zamanlama iptaliyle biten koşu "bitti" değil
      return prev === "cancelled" ? "cancelled" : "finished";
    case "run_schedule_cancelled":
    case "workflow_cancelled":
      return "cancelled";
    case "workflow_failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * Tek bir oturumun çalışma zamanı: kendi olay kanalı (panel bu oturumu canlı ve
 * geçmişiyle buradan izler), kendi onay/zamanlama yuvası ve kendi iptal denetçisi.
 * Oturumlar birbirinden bağımsız — aynı anda koşabilirler.
 */
export class SessionRuntime {
  readonly bus = new EventBus();
  status: SessionStatus = "idle";
  /** Görev kabul edildiği anda true (zamanlanmış bekleme dahil) — çift başlatmayı önler */
  busy = false;
  /** Son/şu anki görev metni ve hedef dizini (lobi listesi + dizin çakışma uyarısı) */
  task?: string;
  cwd?: string;
  private aborter: AbortController | null = null;
  private pendingApproval: ((r: ApprovalResult) => void) | null = null;
  private pendingSchedule: ((o: Extract<ScheduleOutcome, "run_now" | "cancelled">) => void) | null = null;

  /**
   * exclusive: onay/zamanlama YALNIZCA panelden. Sunucu modunda birden çok oturum
   * aynı anda soru sorabileceği için terminal (stdin) yarışa sokulmaz — cevabın
   * hangi oturuma gittiği belirsiz olurdu. CLI tek görev modunda false.
   */
  readonly web: WebApprovalChannel;

  constructor(
    readonly id: string,
    exclusive: boolean,
    onChange: () => void,
  ) {
    this.web = {
      exclusive,
      wait: () => new Promise<ApprovalResult>((resolve) => (this.pendingApproval = resolve)),
      cancel: () => (this.pendingApproval = null),
      waitSchedule: () => new Promise((resolve) => (this.pendingSchedule = resolve)),
      cancelSchedule: () => (this.pendingSchedule = null),
    };
    this.bus.subscribe((e) => {
      const next = statusAfter(e, this.status);
      if (next && next !== this.status) {
        this.status = next;
        onChange();
      }
    });
  }

  /** Geçmiş koşu kayıtlarını (JSONL) kanala yükler — servis yeniden başlasa da panel görür */
  preload(events: TimedEvent[]): void {
    for (const e of events) {
      this.bus.history.push(e);
      this.status = statusAfter(e, this.status) ?? this.status;
    }
    // Yarıda kalmış koşu (servis kapanmış): çalışıyor görünmesin
    if (this.status === "running" || this.status === "approval" || this.status === "scheduled") {
      this.status = "cancelled";
    }
  }

  startRun(task: string, cwd: string): AbortController {
    this.busy = true;
    this.task = task;
    this.cwd = cwd;
    this.aborter = new AbortController();
    return this.aborter;
  }

  endRun(): void {
    this.busy = false;
    this.aborter = null;
    this.pendingApproval = null;
    this.pendingSchedule = null;
  }

  resolveApproval(r: ApprovalResult): boolean {
    if (!this.pendingApproval) return false;
    this.pendingApproval(r);
    this.pendingApproval = null;
    return true;
  }

  resolveSchedule(o: Extract<ScheduleOutcome, "run_now" | "cancelled">): boolean {
    if (!this.pendingSchedule) return false;
    this.pendingSchedule(o);
    this.pendingSchedule = null;
    return true;
  }

  cancel(): boolean {
    if (!this.aborter || this.aborter.signal.aborted) return false;
    this.aborter.abort();
    return true;
  }
}

/**
 * Tüm oturum çalışma zamanları. Bir oturumun runtime'ı ilk ihtiyaçta oluşur ve
 * geçmiş koşu kayıtlarıyla doldurulur. Durum değişince lobi dinleyicileri (panelin
 * sol çubuğu) haberdar edilir.
 */
export class RuntimeRegistry {
  private map = new Map<string, SessionRuntime>();
  private lobby = new Set<() => void>();

  constructor(
    private runsDir: string,
    private exclusive: boolean,
  ) {}

  /** Oturumun runtime'ı (yoksa oluşturur; runLogs verilirse geçmişi diskten yükler) */
  get(id: string, runLogs: string[] = []): SessionRuntime {
    let rt = this.map.get(id);
    if (!rt) {
      rt = new SessionRuntime(id, this.exclusive, () => this.notify());
      rt.preload(readRunLogs(this.runsDir, runLogs));
      this.map.set(id, rt);
    }
    return rt;
  }

  peek(id: string): SessionRuntime | undefined {
    return this.map.get(id);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  /** Şu an görev tutan (koşan ya da zamanlanmış bekleyen) oturumlar */
  busy(): SessionRuntime[] {
    return [...this.map.values()].filter((r) => r.busy);
  }

  /** Lobi değişikliği dinleyicisi (oturum eklendi/durum değişti) */
  onLobby(listener: () => void): () => void {
    this.lobby.add(listener);
    return () => this.lobby.delete(listener);
  }

  notify(): void {
    for (const l of this.lobby) l();
  }
}

/** Koşu kayıtlarını (JSONL) sırayla okur; bozuk satır/dosya atlanır */
export function readRunLogs(runsDir: string, files: readonly string[]): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(runsDir, f), "utf8");
    } catch {
      continue; // silinmiş kayıt
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TimedEvent);
      } catch {
        /* yarım satır */
      }
    }
  }
  return out;
}
