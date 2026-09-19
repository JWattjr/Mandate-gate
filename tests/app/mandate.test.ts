import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainContractError, validEvidenceUrl, validateDraft, type Budget } from '../../lib/mandate.ts';

const budget: Budget = { total_cap: 100000, per_proposal_cap: 25000, reserved: 90000, available: 10000 };
const good = {
  proposalId: 'prop-001',
  amount: '5000',
  rationale: 'Allocate idle reserve into the configured pool.',
  urls: ['https://mandate-gate-azure.vercel.app/evidence/pool-active.html', '', ''],
};

test('a valid draft has no errors', () => {
  assert.deepEqual(validateDraft(good, budget, new Set()), {});
});

test('mirrors the contract limits', () => {
  assert.match(validateDraft({ ...good, amount: '30000' }, budget, new Set()).amount ?? '', /per-proposal cap/);
  assert.match(validateDraft({ ...good, amount: '12000' }, budget, new Set()).amount ?? '', /available budget/);
  assert.ok(validateDraft({ ...good, amount: '0' }, budget, new Set()).amount);
  assert.ok(validateDraft({ ...good, amount: '1.5' }, budget, new Set()).amount);
  assert.ok(validateDraft({ ...good, amount: '-3' }, budget, new Set()).amount);
});

test('rejects duplicate and malformed proposal IDs', () => {
  assert.match(validateDraft(good, budget, new Set(['prop-001'])).proposalId ?? '', /already/);
  assert.ok(validateDraft({ ...good, proposalId: 'a b' }, budget, new Set()).proposalId);
  assert.ok(validateDraft({ ...good, proposalId: 'ab' }, budget, new Set()).proposalId);
});

test('evidence URL rules match the contract', () => {
  assert.equal(validEvidenceUrl('https://example.com/status'), true);
  for (const bad of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://a:b@example.com', 'https://example.com:8443/x', 'https://example.com/' + 'a'.repeat(300)])
    assert.equal(validEvidenceUrl(bad), false, bad);
  assert.ok(validateDraft({ ...good, urls: ['', '', ''] }, budget, new Set()).urls);
  assert.ok(validateDraft({ ...good, urls: [good.urls[0], good.urls[0], ''] }, budget, new Set()).urls);
});

test('explains contract error tags', () => {
  assert.equal(
    explainContractError('UserError("[LIMIT] amount 30000 exceeds the per-proposal cap of 25000")'),
    'Rejected by a deterministic limit: amount 30000 exceeds the per-proposal cap of 25000',
  );
  assert.equal(explainContractError('plain failure'), 'plain failure');
});
