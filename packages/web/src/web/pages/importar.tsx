import { useState, useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageHeader } from "../components/Layout";
import {
  Upload, FileText, CheckCircle2, AlertCircle, Clock,
  RefreshCw, Folder, X, ChevronDown, ChevronUp,
  Link2, Link2Off, Zap, Wifi, WifiOff, ExternalLink,
  Calendar, TrendingUp, Landmark,
} from "lucide-react";
import { getToken } from "../lib/auth";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ImportLog {
  id: string; filename: string; status: "ok" | "error" | "partial";
  totalRows: number; quotasCreated: number; quotasUpdated: number;
  despesasCreated: number; despesasSkipped: number; errorCount: number;
  errors: string | null; createdAt: string | number;
}

interface ImportResult {
  ok?: boolean; alreadyImported?: boolean; previousImport?: ImportLog;
  message?: string; totalRows?: number; quotasCreated?: number;
  quotasUpdated?: number; despesasCreated?: number; despesasSkipped?: number;
  errors?: string[]; error?: string;
}

interface BankStatus {
  configured: boolean;
  connected: boolean;
  connection: {
    id: string; sessionId: string; bankName: string; accounts: string;
    status: string; connectedAt: string | number; expiresAt: string | number;
  } | null;
  lastSync: {
    id: string; syncedFrom: string | number; syncedTo: string | number;
    transactionsFound: number; despesasCreated: number; quotasCreated: number;
    quotasUpdated: number; skipped: number; errors: string | null; status: string;
    createdAt: string | number;
  } | null;
}

interface SyncResult {
  ok?: boolean; transactionsFound?: number; despesasCreated?: number;
  quotasCreated?: number; quotasUpdated?: number; despesasSkipped?: number;
  syncErrors?: string[]; errors?: string[]; error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(ts: string | number): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}

function daysUntil(ts: string | number): number {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function authFetch(url: string, opts: RequestInit = {}) {
  const token = getToken();
  return fetch(url, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: "ok" | "partial" | "error" }) {
  const map = {
    ok:      { label: "OK",       bg: "var(--green-subtle)",          color: "var(--green)" },
    partial: { label: "Parcial",  bg: "rgba(245,158,11,0.15)",        color: "#f59e0b" },
    error:   { label: "Erro",     bg: "var(--red-subtle)",            color: "var(--red)" },
  };
  const s = map[status] ?? map.error;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

function LogRow({ log }: { log: ImportLog }) {
  const [expanded, setExpanded] = useState(false);
  const errors: string[] = log.errors ? JSON.parse(log.errors) : [];
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div
        className="flex items-center gap-3 px-4 py-3 text-sm cursor-pointer hover:opacity-80 transition"
        onClick={() => errors.length > 0 && setExpanded(e => !e)}
      >
        <FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span className="flex-1 font-mono text-xs truncate max-w-[220px]" style={{ color: "var(--text-primary)" }} title={log.filename}>
          {log.filename}
        </span>
        <StatusBadge status={log.status} />
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{log.totalRows} linhas</span>
        <span className="text-xs" style={{ color: "var(--green)" }}>+{log.quotasCreated ?? 0}q</span>
        <span className="text-xs" style={{ color: "var(--blue-primary)" }}>+{log.despesasCreated ?? 0}d</span>
        {log.errorCount > 0 && <span className="text-xs" style={{ color: "var(--red)" }}>{log.errorCount} erros</span>}
        <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>{formatDate(log.createdAt)}</span>
        {errors.length > 0 && (
          <button className="ml-1 opacity-50 hover:opacity-100 transition">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      {expanded && errors.length > 0 && (
        <div className="px-8 pb-3" style={{ background: "var(--bg-elevated)" }}>
          {errors.map((e, i) => <div key={i} className="text-xs font-mono py-0.5" style={{ color: "var(--red)" }}>{e}</div>)}
        </div>
      )}
    </div>
  );
}

// ─── Bank Connection Panel ────────────────────────────────────────────────────
function BankPanel() {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showCustomDate, setShowCustomDate] = useState(false);
  const [customFrom, setCustomFrom] = useState("2026-02-01");
  const [customTo, setCustomTo] = useState(new Date().toISOString().slice(0, 10));
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/bank/status");
      const data = await res.json() as BankStatus;
      setStatus(data);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
    // Check URL params for callback result
    const params = new URLSearchParams(window.location.search);
    if (params.get("bank_connected")) {
      setSyncResult({ ok: true });
      window.history.replaceState({}, "", "/importar");
    } else if (params.get("bank_error")) {
      setSyncResult({ error: decodeURIComponent(params.get("bank_error") ?? "") });
      window.history.replaceState({}, "", "/importar");
    }
  }, []);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await authFetch("/api/bank/connect");
      const data = await res.json() as { authUrl?: string; error?: string };
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        setSyncResult({ error: data.error ?? "Erro ao iniciar ligação" });
      }
    } catch (e: any) {
      setSyncResult({ error: e.message });
    }
    setConnecting(false);
  }

  async function handleSync(customDates?: { date_from: string; date_to: string }) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const body = customDates ? JSON.stringify(customDates) : undefined;
      const res = await authFetch("/api/bank/sync", {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      const data = await res.json() as SyncResult;
      setSyncResult(data);
      await loadStatus();
      // Invalidar todas as queries para forçar reload da UI com dados frescos
      await queryClient.invalidateQueries();
    } catch (e: any) {
      setSyncResult({ error: e.message });
    }
    setSyncing(false);
    setShowCustomDate(false);
  }

  async function handleDisconnect() {
    if (!confirm("Remover ligação bancária? Terás de voltar a ligar.")) return;
    setDisconnecting(true);
    await authFetch("/api/bank/disconnect", { method: "DELETE" });
    await loadStatus();
    setDisconnecting(false);
  }

  if (loading) {
    return (
      <div className="rounded-xl border p-6 flex items-center justify-center gap-3"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
        <RefreshCw size={16} className="animate-spin" style={{ color: "var(--text-muted)" }} />
        <span className="text-sm" style={{ color: "var(--text-muted)" }}>A verificar ligação bancária…</span>
      </div>
    );
  }

  const conn = status?.connection;
  const lastSync = status?.lastSync;
  const isConnected = status?.connected && conn?.status === "active";
  const daysLeft = conn?.expiresAt ? daysUntil(conn.expiresAt) : 0;
  const accounts: any[] = conn?.accounts ? JSON.parse(conn.accounts) : [];

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: "var(--bg-surface)", borderColor: isConnected ? "var(--green)" : "var(--border)" }}>
      {/* Header */}
      <div className="px-5 py-4 flex items-center gap-4"
        style={{ background: isConnected ? "var(--green-subtle)" : "var(--bg-elevated)", borderBottom: "1px solid var(--border)" }}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: isConnected ? "var(--green)" : "var(--bg-surface)", border: "1px solid var(--border)" }}>
          <Landmark size={20} style={{ color: isConnected ? "white" : "var(--text-muted)" }} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
            {isConnected ? (
              <>
                <Wifi size={14} style={{ color: "var(--green)" }} />
                {conn?.bankName ?? "Banco"} — Ligado
              </>
            ) : (
              <>
                <WifiOff size={14} style={{ color: "var(--text-muted)" }} />
                Sincronização Bancária Automática
              </>
            )}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {isConnected
              ? `Token válido por mais ${daysLeft} dias · ${accounts.length} conta(s) ligada(s)`
              : "Liga a conta Santander Empresas para importar movimentos automaticamente via PSD2"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isConnected && (
            <>
              <button
                onClick={() => handleSync()}
                disabled={syncing}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition hover:opacity-80 disabled:opacity-50"
                style={{ background: "var(--green)", color: "white" }}
              >
                {syncing
                  ? <><RefreshCw size={14} className="animate-spin" /> A sincronizar…</>
                  : <><Zap size={14} /> Sincronizar agora</>}
              </button>
              <button
                onClick={() => setShowCustomDate(v => !v)}
                disabled={syncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition hover:opacity-80 disabled:opacity-50"
                style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                title="Sincronizar período específico"
              >
                <Calendar size={13} />
              </button>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition hover:opacity-80"
                style={{ background: "var(--red-subtle)", color: "var(--red)", border: "1px solid var(--red)" }}
              >
                <Link2Off size={13} />
                Desligar
              </button>
            </>
          )}
          {!isConnected && status?.configured && (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition hover:opacity-80 disabled:opacity-50"
              style={{ background: "var(--blue-primary)", color: "white" }}
            >
              {connecting
                ? <><RefreshCw size={14} className="animate-spin" /> A redirecionar…</>
                : <><Link2 size={14} /> Ligar Santander</>}
            </button>
          )}
          {!isConnected && !status?.configured && (
            <div className="text-xs px-3 py-1.5 rounded-lg" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
              Credenciais não configuradas
            </div>
          )}
        </div>
      </div>

      {/* Connected details */}
      {isConnected && (
        <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Última sincronização", value: lastSync ? formatDate(lastSync.createdAt) : "Nunca", icon: Clock },
            { label: "Transações encontradas", value: lastSync?.transactionsFound ?? "—", icon: TrendingUp },
            { label: "Despesas importadas", value: lastSync?.despesasCreated ?? "—", icon: FileText },
            { label: "Quotas atualizadas", value: (lastSync?.quotasCreated ?? 0) + (lastSync?.quotasUpdated ?? 0), icon: CheckCircle2 },
          ].map(item => (
            <div key={item.label} className="rounded-lg p-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-1.5 mb-1">
                <item.icon size={12} style={{ color: "var(--text-muted)" }} />
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{item.label}</span>
              </div>
              <div className="text-sm font-semibold font-mono" style={{ color: "var(--text-primary)" }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Custom date range sync */}
      {showCustomDate && isConnected && (
        <div className="px-5 pb-0 pt-0">
          <div className="rounded-lg border p-3 mb-3" style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}>
            <div className="text-xs font-medium mb-2" style={{ color: "var(--text-secondary)" }}>Sincronizar período específico</div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>De</span>
                <input
                  type="date" value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="text-xs rounded px-2 py-1 font-mono"
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>Até</span>
                <input
                  type="date" value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  className="text-xs rounded px-2 py-1 font-mono"
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
              </div>
              <button
                onClick={() => handleSync({ date_from: customFrom, date_to: customTo })}
                disabled={syncing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition hover:opacity-80 disabled:opacity-50"
                style={{ background: "var(--blue-primary)", color: "white" }}
              >
                {syncing ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
                Buscar
              </button>
            </div>
            <div className="text-xs mt-1.5" style={{ color: "var(--text-muted)" }}>
              Útil para buscar movimentos históricos. Pedidos são divididos em janelas de 30 dias automaticamente.
            </div>
          </div>
        </div>
      )}

      {/* Sync result */}
      {syncResult && (
        <div className="px-5 pb-4">
          <div className="rounded-lg border p-3" style={{
            borderColor: syncResult.error ? "var(--red)" : "var(--green)",
            background: syncResult.error ? "var(--red-subtle)" : "var(--green-subtle)",
          }}>
            <div className="flex items-start gap-2">
              {syncResult.error
                ? <AlertCircle size={15} style={{ color: "var(--red)", marginTop: 1, flexShrink: 0 }} />
                : <CheckCircle2 size={15} style={{ color: "var(--green)", marginTop: 1, flexShrink: 0 }} />}
              <div className="flex-1 text-xs" style={{ color: syncResult.error ? "var(--red)" : "var(--green)" }}>
                {syncResult.error
                  ? syncResult.error.includes("429") || syncResult.error.includes("multiplicity")
                    ? "Limite diário de consultas ao banco atingido. Tenta novamente amanhã."
                    : `Erro: ${syncResult.error}`
                  : syncResult.transactionsFound !== undefined
                  ? <>
                      <span className="font-medium">{syncResult.transactionsFound} transações encontradas</span>
                      {(syncResult as any).period && ` (${(syncResult as any).period.from} → ${(syncResult as any).period.to})`}
                      {" · "}{syncResult.despesasCreated ?? 0} despesas criadas
                      {" · "}{syncResult.quotasCreated ?? 0} quotas criadas
                      {(syncResult.quotasUpdated ?? 0) > 0 && ` · ${syncResult.quotasUpdated} quotas atualizadas`}
                      {(syncResult.despesasSkipped ?? 0) > 0 && ` · ${syncResult.despesasSkipped} ignoradas`}
                      {syncResult.syncErrors && syncResult.syncErrors.length > 0 && (
                        <div className="mt-1 opacity-75">Erros API: {syncResult.syncErrors.join("; ")}</div>
                      )}
                      {syncResult.errors && syncResult.errors.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer opacity-75">{syncResult.errors.length} avisos de importação</summary>
                          <div className="mt-1 opacity-75 space-y-0.5">
                            {syncResult.errors.slice(0, 10).map((e, i) => <div key={i}>• {e}</div>)}
                            {syncResult.errors.length > 10 && <div>…e mais {syncResult.errors.length - 10}</div>}
                          </div>
                        </details>
                      )}
                    </>
                  : "Ligação bancária estabelecida com sucesso"}
              </div>
              <button onClick={() => setSyncResult(null)} className="opacity-50 hover:opacity-100">
                <X size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Not configured warning */}
      {!status?.configured && (
        <div className="px-5 py-3 border-t" style={{ borderColor: "var(--border)" }}>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Para ativar: adiciona <code className="font-mono px-1 py-0.5 rounded" style={{ background: "var(--bg-elevated)" }}>ENABLE_BANKING_CLIENT_ID</code> e{" "}
            <code className="font-mono px-1 py-0.5 rounded" style={{ background: "var(--bg-elevated)" }}>ENABLE_BANKING_PRIVATE_KEY</code> ao ficheiro <code className="font-mono">.env</code> do servidor.
          </p>
        </div>
      )}

      {/* Sandbox warning — only show if sessionId literally contains "sandbox" */}
      {isConnected && conn?.sessionId?.toLowerCase().includes("sandbox") && (
        <div className="px-5 py-2 border-t flex items-center gap-2" style={{ borderColor: "var(--border)", background: "rgba(245,158,11,0.06)" }}>
          <AlertCircle size={13} style={{ color: "#f59e0b" }} />
          <span className="text-xs" style={{ color: "#f59e0b" }}>
            Modo Sandbox — dados de teste. Para produção, muda o Environment para Production no dashboard Enable Banking.
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ImportarPage() {
  const [dragging, setDragging]       = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [result, setResult]           = useState<ImportResult | null>(null);
  const [logs, setLogs]               = useState<ImportLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await authFetch("/api/import/logs");
      const data = await res.json() as { logs: ImportLog[] };
      setLogs(data.logs ?? []);
    } catch {}
    setLogsLoading(false);
  }, []);

  useEffect(() => { loadLogs(); }, []);

  async function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setResult({ error: "Só ficheiros .csv são aceites." });
      return;
    }
    setUploading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await authFetch("/api/import/movimentos", { method: "POST", body: form });
      const data = await res.json() as ImportResult;
      setResult(data);
      if (data.ok) {
        loadLogs();
        await queryClient.invalidateQueries();
      }
    } catch (err: any) {
      setResult({ error: err.message ?? "Erro desconhecido" });
    }
    setUploading(false);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  return (
    <div>
      <PageHeader
        title="Alimentar Dados"
        subtitle="Sincronização automática com o banco ou importação manual de extractos CSV"
        breadcrumb={["Gestão Condomínio", "Alimentar Dados"]}
        actions={
          <button onClick={loadLogs}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition hover:opacity-80"
            style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
            <RefreshCw size={14} />
            Atualizar
          </button>
        }
      />

      <div className="p-6 space-y-6">

        {/* ── Bank connection panel ── */}
        <BankPanel />

        {/* ── Divider ── */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
          <span className="text-xs font-medium uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            ou importar CSV manualmente
          </span>
          <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
        </div>

        {/* ── Upload zone ── */}
        <div
          className={`relative rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer ${dragging ? "scale-[1.01]" : ""}`}
          style={{
            borderColor: dragging ? "var(--blue-primary)" : "var(--border)",
            background: dragging ? "var(--blue-subtle, rgba(59,130,246,0.05))" : "var(--bg-surface)",
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) processFile(file);
            e.target.value = "";
          }} />
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            {uploading ? (
              <>
                <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4 animate-pulse"
                  style={{ background: "var(--blue-subtle, rgba(59,130,246,0.1))" }}>
                  <RefreshCw size={24} style={{ color: "var(--blue-primary)" }} className="animate-spin" />
                </div>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>A processar ficheiro…</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: "var(--bg-elevated)" }}>
                  <Upload size={28} style={{ color: dragging ? "var(--blue-primary)" : "var(--text-muted)" }} />
                </div>
                <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
                  {dragging ? "Largar para importar" : "Arrastar CSV aqui, ou clicar para selecionar"}
                </p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Extracto bancário Santander em formato CSV (codificação latin1)
                </p>
              </>
            )}
          </div>
        </div>

        {/* ── Import result ── */}
        {result && (
          <div className="rounded-xl border p-4" style={{
            borderColor: result.error ? "var(--red)" : result.alreadyImported ? "var(--border)" : "var(--green)",
            background: result.error ? "var(--red-subtle)" : result.alreadyImported ? "var(--bg-surface)" : "var(--green-subtle)",
          }}>
            <div className="flex items-start gap-3">
              {result.error
                ? <AlertCircle size={18} style={{ color: "var(--red)", flexShrink: 0, marginTop: 1 }} />
                : result.alreadyImported
                ? <Clock size={18} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1 }} />
                : <CheckCircle2 size={18} style={{ color: "var(--green)", flexShrink: 0, marginTop: 1 }} />}
              <div className="flex-1 min-w-0">
                {result.error ? (
                  <p className="text-sm font-medium" style={{ color: "var(--red)" }}>Erro: {result.error}</p>
                ) : result.alreadyImported ? (
                  <p className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Ficheiro já importado anteriormente — sem alterações.</p>
                ) : (
                  <>
                    <p className="text-sm font-semibold mb-2" style={{ color: "var(--green)" }}>Importação concluída</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Linhas CSV",         value: result.totalRows ?? 0,       color: "var(--text-primary)" },
                        { label: "Quotas criadas",     value: result.quotasCreated ?? 0,   color: "var(--green)" },
                        { label: "Quotas atualizadas", value: result.quotasUpdated ?? 0,   color: "var(--blue-primary)" },
                        { label: "Despesas criadas",   value: result.despesasCreated ?? 0, color: "var(--blue-primary)" },
                      ].map(s => (
                        <div key={s.label} className="rounded-lg px-3 py-2"
                          style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
                          <div className="text-lg font-bold font-mono" style={{ color: s.color }}>{s.value}</div>
                          <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                    {result.errors && result.errors.length > 0 && (
                      <details className="mt-3">
                        <summary className="text-xs cursor-pointer" style={{ color: "var(--red)" }}>
                          {result.errors.length} aviso(s)
                        </summary>
                        <div className="mt-2 space-y-1">
                          {result.errors.map((e, i) => (
                            <div key={i} className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>{e}</div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
              <button onClick={() => setResult(null)} className="opacity-40 hover:opacity-80 transition" style={{ color: "var(--text-muted)" }}>
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Watcher info ── */}
        <div className="rounded-xl border p-4 flex items-start gap-4"
          style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--bg-elevated)" }}>
            <Folder size={18} style={{ color: "var(--text-muted)" }} />
          </div>
          <div>
            <div className="text-sm font-medium mb-1" style={{ color: "var(--text-primary)" }}>Agente de Monitorização de Pasta</div>
            <div className="text-xs space-y-1" style={{ color: "var(--text-secondary)" }}>
              <p>Para importação automática de ficheiros, arranca o agente no servidor:</p>
              <code className="block mt-1 px-3 py-1.5 rounded-md font-mono text-xs"
                style={{ background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
                bun run packages/web/watcher/agent.ts
              </code>
              <p className="mt-1">Monitoriza a pasta <code className="font-mono">watch_folder/</code> e importa automaticamente qualquer novo CSV.</p>
            </div>
          </div>
        </div>

        {/* ── Import history ── */}
        <div className="rounded-xl border overflow-hidden" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Histórico de Importações CSV</div>
              <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>Últimas 20 importações manuais</div>
            </div>
          </div>
          {logsLoading ? (
            <div className="py-12 text-center">
              <RefreshCw size={20} className="animate-spin mx-auto mb-2" style={{ color: "var(--text-muted)" }} />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar…</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="py-12 text-center">
              <FileText size={32} className="mx-auto mb-3 opacity-20" style={{ color: "var(--text-muted)" }} />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>Nenhuma importação realizada ainda</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3 px-4 py-2 text-xs font-medium uppercase tracking-wide"
                style={{ color: "var(--text-muted)", background: "var(--bg-elevated)" }}>
                <span className="w-4" />
                <span className="flex-1">Ficheiro</span>
                <span>Estado</span><span>Linhas</span><span>Quotas</span><span>Desp.</span><span>Erros</span>
                <span className="ml-2">Data</span><span className="w-4" />
              </div>
              {logs.map(log => <LogRow key={log.id} log={log} />)}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
