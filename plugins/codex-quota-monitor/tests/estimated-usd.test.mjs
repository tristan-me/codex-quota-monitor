import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEstimatedUsd, formatCostCoverage } from '../web/usage-charts.mjs';

test('USD estimates distinguish missing prices from a recorded zero and label the currency', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '', ' ', 'invalid', false, {}]) {
    assert.equal(formatEstimatedUsd(value), '待估算');
  }
  for (const [value, expected] of [[0, 'US$0.00'], [12.345, 'US$12.35'],
    [0.002345, 'US$0.0023'], [0.00002345, 'US$0.000023'], ['0.00000042', 'US$0.00000042']]) {
    assert.equal(formatEstimatedUsd(value), expected);
  }
});

test('small positive USD costs never display as zero, including subnormal values', () => {
  for (let exponent = 0; exponent <= 323; exponent += 1) {
    const value = Number(`1e-${exponent}`);
    const rendered = formatEstimatedUsd(value);
    assert.ok(rendered.startsWith('US$'));
    assert.ok(Number(rendered.slice(3)) > 0, `${value} became ${rendered}`);
  }
  assert.equal(Number(formatEstimatedUsd(Number.MIN_VALUE).slice(3)), Number.MIN_VALUE);
});

test('partial pricing discloses the priced subset and unpriced tokens', () => {
  const estimate = { usd: 0.02, coverage: 'partial', pricedTokens: 750, unpricedTokens: 250, totalTokens: 1000 };
  const label = formatCostCoverage(estimate);
  assert.match(label, /仅已计价部分/);
  assert.match(label, /750 \/ 1,000 tokens/);
  assert.match(label, /未计价 250 tokens/);
  assert.equal(formatCostCoverage({ ...estimate, usd: null }), label);
  assert.doesNotMatch(formatCostCoverage({ usd: 0, coverage: 'complete', pricedTokens: 0, unpricedTokens: 0, totalTokens: 0 }), /仅已计价部分|暂无/);
  assert.match(formatCostCoverage({ usd: null, coverage: 'none', pricedTokens: 0, unpricedTokens: 1000, totalTokens: 1000 }), /尚未计价 1,000 tokens/);
  assert.equal(formatCostCoverage(undefined), '暂无可计价的用量记录');
});
