import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export * from "./auth-schema";

// --- FRAÇÕES ---
export const fracoes = sqliteTable("fracoes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  numero: text("numero").notNull(),           // "1A", "2B", etc.
  andar: integer("andar"),
  proprietarioNome: text("proprietario_nome"),
  proprietarioEmail: text("proprietario_email"),
  proprietarioNif: text("proprietario_nif"),
  proprietarioMorada: text("proprietario_morada"),   // ex: "Rua Poeta António Boto, n.º 39, Hab. 2.º B"
  proprietarioTelefone: text("proprietario_telefone"),
  telegramId: text("telegram_id"),
  tipo: text("tipo").notNull().default("apartamento"), // "apartamento" | "loja" | "garagem"
  ibansConhecidos: text("ibans_conhecidos"),            // JSON array de IBANs associados (estáticos + aprendidos)
  quotaMensal: real("quota_mensal").notNull().default(0),
  permilagem: real("permilagem"),             // % do edifício
  // Dívidas extra por tipo — actualizadas pela cascata de amortização
  obrasDivida: real("obras_divida").default(0),
  incendioDivida: real("incendio_divida").default(0),
  indaquaDivida: real("indaqua_divida").default(0),
  motorDivida: real("motor_divida").default(0),
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- FORNECEDORES ---
export const fornecedores = sqliteTable("fornecedores", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),
  categoria: text("categoria"),               // "limpeza", "jardim", "elevadores", etc.
  nif: text("nif"),
  email: text("email"),
  telefone: text("telefone"),
  website: text("website"),
  avaliacao: real("avaliacao"),               // 1.0 a 5.0
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- DESPESAS ---
export const despesas = sqliteTable("despesas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  descricao: text("descricao").notNull(),
  categoria: text("categoria").notNull(),     // "água", "eletricidade", "limpeza", "manutenção", "seguros", "outros"
  subcategoria: text("subcategoria"),
  valor: real("valor").notNull(),
  data: integer("data", { mode: "timestamp" }).notNull(),
  fornecedorId: text("fornecedor_id").references(() => fornecedores.id),
  faturaUrl: text("fatura_url"),
  recorrente: integer("recorrente", { mode: "boolean" }).default(false),
  notas: text("notas"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- QUOTAS ---
export const quotas = sqliteTable("quotas", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracaoId: text("fracao_id").notNull().references(() => fracoes.id),
  quotaTipoId: text("quota_tipo_id"),         // optional link to quota_tipos
  tipo: text("tipo").notNull().default("condominio"), // "condominio" | "obras" | "extra" | "fundo_reserva"
  mes: integer("mes").notNull(),
  ano: integer("ano").notNull(),
  valor: real("valor").notNull(),
  fundoReserva: real("fundo_reserva"),        // 10% auto-calculated, stored separately
  pago: integer("pago", { mode: "boolean" }).default(false),
  dataPagamento: integer("data_pagamento", { mode: "timestamp" }),
  metodoPagamento: text("metodo_pagamento"),  // "transferência", "mbway", "numerário", "cheque"
  observacoes: text("observacoes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- RECIBOS ---
export const recibos = sqliteTable("recibos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fracaoId: text("fracao_id").notNull().references(() => fracoes.id),
  quotaId: text("quota_id").references(() => quotas.id),
  numeroRecibo: text("numero_recibo").unique(), // "2026.95"
  mes: integer("mes"),                          // 1-12
  ano: integer("ano"),                          // 2026
  valor: real("valor").notNull(),
  pdfUrl: text("pdf_url"),
  hashSha256: text("hash_sha256"),             // blockchain-ready
  txHash: text("tx_hash"),                     // on-chain futuro
  enviadoEmail: integer("enviado_email", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- IMPORT LOGS ---
export const importLogs = sqliteTable("import_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  filename: text("filename").notNull(),
  fileHash: text("file_hash"),               // SHA-256 of file to detect re-imports
  status: text("status").notNull().default("ok"), // "ok" | "error" | "partial"
  totalRows: integer("total_rows").default(0),
  quotasCreated: integer("quotas_created").default(0),
  quotasUpdated: integer("quotas_updated").default(0),
  despesasCreated: integer("despesas_created").default(0),
  despesasSkipped: integer("despesas_skipped").default(0),
  errorCount: integer("error_count").default(0),
  errors: text("errors"),                    // JSON array of error strings
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- BANK CONNECTIONS (Enable Banking) ---
export const bankConnections = sqliteTable("bank_connections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id").notNull(),
  bankName: text("bank_name").notNull().default("Santander Empresas PT"),
  accounts: text("accounts"),               // JSON array of account objects
  status: text("status").notNull().default("active"), // "active" | "expired" | "revoked"
  connectedAt: integer("connected_at", { mode: "timestamp" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- BANK SYNC LOGS ---
export const bankSyncLogs = sqliteTable("bank_sync_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  connectionId: text("connection_id"),
  syncedFrom: integer("synced_from", { mode: "timestamp" }),
  syncedTo: integer("synced_to", { mode: "timestamp" }),
  transactionsFound: integer("transactions_found").default(0),
  despesasCreated: integer("despesas_created").default(0),
  quotasCreated: integer("quotas_created").default(0),
  quotasUpdated: integer("quotas_updated").default(0),
  skipped: integer("skipped").default(0),
  errors: text("errors"),                   // JSON array
  status: text("status").notNull().default("ok"), // "ok" | "partial" | "error"
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- CONFIGURAÇÕES (chave-valor) ---
export const configuracoes = sqliteTable("configuracoes", {
  chave: text("chave").primaryKey(),            // "saldo_conta_corrente", "saldo_obras", "saldo_fundo_reserva"
  valor: text("valor").notNull(),               // JSON string or plain value
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- TRANSAÇÕES BANCÁRIAS (Enable Banking staging) ---
// Recebidas via sync antes de serem importadas como quotas/despesas.
// imported=0 → ainda não processadas (potencialmente "cativos" na conta à ordem).
// imported=1 → já gerou quota ou despesa; import_type indica o destino.
export const bankTransactions = sqliteTable("bank_transactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  connectionId: text("connection_id").references(() => bankConnections.id),
  transactionId: text("transaction_id").unique(), // ID externo Enable Banking (dedup)
  amount: real("amount").notNull(),               // positivo = crédito, negativo = débito
  currency: text("currency").default("EUR"),
  date: integer("date", { mode: "timestamp" }).notNull(),
  description: text("description"),              // remittance_information concatenado
  creditorName: text("creditor_name"),           // nome do credor (saídas)
  debtorName: text("debtor_name"),               // nome do devedor/pagador (entradas)
  type: text("type"),                            // "CRDT" | "DBIT"
  status: text("status").default("pending"),     // "pending" | "processed" | "ignored"
  imported: integer("imported").default(0),      // 0=não processado, 1=importado
  importType: text("import_type"),               // "quota" | "despesa" | "cativo"
  importRefId: text("import_ref_id"),            // ID da quota/despesa criada
  requiresManualReview: integer("requires_manual_review").default(0), // 1=motor devolveu null, revisão manual
  rawData: text("raw_data"),                     // JSON raw do Enable Banking
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// --- TIPOS DE QUOTA ---
export const quotaTipos = sqliteTable("quota_tipos", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  nome: text("nome").notNull(),               // "Quota Condomínio", "Fundo Obras", etc.
  tipo: text("tipo").notNull(),               // "condominio" | "obras" | "extra" | "fundo_reserva"
  descricao: text("descricao"),
  keywords: text("keywords"),               // CSV keywords para matching bancário: "MOTOR GARAGEM,PORTAO"
  valorBase: real("valor_base"),             // base value (before permilagem calc)
  ativo: integer("ativo", { mode: "boolean" }).default(true),
  dataInicio: integer("data_inicio", { mode: "timestamp" }),
  dataFim: integer("data_fim", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
