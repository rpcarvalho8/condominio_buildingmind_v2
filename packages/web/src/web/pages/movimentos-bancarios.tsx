import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToken } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { formatEuro } from "../lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Movement {
  seq: number;
  dataOperacao: string;
  mes: string;
  ano: string;
  tipo: string;
  descritivo: string;
  montante: number;
  saldo: number;
  categoria: string;
  subCategoria: string;
  categoriaSource: "csv" | "auto" | "unmatched";
  nomeIdentificado?: string;
  fracaoIdentificada?: string | null;
  notaCategorizacao?: string;
}

interface Stats {
  entradas: number;
  saidas: number;
  totalEntradas: number;
  totalSaidas: number;
  saldoFinal: number;
  categorizados: number;
  naoCategorizado: number;
  despesasBancarias: number;
  porFracao: Record<string, { count: number; total: number }>;
  porCategoria: Record<string, { count: number; total: number }>;
}

interface FracaoResumo {
  fracao: string;
  nome: string;
  tipo: string;
  permilage: number;
  totalPago: number;
  numPagamentos: number;
  identificadoNoBanco: boolean;
}

// ─── API helpers ──────────────────────────────────────────────────────────────
function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeaders() });
  return r.json();
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function CatBadge({ source, cat }: { source: string; cat: string }) {
  const color =
    source === "csv"   ? "bg-blue-100 text-blue-700" :
    source === "auto"  ? "bg-green-100 text-green-700" :
    "bg-red-100 text-red-700";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
      {cat || "—"}
    </span>
  );
}

function KpiCard({ label, value, sub, color = "text-gray-900" }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-white rounded-xl border p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
      {/* ── RECONCILIAÇÃO ── */}
      {tab === "reconciliacao" && (
        <div className="space-y-6">
          {/* Engine summary */}
          {reconcData?.resumo && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KpiCard
                label="Total movimentos"
                value={String(reconcData.resumo.totalMovimentos)}
                color="text-gray-900"
              />
              <KpiCard
                label="Categorizados CSV"
                value={String(reconcData.resumo.porSource?.csv ?? 0)}
                sub="originalmente no CSV"
                color="text-blue-600"
              />
              <KpiCard
                label="Categorizados auto"
                value={String(reconcData.resumo.porSource?.auto ?? 0)}
                sub="engine de reconciliação"
                color="text-green-600"
              />
              <KpiCard
                label="Não identificados"
                value={String(reconcData.resumo.porSource?.unmatched ?? 0)}
                sub={`${reconcData.resumo.percentagemCategorizado}% coberto`}
                color={(reconcData.resumo.porSource?.unmatched ?? 0) === 0 ? "text-green-600" : "text-red-600"}
              />
            </div>
          )}

          {/* Portão status */}
          {reconcData?.portaoStatus && (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-5 py-4 border-b">
                <h3 className="font-semibold text-gray-900">Estado do Portão por Fração</h3>
                <p className="text-sm text-gray-500 mt-0.5">Pagamentos portão/garagem identificados no extracto bancário</p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-gray-100">
                {(reconcData.portaoStatus as any[]).sort((a, b) => (b.pago ? 1 : 0) - (a.pago ? 1 : 0)).map((ps: any) => (
                  <div key={ps.fracao} className={`bg-white p-3 ${ps.pago ? "border-l-4 border-green-400" : "border-l-4 border-gray-200"}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-sm text-gray-900">Fração {ps.fracao}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        ps.pago ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                      }`}>
                        {ps.pago ? "Pago" : "Em dívida"}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{ps.nome}</div>
                    <div className="text-sm font-medium text-gray-700 mt-1">{formatEuro(ps.amount)}</div>
                    {ps.pagamentos?.length > 0 && (
                      <div className="text-xs text-green-600 mt-1">{ps.pagamentos[0].data}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Auto-categorised movements */}
          {reconcData?.autoCatEntradas && (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-5 py-4 border-b flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">Movimentos auto-categorizados</h3>
                  <p className="text-sm text-gray-500 mt-0.5">Entradas categorizadas pelo engine (não tinham categoria no CSV)</p>
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
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fração</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(reconcData.autoCatEntradas as any[]).map((m: any, i: number) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{m.data}</td>
                        <td className="px-4 py-2 text-gray-700 max-w-[200px] truncate" title={m.descritivo}>{m.descritivo}</td>
                        <td className="px-4 py-2 text-right font-medium text-green-700">{formatEuro(m.montante)}</td>
                        <td className="px-4 py-2">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                            {m.categoria}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {m.subCategoria && (
                            <span className="font-bold text-blue-700">{m.subCategoria}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 max-w-[200px] truncate" title={m.nota}>{m.nota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function MovimentosBancariosPage() {
  const [tab, setTab] = useState<"overview" | "movimentos" | "fracoes" | "categorias" | "reconciliacao">("overview");
  const [filterCat, setFilterCat]       = useState("");
  const [filterFracao, setFilterFracao] = useState("");
  const [filterTipo, setFilterTipo]     = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [page, setPage] = useState(1);

  // Overview data
  const { data: overview } = useQuery({
    queryKey: ["bank-movements-overview"],
    queryFn: () => apiFetch<any>("/api/bank-movements?force=1"),
    staleTime: 60_000,
  });

  const { data: fracoesData } = useQuery({
    queryKey: ["bank-movements-fracoes"],
    queryFn: () => apiFetch<any>("/api/bank-movements/resumo-fracoes"),
    staleTime: 60_000,
  });

  const { data: catData } = useQuery({
    queryKey: ["bank-movements-cats"],
    queryFn: () => apiFetch<any>("/api/bank-movements/categorias"),
    staleTime: 60_000,
  });

  const { data: reconcData } = useQuery({
    queryKey: ["bank-movements-reconciliacao"],
    queryFn: () => apiFetch<any>("/api/bank-movements/reconciliacao"),
    staleTime: 60_000,
    enabled: tab === "reconciliacao",
  });

  const stats: Stats | null = overview?.condominio?.estatisticas ?? null;
  const fracoes: FracaoResumo[] = fracoesData?.resumo ?? [];
  const categorias: { categoria: string; count: number; total: number }[] = catData?.categorias ?? [];

  // Movimentos — dentro do React Query para responder a invalidateQueries()
  const { data: movData, isLoading: movLoading } = useQuery({
    queryKey: ["bank-movements-lista", page, filterCat, filterFracao, filterTipo, filterSource],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "50" });
      if (filterCat)    params.set("categoria", filterCat);
      if (filterFracao) params.set("fracao", filterFracao);
      if (filterTipo)   params.set("tipo", filterTipo);
      if (filterSource) params.set("source", filterSource);
      return apiFetch<any>(`/api/bank-movements/condominio?${params}`);
    },
    enabled: tab === "movimentos",
    staleTime: 30_000,
  });

  const movimentos: Movement[] = movData?.movimentos ?? [];
  const totalMov: number = movData?.total ?? 0;

  const TABS = [
    { id: "overview",       label: "Resumo" },
    { id: "movimentos",     label: "Movimentos" },
    { id: "fracoes",        label: "Por Fração" },
    { id: "categorias",     label: "Categorias" },
    { id: "reconciliacao",  label: "Reconciliação" },
  ] as const;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Movimentos Bancários"
        subtitle="Extracto Santander auto-categorizado — conta condomínio (2023–2026)"
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
          {!stats ? (
            <div className="text-center py-20 text-gray-500">A processar extracto bancário...</div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                  label="Saldo actual"
                  value={formatEuro(stats.saldoFinal)}
                  sub="conta corrente"
                />
                <KpiCard
                  label="Total entradas"
                  value={formatEuro(stats.totalEntradas)}
                  sub={`${stats.entradas} movimentos`}
                  color="text-green-700"
                />
                <KpiCard
                  label="Total saídas"
                  value={formatEuro(stats.totalSaidas)}
                  sub={`${stats.saidas} movimentos`}
                  color="text-red-700"
                />
                <KpiCard
                  label="Categorizados"
                  value={`${stats.categorizados}/${stats.entradas + stats.saidas}`}
                  sub={stats.naoCategorizado === 0 ? "✓ 100% identificados" : `${stats.naoCategorizado} por identificar`}
                  color="text-blue-700"
                />
              </div>

              {/* Categorisation status */}
              <div className="bg-white rounded-xl border p-5">
                <h3 className="font-semibold text-gray-900 mb-3">Estado da Categorização Automática</h3>
                <div className="flex gap-6 flex-wrap mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"/>
                    <span className="text-sm text-gray-700">Do CSV original ({stats.categorizados - Object.values(stats.porFracao).reduce((s, v) => s + v.count, 0)} mov.)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-green-500 inline-block"/>
                    <span className="text-sm text-gray-700">Auto-identificados pelo motor</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-gray-300 inline-block"/>
                    <span className="text-sm text-gray-700">{stats.despesasBancarias} encargos bancários (comissões/imp.selo)</span>
                  </div>
                </div>
                {stats.naoCategorizado === 0 ? (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                    ✓ Todos os {stats.entradas + stats.saidas} movimentos foram categorizados com sucesso (2023–Jan 2026).
                  </div>
                ) : (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                    ⚠ {stats.naoCategorizado} movimentos ainda não identificados — ver tab "Movimentos" com filtro "Não identificado".
                  </div>
                )}
              </div>

              {/* Top frações */}
              <div className="bg-white rounded-xl border p-5">
                <h3 className="font-semibold text-gray-900 mb-4">Pagamentos identificados por Fração</h3>
                <div className="space-y-2">
                  {Object.entries(stats.porFracao)
                    .sort(([, a], [, b]) => b.total - a.total)
                    .map(([fr, v]) => {
                      const maxTotal = Math.max(...Object.values(stats.porFracao).map(x => x.total));
                      return (
                        <div key={fr} className="flex items-center gap-3">
                          <span className="text-xs font-mono bg-gray-100 px-2 py-1 rounded w-10 text-center shrink-0">{fr}</span>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div
                              className="bg-blue-500 h-2 rounded-full transition-all"
                              style={{ width: `${(v.total / maxTotal) * 100}%` }}
                            />
                          </div>
                          <span className="text-sm font-medium w-28 text-right">{formatEuro(v.total)}</span>
                          <span className="text-xs text-gray-500 w-16 text-right">{v.count} pag.</span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Note on cut-off */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <strong>Nota:</strong> O extracto CSV cobre os movimentos até 30 Janeiro 2026. Pagamentos posteriores (Fev–Mai 2026) 
                constam de outros documentos (capturas de ecrã partilhadas) mas não estão neste ficheiro.
              </div>
            </>
          )}
        </div>
      )}

      {/* ── MOVIMENTOS ── */}
      {tab === "movimentos" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-xl border p-4 flex flex-wrap gap-3 items-center">
            <select
              value={filterTipo}
              onChange={e => { setFilterTipo(e.target.value); setPage(1); }}
              className="text-sm border rounded-lg px-3 py-2 bg-white"
            >
              <option value="">Tipo: Todos</option>
              <option value="Entrada">Entradas</option>
              <option value="Saída">Saídas</option>
            </select>
            <select
              value={filterSource}
              onChange={e => { setFilterSource(e.target.value); setPage(1); }}
              className="text-sm border rounded-lg px-3 py-2 bg-white"
            >
              <option value="">Fonte: Todas</option>
              <option value="csv">Do CSV original</option>
              <option value="auto">Auto-categorizado</option>
              <option value="unmatched">Não identificado</option>
            </select>
            <select
              value={filterCat}
              onChange={e => { setFilterCat(e.target.value); setPage(1); }}
              className="text-sm border rounded-lg px-3 py-2 bg-white"
            >
              <option value="">Categoria: Todas</option>
              {categorias.map(c => (
                <option key={c.categoria} value={c.categoria}>{c.categoria}</option>
              ))}
            </select>
            <input
              type="text"
              value={filterFracao}
              onChange={e => { setFilterFracao(e.target.value.toUpperCase()); setPage(1); }}
              placeholder="Fração (ex: L)"
              className="text-sm border rounded-lg px-3 py-2 w-32"
            />
            <button
              onClick={() => { setFilterTipo(""); setFilterSource(""); setFilterCat(""); setFilterFracao(""); setPage(1); }}
              className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 border rounded-lg"
            >
              Limpar filtros
            </button>
            <div className="ml-auto text-sm text-gray-500">{totalMov} resultados</div>
          </div>

          {movLoading ? (
            <div className="text-center py-10 text-gray-500">A carregar...</div>
          ) : (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Data</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Descritivo</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Categoria</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fração</th>
                      <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase whitespace-nowrap">Montante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {movimentos.map((m, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap font-mono text-xs">
                          {m.dataOperacao}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="text-gray-900 truncate" title={m.descritivo}>{m.descritivo}</div>
                          {m.notaCategorizacao && (
                            <div className="text-xs text-gray-400 mt-0.5 truncate" title={m.notaCategorizacao}>
                              {m.notaCategorizacao}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <CatBadge source={m.categoriaSource} cat={m.categoria} />
                        </td>
                        <td className="px-4 py-3">
                          {m.subCategoria ? (
                            <span className="text-xs font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-bold">
                              {m.subCategoria}
                            </span>
                          ) : "—"}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-medium whitespace-nowrap ${
                          m.montante > 0 ? "text-green-700" : "text-red-700"
                        }`}>
                          {m.montante > 0 ? "+" : ""}{formatEuro(Math.abs(m.montante))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="px-4 py-3 border-t flex items-center justify-between">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                  className="text-sm px-3 py-1.5 border rounded-lg disabled:opacity-40 hover:bg-gray-50"
                >
                  ← Anterior
                </button>
                <span className="text-sm text-gray-500">
                  Página {page} de {Math.ceil(totalMov / 50)} ({totalMov} total)
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

      {/* ── POR FRAÇÃO ── */}
      {tab === "fracoes" && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
            <strong>Nota:</strong> Os pagamentos mostrados provêm exclusivamente do extracto bancário CSV (2023–Jan 2026).
            Frações com "Sem pagamentos" podem ter pago por débito direto, referência MB, ou após Jan 2026.
          </div>
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">FR</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Proprietário</th>
                    <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Tipo</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">‰</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pag.</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Total Pago</th>
                    <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {fracoes.map(fr => (
                    <tr key={fr.fracao} className={`hover:bg-gray-50 ${!fr.identificadoNoBanco ? "bg-amber-50/50" : ""}`}>
                      <td className="px-4 py-3">
                        <span className="font-mono font-bold text-gray-900 bg-gray-100 px-2 py-1 rounded text-xs">
                          {fr.fracao}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{fr.nome}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          fr.tipo === "habitacao" ? "bg-blue-100 text-blue-700" :
                          fr.tipo === "loja"      ? "bg-purple-100 text-purple-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {fr.tipo}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 font-mono text-xs">{fr.permilage.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{fr.numPagamentos}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{formatEuro(fr.totalPago)}</td>
                      <td className="px-4 py-3 text-center">
                        {fr.identificadoNoBanco ? (
                          <span className="text-xs text-green-700 font-medium">✓ Identificado</span>
                        ) : (
                          <span className="text-xs text-amber-700">Sem dados</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-sm font-medium text-gray-700">Total</td>
                    <td className="px-4 py-3 text-right font-medium">{fracoes.reduce((s, f) => s + f.numPagamentos, 0)}</td>
                    <td className="px-4 py-3 text-right font-bold text-gray-900">
                      {formatEuro(fracoes.reduce((s, f) => s + f.totalPago, 0))}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── CATEGORIAS ── */}
      {tab === "categorias" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border p-5">
            <h3 className="font-semibold text-gray-900 mb-4">Distribuição por Categoria (condomínio + obras)</h3>
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
          {/* Engine summary */}
          {reconcData?.resumo && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KpiCard
                label="Total movimentos"
                value={String(reconcData.resumo.totalMovimentos)}
                color="text-gray-900"
              />
              <KpiCard
                label="Categorizados CSV"
                value={String(reconcData.resumo.porSource?.csv ?? 0)}
                sub="originalmente no CSV"
                color="text-blue-600"
              />
              <KpiCard
                label="Categorizados auto"
                value={String(reconcData.resumo.porSource?.auto ?? 0)}
                sub="engine de reconciliação"
                color="text-green-600"
              />
              <KpiCard
                label="Não identificados"
                value={String(reconcData.resumo.porSource?.unmatched ?? 0)}
                sub={`${reconcData.resumo.percentagemCategorizado}% coberto`}
                color={(reconcData.resumo.porSource?.unmatched ?? 0) === 0 ? "text-green-600" : "text-red-600"}
              />
            </div>
          )}

          {/* Portão status */}
          {reconcData?.portaoStatus && (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-5 py-4 border-b">
                <h3 className="font-semibold text-gray-900">Estado do Portão por Fração</h3>
                <p className="text-sm text-gray-500 mt-0.5">Pagamentos portão/garagem identificados no extracto bancário</p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-px bg-gray-100">
                {(reconcData.portaoStatus as any[]).sort((a, b) => (b.pago ? 1 : 0) - (a.pago ? 1 : 0)).map((ps: any) => (
                  <div key={ps.fracao} className={`bg-white p-3 ${ps.pago ? "border-l-4 border-green-400" : "border-l-4 border-gray-200"}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-sm text-gray-900">Fração {ps.fracao}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        ps.pago ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                      }`}>
                        {ps.pago ? "Pago" : "Em dívida"}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{ps.nome}</div>
                    <div className="text-sm font-medium text-gray-700 mt-1">{formatEuro(ps.amount)}</div>
                    {ps.pagamentos?.length > 0 && (
                      <div className="text-xs text-green-600 mt-1">{ps.pagamentos[0].data}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Auto-categorised movements */}
          {reconcData?.autoCatEntradas && (
            <div className="bg-white rounded-xl border overflow-hidden">
              <div className="px-5 py-4 border-b flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">Movimentos auto-categorizados</h3>
                  <p className="text-sm text-gray-500 mt-0.5">Entradas categorizadas pelo engine (não tinham categoria no CSV)</p>
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
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Fração</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Nota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(reconcData.autoCatEntradas as any[]).map((m: any, i: number) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{m.data}</td>
                        <td className="px-4 py-2 text-gray-700 max-w-[200px] truncate" title={m.descritivo}>{m.descritivo}</td>
                        <td className="px-4 py-2 text-right font-medium text-green-700">{formatEuro(m.montante)}</td>
                        <td className="px-4 py-2">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                            {m.categoria}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {m.subCategoria && (
                            <span className="font-bold text-blue-700">{m.subCategoria}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 max-w-[200px] truncate" title={m.nota}>{m.nota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
