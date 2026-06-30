import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useBankSync } from "../hooks/useBankSync";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { formatEuro, getMesNome } from "../lib/utils";
import {
  TrendingUp, TrendingDown, AlertCircle, CheckCircle2,
  Euro, Building2, RefreshCw, Zap, ChevronRight,
  Flame, Droplets, Wrench, ArrowLeft, Clock, Wallet,
  ArrowDownCircle, ArrowUpCircle, PiggyBank, DoorOpen,
  ChevronDown, ChevronUp, Lock, Unlock, Cog
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer
} from "recharts";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
const CATEGORIA_LABEL: Record<string, string> = {
  agua: "Água", eletricidade: "Eletricidade", limpeza: "Limpeza",
  jardim: "Jardim", elevadores: "Elevadores", manutencao: "Manutenção",
  administracao: "Administração", honorarios: "Honorários",
  seguros: "Seguros", diversos: "Diversos", outros: "Outros",
};

type Secao = "overview" | "contaCorrente" | "obras" | "incendio" | "quotaExtra" | "fundoReserva" | string;

// ──────────────────────────────────────────────
// Root
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// SyncBanner — barra discreta no topo
// ──────────────────────────────────────────────
function SyncBanner({ isSyncing, syncError, syncDone }: { isSyncing: boolean; syncError: string | null; syncDone: boolean }) {
  if (!isSyncing && !syncError && !syncDone) return null;

  if (isSyncing) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-2 text-xs"
        style={{ background: "rgba(59,130,246,0.08)", borderBottom: "1px solid rgba(59,130,246,0.2)", color: "var(--blue-bright)" }}>
        <svg className="animate-spin h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>A sincronizar movimentos bancários Santander…</span>
      </div>
    );
  }

  if (syncError) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-2 text-xs"
        style={{ background: "rgba(245,158,11,0.08)", borderBottom: "1px solid rgba(245,158,11,0.25)", color: "var(--amber)" }}>
        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <span>Sync bancário: {syncError}</span>
      </div>
    );
  }

  if (syncDone) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-2 text-xs"
        style={{ background: "rgba(34,197,94,0.07)", borderBottom: "1px solid rgba(34,197,94,0.2)", color: "var(--green)" }}>
        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span>Movimentos bancários sincronizados</span>
      </div>
    );
  }

  return null;
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const [secao, setSecao] = useState<Secao>("overview");
  const { isSyncing, syncError, syncDone } = useBankSync();

  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api.dashboard.$get()).json(),
  });

  const seedMut = useMutation({
    mutationFn: async () => (await api.seed.$post()).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard"] }),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <SyncBanner isSyncing={isSyncing} syncError={syncError} syncDone={syncDone} />
        <div className="flex items-center justify-center flex-1" style={{ color: "var(--text-muted)" }}>
          <div className="flex items-center gap-3">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">A carregar…</span>
          </div>
        </div>
      </div>
    );
  }

  const d = data as any;

  if (!d || d.totalFracoes === 0) {
    return (
      <>
        <SyncBanner isSyncing={isSyncing} syncError={syncError} syncDone={syncDone} />
        <PageHeader title="Dashboard" subtitle="Urbanização da Fonte" />
        <div className="flex flex-col items-center justify-center h-96 gap-4">
          <Building2 size={48} style={{ color: "var(--text-muted)" }} />
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem dados ainda</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Carrega dados de teste para começar</p>
          <Button onClick={() => seedMut.mutate()} loading={seedMut.isPending}>
            <Zap size={14} /> Carregar dados de teste
          </Button>
        </div>
      </>
    );
  }

  // Secções de detalhe
  const syncBannerEl = <SyncBanner isSyncing={isSyncing} syncError={syncError} syncDone={syncDone} />;
  if (secao === "contaCorrente") return <>{syncBannerEl}<SecaoContaCorrente data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "obras") return <>{syncBannerEl}<SecaoObras data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "incendio") return <>{syncBannerEl}<SecaoIncendio data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "quotaExtra") return <>{syncBannerEl}<SecaoQuotaExtra data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "portaoGaragem") return <>{syncBannerEl}<SecaoPortaoGaragem data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "motor") return <>{syncBannerEl}<SecaoMotor data={d} onBack={() => setSecao("overview")} /></>;
  if (secao === "fundoReserva") return <>{syncBannerEl}<SecaoFundoReserva data={d} onBack={() => setSecao("overview")} /></>;
  const extraSel = d.extras?.find((e: any) => e.tipo.id === secao);
  if (extraSel) return <>{syncBannerEl}<SecaoExtra extra={extraSel} incendioData={d.incendio} onBack={() => setSecao("overview")} /></>;

  return (
    <>
      <SyncBanner isSyncing={isSyncing} syncError={syncError} syncDone={syncDone} />
      <Overview d={d} setSecao={setSecao} onRefresh={async () => {
        // Timeout de 15 s — garante que o botão nunca fica congelado em offline
        const postPromise = api.dashboard.recalcular.$post();
        const timeoutPromise = new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 15_000)
        );
        try {
          await Promise.race([postPromise, timeoutPromise]);
        } catch (_) { /* ignora erros de rede e timeouts — o GET mostra estado actual */ }
        await qc.invalidateQueries({ queryKey: ["dashboard"] });
      }} />
    </>
  );
}

// ══════════════════════════════════════════════
// SALDO OPERACIONAL CARD
// Headline = saldoLiquidoBanco (CC + Obras + FR) — disponibilidade real imediata em banco.
// Barra mostra:
//   azul  = Conta à Ordem operacional (CC − cativos)
//   amber = Cativos virtuais (Motor + Incêndio retidos na CC)
//   verde = Fundo Reserva (depósito a prazo)
//   laranja = Obras (depósito a prazo)
// ══════════════════════════════════════════════
function SaldoOperacionalCard({ d }: { d: any }) {
  // ── Valores do backend ────────────────────────────────────────────
  // saldoLiquidoBanco = CC + Obras + FR (total físico imediato em banco)
  const totalBanco: number    = d.saldoLiquidoBanco
    ?? ((d.saldoContaCorrenteTotal ?? 0) + (d.obras?.saldoConta ?? 0) + (d.fundoReserva?.saldoConta ?? 0));
  const cc: number            = d.saldoContaCorrenteTotal ?? d.contaCorrente?.saldoConta ?? 0;
  const obras: number         = d.obras?.saldoConta ?? 0;
  const fr: number            = d.fundoReserva?.saldoConta ?? 0;
  const cativos               = d.valoresCativos ?? {};
  const cativosTotal: number  = cativos.total ?? 0;
  // Operacional = CC − cativos (o que pode ser gasto em despesas correntes)
  const operacional: number   = d.saldoOperacionalDisponivel ?? Math.max(0, cc - cativosTotal);

  // ── Segmentos da barra (em relação a totalBanco) ──────────────────
  const pct = (v: number) => totalBanco > 0 ? Math.max(0.3, (v / totalBanco) * 100) : 0;

  const segmentos = [
    { key: "operacional", color: "var(--blue-bright)", label: "CC operacional",    value: operacional },
    ...(cativosTotal > 0 ? [{ key: "cativos", color: "#fb923c", label: "Cativos (Motor/Incêndio)", value: cativosTotal }] : []),
    ...(fr    > 0 ? [{ key: "fr",    color: "#22c55e", label: "Fundo Reserva",    value: fr    }] : []),
    ...(obras > 0 ? [{ key: "obras", color: "#fbbf24", label: "Obras (Abanca)",   value: obras }] : []),
  ];

  return (
    <div className="rounded-xl border p-5 space-y-4" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
      {/* Header — headline = total físico em banco */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            Saldo líquido em banco
          </p>
          <p className="text-3xl font-mono font-bold tracking-tight mt-0.5" style={{ color: "var(--text-primary)" }}>
            {formatEuro(totalBanco)}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            CC {formatEuro(cc)} + Obras {formatEuro(obras)} + FR {formatEuro(fr)}
          </p>
        </div>
        <div className="text-right">
          <div className="flex items-center gap-1.5 justify-end mb-1">
            <Unlock size={13} style={{ color: "var(--green)" }} />
            <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>CC disponível</p>
          </div>
          <p className="text-xl font-mono font-bold" style={{ color: "var(--green)" }}>
            {formatEuro(operacional)}
          </p>
          {cativosTotal > 0 && (
            <div className="flex items-center gap-1.5 justify-end mt-1">
              <Lock size={11} style={{ color: "var(--amber)" }} />
              <p className="text-xs font-mono" style={{ color: "var(--amber)" }}>
                {formatEuro(cativosTotal)} cativos
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Breakdown bar — proporcional ao totalBanco */}
      <div>
        <div className="flex h-3 rounded-full overflow-hidden gap-px" style={{ background: "var(--bg-elevated)" }}>
          {segmentos.map((s, i) => (
            <div
              key={s.key}
              className={`transition-all duration-500${i === 0 ? " rounded-l-full" : ""}${i === segmentos.length - 1 ? " rounded-r-full" : ""}`}
              style={{ width: `${pct(s.value)}%`, background: s.color, opacity: s.key === "operacional" ? 0.9 : 1 }}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
          {segmentos.map(s => (
            <div key={s.key} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color, opacity: s.key === "operacional" ? 0.9 : 1 }} />
              {s.label} <span className="font-mono ml-0.5">{formatEuro(s.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// CATIVOS ALERT
// Painel colapsível — só aparece quando há movimentos cativos (imported=0)
// Lista cada movimento com badge da gaveta, montante e descrição
// ══════════════════════════════════════════════
function CativosAlert({ d }: { d: any }) {
  const [open, setOpen] = useState(false);
  const cativos = d.valoresCativos ?? {};
  const movimentos: any[] = cativos.movimentos ?? [];
  const numMov: number = cativos.numMovimentos ?? 0;

  if (numMov === 0) return null;

  const gavetas = Object.entries(GAVETA_COLORS)
    .map(([key, meta]) => ({ key, ...meta, value: (cativos[key] ?? 0) as number }))
    .filter(g => g.value > 0);

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--amber)", background: "rgba(245,158,11,0.06)" }}>
      {/* Header — sempre visível */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors"
        style={{ color: "var(--text-primary)" }}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2.5">
          <Lock size={15} style={{ color: "var(--amber)", flexShrink: 0 }} />
          <div>
            <span className="text-sm font-semibold" style={{ color: "var(--amber)" }}>
              {numMov} movimento{numMov !== 1 ? "s" : ""} a aguardar classificação
            </span>
            <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>
              {formatEuro(cativos.total ?? 0)} cativos na conta à ordem
            </span>
          </div>
        </div>
        {open ? <ChevronUp size={16} style={{ color: "var(--text-muted)" }} /> : <ChevronDown size={16} style={{ color: "var(--text-muted)" }} />}
      </button>

      {/* Collapsed summary — gavetas com valores */}
      {!open && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {gavetas.map(g => (
            <span key={g.key} className="text-xs px-2.5 py-1 rounded-full font-medium"
              style={{ background: `${g.bar}22`, color: g.bar, border: `1px solid ${g.bar}55` }}>
              {g.label}: {formatEuro(g.value)}
            </span>
          ))}
        </div>
      )}

      {/* Expanded — lista de movimentos */}
      {open && (
        <div className="border-t" style={{ borderColor: "rgba(245,158,11,0.2)" }}>
          {movimentos.length === 0 ? (
            <div className="px-4 py-3 space-y-1">
              {/* Sem detalhe de movimentos — mostrar apenas totais por gaveta */}
              {gavetas.map(g => (
                <div key={g.key} className="flex items-center justify-between py-1.5 px-2 rounded-lg"
                  style={{ background: "var(--bg-elevated)" }}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ background: `${g.bar}22`, color: g.bar }}>
                      {g.label}
                    </span>
                  </div>
                  <span className="text-sm font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                    {formatEuro(g.value)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "rgba(245,158,11,0.1)" }}>
              {movimentos.map((m: any, i: number) => {
                const gavetaMeta = GAVETA_COLORS[m.gaveta];
                return (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
                        style={{
                          background: gavetaMeta ? `${gavetaMeta.bar}22` : "var(--bg-elevated)",
                          color: gavetaMeta?.bar ?? "var(--text-secondary)",
                          border: `1px solid ${gavetaMeta ? `${gavetaMeta.bar}55` : "var(--border)"}`,
                        }}>
                        {gavetaMeta?.label ?? m.gaveta}
                      </span>
                      <span className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>
                        {m.description ?? m.descricao ?? "—"}
                      </span>
                    </div>
                    <span className="text-sm font-mono font-semibold ml-3 shrink-0" style={{ color: "var(--text-primary)" }}>
                      {formatEuro(Math.abs(m.amount ?? m.montante ?? 0))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {/* Totais por gaveta (sempre no fundo quando expandido) */}
          {movimentos.length > 0 && (
            <div className="px-4 py-3 border-t flex flex-wrap gap-2"
              style={{ borderColor: "rgba(245,158,11,0.2)", background: "rgba(245,158,11,0.04)" }}>
              {gavetas.map(g => (
                <span key={g.key} className="text-xs px-2.5 py-1 rounded-full font-semibold"
                  style={{ background: `${g.bar}22`, color: g.bar, border: `1px solid ${g.bar}55` }}>
                  {g.label}: {formatEuro(g.value)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
// OVERVIEW — layout principal
// ══════════════════════════════════════════════
function Overview({ d, setSecao, onRefresh }: any) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mesNome = getMesNome(d.mesAtual);
  const taxaCobranca = d.totalQuotas > 0 ? Math.round((d.quotasPagas / d.totalQuotas) * 100) : 0;

  // Total saldos em caixa (todas as contas)
  const totalEmCaixa =
    (d.contaCorrente?.saldoConta ?? 0) +
    (d.obras?.saldoConta ?? 0) +
    (d.fundoReserva?.saldoConta ?? 0) +
    (d.quotaExtra?.saldoConta ?? 0) +
    (d.incendio?.saldoConta ?? 0) +
    (d.portaoGaragem?.saldoConta ?? 0);

  // Total a receber (todas as fontes)
  const totalAReceber =
    (d.contaCorrente?.totalEmAtraso ?? 0) +
    (d.obras?.totalAtraso ?? 0) +
    (d.fundoReserva?.totalEmAtraso ?? 0) +
    (d.incendio?.aReceber ?? 0) +
    (d.quotaExtra?.aReceber ?? 0) +
    (d.portaoGaragem?.aReceber ?? 0) +
    (d.motor?.aReceber ?? 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Urbanização da Fonte · ${mesNome} ${d.anoAtual}`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            disabled={isRefreshing}
            onClick={async () => {
              setIsRefreshing(true);
              try { await onRefresh(); } finally { setIsRefreshing(false); }
            }}
          >
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "A recalcular…" : "Atualizar"}
          </Button>
        }
      />

      <div className="p-6 space-y-8">

        {/* ── 1. RESUMO TOPO ─────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SumCard
            label="Total em caixa"
            value={formatEuro(totalEmCaixa)}
            sub="todas as contas"
            icon={<Wallet size={18} />}
            color="blue"
          />
          <SumCard
            label="Por receber"
            value={formatEuro(totalAReceber)}
            sub="em atraso/pendente"
            icon={<ArrowDownCircle size={18} />}
            color={totalAReceber > 0 ? "red" : "green"}
          />
          <SumCard
            label={`Despesas - ${mesNome}`}
            value={formatEuro(d.totalDespesasMes)}
            sub="partes comuns"
            icon={<ArrowUpCircle size={18} />}
            color="amber"
          />
          <SumCard
            label="Taxa de cobrança"
            value={`${taxaCobranca}%`}
            sub={`${d.quotasPagas}/${d.totalQuotas} frações pagas`}
            icon={<CheckCircle2 size={18} />}
            color={taxaCobranca >= 90 ? "green" : taxaCobranca >= 70 ? "amber" : "red"}
          />
        </div>

        {/* ── 1b. SALDO OPERACIONAL + CATIVOS ───────── */}
        <div className="space-y-3">
          <SaldoOperacionalCard d={d} />
          <CativosAlert d={d} />
        </div>

        {/* ── 2. CONTAS ──────────────────────────────── */}
        <section>
          <SectionLabel>Contas do condomínio</SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-3">
            {/* Conta corrente */}
            {(() => {
              const ccFromMorosos = (d.contaCorrente?.morosos ?? []).reduce((s: number, m: any) => s + (m.total ?? 0), 0);
              const ccAReceber = Math.max(d.contaCorrente?.totalEmAtraso ?? 0, ccFromMorosos);
              return (
                <ContaCard
                  titulo="Conta Corrente"
                  banco="Santander Totta"
                  saldo={d.contaCorrente?.saldoConta ?? 0}
                  aReceber={ccAReceber}
                  aReceberLabel={`${d.contaCorrente?.fracoesEmAtraso ?? (d.contaCorrente?.morosos?.length ?? 0)} frações em atraso`}
                  color="blue"
                  icon={<Euro size={20} />}
                  onClick={() => setSecao("contaCorrente")}
                />
              );
            })()}
            {/* Obras */}
            <ContaCard
              titulo="Obras"
              banco="Abanca"
              saldo={d.obras?.saldoConta ?? 0}
              aReceber={d.obras?.totalAtraso ?? 0}
              aReceberLabel={`${d.obras?.fracoesEmAtraso ?? 0} frações em atraso`}
              color="amber"
              icon={<Wrench size={20} />}
              onClick={() => setSecao("obras")}
            />
            {/* Quota Extra Elevadores */}
            <ContaCard
              titulo="Quota Extra — Elevadores"
              banco="Abanca"
              saldo={d.quotaExtra?.saldoConta ?? 0}
              aReceber={d.quotaExtra?.aReceber ?? 0}
              aReceberLabel={`${d.quotaExtra?.morosos?.length ?? 0} frações em divida`}
              color="purple"
              icon={<Zap size={20} />}
              onClick={() => setSecao("quotaExtra")}
            />
            {/* Quota Extra Motor */}
            <ContaCard
              titulo="Quota Extra Motor"
              banco="Quota extra motor — Excel col U"
              saldo={0}
              saldoLabel="sem conta dedicada"
              aReceber={d.motor?.aReceber ?? 0}
              aReceberLabel={`${d.motor?.fracoesEmAtraso ?? 0} frações em dívida`}
              color="slate"
              icon={<Cog size={20} />}
              onClick={() => setSecao("motor")}
            />
            {/* Incêndio */}
            <ContaCard
              titulo="Incendio"
              banco="Conta geral"
              saldo={d.incendio?.saldoConta ?? 0}
              saldoLabel="Obra paga"
              aReceber={d.incendio?.aReceber ?? 0}
              aReceberLabel={`${d.incendio?.fracoesEmAtraso ?? 0} frações por receber`}
              color="red"
              icon={<Flame size={20} />}
              onClick={() => setSecao("incendio")}
            />
            {/* Fundo de Reserva */}
            <ContaCard
              titulo="Fundo Reserva"
              banco="Santander Totta"
              saldo={d.fundoReserva?.saldoConta ?? 0}
              aReceber={d.fundoReserva?.totalEmAtraso ?? 0}
              aReceberLabel={`${d.fundoReserva?.fracoesEmAtraso ?? 0} frações em atraso`}
              color="green"
              icon={<PiggyBank size={20} />}
              onClick={() => setSecao("fundoReserva")}
            />
          </div>
        </section>

        {/* ── 3. MOROSOS + GRÁFICO ──────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Morosos — unified across all sources */}
          <div className="lg:col-span-2 space-y-3">
            <SectionLabel>Frações em atraso</SectionLabel>
            {(() => {
              // Merge devedores by fracao.numero across all sources
              const devedoresMap = new Map<string, { fracao: any; total: number }>();
              const addMorosos = (list: any[] | undefined) => {
                if (!list) return;
                for (const m of list) {
                  const num: string = m.fracao?.numero ?? m.fracao?.id ?? "?";
                  const existing = devedoresMap.get(num);
                  if (existing) {
                    existing.total += m.total ?? 0;
                  } else {
                    devedoresMap.set(num, { fracao: m.fracao, total: m.total ?? 0 });
                  }
                }
              };
              addMorosos(d.contaCorrente?.morosos);
              addMorosos(d.fundoReserva?.morosos);
              addMorosos(d.obras?.morosos);
              addMorosos(d.motor?.morosos);
              addMorosos(d.incendio?.morosos);
              addMorosos(d.quotaExtra?.morosos);

              const devedores = Array.from(devedoresMap.values())
                .filter((x) => x.total > 0)
                .sort((a, b) => (a.fracao?.numero ?? "").localeCompare(b.fracao?.numero ?? ""));

              if (devedores.length === 0) {
                return (
                  <Card>
                    <CardContent className="flex items-center gap-3 py-6">
                      <CheckCircle2 size={24} style={{ color: "var(--green)" }} />
                      <div>
                        <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Tudo em dia</p>
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>Sem morosos este mês</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              }

              const visible = devedores.slice(0, 6);
              const rest = devedores.length - visible.length;
              return (
                <Card>
                  <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                    {visible.map((dev) => (
                      <MorososRow key={dev.fracao?.numero ?? dev.fracao?.id} m={dev} />
                    ))}
                    {rest > 0 && (
                      <button
                        onClick={() => setSecao("contaCorrente")}
                        className="w-full py-3 text-xs text-center hover:opacity-70 transition-opacity"
                        style={{ color: "var(--blue-bright)" }}
                      >
                        Ver todos ({devedores.length}) →
                      </button>
                    )}
                  </div>
                </Card>
              );
            })()}
          </div>

          {/* Gráfico evolução */}
          <div className="lg:col-span-3">
            <SectionLabel>Evolução — últimos 6 meses</SectionLabel>
            <Card className="h-full">
              <CardContent className="pt-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={d.evolucao} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}€`} width={55} />
                    <Tooltip
                      contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, color: "var(--text-primary)", fontSize: 12 }}
                      formatter={(val: number) => formatEuro(val)}
                    />
                    <Bar dataKey="receita" fill="var(--blue-primary)" radius={[4, 4, 0, 0]} name="Receita" />
                    <Bar dataKey="despesa" fill="var(--red)" radius={[4, 4, 0, 0]} name="Despesas" opacity={0.7} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex gap-4 mt-1">
                  <LegendDot color="var(--blue-primary)" label="Receita" />
                  <LegendDot color="var(--red)" label="Despesas" opacity="0.7" />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// CONTA CARD — bloco principal por conta
// ══════════════════════════════════════════════
function ContaCard({
  titulo, banco, saldo, saldoLabel, aReceber, aReceberLabel, color, icon, onClick, semDetalhe
}: {
  titulo: string; banco: string;
  saldo: number; saldoLabel?: string;
  aReceber: number; aReceberLabel: string;
  color: "blue" | "amber" | "green" | "red" | "purple" | "orange" | "slate";
  icon: React.ReactNode; onClick?: () => void; semDetalhe?: boolean;
}) {
  const palette = {
    blue:   { bg: "var(--blue-subtle)",   fg: "var(--blue-bright)",   pill: "rgba(59,130,246,0.12)" },
    amber:  { bg: "var(--amber-subtle)",  fg: "var(--amber)",         pill: "rgba(245,158,11,0.12)" },
    green:  { bg: "var(--green-subtle)",  fg: "var(--green)",         pill: "rgba(34,197,94,0.12)"  },
    red:    { bg: "var(--red-subtle)",    fg: "var(--red)",           pill: "rgba(239,68,68,0.12)"  },
    purple: { bg: "var(--purple-subtle)", fg: "var(--purple)",        pill: "rgba(168,85,247,0.12)" },
    orange: { bg: "rgba(249,115,22,0.1)", fg: "rgb(249,115,22)",      pill: "rgba(249,115,22,0.12)" },
    slate:  { bg: "rgba(100,116,139,0.1)", fg: "rgb(100,116,139)",   pill: "rgba(100,116,139,0.12)" },
  }[color];

  return (
    <button
      onClick={semDetalhe ? undefined : onClick}
      className="text-left w-full rounded-xl border transition-all duration-150 group"
      style={{
        background: "var(--bg-surface)",
        borderColor: "var(--border)",
        cursor: semDetalhe ? "default" : "pointer",
      }}
      onMouseEnter={e => { if (!semDetalhe) (e.currentTarget as HTMLElement).style.borderColor = palette.fg; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
    >
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: palette.bg, color: palette.fg }}>
              {icon}
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>{titulo}</p>
              <p className="text-xs leading-tight" style={{ color: "var(--text-muted)" }}>{banco}</p>
            </div>
          </div>
          {!semDetalhe && <ChevronRight size={14} className="opacity-40 group-hover:opacity-100 transition-opacity" style={{ color: "var(--text-muted)" }} />}
        </div>

        {/* Saldo */}
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide mb-0.5" style={{ color: "var(--text-muted)" }}>
            {saldoLabel ?? "Saldo em conta"}
          </p>
          <p className="text-2xl font-mono font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            {formatEuro(saldo)}
          </p>
        </div>

        {/* A receber */}
        <div
          className="rounded-lg px-3 py-2 flex items-center justify-between"
          style={{ background: aReceber > 0 ? "var(--red-subtle)" : "var(--green-subtle)" }}
        >
          <span className="text-xs" style={{ color: aReceber > 0 ? "var(--red)" : "var(--green)" }}>
            {aReceber > 0 ? aReceberLabel : "Tudo em dia"}
          </span>
          {aReceber > 0 && (
            <span className="text-xs font-mono font-semibold" style={{ color: "var(--red)" }}>
              {formatEuro(aReceber)}
            </span>
          )}
          {aReceber === 0 && <CheckCircle2 size={13} style={{ color: "var(--green)" }} />}
        </div>
      </div>
    </button>
  );
}

// ══════════════════════════════════════════════
// RESUMO TOPO
// ══════════════════════════════════════════════
function SumCard({ label, value, sub, icon, color }: {
  label: string; value: string; sub: string; icon: React.ReactNode;
  color: "blue" | "amber" | "green" | "red";
}) {
  const palette = {
    blue:  { bg: "var(--blue-subtle)",  fg: "var(--blue-bright)" },
    amber: { bg: "var(--amber-subtle)", fg: "var(--amber)" },
    green: { bg: "var(--green-subtle)", fg: "var(--green)" },
    red:   { bg: "var(--red-subtle)",   fg: "var(--red)" },
  }[color];

  return (
    <div className="rounded-xl border p-4" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: palette.bg, color: palette.fg }}>
          {icon}
        </div>
      </div>
      <p className="text-2xl font-mono font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>{value}</p>
      <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>
    </div>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: CONTA CORRENTE
// ══════════════════════════════════════════════
function SecaoContaCorrente({ data: d, onBack }: any) {
  const morosos = d.contaCorrente?.morosos ?? [];
  const total = d.contaCorrente?.totalEmAtraso ?? 0;
  const pagNaoReg = (d.pagamentosNaoRegistados ?? []) as Array<{
    fracao: string; proprietario: string; pagamentos: Array<{data:string;montante:number;descricao:string;referencia:string}>; totalPago:number; cobreAte:{quota:string;fundo:string}; disputaCondominio:string; contasNaoCovertas:string[]
  }>;

  return (
    <>
      <PageHeader
        title="Conta Corrente"
        subtitle={`${morosos.length} frações em atraso · ${formatEuro(total)} por cobrar`}
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">

        {/* Alerta pagamentos não registados */}
        {pagNaoReg.length > 0 && (
          <div className="rounded-xl border px-4 py-3 space-y-3"
            style={{ background: "rgba(245,158,11,0.08)", borderColor: "var(--amber)" }}>
            <div className="flex items-center gap-2">
              <AlertCircle size={15} style={{ color: "var(--amber)", flexShrink: 0 }} />
              <p className="text-sm font-semibold" style={{ color: "var(--amber)" }}>
                Pagamentos bancários não registados pelo condomínio
              </p>
            </div>
            {pagNaoReg.map((p) => (
              <div key={p.fracao} className="space-y-2">
                <p className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                  Fração {p.fracao} — {p.proprietario}
                </p>
                <div className="space-y-1">
                  {p.pagamentos.map((pag) => (
                    <div key={pag.referencia} className="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg"
                      style={{ background: "var(--bg-elevated)" }}>
                      <span style={{ color: "var(--text-secondary)" }}>{pag.data} · {pag.descricao}</span>
                      <span className="font-mono font-bold" style={{ color: "var(--amber)" }}>{formatEuro(pag.montante)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs px-1" style={{ color: "var(--text-secondary)" }}>
                  <span className="font-medium">Quota cobre até:</span> {p.cobreAte.quota}
                </p>
                <p className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
                  <span className="font-medium text-amber-500">Posição do condomínio (contestada):</span> {p.disputaCondominio}
                </p>
                <p className="text-xs px-1" style={{ color: "var(--text-muted)" }}>
                  Contas NÃO cobertas por estes pagamentos: {p.contasNaoCovertas.join(" · ")}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <KpiCard label="Saldo em conta" value={formatEuro(d.contaCorrente?.saldoConta ?? 0)} sub="Santander" icon={<Euro size={16} />} iconColor="var(--blue-bright)" />
          <KpiCard label="Em atraso" value={formatEuro(total)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
          <KpiCard label="Frações em dia" value={String(d.totalFracoes - morosos.length)} sub={`de ${d.totalFracoes}`} icon={<CheckCircle2 size={16} />} iconColor="var(--green)" />
        </div>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem morosos!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: OBRAS
// ══════════════════════════════════════════════
function SecaoObras({ data: d, onBack }: any) {
  const obras = d.obras ?? {};
  const morosos = obras.morosos ?? [];
  return (
    <>
      <PageHeader
        title="Obras"
        subtitle="Derrama de obras do edifício"
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label="Saldo conta Abanca" value={formatEuro(obras.saldoConta ?? 0)} sub="Abanca Obras" icon={<Euro size={16} />} iconColor="var(--amber)" />
          <KpiCard label="Total cobrado" value={formatEuro(obras.totalPago ?? 0)} sub="por condóminos" icon={<CheckCircle2 size={16} />} iconColor="var(--green)" />
          <KpiCard label="Em atraso" value={formatEuro(obras.totalAtraso ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
        </div>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem morosos em obras!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: INCENDIO
// ══════════════════════════════════════════════
function SecaoIncendio({ data: d, onBack }: any) {
  const inc = d.incendio ?? {};
  const morosos = inc.morosos ?? [];
  const totalDerrama = (inc.saldoConta ?? 0) + (inc.aReceber ?? 0);
  return (
    <>
      <PageHeader
        title="Incendio"
        subtitle="Obras de incendio — obra liquidada, reembolso pendente"
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        <div className="rounded-xl border px-4 py-3 flex items-start gap-3"
          style={{ background: "var(--green-subtle)", borderColor: "var(--green)" }}>
          <CheckCircle2 size={16} style={{ color: "var(--green)", marginTop: 2 }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Obra liquidada ao empreiteiro</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Pago com fundos da conta geral (Santander). Saldo da conta incendio = €0.
              Faltam receber €{inc.aReceber?.toFixed(2)} de 3 frações para reembolso.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label="Saldo da conta" value={formatEuro(inc.saldoConta ?? 0)} sub="obra paga" icon={<CheckCircle2 size={16} />} iconColor="var(--green)" />
          <KpiCard label="Por receber" value={formatEuro(inc.aReceber ?? 0)} sub="G / AC / AD" icon={<AlertCircle size={16} />} iconColor="var(--red)" />
          <KpiCard label="Total derrama" value={formatEuro(totalDerrama)} sub="total imputado" icon={<Euro size={16} />} iconColor="var(--blue-bright)" />
        </div>
        {morosos.length > 0 && (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: QUOTA EXTRA
// ══════════════════════════════════════════════
function SecaoQuotaExtra({ data: d, onBack }: any) {
  const qe = d.quotaExtra ?? {};
  const morosos = qe.morosos ?? [];
  const totalCobrado = (qe.saldoConta ?? 0);
  return (
    <>
      <PageHeader
        title="Quota Extra — Divida à Empresa de Manutenção dos Elevadores"
        subtitle={`${morosos.length} frações em divida`}
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label="Saldo conta Abanca" value={formatEuro(qe.saldoConta ?? 0)} sub="valor acumulado" icon={<Euro size={16} />} iconColor="var(--purple)" />
          <KpiCard label="Por cobrar" value={formatEuro(qe.aReceber ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
          <KpiCard label="Total derrama" value={formatEuro((qe.saldoConta ?? 0) + (qe.aReceber ?? 0))} sub="total imputado" icon={<TrendingUp size={16} />} iconColor="var(--blue-bright)" />
        </div>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem pendencias!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: PORTÃO GARAGEM
// ══════════════════════════════════════════════
function SecaoPortaoGaragem({ data: d, onBack }: any) {
  const pg = d.portaoGaragem ?? {};
  const morosos = pg.morosos ?? [];
  return (
    <>
      <PageHeader
        title="Avaria do Portão da Garagem"
        subtitle={`Orçamento OR M/123 · ${morosos.length} frações por pagar`}
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label="Total do orçamento" value={formatEuro(pg.totalOrcamento ?? 707.25)} sub="com IVA (23%)" icon={<DoorOpen size={16} />} iconColor="rgb(249,115,22)" />
          <KpiCard label="Por cobrar" value={formatEuro(pg.aReceber ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
          <KpiCard label="Já pago pelas frações" value={formatEuro(pg.pago ?? 0)} sub={`${Math.round(((pg.pago ?? 0) / (pg.totalOrcamento ?? 707.25)) * 100)}% liquidado`} icon={<TrendingUp size={16} />} iconColor="var(--green)" />
        </div>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Kit motor seccionado marca Sommer — fornecimento e montagem. Vencimento: 28-05-2026.
        </p>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Todas as frações liquidaram!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: MOTOR GARAGEM
// ══════════════════════════════════════════════
function SecaoMotor({ data: d, onBack }: any) {
  const motor = d.motor ?? {};
  const morosos = motor.morosos ?? [];
  return (
    <>
      <PageHeader
        title="Motor da Garagem"
        subtitle={`Quota extra motor · ${morosos.length} frações em dívida`}
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <KpiCard label="Por receber" value={formatEuro(motor.aReceber ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
          <KpiCard label="Frações em dívida" value={String(morosos.length)} sub="col U do Excel" icon={<Cog size={16} />} iconColor="rgb(100,116,139)" />
        </div>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Quota extra motor garagem — fonte: Excel col U. Total em dívida: {formatEuro(motor.aReceber ?? 0)}.
        </p>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Todas as frações liquidaram!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: FUNDO DE RESERVA
// ══════════════════════════════════════════════
function SecaoFundoReserva({ data: d, onBack }: any) {
  const fr = d.fundoReserva ?? {};
  const morosos = fr.morosos ?? [];
  // Check if L has a nota (corrected value due to unregistered payment)
  const morososComNota = morosos.filter((m: any) => m.nota);

  return (
    <>
      <PageHeader
        title="Fundo de Reserva"
        subtitle="Poupanca obrigatoria do condominio"
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">

        {morososComNota.length > 0 && (
          <div className="rounded-xl border px-4 py-3 flex items-start gap-3"
            style={{ background: "rgba(245,158,11,0.08)", borderColor: "var(--amber)" }}>
            <AlertCircle size={15} style={{ color: "var(--amber)", marginTop: 1, flexShrink: 0 }} />
            <div className="space-y-1">
              <p className="text-xs font-semibold" style={{ color: "var(--amber)" }}>Valor corrigido — pagamento não registado</p>
              {morososComNota.map((m: any) => (
                <p key={m.fracao.id} className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  Fração {m.fracao.numero}: {m.nota}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <KpiCard label="Saldo em conta" value={formatEuro(fr.saldoConta ?? 0)} sub="Santander" icon={<PiggyBank size={16} />} iconColor="var(--green)" />
          <KpiCard label="Em atraso" value={formatEuro(fr.totalEmAtraso ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
        </div>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Tudo em dia!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => (
            <div key={m.fracao.id} className="space-y-1">
              <MorososCard m={m} />
              {m.nota && (
                <p className="text-xs px-4 pb-1" style={{ color: "var(--text-muted)" }}>
                  ⚠ {m.nota}
                </p>
              )}
            </div>
          ))}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// SECÇÃO: EXTRA (generico, via quota tipos BD)
// ══════════════════════════════════════════════
function SecaoExtra({ extra, incendioData, onBack }: any) {
  const morosos = extra.morosos ?? [];
  const tipo = extra.tipo;
  const isIncendio = tipo.nome.toLowerCase().includes("incend");

  const totalCobrado = isIncendio ? (incendioData?.saldoConta ?? 0) + (incendioData?.aReceber ?? 0) - (incendioData?.saldoConta ?? 0) : extra.totalPago;
  const totalAtraso = isIncendio ? (incendioData?.aReceber ?? 0) : extra.totalAtraso;
  const totalTotal = isIncendio ? (incendioData?.aReceber ?? 0) : extra.totalTotal;

  return (
    <>
      <PageHeader
        title={tipo.nome}
        subtitle={tipo.descricao ?? "Cota extra"}
        actions={<Button variant="secondary" size="sm" onClick={onBack}><ArrowLeft size={13} /> Voltar</Button>}
      />
      <div className="p-6 space-y-4">
        {isIncendio && (
          <div className="rounded-xl border px-4 py-3 flex items-start gap-3"
            style={{ background: "var(--green-subtle)", borderColor: "var(--green)" }}>
            <CheckCircle2 size={16} style={{ color: "var(--green)", marginTop: 2 }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Obra liquidada</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                O empreiteiro foi pago com fundos da conta geral. Saldo da conta incêndio = €0.
                Em falta: €157.98 de 3 condóminos (G, AC, AD) para reembolso.
              </p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          {isIncendio ? (
            <>
              <KpiCard label="Saldo da conta" value={formatEuro(incendioData?.saldoConta ?? 0)} sub="obra paga ✓" icon={<CheckCircle2 size={16} />} iconColor="var(--green)" />
              <KpiCard label="Por receber" value={formatEuro(incendioData?.aReceber ?? 0)} sub="G / AC / AD" icon={<AlertCircle size={16} />} iconColor="var(--red)" />
              <KpiCard label="Total derrama" value={formatEuro((incendioData?.saldoConta ?? 0) + (incendioData?.aReceber ?? 0))} sub="total imputado" icon={<Euro size={16} />} iconColor="var(--blue-bright)" />
            </>
          ) : (
            <>
              <KpiCard label="Total cobrado" value={formatEuro(extra.totalPago ?? 0)} sub="por condóminos" icon={<CheckCircle2 size={16} />} iconColor="var(--green)" />
              <KpiCard label="Em atraso" value={formatEuro(extra.totalAtraso ?? 0)} sub={`${morosos.length} frações`} icon={<AlertCircle size={16} />} iconColor="var(--red)" />
              <KpiCard label="Total derrama" value={formatEuro(extra.totalTotal ?? 0)} sub="total imputado" icon={<Euro size={16} />} iconColor="var(--blue-bright)" />
            </>
          )}
        </div>
        {morosos.length === 0 ? (
          <Card><CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <CheckCircle2 size={40} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem pendências!</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-3">{morosos.map((m: any) => <MorososCard key={m.fracao.id} m={m} />)}</div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════
// UI helpers
// ══════════════════════════════════════════════
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
      {children}
    </p>
  );
}

function LegendDot({ color, label, opacity }: { color: string; label: string; opacity?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
      <div className="w-3 h-2 rounded-sm" style={{ background: color, opacity: opacity ?? "1" }} />
      {label}
    </div>
  );
}

function MorososRow({ m }: { m: any }) {
  const fracao = m.fracao;
  const meses = m.quotas?.length ?? 0;
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
          style={{ background: "var(--red-subtle)", color: "var(--red)" }}>
          {fracao?.numero}
        </div>
        <div>
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{fracao?.proprietarioNome || "—"}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{meses} {meses === 1 ? "mês" : "meses"} em atraso</p>
        </div>
      </div>
      <p className="text-sm font-mono font-semibold" style={{ color: "var(--red)" }}>{formatEuro(m.total)}</p>
    </div>
  );
}

function MorososCard({ m }: { m: any }) {
  const fracao = m.fracao;
  const quotas = m.quotas ?? [];
  const meses = quotas.length;
  const urgencia = meses >= 3 ? "red" : meses >= 2 ? "amber" : "muted";
  return (
    <Card>
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
              style={{
                background: urgencia === "red" ? "var(--red-subtle)" : urgencia === "amber" ? "var(--amber-subtle)" : "var(--bg-elevated)",
                color: urgencia === "red" ? "var(--red)" : urgencia === "amber" ? "var(--amber)" : "var(--text-secondary)",
              }}>
              {fracao?.numero}
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{fracao?.proprietarioNome || "—"}</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Fração {fracao?.numero}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-base font-mono font-bold" style={{ color: "var(--red)" }}>{formatEuro(m.total)}</p>
            <Badge variant={urgencia as any} className="mt-1">
              <Clock size={10} className="mr-1" />{meses} {meses === 1 ? "mês" : "meses"} em atraso
            </Badge>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {quotas.map((q: any) => (
            <div key={q.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
              style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
              <span>{getMesNome(q.mes)} {q.ano}</span>
              <span className="font-mono font-medium" style={{ color: "var(--amber)" }}>{formatEuro(q.valor)}</span>
            </div>
          ))}
        </div>
        {(fracao?.proprietarioTelefone || fracao?.proprietarioEmail) && (
          <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs mr-1" style={{ color: "var(--text-muted)" }}>Contactar:</span>
            {fracao?.proprietarioTelefone && (
              <a href={`tel:${fracao.proprietarioTelefone}`}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                📞 {fracao.proprietarioTelefone}
              </a>
            )}
            {fracao?.proprietarioEmail && (
              <a href={`mailto:${fracao.proprietarioEmail}?subject=Quota em atraso — Fração ${fracao.numero}`}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}>
                ✉ Email
              </a>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function KpiCard({ label, value, sub, icon, iconColor }: {
  label: string; value: string; sub: string; icon: React.ReactNode; iconColor: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
          <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: "var(--bg-elevated)", color: iconColor }}>
            {icon}
          </div>
        </div>
        <div className="text-xl font-semibold font-mono tracking-tight" style={{ color: "var(--text-primary)" }}>{value}</div>
        <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{sub}</div>
      </CardContent>
    </Card>
  );
}
