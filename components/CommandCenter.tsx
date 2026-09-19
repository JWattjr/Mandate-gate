'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PolicyQuote } from '@genlayer/transaction-kit';
import demo from '@/config/demo.json';
import {
  CHAIN_ID,
  CONTRACT_ADDRESS,
  DEPLOY_TX,
  balanceOf,
  cancelTx,
  chain,
  configured,
  explorerAddress,
  explorerTx,
  proposalTx,
  quoteAndSubmit,
  readProposal,
  readSnapshot,
  requestTestFunds,
  trackTransaction,
  type Snapshot,
  type Tracked,
} from '@/lib/genlayer';
import {
  explainContractError,
  shortHex,
  units,
  validateDraft,
  type Draft,
  type DraftErrors,
  type Proposal,
} from '@/lib/mandate';
import {
  chainMatches,
  connect,
  discoverWallets,
  errorMessage,
  firstAccount,
  switchNetwork,
  type WalletOption,
} from '@/lib/wallet';
import {
  BudgetPanel,
  ConfigPanel,
  DivisionPanel,
  ExtLink,
  HistoryPanel,
  MandatePanel,
  Mark,
  Panel,
  StatsPanel,
  Verdict,
  type HistoryFilter,
} from './ui';

type Stage = 'quoting' | 'signing' | 'pending' | 'processing' | 'decided' | 'finalized' | 'failed';

type ActiveTx = {
  kind: 'evaluate' | 'cancel';
  proposalId: string;
  stage: Stage;
  hash?: `0x${string}`;
  quote?: { feeValue: string; gasless: boolean };
  tracked?: Tracked;
  error?: string;
  outcome?: Proposal | null;
  outcomeFinality?: 'decided' | 'final';
  startedAt: number;
};

const STORAGE_KEY = 'mandategate.activeTx.v1';
const LOW_BALANCE = 5n * 10n ** 17n;

const FIXTURES = [
  { key: 'active', label: 'Active pool', url: demo.fixtures.active, color: 'var(--ok)' },
  { key: 'warning', label: 'Exploit warning', url: demo.fixtures.warning, color: 'var(--bad)' },
  { key: 'ambiguous', label: 'Different pool', url: demo.fixtures.ambiguous, color: 'var(--warn)' },
] as const;

function freshId(prefix = 'prop') {
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${rand}`;
}

function gen(wei: bigint | string) {
  const value = typeof wei === 'string' ? BigInt(wei) : wei;
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac} GEN`;
}

function loadStored(): ActiveTx | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as ActiveTx;
    return stored.hash ? { ...stored, stage: 'pending', outcome: undefined } : null;
  } catch {
    return null;
  }
}

function store(tx: ActiveTx | null) {
  try {
    if (!tx?.hash || tx.stage === 'finalized' || tx.stage === 'failed') window.localStorage.removeItem(STORAGE_KEY);
    else
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ kind: tx.kind, proposalId: tx.proposalId, hash: tx.hash, startedAt: tx.startedAt }),
      );
  } catch {
    /* storage unavailable (private mode); tracking still works for this tab */
  }
}

export default function CommandCenter() {
  // ------------------------------------------------------------- chain state
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rpcLive, setRpcLive] = useState<boolean | null>(null);

  const refresh = useCallback(async (mode: 'final' | 'latest' = 'latest') => {
    if (!configured) return;
    setRefreshing(true);
    try {
      // One quiet retry absorbs a transient rate-limit or gateway error.
      const next = await readSnapshot(mode).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return readSnapshot(mode);
      });
      setSnapshot(next);
      setLoadError(null);
      setRpcLive(true);
    } catch (error) {
      setLoadError(errorMessage(error));
      setRpcLive(false);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial read from Studio Next; state updates happen after the network responds.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 90_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // ------------------------------------------------------------ wallet state
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [wallet, setWallet] = useState<WalletOption | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [funding, setFunding] = useState(false);

  useEffect(() => discoverWallets(window, setWallets), []);

  useEffect(() => {
    const provider = wallet?.provider;
    if (!provider?.on) return;
    const onAccounts = (accounts: unknown) => setAccount(firstAccount(accounts));
    const onChain = (id: unknown) => setWalletChain(typeof id === 'string' ? id : null);
    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [wallet]);

  const onRightChain = chainMatches(walletChain, CHAIN_ID);

  const readBalance = useCallback(async (address: string) => {
    try {
      setBalance(await balanceOf(address));
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    // Balance is an external read keyed to the connected account.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (account && onRightChain) void readBalance(account);
  }, [account, onRightChain, readBalance]);

  const connectWallet = async (option: WalletOption) => {
    setWalletError(null);
    try {
      const address = await connect(option.provider);
      setWallet(option);
      setAccount(address);
      setWalletChain((await option.provider.request({ method: 'eth_chainId' })) as string);
    } catch (error) {
      setWalletError(errorMessage(error));
    }
  };

  const switchToStudio = async () => {
    if (!wallet) return;
    setWalletError(null);
    try {
      await switchNetwork(wallet.provider, chain);
      setWalletChain((await wallet.provider.request({ method: 'eth_chainId' })) as string);
    } catch (error) {
      setWalletError(`Could not switch networks: ${errorMessage(error)}`);
    }
  };

  const disconnect = () => {
    setWallet(null);
    setAccount(null);
    setWalletChain(null);
    setBalance(null);
  };

  const fund = async () => {
    if (!account) return;
    setFunding(true);
    setWalletError(null);
    try {
      await requestTestFunds(account);
      await readBalance(account);
    } catch (error) {
      setWalletError(`Faucet request failed: ${errorMessage(error)}`);
    } finally {
      setFunding(false);
    }
  };

  const isOwner = !!account && !!snapshot && snapshot.mandate.owner.toLowerCase() === account.toLowerCase();

  // -------------------------------------------------------------- form state
  const [draft, setDraft] = useState<Draft>({
    proposalId: '',
    amount: '10000',
    rationale: 'Allocate idle treasury reserve into the configured WETH/USDC pool to earn swap fees.',
    urls: [demo.fixtures.active, '', ''],
  });
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    // A random proposal ID is generated on the client only, to avoid a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft((d) => (d.proposalId ? d : { ...d, proposalId: freshId() }));
  }, []);

  const knownIds = useMemo(() => new Set(snapshot?.proposals.map((p) => p.proposal_id) ?? []), [snapshot]);
  const errors: DraftErrors = useMemo(
    () => validateDraft(draft, snapshot?.budget ?? null, knownIds),
    [draft, snapshot, knownIds],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const applyFixture = (url: string, key: string) => {
    setDraft((d) => ({ ...d, proposalId: freshId(key), urls: [url, '', ''] }));
  };

  // ----------------------------------------------------------- transactions
  const [active, setActive] = useState<ActiveTx | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const trackingRef = useRef<string | null>(null);
  const busy = !!active && !['finalized', 'failed'].includes(active.stage);

  const update = useCallback((patch: Partial<ActiveTx>) => {
    setActive((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      store(next);
      return next;
    });
  }, []);

  const follow = useCallback(
    async (tx: ActiveTx) => {
      if (!tx.hash || trackingRef.current === tx.hash) return;
      trackingRef.current = tx.hash;
      let decidedRead = false;
      const final = await trackTransaction(
        tx.hash,
        async (t) => {
          const stage: Stage = t.phase === 'finalized' ? 'finalized' : t.phase === 'decided' ? 'decided' : t.phase;
          update({ tracked: t, stage });
          // Show a decided (not yet final) outcome as soon as execution is known to have succeeded.
          if (t.phase === 'decided' && t.executed && !decidedRead && tx.kind === 'evaluate') {
            decidedRead = true;
            try {
              const proposal = await readProposal(tx.proposalId, 'latest');
              update({ outcome: proposal, outcomeFinality: 'decided' });
            } catch {
              /* the finalized read below is authoritative */
            }
          }
        },
        () => trackingRef.current !== tx.hash,
      ).catch((error) => {
        update({ stage: 'failed', error: errorMessage(error) });
        return null;
      });
      if (!final) return;
      if (final.phase !== 'finalized') {
        update({ error: 'Still waiting for finality. Tracking stopped; refresh to resume.' });
        return;
      }
      if (!final.executed) {
        update({
          stage: 'failed',
          error:
            final.statusName === 'UNDETERMINED'
              ? 'Validators did not reach agreement, so the contract recorded nothing and the budget is unchanged. The proposal ID is still free.'
              : final.errorText
                ? `${explainContractError(final.errorText)}. Nothing was recorded and the budget is unchanged.`
                : `Execution did not succeed (${final.executionResult ?? 'unknown result'}). Nothing was recorded and the budget is unchanged.`,
        });
        await refresh('final');
        return;
      }
      const proposal = await readProposal(tx.proposalId, 'final').catch(() => null);
      update({ stage: 'finalized', outcome: proposal, outcomeFinality: 'final' });
      setSelectedId(tx.proposalId);
      await refresh('final');
    },
    [refresh, update],
  );

  // Resume a transaction that was in flight before a reload.
  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive(stored);
      void follow(stored);
    }
  }, [follow]);

  const send = async (kind: ActiveTx['kind'], proposalId: string) => {
    if (!wallet || !account) return;
    const tx: ActiveTx = { kind, proposalId, stage: 'quoting', startedAt: Date.now() };
    trackingRef.current = null;
    setActive(tx);
    setSelectedId(null);
    try {
      const input =
        kind === 'evaluate'
          ? proposalTx({
              proposalId,
              pair: snapshot?.mandate.pair ?? demo.pair,
              poolId: snapshot?.mandate.pool_id ?? demo.poolId,
              amount: Number(draft.amount.trim()),
              rationale: draft.rationale.split(/\s+/).filter(Boolean).join(' '),
              urls: draft.urls.map((u) => u.trim()).filter(Boolean),
            })
          : cancelTx(proposalId);
      const hash = await quoteAndSubmit(wallet.provider, account, input, (q: PolicyQuote) => {
        update({ stage: 'signing', quote: { feeValue: q.feeValue.toString(), gasless: !!q.gasless } });
      });
      const submitted = { ...tx, hash, stage: 'pending' as Stage };
      setActive((prev) => ({ ...(prev ?? tx), hash, stage: 'pending' }));
      store(submitted);
      if (kind === 'evaluate') setDraft((d) => ({ ...d, proposalId: freshId() }));
      void readBalance(account);
      await follow(submitted);
    } catch (error) {
      update({ stage: 'failed', error: errorMessage(error) });
    }
  };

  const submitProposal = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    void send('evaluate', draft.proposalId);
  };

  const cancelAuthorization = (id: string) => {
    if (!window.confirm(`Cancel authorization ${id} and release its reservation? This is recorded on-chain.`)) return;
    void send('cancel', id);
  };

  // ----------------------------------------------------------------- render
  const loading = !snapshot && !loadError;
  const selected = selectedId ? snapshot?.proposals.find((p) => p.proposal_id === selectedId) ?? null : null;
  const readLabel = snapshot
    ? `${snapshot.mode === 'final' ? 'Finalized' : 'Latest accepted'} state · read ${new Date(snapshot.readAt).toLocaleTimeString('en-GB')}`
    : 'Reading Studio Next…';

  const canSubmit = !!account && onRightChain && !busy && !!snapshot;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Mark />
            <div>
              <div className="brand-name">MandateGate</div>
              <div className="brand-sub">Treasury liquidity authorization · GenLayer</div>
            </div>
          </div>
          <span className="net-badge" title={`RPC ${chain.rpcUrls.default.http[0]}`}>
            <span className={`dot ${rpcLive === true ? 'live' : rpcLive === false ? 'down' : ''}`} />
            Studio Next · chain {CHAIN_ID}
          </span>
          <div className="wallet-cluster">
            {account ? (
              <>
                <span className="address-chip" title={account}>
                  {shortHex(account)}
                  {isOwner ? <span className="owner-tag">OWNER</span> : null}
                </span>
                <button type="button" className="btn on-dark secondary small" onClick={disconnect}>
                  Disconnect
                </button>
              </>
            ) : wallets.length ? (
              wallets.slice(0, 2).map((w) => (
                <button key={w.id} type="button" className="btn on-dark small" onClick={() => void connectWallet(w)}>
                  Connect {wallets.length > 1 ? w.name : 'wallet'}
                </button>
              ))
            ) : (
              <span className="net-badge">No browser wallet detected</span>
            )}
          </div>
        </div>
      </header>

      <div className="disclosure" role="note">
        <div className="disclosure-inner">
          <strong>Authorization prototype. No assets are held or deployed.</strong>
          <span>
            Amounts are accounting units in a demonstration budget. A COMPLIANT decision reserves units on-chain; nothing
            is swapped, bridged or deposited.
          </span>
        </div>
      </div>

      <main className="page">
        <section className="page-intro" aria-labelledby="page-title">
          <div className="intro-copy">
            <h1 id="page-title">Review every allocation before it moves.</h1>
            <p>
              Read the frozen mandate, confirm the evidence sources, and submit one treasury authorization to GenLayer
              consensus.
            </p>
          </div>
          <div className="intro-rail" aria-label="Authorization review flow">
            <div className="intro-step">
              <span className="intro-step-index">01</span>
              <span>Read mandate</span>
            </div>
            <div className="intro-step">
              <span className="intro-step-index">02</span>
              <span>Check evidence</span>
            </div>
            <div className="intro-step">
              <span className="intro-step-index">03</span>
              <span>Submit authorization</span>
            </div>
          </div>
        </section>

        {!configured ? (
          <div className="notice bad" style={{ marginBottom: 20 }}>
            No MandateGate contract is configured. Run <code>npm run deploy:contract</code> or set
            NEXT_PUBLIC_MANDATEGATE_ADDRESS.
          </div>
        ) : null}
        {loadError ? (
          <div className="notice bad notice-row" style={{ marginBottom: 20 }}>
            <span>
              Could not read the contract from Studio Next: {loadError}. Studio Next may have been reset, or it may be
              rate-limiting this browser.
            </span>
            <button type="button" className="btn secondary small" onClick={() => void refresh()} disabled={refreshing}>
              Retry
            </button>
          </div>
        ) : null}

        <div className="layout">
          <div className="stack">
            <BudgetPanel budget={snapshot?.budget ?? null} loading={loading} readLabel={readLabel} />

            <Panel
              title="New proposal"
              id="form-title"
              className="proposal-panel"
              meta={
                <span>
                  {demo.pair} · <span className="mono">{demo.poolId}</span>
                </span>
              }
            >
              <WalletGate
                hasWallet={wallets.length > 0}
                account={account}
                onRightChain={onRightChain}
                onSwitch={() => void switchToStudio()}
                balance={balance}
                funding={funding}
                onFund={() => void fund()}
                error={walletError}
              />
              <form className="form" onSubmit={submitProposal} noValidate style={{ marginTop: 14 }}>
                <div className="row-2">
                  <div className="field">
                    <label htmlFor="pid">Proposal ID</label>
                    <input
                      id="pid"
                      className="input mono"
                      value={draft.proposalId}
                      onChange={(e) => setDraft({ ...draft, proposalId: e.target.value })}
                      aria-invalid={touched && !!errors.proposalId}
                      aria-describedby="pid-help"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span id="pid-help" className={touched && errors.proposalId ? 'error-text' : 'hint'}>
                      {touched && errors.proposalId ? errors.proposalId : 'Unique. A used ID is rejected deterministically.'}
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="amount">Allocation amount</label>
                    <div className="input-with-suffix">
                      <input
                        id="amount"
                        className="input num"
                        inputMode="numeric"
                        value={draft.amount}
                        onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                        aria-invalid={touched && !!errors.amount}
                        aria-describedby="amount-help"
                        autoComplete="off"
                      />
                      <span className="suffix">units</span>
                    </div>
                    <span id="amount-help" className={touched && errors.amount ? 'error-text' : 'hint'}>
                      {touched && errors.amount
                        ? errors.amount
                        : `Whole units, max ${units(snapshot?.budget.per_proposal_cap ?? demo.perProposalCap)} per proposal.`}
                    </span>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="rationale">Rationale</label>
                  <textarea
                    id="rationale"
                    className="textarea"
                    value={draft.rationale}
                    maxLength={600}
                    onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
                    aria-invalid={touched && !!errors.rationale}
                    aria-describedby="rationale-help"
                  />
                  <span id="rationale-help" className={touched && errors.rationale ? 'error-text' : 'hint'}>
                    {touched && errors.rationale
                      ? errors.rationale
                      : `${draft.rationale.length}/600. Treated as untrusted context; it cannot override the mandate.`}
                  </span>
                </div>

                <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="label">Evidence URLs (1–3, public HTTPS)</legend>
                  <div className="fixtures" aria-label="Load a synthetic reviewer fixture">
                    {FIXTURES.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        className="chip-btn"
                        onClick={() => applyFixture(f.url, f.key)}
                        disabled={busy}
                      >
                        <span className="chip-swatch" style={{ background: f.color }} />
                        {f.label} fixture
                      </button>
                    ))}
                  </div>
                  {draft.urls.map((url, index) => (
                    <div className="url-row" key={index}>
                      <input
                        className="input mono"
                        type="url"
                        placeholder={index === 0 ? 'https://…' : 'Optional additional source, e.g. a live status page'}
                        aria-label={`Evidence URL ${index + 1}`}
                        value={url}
                        onChange={(e) => {
                          const urls = [...draft.urls];
                          urls[index] = e.target.value;
                          setDraft({ ...draft, urls });
                        }}
                        aria-invalid={touched && !!errors.urls}
                        spellCheck={false}
                      />
                    </div>
                  ))}
                  <span className={touched && errors.urls ? 'error-text' : 'hint'}>
                    {touched && errors.urls
                      ? errors.urls
                      : 'Validators fetch these pages themselves. Fixtures are synthetic; any live HTTPS source is accepted too.'}
                  </span>
                </fieldset>

                <div className="actions">
                  <button type="submit" className="btn" disabled={!canSubmit}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : null}
                    Submit for adjudication
                  </button>
                  <span className="hint">
                    {!account
                      ? 'Connect a wallet to submit.'
                      : !onRightChain
                        ? 'Switch to Studio Next to submit.'
                        : busy
                          ? 'A transaction is in progress.'
                          : !snapshot
                            ? 'Waiting for contract state from Studio Next before submitting.'
                          : 'Deterministic limits run first; then validators fetch and assess the evidence.'}
                  </span>
                </div>
              </form>
            </Panel>

            <DecisionPanel active={active} selected={selected} onDismiss={() => setActive(null)} />

            <HistoryPanel
              proposals={snapshot?.proposals ?? []}
              loading={loading}
              filter={filter}
              onFilter={setFilter}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                if (active && !busy) setActive(null);
                document.getElementById('decision-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              isOwner={isOwner && onRightChain}
              onCancel={cancelAuthorization}
              busy={busy}
            />
            <div className="actions">
              <button type="button" className="btn secondary small" onClick={() => void refresh('final')} disabled={refreshing}>
                {refreshing ? <span className="spinner" aria-hidden="true" /> : null}
                Refresh finalized state
              </button>
              <span className="hint">
                {isOwner
                  ? 'You are the contract owner: Cancel releases an active reservation.'
                  : 'Cancellation is owner-only. Connect the owner wallet to release reservations.'}
              </span>
            </div>
          </div>

          <aside className="stack aside">
            <MandatePanel mandate={snapshot?.mandate ?? null} loading={loading} />
            <ConfigPanel mandate={snapshot?.mandate ?? null} contract={CONTRACT_ADDRESS} deployTx={DEPLOY_TX} venue={demo.venue} />
            <StatsPanel summary={snapshot?.summary ?? null} />
            <DivisionPanel />
          </aside>
        </div>
      </main>
      <footer className="footer">
        MandateGate is a GenLayer Portal demonstration on Studio Next (a resettable development network). Evidence
        fixtures at <ExtLink href={`${demo.appUrl}/evidence/`}>/evidence/</ExtLink> are synthetic and clearly labelled.
        Contract <ExtLink href={explorerAddress(CONTRACT_ADDRESS)}>{shortHex(CONTRACT_ADDRESS, 8, 6)}</ExtLink>.
      </footer>
    </>
  );
}

function WalletGate({
  hasWallet,
  account,
  onRightChain,
  onSwitch,
  balance,
  funding,
  onFund,
  error,
}: {
  hasWallet: boolean;
  account: string | null;
  onRightChain: boolean;
  onSwitch: () => void;
  balance: bigint | null;
  funding: boolean;
  onFund: () => void;
  error: string | null;
}) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {!hasWallet ? (
        <div className="notice info">
          Reading works without a wallet. To submit, install an EIP-1193 browser wallet such as MetaMask or Rabby.
        </div>
      ) : !account ? (
        <div className="notice info">Connect a wallet from the top bar to submit proposals. Everything on this page is readable without one.</div>
      ) : !onRightChain ? (
        <div className="notice warn notice-row">
          <span>Your wallet is on another network. MandateGate runs on GenLayer Studio Next (chain {CHAIN_ID}).</span>
          <button type="button" className="btn small" onClick={onSwitch}>
            Switch to Studio Next
          </button>
        </div>
      ) : balance !== null && balance < LOW_BALANCE ? (
        <div className="notice warn notice-row">
          <span>
            Balance {gen(balance)}. Studio Next transactions take a refundable fee deposit. Use the development faucet
            to get test GEN, which has no value.
          </span>
          <button type="button" className="btn small" onClick={onFund} disabled={funding}>
            {funding ? <span className="spinner" aria-hidden="true" /> : null}
            Get test GEN
          </button>
        </div>
      ) : null}
      {error ? <div className="notice bad">{error}</div> : null}
    </div>
  );
}

const STEPS: { key: string; label: string }[] = [
  { key: 'quoting', label: 'Fee quote' },
  { key: 'signing', label: 'Wallet signature' },
  { key: 'pending', label: 'Queued' },
  { key: 'processing', label: 'Validators' },
  { key: 'decided', label: 'Decided' },
  { key: 'finalized', label: 'Finalized' },
];

function DecisionPanel({
  active,
  selected,
  onDismiss,
}: {
  active: ActiveTx | null;
  selected: Proposal | null;
  onDismiss: () => void;
}) {
  if (!active) {
    return (
      <Panel title="Decision" id="decision-title">
        {selected ? (
          <Verdict proposal={selected} finality="final" />
        ) : (
          <div className="empty">
            <strong>No decision selected</strong>
            Submit a proposal to watch it move through consensus, or choose one from the history below.
          </div>
        )}
      </Panel>
    );
  }

  const failedAt = active.stage === 'failed';
  const reached = (key: string) => {
    const order = STEPS.map((s) => s.key);
    const current = failedAt ? order.indexOf(active.tracked ? (active.tracked.phase === 'finalized' ? 'finalized' : active.tracked.phase) : active.hash ? 'pending' : 'signing') : order.indexOf(active.stage);
    const index = order.indexOf(key);
    if (index < current) return 'done';
    if (index === current) return failedAt ? 'failed' : active.stage === 'finalized' ? 'done' : 'active';
    return '';
  };
  const t = active.tracked;

  return (
    <Panel
      title={active.kind === 'evaluate' ? 'Decision' : 'Authorization cancellation'}
      id="decision-title"
      meta={
        !['finalized', 'failed'].includes(active.stage) ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span className="spinner" aria-hidden="true" /> In progress
          </span>
        ) : (
          <button type="button" className="btn ghost small" onClick={onDismiss}>
            Close
          </button>
        )
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <ol className="lifecycle" aria-label="Transaction lifecycle">
          {STEPS.map((s) => (
            <li key={s.key} className={reached(s.key)}>
              <span className="bar" />
              {s.label}
            </li>
          ))}
        </ol>

        <dl className="tx-grid">
          <dt>Proposal</dt>
          <dd className="mono">{active.proposalId}</dd>
          <dt>Transaction</dt>
          <dd className="mono">
            {active.hash ? <ExtLink href={explorerTx(active.hash)}>{shortHex(active.hash, 10, 8)}</ExtLink> : 'Not submitted yet'}
          </dd>
          <dt>Lifecycle status</dt>
          <dd className="mono">{t?.statusName ?? (active.hash ? 'PENDING' : active.stage.toUpperCase())}</dd>
          <dt>Execution result</dt>
          <dd className="mono">
            {t?.executionResult ?? '—'}
            {t?.executed === true ? ' · succeeded' : t?.executed === false ? ' · did not succeed' : ''}
          </dd>
          <dt>Fee deposit</dt>
          <dd className="mono">
            {active.quote ? (active.quote.gasless ? 'Gasless network' : `${gen(active.quote.feeValue)} (refundable, unused part returned)`) : '—'}
          </dd>
          <dt>Contract</dt>
          <dd className="mono">
            <ExtLink href={explorerAddress(CONTRACT_ADDRESS)}>{shortHex(CONTRACT_ADDRESS, 10, 8)}</ExtLink>
          </dd>
        </dl>

        {active.stage === 'quoting' ? <div className="notice info">Reading live fee prices from Studio Next…</div> : null}
        {active.stage === 'signing' ? <div className="notice info">Confirm the transaction in your wallet.</div> : null}
        {active.stage === 'pending' || active.stage === 'processing' ? (
          <div className="notice info">
            {active.kind === 'evaluate'
              ? 'The leader and validators are each fetching the evidence and assessing it against the mandate. This usually takes one to three minutes.'
              : 'Validators are executing the owner-only cancellation.'}
          </div>
        ) : null}
        {active.stage === 'decided' && t?.executed && active.kind === 'evaluate' && !active.outcome ? (
          <div className="notice info">Consensus decided and execution succeeded. Reading the recorded decision…</div>
        ) : null}
        {active.stage === 'decided' && t?.executed && active.kind === 'cancel' ? (
          <div className="notice info">
            Consensus decided and execution succeeded. The release is shown as final once the transaction finalizes.
          </div>
        ) : null}
        {active.stage === 'decided' && t && !t.executed ? (
          <div className="notice warn">
            Consensus decided but execution did not succeed ({t.statusName}/{t.executionResult ?? 'unknown'}). Waiting for
            finality before reporting.
          </div>
        ) : null}
        {active.error ? <div className="notice bad">{active.error}</div> : null}

        {active.kind === 'evaluate' && active.outcome ? (
          <Verdict proposal={active.outcome} finality={active.outcomeFinality === 'final' ? 'final' : 'decided'} />
        ) : null}
        {active.kind === 'cancel' && active.stage === 'finalized' ? (
          active.outcome?.authorization === 'CANCELLED' ? (
            <div className="notice ok">
              Authorization {active.proposalId} is cancelled and its reservation was released (read back from finalized
              contract state). The original judgment stays in the history.
            </div>
          ) : (
            <div className="notice warn">
              The transaction finalized, but the finalized contract state does not yet show this authorization as
              cancelled. Use Refresh finalized state to check again.
            </div>
          )
        ) : null}
      </div>
    </Panel>
  );
}
