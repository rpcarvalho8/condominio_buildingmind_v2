# TASK: Matriz Canónica de Orçamentos e Saldos

## Alterações em dashboard.ts

### 1. SALDO_DEFAULTS — âncora 15/06/2026
- saldo_conta_corrente: 1806.74  (era 3388.39 — novo físico confirmado)
- saldo_fundo_reserva: 651.30   (igual)
- saldo_quota_extra: 110.45     (igual — depósito a prazo elevadores)
- saldo_obras: 21185.29         (igual)
- saldo_incendio: 0             (igual)

### 2. Constantes ORCAMENTOS_EXTRA (novo bloco)
- ORCAMENTO_MOTOR: 707.25
- ORCAMENTO_INCENDIO: 2644.50
- ORCAMENTO_ELEVADORES: 6958.18
- ORCAMENTO_OBRAS: 50550.04

### 3. IBANs das poupanças físicas (ignorar saídas para eles)
- A ser injetados em IBANS_POUPANCA_FISICA
- Saídas DBIT para estes IBANs = transferência interna (ignorar no processamento)

### 4. recalcularSaldos() — nova lógica de triagem
DATA ANCORA: 2026-06-02 (hardcoded, não depende de saldo_base_data)

Regras de triagem dos bank_transactions desde 02/06/2026:
- Receitas Obras (cativo_obras) → saldo_obras += valor (imediato)
- Receitas FR (cativo_fundo_reserva) → saldo_fundo_reserva += valor (imediato)
- Receitas Motor/Incendio → permanecem como cativos virtuais na conta à ordem
- Saídas para IBANS_POUPANCA_FISICA → ignorar (não são despesas)
- Movimento 15.00€ → ignorar (teste)

### 5. Morosidade por cota extra
- em_divida_motor = ORCAMENTO_MOTOR − SUM(quotas pago=true WHERE quotaTipoId=PORTAO_TIPO_ID)
- em_divida_incendio = ORCAMENTO_INCENDIO − SUM(quotas pago=true WHERE quotaTipoId=INCENDIO_TIPO_ID)
- em_divida_elevadores = ORCAMENTO_ELEVADORES − SUM(quotas pago=true WHERE quotaTipoId=ELEV_TIPO_ID)
- em_divida_obras = ORCAMENTO_OBRAS − SUM(quotas pago=true WHERE tipo='obras')
- Persistir como: divida_total_motor, divida_total_incendio, divida_total_elevadores, divida_total_obras

## Status
- [ ] SALDO_DEFAULTS atualizado
- [ ] ORCAMENTOS_EXTRA adicionado
- [ ] IBANS_POUPANCA_FISICA adicionado
- [ ] recalcularSaldos() atualizado
- [ ] TSC 0 erros
- [ ] Commit + push
