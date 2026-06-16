import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getToken } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { formatEuro } from "../lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Movement {
  id: string;
  dataOperacao: string;
  descritivo: string;
  montante: number;
  tipo: "Entrada" | "Saída";
  categoria: string;
  categoriaSource: "auto" | "unmatched";
  nomeIdentificado?: string;
  notaCategorizacao?: string;
  status: string;
  requiresReview: boolean;
}

interface Stats {
  entradas: number;
  saidas: number;
  totalEntradas: number;
  totalSaidas: number;
  saldoFinal: number;
  categorizados: number;
  naoCategorizado: number;
  porCategoria: Record<string, { count: number; total: number }>;
}

// ─── API helpers ──────────────────────────────────────────────────────────────
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function patchClassificacao(
  id: string,
  classificacao: string,
  debtorName?: string,
): Promise<void> {
  const r = await fetch(`/api/bank-movements/${id}/classificacao`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    // debtorName é usado pelo backend para inferir a fração e criar a quota
    body: JSON.stringify({ classificacao, ...(debtorName ? { debtorName } : {}) }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as any).error ?? `HTTP ${r.status}`);
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = "text-gray-900" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

// ─── Opções de classificação reais do condomínio ─────────────────────────────
const CLASSIFICACOES = [
  { value: "quota",          label: "Quota Condomínio Regular" },
  { value: "quota_obras",    label: "Quota Extra Obras" },
  { value: "quota_incendio", label: "Quota Extra Incêndio" },
  { value: "quota_motor",    label: "Quota Extra Motor Garagem" },
  { value: "despesa",        label: "Despesa / Pagamento" },
];

// ─── Toast component ──────────────────────────────────────────────────────────
function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center gap-3 bg-green-600 text-white px-5 py-3 rounded-xl shadow-xl text-sm font-medium max-w-sm">
        <span className="text-lg">✅</span>
        <span>{message}</span>
        <button onClick={onDone} className="ml-auto text-green-200 hover:text-white text-lg leading-none">×</button>
      </div>
    </div>
  );
}

function ClassDropdown({ id, current, debtorName, onSave }: {
  id: string;
  current: string;
  debtorName?: string;
  onSave: (id: string, val: string, debtorName?: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (!val) return;
    setSaving(true);
    try {
      await onSave(id, val, debtorName);
    } finally {
      setSaving(false);
    }
  }

  const normalised = CLASSIFICACOES.find(c => c.value === current)?.value ?? "";

  return (
    <select
      value={normalised}
      onChange={handleChange}
      disabled={saving}
      className={`text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white text-gray-900 font-medium
        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500
        hover:border-gray-400 cursor-pointer transition-all
        ${saving ? "opacity-50 cursor-wait" : ""}`}
    >
      <option value="" className="text-gray-500">— Não classificado —</option>
      {CLASSIFICACOES.map(c => (
        <option key={c.value} value={c.value} className="text-gray-900">{c.label}</option>
      ))}
    </select>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MovimentosBancariosPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"overview" | "movimentos" | "categorias" | "reconciliacao">("overview");
  const [filterCat, setFilterCat]   = useState("");
  const [filterTipo, setFilterTipo] = useState("");
  const [page, setPage]             = useState(1);
  const [toast, setToast]           = useState<string | null>(null);

  // ── Overview (stats gerais) ──
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ["bm-overview"],
    queryFn: () => apiFetch<any>("/api/bank-movements?force=1"),
    staleTime: 60_000,
  });

  // ── Categorias ──
  const { data: catData } = useQuery({
    queryKey: ["bm-categorias"],
    queryFn: () => apiFetch<any>("/api/bank-movements/categorias"),
    staleTime: 60_000,
  });

  // ── Reconciliação ──
  const { data: reconcData } = useQuery({
    queryKey: ["bm-reconciliacao"],
    queryFn: () => apiFetch<any>("/api/bank-movements/reconciliacao"),
    staleTime: 60_000,
    enabled: tab === "reconciliacao",
  });

  // ── Lista movimentos ──
  const { data: movData, isLoading: movLoading } = useQuery({
    queryKey: ["bm-lista", page, filterCat, filterTipo],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (filterCat)  params.set("categoria", filterCat);
      if (filterTipo) params.set("tipo", filterTipo);
      return apiFetch<any>(`/api/bank-movements/condominio?${params}`);
    },
    enabled: tab === "movimentos",
    staleTime: 30_000,
  });

  // ── Mutation: gravar classificação + disparar cascata ──
  const classifyMutation = useMutation({
    mutationFn: ({ id, val, debtorName }: { id: string; val: string; debtorName?: string }) =>
      patchClassificacao(id, val, debtorName),
    onSuccess: () => {
      // Invalidar todos os dados dependentes — dashboard, lista, categorias
      qc.invalidateQueries({ queryKey: ["bm-lista"] });
      qc.invalidateQueries({ queryKey: ["bm-overview"] });
      qc.invalidateQueries({ queryKey: ["bm-categorias"] });
      qc.invalidateQueries({ queryKey: ["bm-reconciliacao"] });
      // Dashboard cards também precisam de refresh
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["fracoes"] });
      qc.invalidateQueries({ queryKey: ["quotas"] });
      qc.invalidateQueries({ queryKey: ["morosos"] });
      // Toast + reload forçado para garantir que não há cache a mascarar os dados reais
      setToast("✨ Movimento reclassificado! A recarregar...");
      setTimeout(() => window.location.reload(), 1200);
    },
    onError: (err: Error) => {
      setToast(`❌ Erro ao reclassificar: ${err.message}`);
    },
  });

  const stats: Stats | null = overview?.condominio?.estatisticas ?? null;
  const movimentos: Movement[] = movData?.movimentos ?? [];
  const totalMov: number       = movData?.total ?? 0;
  const categorias: { categoria: string; count: number; total: number }[] = catData?.categorias ?? [];

  const TABS = [
    { id: "overview",      label: "Resumo" },
    { id: "movimentos",    label: "Movimentos" },
    { id: "categorias",    label: "Categorias" },
    { id: "reconciliacao", label: "Reconciliação" },
  ] as const;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Toast global */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <PageHeader
        title="Movimentos Bancários"
        subtitle="Transacções Enable Banking — conta condomínio"
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-b-2 border-blue-600 text-blue-700"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {overviewLoading ? (
            <div className="text-center py-20 text-gray-500">A carregar dados...</div>
          ) : !stats ? (
            /* DB vazia — sem transacções Enable Banking */
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center text-3xl">🏦</div>
              <div className="text-center max-w-md">
                <p className="text-lg font-semibold text-gray-800 mb-2">Sem movimentos bancários registados</p>
                <p className="text-sm text-gray-500">
                  Ainda não existem transacções sincronizadas via Enable Banking.
                  Liga a conta bancária em <strong>Definições → Enable Banking</strong> para iniciar a sincronização.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                  label="Saldo actual"
                  value={formatEuro(stats.saldoFinal)}
                  sub="entradas − saídas"
                />
                <KpiCard
                  label="Total entradas"
                  value={formatEuro(stats.totalEntradas)}
                  sub={`${stats.entradas} transacções`}
                  color="text-green-700"
                />
                <KpiCard
                  label="Total saídas"
                  value={formatEuro(stats.totalSaidas)}
                  sub={`${stats.saidas} transacções`}
                  color="text-red-700"
                />
                <KpiCard
                  label="Classificadas"
                  value={`${stats.categorizados}/${stats.entradas + stats.saidas}`}
                  sub={stats.naoCategorizado === 0
                    ? "✓ 100% classificadas"
                    : `${stats.naoCategorizado} por classificar`}
                  color="text-blue-700"
                />
              </div>

              {/* Estado classificação */}
              {stats.naoCategorizado > 0 && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                  ⚠ <strong>{stats.naoCategorizado}</strong> transacções aguardam classificação manual — abre o separador <strong>Movimentos</strong> para as classificar.
                </div>
              )}

              {/* Top categorias */}
              {Object.keys(stats.porCategoria).length > 0 && (
                <div className="bg-white rounded-xl border p-5">
                  <h3 className="font-semibold text-gray-900 mb-4">Distribuição por Categoria</h3>
                  <div className="space-y-2">
                    {Object.entries(stats.porCategoria)
                      .sort(([, a], [, b]) => b.total - a.total)
                      .map(([cat, v]) => {
                        const maxTotal = Math.max(...Object.values(stats.porCategoria).map(x => x.total));
                        return (
                          <div key={cat} className="flex items-center gap-3">
                            <span className="text-sm text-gray-700 w-44 truncate shrink-0" title={cat}>{cat}</span>
                            <div className="flex-1 bg-gray-100 rounded-full h-2">
                              <div
                                className="bg-blue-500 h-2 rounded-full transition-all"
                                style={{ width: `${(v.total / maxTotal) * 100}%` }}
                              />
                            </div>
                            <span className="text-sm font-medium w-28 text-right">{formatEuro(v.total)}</span>
                            <span className="text-xs text-gray-500 w-16 text-right">{v.count} mov.</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── MOVIMENTOS ── */}
      {tab === "movimentos" && (
        <div className="space-y-4">
          {/* Filtros */}
          <div className="bg-white rounded-xl border p-4 flex flex-wrap gap-3 items-center">
            <select
              value={filterTipo}
              onChange={e => { setFilterTipo(e.target.value); setPage(1); }}
              className="text-sm border rounded-lg px-3 py-2 bg-white text-gray-900 font-medium"
            >
              <option value="">Tipo: Todos</option>
              <option value="Entrada">Entradas</option>
              <option value="Saída">Saídas</option>
            </select>
            <select
              value={filterCat}
              onChange={e => { setFilterCat(e.target.value); setPage(1); }}
              className="text-sm border rounded-lg px-3 py-2 bg-white text-gray-900 font-medium"
            >
              <option value="">Categoria: Todas</option>
              {categorias.map(c => (
                <option key={c.categoria} value={c.categoria}>{c.categoria}</option>
              ))}
            </select>
            <button
              onClick={() => { setFilterTipo(""); setFilterCat(""); setPage(1); }}
              className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 border rounded-lg"
            >
              Limpar filtros
            </button>
            <div className="ml-auto text-sm text-gray-500">{totalMov} resultados</div>
          </div>

          {movLoading ? (
            <div className="text-center py-10 text-gray-500">A carregar...</div>
          ) : movimentos.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-2xl">🏦</div>
              <p className="text-gray-500 text-sm">Sem movimentos bancários registados pelo Enable Banking.</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Data</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Descritivo</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Classificação</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Montante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {movimentos.map((m) => (
                      <tr key={m.id} className={`hover:bg-gray-50 transition-colors ${m.requiresReview ? "bg-amber-50/40" : ""}`}>
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap font-mono text-xs">
                          {m.dataOperacao}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="text-gray-900 truncate" title={m.descritivo}>{m.descritivo}</div>
                          {m.notaCategorizacao && m.notaCategorizacao !== m.descritivo && (
                            <div className="text-xs text-gray-400 mt-0.5 truncate" title={m.notaCategorizacao}>
                              {m.notaCategorizacao}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <ClassDropdown
                            id={m.id}
                            current={m.categoria}
                            debtorName={m.nomeIdentificado}
                            onSave={(id, val, dn) => classifyMutation.mutateAsync({ id, val, debtorName: dn })}
                          />
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-medium whitespace-nowrap ${
                          m.montante >= 0 ? "text-green-700" : "text-red-700"
                        }`}>
                          {m.montante >= 0 ? "+" : ""}{formatEuro(Math.abs(m.montante))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Paginação */}
              <div className="px-4 py-3 border-t flex items-center justify-between">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                  className="text-sm px-3 py-1.5 border rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  ← Anterior
                </button>
                <span className="text-sm text-gray-500">
                  Página {page} de {Math.ceil(totalMov / 50) || 1} ({totalMov} total)
                </span>
                <button
                  disabled={page * 50 >= totalMov}
                  onClick={() => setPage(p => p + 1)}
                  className="text-sm px-3 py-1.5 border rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  Seguinte →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CATEGORIAS ── */}
      {tab === "categorias" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border p-5">
            <h3 className="font-semibold text-gray-900 mb-4">Distribuição por Categoria</h3>
            {categorias.length === 0 ? (
              <p className="text-sm text-gray-400">Sem transacções classificadas.</p>
            ) : (
              <div className="space-y-3">
                {categorias.map(c => {
                  const maxTotal = categorias[0]?.total ?? 1;
                  return (
                    <div key={c.categoria} className="flex items-center gap-3">
                      <div className="w-52 text-sm text-gray-700 truncate shrink-0" title={c.categoria}>
                        {c.categoria}
                      </div>
                      <div className="flex-1 bg-gray-100 rounded-full h-3">
                        <div
                          className="bg-blue-500 h-3 rounded-full"
                          style={{ width: `${(c.total / maxTotal) * 100}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-28 text-right">{formatEuro(c.total)}</span>
                      <span className="text-xs text-gray-500 w-16 text-right">{c.count} mov.</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Categoria</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Movimentos</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {categorias.map(c => (
                  <tr key={c.categoria} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700">{c.categoria}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{c.count}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatEuro(c.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t">
                <tr>
                  <td className="px-4 py-3 font-medium text-gray-700">Total geral</td>
                  <td className="px-4 py-3 text-right font-medium">{categorias.reduce((s, c) => s + c.count, 0)}</td>
                  <td className="px-4 py-3 text-right font-bold">{formatEuro(categorias.reduce((s, c) => s + c.total, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── RECONCILIAÇÃO ── */}
      {tab === "reconciliacao" && (
        <div className="space-y-6">
          {reconcData?.resumo && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KpiCard label="Total movimentos" value={String(reconcData.resumo.totalMovimentos)} />
              <KpiCard
                label="Classificados (auto)"
                value={String(reconcData.resumo.porSource?.auto ?? 0)}
                sub="com importType definido"
                color="text-green-600"
              />
              <KpiCard
                label="Por classificar"
                value={String(reconcData.resumo.porSource?.unmatched ?? 0)}
                color={(reconcData.resumo.porSource?.unmatched ?? 0) === 0 ? "text-green-600" : "text-amber-600"}
              />
              <KpiCard
                label="Cobertura"
                value={`${reconcData.resumo.percentagemCategorizado}%`}
                color="text-blue-600"
              />
            </div>
          )}

          {reconcData?.autoCatEntradas?.length > 0 && (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-5 py-4 border-b flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">Transacções classificadas</h3>
                  <p className="text-sm text-gray-500 mt-0.5">Entradas com classificação atribuída</p>
                </div>
                <span className="text-sm text-gray-500">{reconcData.autoCatEntradas.length} registos</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Data</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Descritivo</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Montante</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Categoria</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(reconcData.autoCatEntradas as any[]).map((m: any, i: number) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{m.data ?? "—"}</td>
                        <td className="px-4 py-2 text-gray-700 max-w-[200px] truncate" title={m.descritivo}>{m.descritivo ?? "—"}</td>
                        <td className="px-4 py-2 text-right font-medium text-green-700">{formatEuro(m.montante ?? 0)}</td>
                        <td className="px-4 py-2">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                            {m.categoria ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 max-w-[200px] truncate" title={m.nota}>{m.nota ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!reconcData && (
            <div className="text-center py-10 text-gray-400">A carregar...</div>
          )}
        </div>
      )}
    </div>
  );
}
