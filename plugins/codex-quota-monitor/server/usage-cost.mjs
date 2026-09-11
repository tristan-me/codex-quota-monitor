// Published Codex credit rates are allocation weights, not subscription percentages.
// Source checked 2026-09-11: https://learn.chatgpt.com/docs/pricing#token-rates
// Fast mode: https://learn.chatgpt.com/docs/agent-configuration/speed
export const COST_RATE_VERSION = 'codex-credits-2026-09-11';
export const COST_RATE_SOURCE = 'https://learn.chatgpt.com/docs/pricing#token-rates';
export const TOKEN_CREDIT_RATES = Object.freeze({
  'gpt-6-astra': [250, 25, 1250],
  'gpt-5.6-sol': [100, 10, 500],
  'gpt-5.6-terra': [50, 5, 300],
  'gpt-5.6-luna': [5, 0.5, 30],
  'gpt-5.5': [125, 12.5, 750],
  'gpt-5.4': [62.5, 6.25, 375],
  'gpt-5.4-mini': [18.75, 1.875, 113],
});

export function tokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const input = value.input_tokens ?? value.inputTokens;
  const cached = value.cached_input_tokens ?? value.cachedInputTokens;
  const output = value.output_tokens ?? value.outputTokens;
  if (![input, cached, output].every(n => Number.isFinite(n) && n >= 0) || cached > input) return null;
  // reasoning_output_tokens is already part of output_tokens.
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: input + output };
}

export function usageDifference(current, previous) {
  if (!current || !previous) return null;
  const input = current.inputTokens - previous.inputTokens;
  const cached = current.cachedInputTokens - previous.cachedInputTokens;
  const output = current.outputTokens - previous.outputTokens;
  return tokenUsage({ inputTokens: input, cachedInputTokens: cached, outputTokens: output });
}

export function usageCredits(usage, model, serviceTier = null) {
  const rates = TOKEN_CREDIT_RATES[model];
  if (!usage || !rates || (serviceTier && !['standard', 'default', 'fast'].includes(serviceTier))) return null;
  const multiplier = serviceTier === 'fast' ? (model.startsWith('gpt-5.4') ? 2 : 2.5) : 1;
  return ((usage.inputTokens - usage.cachedInputTokens) * rates[0] +
    usage.cachedInputTokens * rates[1] + usage.outputTokens * rates[2]) * multiplier / 1_000_000;
}

export function addUsage(left, right) {
  return {
    inputTokens: (left?.inputTokens || 0) + right.inputTokens,
    cachedInputTokens: (left?.cachedInputTokens || 0) + right.cachedInputTokens,
    outputTokens: (left?.outputTokens || 0) + right.outputTokens,
    totalTokens: (left?.totalTokens || 0) + right.totalTokens,
  };
}
