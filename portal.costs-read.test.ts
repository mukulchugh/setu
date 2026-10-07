import { expect, test } from 'bun:test';
import { parseCostsSummary } from './portal/costs-read';
const summary = () => ({
  anthropic: {
    provider: 'anthropic',
    configured: true,
    totalCostUsd: 0,
    windowDays: 30,
    byModel: [],
  },
  openai: { provider: 'openai', configured: false, reason: 'Not configured' },
  gemini: { provider: 'gemini', configured: false, reason: 'Detection only' },
  budgets: null,
});

test('zero reported spend is distinct from unconfigured or unavailable provider totals', () => {
  const value = summary();
  expect(parseCostsSummary(value)).toBe(value);
  expect(parseCostsSummary(value).openai.totalCostUsd).toBeUndefined();
  expect(parseCostsSummary(value).anthropic.totalCostUsd).toBe(0);
});

test('malformed refresh cannot replace the previous provider summary', () => {
  for (const value of [
    null,
    { error: 'Unavailable' },
    { ...summary(), openai: null },
    {
      ...summary(),
      anthropic: {
        provider: 'anthropic',
        configured: true,
        totalCostUsd: '12',
      },
    },
    {
      ...summary(),
      anthropic: {
        provider: 'anthropic',
        configured: true,
        byModel: [{ model: 'model', costUsd: null }],
      },
    },
    {
      ...summary(),
      budgets: { daily: { limit: 20, spent: 1, status: 'invented' } },
    },
    { ...summary(), budgets: { daily: null } },
    { ...summary(), budgets: { daily: false } },
    {
      ...summary(),
      budgets: {
        daily: { limit: 20, spent: 1, status: 'ok', incomplete: 'false' },
      },
    },
  ]) {
    expect(() => parseCostsSummary(value)).toThrow();
  }
});

test('partial provider errors and incomplete budgets stay visible, without inventing zero totals', () => {
  const value = {
    ...summary(),
    openai: {
      provider: 'openai',
      configured: true,
      error: 'Provider unavailable',
    },
    budgets: {
      daily: { limit: 20, spent: 2, status: 'incomplete', incomplete: true },
    },
  };
  expect(parseCostsSummary(value)).toBe(value);
  expect(parseCostsSummary(value).openai.totalCostUsd).toBeUndefined();
  expect(parseCostsSummary(value).budgets?.daily?.status).toBe('incomplete');
});
