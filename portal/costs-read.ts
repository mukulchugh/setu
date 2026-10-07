export interface ProviderCosts {
  byModel?: { costUsd: number; model: string }[];
  configured: boolean;
  error?: string;
  provider: string;
  reason?: string;
  totalCostUsd?: number;
  windowDays?: number;
}
interface BudgetPeriod {
  incomplete?: boolean;
  limit: number;
  spent: number;
  status: 'ok' | 'warning' | 'over' | 'incomplete';
}
export interface Budgets {
  daily?: BudgetPeriod;
  monthly?: BudgetPeriod;
  weekly?: BudgetPeriod;
}
export interface CostsSummary {
  anthropic: ProviderCosts;
  budgets: Budgets | null;
  gemini: ProviderCosts;
  openai: ProviderCosts;
}

// Reject malformed reads so a refresh keeps the previous totals, never invents zero spend.
export function parseCostsSummary(value: unknown): CostsSummary {
  if (!value || typeof value !== 'object') {
    throw new Error('Costs unavailable');
  }
  const summary = value as CostsSummary;
  for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
    const row = summary[provider];
    if (
      !row ||
      row.provider !== provider ||
      typeof row.configured !== 'boolean'
    ) {
      throw new Error('Invalid provider costs');
    }
    for (const field of ['reason', 'error'] as const) {
      if (row[field] !== undefined && typeof row[field] !== 'string') {
        throw new Error('Invalid provider message');
      }
    }
    for (const field of ['totalCostUsd', 'windowDays'] as const) {
      if (row[field] !== undefined && !Number.isFinite(row[field])) {
        throw new Error('Invalid cost total');
      }
    }
    if (
      row.byModel !== undefined &&
      (!Array.isArray(row.byModel) ||
        row.byModel.some(
          (model) =>
            !model ||
            typeof model.model !== 'string' ||
            !Number.isFinite(model.costUsd)
        ))
    ) {
      throw new Error('Invalid model costs');
    }
  }
  if (summary.budgets != null) {
    if (typeof summary.budgets !== 'object' || Array.isArray(summary.budgets)) {
      throw new Error('Invalid budgets');
    }
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      const row = summary.budgets[period];
      if (
        row !== undefined &&
        (!row ||
          typeof row !== 'object' ||
          !Number.isFinite(row.limit) ||
          !Number.isFinite(row.spent) ||
          (row.incomplete !== undefined &&
            typeof row.incomplete !== 'boolean') ||
          !['ok', 'warning', 'over', 'incomplete'].includes(row.status))
      ) {
        throw new Error('Invalid budget period');
      }
    }
  }
  return summary;
}
