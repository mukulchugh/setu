import { expect, test } from 'bun:test';
import { parseCostsSummary } from './portal/costs-read';

const summary = () => ({
  anthropic: {
    byModel: [],
    configured: true,
    provider: 'anthropic',
    totalCostUsd: 0,
    windowDays: 30,
  },
  budgets: null,
  gemini: { configured: false, provider: 'gemini', reason: 'Detection only' },
  openai: { configured: false, provider: 'openai', reason: 'Not configured' },
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
        configured: true,
        provider: 'anthropic',
        totalCostUsd: '12',
      },
    },
    {
      ...summary(),
      anthropic: {
        byModel: [{ costUsd: null, model: 'model' }],
        configured: true,
        provider: 'anthropic',
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
        daily: { incomplete: 'false', limit: 20, spent: 1, status: 'ok' },
      },
    },
  ]) {
    expect(() => parseCostsSummary(value)).toThrow();
  }
});

test('partial provider errors and incomplete budgets stay visible, without inventing zero totals', () => {
  const value = {
    ...summary(),
    budgets: {
      daily: { incomplete: true, limit: 20, spent: 2, status: 'incomplete' },
    },
    openai: {
      configured: true,
      error: 'Provider unavailable',
      provider: 'openai',
    },
  };
  expect(parseCostsSummary(value)).toBe(value);
  expect(parseCostsSummary(value).openai.totalCostUsd).toBeUndefined();
  expect(parseCostsSummary(value).budgets?.daily?.status).toBe('incomplete');
});
