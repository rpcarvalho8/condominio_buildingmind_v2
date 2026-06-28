/**
 * Recibos Mensais
 * Gera PDFs de recibo para cada fração com quotas pagas no mês
 *
 * Routes:
 *   POST /api/recibos/gerar          → gera recibos para mês/ano
 *   GET  /api/recibos                → lista recibos
 *   GET  /api/recibos/:id/pdf        → download PDF de um recibo
 *   POST /api/recibos/:id/email      → reenviar email de um recibo
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { exec } from "node:child_process";

// ─── Logo base64 (embedded for PDF generation) ──────────────────────────────
const LOGO_PATH = path.join(process.cwd(), "public", "logo_condominio.png");
let LOGO_B64 = "";
try {
  LOGO_B64 = fs.readFileSync(LOGO_PATH).toString("base64");
} catch {}

// ─── Config ─────────────────────────────────────────────────────────────────
const CONDOMINIO = {
  nome: "Condomínio Urbanização da Fonte",
  morada: "Rua Poeta António Boto, 21, 37 e 39",
  localidade: "4785-390 Trofa",
  nif: "901932027",
};

const PDF_DIR = path.join(process.cwd(), "data", "recibos");
fs.mkdirSync(PDF_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function formatEur(v: number): string {
  return v.toFixed(2).replace(".", ",");
}

const MESES = [
  "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// ─── Recibo sequence ──────────────────────────────────────────────────────────
// Número global contínuo (não reinicia por ano)
// Último recibo emitido manualmente: 2026.94 → próximo é 2026.95
const RECIBO_SEQ_OFFSET = 94; // last manually-issued recibo for 2026

async function getLastReciboSeq(ano: number): Promise<number> {
  const rows = await db.select({ n: schema.recibos.numeroRecibo })
    .from(schema.recibos)
    .orderBy(desc(schema.recibos.createdAt))
    .limit(200);
  
  let maxSeq = RECIBO_SEQ_OFFSET; // start from 94 minimum
  for (const r of rows) {
    if (!r.n) continue;
    const parts = r.n.split(".");
    if (parts[0] === String(ano)) {
      const s = parseInt(parts[1] ?? "0");
      if (s > maxSeq) maxSeq = s;
    }
  }
  return maxSeq;
}

// ─── Morada da fração ─────────────────────────────────────────────────────────
function buildMoradaFracao(fracao: { numero: string; proprietarioMorada?: string | null; tipo: string }): string {
  // If stored morada exists, use it
  if (fracao.proprietarioMorada) return fracao.proprietarioMorada;
  // Fallback: generic condominio address
  return `Rua Poeta António Boto, Urbanização da Fonte`;
}

// ─── HTML template ────────────────────────────────────────────────────────────
function buildReciboHtml(data: {
  numeroRecibo: string;
  dataDocumento: string;
  fracao: { numero: string };
  proprietario: { nome: string; morada: string; localidade: string; nif?: string };
  linhas: { fracao: string; descricao: string; vencimento: string; dataPagamento: string; valor: number }[];
  total: number;
  metodoPagamento: string;
}): string {
  const logoSrc = LOGO_B64 ? `data:image/png;base64,${LOGO_B64}` : "";
  
  const linhasHtml = data.linhas.map(l => `
    <tr>
      <td>${l.fracao}</td>
      <td>${l.descricao}</td>
      <td>${l.vencimento}</td>
      <td>${l.dataPagamento}</td>
      <td class="right">${formatEur(l.valor)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Calibri", "Arial", sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    background: white;
    padding: 28mm 20mm 20mm 20mm;
    position: relative;
  }

  /* Decorative corner triangles */
  .corner-tl {
    position: fixed;
    top: 0; left: 0;
    width: 0; height: 0;
    border-style: solid;
    border-width: 55px 55px 0 0;
    border-color: #b5a99a transparent transparent transparent;
    opacity: 0.55;
  }
  .corner-br {
    position: fixed;
    bottom: 0; right: 0;
    width: 0; height: 0;
    border-style: solid;
    border-width: 0 0 55px 55px;
    border-color: transparent transparent #b5a99a transparent;
    opacity: 0.55;
  }

  /* Right sidebar line */
  .sidebar-line {
    position: fixed;
    top: 0; right: 18mm;
    width: 1.5px;
    height: 100%;
    background: #b5a99a;
    opacity: 0.4;
  }

  /* Logo top-right */
  .header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
  }
  .logo-img {
    width: 130px;
    opacity: 0.9;
  }

  /* Recibo info top-right */
  .recibo-info {
    text-align: right;
    margin-bottom: 20px;
  }
  .recibo-info .numero {
    font-size: 13pt;
    font-weight: bold;
  }
  .recibo-info .original {
    font-size: 10pt;
    color: #555;
  }
  .recibo-info .data {
    font-size: 10pt;
    color: #333;
  }

  /* Partes */
  .partes {
    display: flex;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  .condominio {
    font-size: 10.5pt;
  }
  .condominio strong {
    font-size: 11pt;
    display: block;
    margin-bottom: 2px;
  }
  .destinatario {
    text-align: left;
    font-size: 10.5pt;
    max-width: 52%;
  }
  .destinatario .label {
    font-style: italic;
    color: #555;
    margin-bottom: 2px;
    font-size: 9.5pt;
  }

  .nif-row {
    margin-bottom: 20px;
    font-size: 10.5pt;
  }

  .intro {
    margin-bottom: 10px;
    font-size: 10.5pt;
  }

  /* Tabela */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
    margin-bottom: 6px;
  }
  thead tr {
    border-bottom: 1.5px solid #333;
  }
  thead th {
    padding: 5px 6px;
    font-weight: 600;
    text-align: left;
    font-size: 9.5pt;
    text-decoration: underline;
  }
  thead th.right, tbody td.right {
    text-align: right;
  }
  tbody tr {
    border-bottom: 0.5px solid #ddd;
  }
  tbody td {
    padding: 5px 6px;
    vertical-align: top;
  }
  .total-row {
    display: flex;
    justify-content: flex-end;
    gap: 20px;
    border-top: 1px solid #333;
    padding-top: 4px;
    margin-top: 2px;
    font-size: 10pt;
  }
  .total-row .label { font-weight: 600; }
  .total-row .value { font-weight: 600; min-width: 60px; text-align: right; }

  .iva-note {
    font-size: 8.5pt;
    color: #555;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .pagamento {
    font-size: 10.5pt;
    margin-bottom: 40px;
  }
  .pagamento strong { font-weight: 600; }

  .assinatura {
    margin-top: 20px;
    font-size: 10.5pt;
  }
  .assinatura .admin-label {
    margin-bottom: 30px;
  }
  .assinatura .nome-italico {
    font-style: italic;
    margin-bottom: 4px;
  }
  .assinatura .linha {
    width: 200px;
    border-bottom: 1px solid #333;
  }

  .pagina {
    position: fixed;
    bottom: 10mm;
    right: 25mm;
    font-size: 9pt;
    color: #888;
  }
</style>
</head>
<body>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="sidebar-line"></div>

  <!-- Logo -->
  <div class="header">
    ${logoSrc ? `<img class="logo-img" src="${logoSrc}" />` : ""}
  </div>

  <!-- Recibo info -->
  <div class="recibo-info">
    <div class="numero">Recibo n.º ${data.numeroRecibo}</div>
    <div class="original">Original</div>
    <div class="data">Data do documento: ${data.dataDocumento}</div>
  </div>

  <!-- Partes -->
  <div class="partes">
    <div class="condominio">
      <strong>${CONDOMINIO.nome}</strong>
      ${CONDOMINIO.morada}<br>
      ${CONDOMINIO.localidade}<br>
      NIF: ${CONDOMINIO.nif}
    </div>
    <div class="destinatario">
      <div class="label">Exmo/a Sr/a.:</div>
      ${data.proprietario.nome}<br>
      ${data.proprietario.morada}<br>
      ${data.proprietario.localidade}
    </div>
  </div>

  <!-- NIF -->
  <div class="nif-row">
    ${data.proprietario.nif ? `V/ NIF: ${data.proprietario.nif}` : ""}
  </div>

  <!-- Intro -->
  <div class="intro">Recebemos de V. Ex.ª o pagamento dos seguintes valores:</div>

  <!-- Tabela -->
  <table>
    <thead>
      <tr>
        <th style="width:8%">Fração</th>
        <th>Descrição</th>
        <th style="width:14%">Vencimento</th>
        <th style="width:18%">Data de pagamento</th>
        <th class="right" style="width:14%">Recebido (€)</th>
      </tr>
    </thead>
    <tbody>
      ${linhasHtml}
    </tbody>
  </table>

  <div class="iva-note">Isento de I.V.A. nos termos do artigo 9.º do n.º 21 do CIVA</div>

  <div class="total-row">
    <span class="label">Total:</span>
    <span class="value">${formatEur(data.total)}</span>
  </div>

  <br><br>

  <!-- Pagamento -->
  <div class="pagamento">
    <strong>Pagamento:</strong> ${data.metodoPagamento}
  </div>

  <!-- Assinatura -->
  <div class="assinatura">
    <div class="admin-label">A Administração do Condomínio</div>
    <div class="nome-italico">${CONDOMINIO.nome}</div>
    <div class="linha"></div>
  </div>

  <div class="pagina">Página 1 / 1</div>
</body>
</html>`;
}

// ─── Email sending ────────────────────────────────────────────────────────────
async function enviarReciboEmail(params: {
  para: string;
  nomeProprietario: string;
  numeroRecibo: string;
  valor: number;
  pdfPath: string;
  mes: number;
  ano: number;
}): Promise<void> {
  const mesNome = MESES[params.mes];
  const subject = `Recibo n.º ${params.numeroRecibo} — ${mesNome} ${params.ano}`;
  const html = `
    <p>Exmo/a Sr/a. ${params.nomeProprietario},</p>
    <p>Segue em anexo o recibo n.º <strong>${params.numeroRecibo}</strong> 
    referente a <strong>${mesNome} ${params.ano}</strong>, 
    no valor de <strong>€${params.valor.toFixed(2).replace(".", ",")}</strong>.</p>
    <br>
    <p>Com os melhores cumprimentos,</p>
    <p><strong>A Administração do Condomínio</strong><br>
    ${CONDOMINIO.nome}</p>
  `;
  
  await new Promise<void>((resolve, reject) => {
    const htmlEscaped = html.replace(/"/g, '\\"');
    const cmd = `send-email --to "${params.para}" --subject "${subject}" --html "${htmlEscaped}" --attach "${params.pdfPath}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// ─── Generate PDF via Puppeteer ───────────────────────────────────────────────
async function htmlToPdf(html: string, outPath: string): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

// ─── Core: gerar recibos para mês/ano ────────────────────────────────────────
export async function gerarRecibosParaMes(mes: number, ano: number, opts: {
  sendEmail?: boolean; // default true (mantém comportamento original); false = só gera PDFs
} = {}): Promise<{
  gerados: number;
  erros: string[];
  ignorados: number;
}> {
  const { sendEmail = true } = opts;
  const erros: string[] = [];
  let gerados = 0;
  let ignorados = 0;

  // Get all active fracoes
  const fracoesList = await db.select().from(schema.fracoes).where(eq(schema.fracoes.ativo, true));

  // Start sequential counter ONCE before the loop
  let seq = await getLastReciboSeq(ano);

  for (const fracao of fracoesList) {
    try {
      // Check if recibo already exists for this fracao+mes+ano
      const existing = await db.select({ id: schema.recibos.id }).from(schema.recibos).where(
        and(
          eq(schema.recibos.fracaoId, fracao.id),
          eq(schema.recibos.mes, mes),
          eq(schema.recibos.ano, ano),
        )
      ).limit(1);

      if (existing.length > 0) {
        ignorados++;
        continue;
      }

      // Get ALL paid quotas for this fracao this month (group into one recibo)
      const quotasPagas = await db.select().from(schema.quotas).where(
        and(
          eq(schema.quotas.fracaoId, fracao.id),
          eq(schema.quotas.mes, mes),
          eq(schema.quotas.ano, ano),
          eq(schema.quotas.pago, true),
        )
      ).orderBy(schema.quotas.tipo);

      if (quotasPagas.length === 0) continue;

      // Build all linhas for this fracao (one recibo with all quota lines)
      const linhas: {
        fracao: string; descricao: string; vencimento: string;
        dataPagamento: string; valor: number;
      }[] = [];

      let total = 0;
      let metodoPagamento = "Transferência";
      const mesNome = MESES[mes];
      const vencBase = new Date(ano, mes - 1, 10); // default vencimento day 10

      for (const q of quotasPagas) {
        let descricao: string;
        if (q.tipo === "fundo_reserva") {
          descricao = `${mesNome} ${ano} - Fundo de Reserva`;
        } else if (q.tipo === "extra") {
          descricao = q.observacoes ?? `${mesNome} ${ano} - Quota Extra`;
        } else if (q.tipo === "obras") {
          descricao = q.observacoes ?? `${mesNome} ${ano} - Fundo de Obras`;
        } else {
          // condominio — main quota
          descricao = `${mesNome} ${ano} - Orçamento`;
        }

        const dataPag = q.dataPagamento ?? new Date();
        if (q.metodoPagamento) metodoPagamento = q.metodoPagamento;

        // Vencimento: day 10 of the month
        const venc = new Date(ano, mes - 1, 10);

        // Main quota line
        linhas.push({
          fracao: fracao.numero,
          descricao,
          vencimento: formatDate(venc),
          dataPagamento: formatDate(dataPag),
          valor: q.valor,
        });
        total += q.valor;

        // Fundo de Reserva embedded in condominio quota
        if (q.tipo === "condominio" && q.fundoReserva && q.fundoReserva > 0) {
          linhas.push({
            fracao: fracao.numero,
            descricao: `${mesNome} ${ano} - Fundo de Reserva`,
            vencimento: formatDate(venc),
            dataPagamento: formatDate(dataPag),
            valor: q.fundoReserva,
          });
          total += q.fundoReserva;
        }
      }

      if (linhas.length === 0) continue;

      // Increment sequence ONCE per fracao
      seq++;
      const numeroRecibo = `${ano}.${seq}`;
      const dataDocumento = formatDate(new Date(ano, mes, 0)); // last day of month

      // Build HTML
      const morada = buildMoradaFracao(fracao as any);
      const html = buildReciboHtml({
        numeroRecibo,
        dataDocumento,
        fracao,
        proprietario: {
          nome: fracao.proprietarioNome ?? "Proprietário",
          morada,
          localidade: "4785-390 Trofa",
          nif: (fracao as any).proprietarioNif ?? undefined,
        },
        linhas,
        total,
        metodoPagamento,
      });

      // Generate PDF
      const safeFracao = fracao.numero.replace(/[^a-zA-Z0-9]/g, "");
      const pdfFilename = `recibo_${ano}_${String(mes).padStart(2, "0")}_${safeFracao}_${numeroRecibo}.pdf`;
      const pdfPath = path.join(PDF_DIR, pdfFilename);
      await htmlToPdf(html, pdfPath);

      // Hash
      const pdfBuffer = fs.readFileSync(pdfPath);
      const hash = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

      // Save to DB
      await db.insert(schema.recibos).values({
        fracaoId: fracao.id,
        quotaId: quotasPagas[0]?.id ?? null,
        numeroRecibo,
        mes,
        ano,
        valor: total,
        pdfUrl: `/api/recibos/pdf/${pdfFilename}`,
        hashSha256: hash,
        enviadoEmail: false,
      });

      gerados++;
      console.log(`[recibos] Gerado recibo ${numeroRecibo} para fração ${fracao.numero} (${linhas.length} linhas, total €${total.toFixed(2)})`);

      // Auto-send email if proprietario has email AND sendEmail=true
      // (sendEmail=false: apenas gera PDFs, envio fica para o lote unificado do dia 1)
      if (sendEmail && fracao.proprietarioEmail) {
        try {
          await enviarReciboEmail({
            para: fracao.proprietarioEmail,
            nomeProprietario: fracao.proprietarioNome ?? "Proprietário",
            numeroRecibo,
            valor: total,
            pdfPath,
            mes,
            ano,
          });
          await db.update(schema.recibos).set({ enviadoEmail: true })
            .where(eq(schema.recibos.numeroRecibo, numeroRecibo));
          console.log(`[recibos] Email enviado para ${fracao.proprietarioEmail}`);
        } catch (emailErr: any) {
          console.error(`[recibos] Erro email para ${fracao.proprietarioEmail}:`, emailErr?.message);
          // Don't fail the whole generation for email errors
        }
      }

    } catch (err: any) {
      const msg = `Fração ${fracao.numero}: ${err?.message ?? err}`;
      erros.push(msg);
      console.error("[recibos] Erro:", msg);
    }
  }

  return { gerados, erros, ignorados };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
export const recibosRoutes = new Hono()

  // POST /api/recibos/gerar  { mes, ano }
  .post("/gerar", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const now = new Date();
    const mes = Number(body.mes ?? now.getMonth() + 1);
    const ano = Number(body.ano ?? now.getFullYear());

    if (mes < 1 || mes > 12 || ano < 2020 || ano > 2100) {
      return c.json({ error: "mes/ano inválidos" }, 400);
    }

    const result = await gerarRecibosParaMes(mes, ano);
    return c.json({ gerados: result.gerados, ignorados: result.ignorados, erros: result.erros });
  })

  // GET /api/recibos  → lista
  .get("/", requireAdmin, async (c) => {
    const rows = await db
      .select({
        id: schema.recibos.id,
        numeroRecibo: schema.recibos.numeroRecibo,
        mes: schema.recibos.mes,
        ano: schema.recibos.ano,
        valor: schema.recibos.valor,
        pdfUrl: schema.recibos.pdfUrl,
        enviadoEmail: schema.recibos.enviadoEmail,
        createdAt: schema.recibos.createdAt,
        fracaoNumero: schema.fracoes.numero,
        proprietarioNome: schema.fracoes.proprietarioNome,
        proprietarioEmail: schema.fracoes.proprietarioEmail,
      })
      .from(schema.recibos)
      .leftJoin(schema.fracoes, eq(schema.recibos.fracaoId, schema.fracoes.id))
      .orderBy(desc(schema.recibos.createdAt));
    return c.json(rows);
  })

  // GET /api/recibos/pdf/:filename  → stream PDF
  .get("/pdf/:filename", async (c) => {
    const filename = c.req.param("filename");
    // Security: no path traversal
    if (filename.includes("..") || filename.includes("/")) {
      return c.text("Not found", 404);
    }
    const pdfPath = path.join(PDF_DIR, filename);
    if (!fs.existsSync(pdfPath)) return c.text("Not found", 404);
    const buf = fs.readFileSync(pdfPath);
    return new Response(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  })

  // POST /api/recibos/:id/email  → send/resend
  .post("/:id/email", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const rows = await db.select({
      id: schema.recibos.id,
      numeroRecibo: schema.recibos.numeroRecibo,
      pdfUrl: schema.recibos.pdfUrl,
      valor: schema.recibos.valor,
      mes: schema.recibos.mes,
      ano: schema.recibos.ano,
      proprietarioNome: schema.fracoes.proprietarioNome,
      proprietarioEmail: schema.fracoes.proprietarioEmail,
    })
      .from(schema.recibos)
      .leftJoin(schema.fracoes, eq(schema.recibos.fracaoId, schema.fracoes.id))
      .where(eq(schema.recibos.id, id))
      .limit(1);

    if (!rows[0]) return c.json({ error: "Recibo não encontrado" }, 404);
    const recibo = rows[0];

    if (!recibo.proprietarioEmail) {
      return c.json({ error: "Fração sem email configurado" }, 400);
    }

    // Get PDF file
    const filename = recibo.pdfUrl?.split("/").pop();
    if (!filename) return c.json({ error: "PDF não encontrado" }, 404);
    const pdfPath = path.join(PDF_DIR, filename);
    if (!fs.existsSync(pdfPath)) return c.json({ error: "PDF file missing" }, 404);

    // Use stored mes/ano from DB
    const anoRecibo = recibo.ano ?? parseInt(recibo.numeroRecibo?.split(".")?.[0] ?? "2026");
    const mesRecibo = recibo.mes ?? new Date().getMonth() + 1;

    await enviarReciboEmail({
      para: recibo.proprietarioEmail,
      nomeProprietario: recibo.proprietarioNome ?? "Proprietário",
      numeroRecibo: recibo.numeroRecibo ?? "",
      valor: recibo.valor,
      pdfPath,
      mes: mesRecibo,
      ano: anoRecibo,
    });

    await db.update(schema.recibos).set({ enviadoEmail: true }).where(eq(schema.recibos.id, id));
    return c.json({ ok: true, enviado_para: recibo.proprietarioEmail });
  });

// ─── Cron: último dia do mês às 23h59 ───────────────────────────────────────
// Gera recibos PDF para o mês que termina, sem enviar emails (envio é feito
// pelo cron de dia 1 como parte do lote unificado recibo+nota de cobrança).
export function scheduleRecibosCron() {
  function msUntilEndOfMonth(): number {
    const now = new Date();
    // Último dia do mês corrente às 23:59:00
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 0, 0);
    if (lastDay <= now) {
      // Já passou — agendar para o fim do próximo mês
      const nextLast = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 0, 0);
      return nextLast.getTime() - now.getTime();
    }
    return lastDay.getTime() - now.getTime();
  }

  function scheduleNext() {
    const ms = msUntilEndOfMonth();
    const horas = Math.round(ms / 3600000);
    console.log(`[recibos-cron] Próxima geração em ${horas}h (último dia do mês às 23:59)`);
    setTimeout(async () => {
      const now = new Date();
      const mes = now.getMonth() + 1;
      const ano = now.getFullYear();
      console.log(`[recibos-cron] A gerar recibos para ${mes}/${ano} (sem envio de email — aguarda lote dia 1)...`);
      try {
        // sendEmail=false: apenas gera os PDFs, o envio fica para o cron de dia 1
        const result = await gerarRecibosParaMes(mes, ano, { sendEmail: false });
        console.log(`[recibos-cron] Gerados: ${result.gerados}, Ignorados: ${result.ignorados}, Erros: ${result.erros.length}`);
      } catch (e) {
        console.error("[recibos-cron] Erro:", e);
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
