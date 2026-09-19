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
import { Backdrop, Gatekeeper, Icon, Loader, PixelAvatar, type IconName } from './art';

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
  { key: 'active', label: 'Active pool', url: demo.fixtures.active, hint: 'Pool active and supported', icon: 'check' },
  { key: 'warning', label: 'Exploit warning', url: demo.fixtures.warning, hint: 'Suspension reported', icon: 'cross' },
  { key: 'ambiguous', label: 'Different pool', url: demo.fixtures.ambiguous, hint: 'Identity mismatch', icon: 'question' },
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
  const filledUrls = draft.urls.map((u) => u.trim()).filter(Boolean);

  return (
    <>
      <Backdrop />
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Mark />
            <div>
              <div className="brand-name">MandateGate</div>
              <div className="brand-sub">Treasury liquidity authorization · GenLayer</div>
            </div>
          </div>
          <span className="hud-pill net-badge" title={`RPC ${chain.rpcUrls.default.http[0]}`}>
            <span className={`dot ${rpcLive === true ? 'live' : rpcLive === false ? 'down' : ''}`} aria-hidden="true" />
            <span className="hud-label" aria-hidden="true">
              SYS
            </span>
            Studio Next · chain {CHAIN_ID}
            <span className="visually-hidden">
              {rpcLive === true ? ', online' : rpcLive === false ? ', unreachable' : ', connecting'}
            </span>
          </span>
          <div className="wallet-cluster">
            {account ? (
              <>
                <span className="hud-pill player-badge" title={account}>
                  <PixelAvatar address={account} />
                  <span className="mono">{shortHex(account)}</span>
                  {isOwner ? (
                    <span className="owner-tag">
                      <Icon name="star" size={11} />
                      OWNER
                    </span>
                  ) : null}
                </span>
                <button type="button" className="btn hud-btn secondary small" onClick={disconnect}>
                  Disconnect
                </button>
              </>
            ) : wallets.length ? (
              wallets.slice(0, 2).map((w) => (
                <button key={w.id} type="button" className="btn hud-btn small" onClick={() => void connectWallet(w)}>
                  <Icon name="bolt" size={14} />
                  Connect {wallets.length > 1 ? w.name : 'wallet'}
                </button>
              ))
            ) : (
              <span className="hud-pill net-badge">No browser wallet detected</span>
            )}
          </div>
        </div>
      </header>

      <div className="disclosure" role="note">
        <div className="disclosure-inner">
          <strong>
            <Icon name="shield" size={14} />
            Authorization prototype. No assets are held or deployed.
          </strong>
          <span>
            Amounts are accounting units in a demonstration budget. A COMPLIANT decision reserves units on-chain; nothing
            is swapped, bridged or deposited.
          </span>
        </div>
      </div>

      <main className="page">
        <section className="hero" aria-labelledby="page-title">
          <div className="hero-copy">
            <h1 id="page-title">Review every allocation before it moves.</h1>
            <p>
              Read the frozen mandate, confirm the evidence sources, and submit one treasury authorization to GenLayer
              consensus.
            </p>
            <ol className="mission-path" aria-label="Authorization review flow">
              {(
                [
                  ['1', 'Read mandate', 'scroll'],
                  ['2', 'Check evidence', 'lens'],
                  ['3', 'Submit authorization', 'flag'],
                ] as const
              ).map(([n, label, icon]) => (
                <li className="mission-node" key={n}>
                  <span className="mission-marker" aria-hidden="true">
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="mission-step">
                    <span className="step-num">Step {n}</span>
                    {label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="hero-scene" aria-hidden="true">
            <div className="scene-card">
              <span className="scene-cloud scene-cloud-a" />
              <span className="scene-cloud scene-cloud-b" />
              <Gatekeeper mood={busy ? 'waiting' : 'idle'} size={118} className="scene-mascot" />
              <span className="scene-ground" />
              <span className="scene-bubble">
                {busy ? 'Validators are reviewing…' : 'Every proposal meets the rulebook first.'}
              </span>
            </div>
          </div>
        </section>

        {!configured ? (
          <div className="notice bad page-notice">
            No MandateGate contract is configured. Run <code>npm run deploy:contract</code> or set
            NEXT_PUBLIC_MANDATEGATE_ADDRESS.
          </div>
        ) : null}
        {loadError ? (
          <div className="notice bad notice-row page-notice" role="alert">
            <Gatekeeper mood="concerned" size={40} />
            <span className="notice-text">
              Could not read the contract from Studio Next: {loadError}. Studio Next may have been reset, or it may be
              rate-limiting this browser.
            </span>
            <button type="button" className="btn secondary small" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? <Loader /> : null}
              Retry
            </button>
          </div>
        ) : null}

        <div className="layout">
          <div className="stack">
            <BudgetPanel budget={snapshot?.budget ?? null} loading={loading} readLabel={readLabel} />

            <Panel
              title="New proposal"
              kicker="Current mission"
              icon="scroll"
              id="form-title"
              className="proposal-panel"
              meta={
                <span className="target-chip">
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
              <form className="form" onSubmit={submitProposal} noValidate>
                <section className="stage" aria-labelledby="stage-details">
                  <h3 className="stage-title" id="stage-details">
                    <span className="step-badge" aria-hidden="true">
                      1
                    </span>
                    Proposal details
                  </h3>
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
                </section>

                <section className="stage" aria-labelledby="stage-rationale">
                  <h3 className="stage-title" id="stage-rationale">
                    <span className="step-badge" aria-hidden="true">
                      2
                    </span>
                    <label htmlFor="rationale">Rationale</label>
                  </h3>
                  <div className="field">
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
                </section>

                <fieldset className="stage stage-fieldset">
                  <legend className="stage-title">
                    <span className="step-badge" aria-hidden="true">
                      3
                    </span>
                    Evidence URLs (1–3, public HTTPS)
                  </legend>
                  <div className="fixtures" role="group" aria-label="Load a synthetic reviewer fixture">
                    {FIXTURES.map((f) => {
                      const selectedFixture = filledUrls.length === 1 && filledUrls[0] === f.url;
                      return (
                        <button
                          key={f.key}
                          type="button"
                          className={`cartridge cartridge-${f.key}`}
                          onClick={() => applyFixture(f.url, f.key)}
                          disabled={busy}
                          aria-pressed={selectedFixture}
                        >
                          <span className="cartridge-icon" aria-hidden="true">
                            <Icon name={f.icon as IconName} size={16} />
                          </span>
                          <span className="cartridge-text">
                            <b>{f.label} fixture</b>
                            <small>{f.hint}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="url-list">
                    {draft.urls.map((url, index) => (
                      <div className="url-row" key={index}>
                        <span className="url-slot" aria-hidden="true">
                          {index + 1}
                        </span>
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
                  </div>
                  <span className={touched && errors.urls ? 'error-text' : 'hint'}>
                    {touched && errors.urls
                      ? errors.urls
                      : 'Validators fetch these pages themselves. Fixtures are synthetic; any live HTTPS source is accepted too.'}
                  </span>
                </fieldset>

                <section className="stage stage-submit" aria-labelledby="stage-submit">
                  <h3 className="stage-title" id="stage-submit">
                    <span className="step-badge" aria-hidden="true">
                      4
                    </span>
                    Submit
                  </h3>
                  <div className="actions">
                    <button type="submit" className="btn btn-primary btn-launch" disabled={!canSubmit}>
                      {busy ? <Loader /> : <Icon name="gate" size={18} />}
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
                </section>
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
                {refreshing ? <Loader /> : null}
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
    <div className="gate-notices">
      {!hasWallet ? (
        <div className="notice info">
          <Icon name="bolt" size={16} />
          <span className="notice-text">
            Reading works without a wallet. To submit, install an EIP-1193 browser wallet such as MetaMask or Rabby.
          </span>
        </div>
      ) : !account ? (
        <div className="notice info">
          <Icon name="bolt" size={16} />
          <span className="notice-text">
            Connect a wallet from the top bar to submit proposals. Everything on this page is readable without one.
          </span>
        </div>
      ) : !onRightChain ? (
        <div className="notice warn notice-row">
          <Icon name="map" size={16} />
          <span className="notice-text">
            Your wallet is on another network. MandateGate runs on GenLayer Studio Next (chain {CHAIN_ID}).
          </span>
          <button type="button" className="btn btn-primary small" onClick={onSwitch}>
            Switch to Studio Next
          </button>
        </div>
      ) : balance !== null && balance < LOW_BALANCE ? (
        <div className="notice warn notice-row">
          <Icon name="bolt" size={16} />
          <span className="notice-text">
            Balance {gen(balance)}. Studio Next transactions take a refundable fee deposit. Use the development faucet
            to get test GEN, which has no value.
          </span>
          <button type="button" className="btn btn-primary small" onClick={onFund} disabled={funding}>
            {funding ? <Loader /> : null}
            Get test GEN
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="notice bad" role="alert">
          <Icon name="cross" size={16} />
          <span className="notice-text">{error}</span>
        </div>
      ) : null}
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

type StepState = 'done' | 'active' | 'failed' | 'pending' | 'final';

const STEP_TEXT: Record<StepState, string> = {
  done: 'completed',
  active: 'in progress',
  failed: 'failed',
  pending: 'not started',
  final: 'finalized',
};

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
      <Panel title="Decision" kicker="Quest result" icon="flag" id="decision-title" className="decision-panel">
        {selected ? (
          <Verdict proposal={selected} finality="final" />
        ) : (
          <div className="empty">
            <Gatekeeper mood="idle" size={72} />
            <strong>No decision selected</strong>
            <span>Submit a proposal to watch it move through consensus, or choose one from the history below.</span>
          </div>
        )}
      </Panel>
    );
  }

  const failedAt = active.stage === 'failed';
  const stepState = (key: string): StepState => {
    const order = STEPS.map((s) => s.key);
    const current = failedAt
      ? order.indexOf(
          active.tracked
            ? active.tracked.phase === 'finalized'
              ? 'finalized'
              : active.tracked.phase
            : active.hash
              ? 'pending'
              : 'signing',
        )
      : order.indexOf(active.stage);
    const index = order.indexOf(key);
    if (index < current) return 'done';
    if (index === current) {
      if (failedAt) return 'failed';
      return active.stage === 'finalized' ? 'final' : 'active';
    }
    return 'pending';
  };
  const t = active.tracked;
  const inFlight = !['finalized', 'failed'].includes(active.stage);
  const waiting = active.stage === 'pending' || active.stage === 'processing';

  return (
    <Panel
      title={active.kind === 'evaluate' ? 'Decision' : 'Authorization cancellation'}
      kicker="Quest result"
      icon="flag"
      id="decision-title"
      className="decision-panel"
      meta={
        inFlight ? (
          <span className="inline-status">
            <Loader /> In progress
          </span>
        ) : (
          <button type="button" className="btn ghost small" onClick={onDismiss}>
            Close
          </button>
        )
      }
    >
      <div className="decision-body">
        <ol className="lifecycle" aria-label="Transaction lifecycle">
          {STEPS.map((s) => {
            const state = stepState(s.key);
            const icon: IconName | null =
              state === 'done' ? 'check' : state === 'failed' ? 'cross' : state === 'final' ? 'flag' : null;
            return (
              <li key={s.key} className={`checkpoint ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="checkpoint-node" aria-hidden="true">
                  {icon ? <Icon name={icon} size={14} /> : state === 'active' ? <Loader /> : <span className="node-dot" />}
                </span>
                <span className="checkpoint-label">
                  {s.label}
                  <span className="visually-hidden">: {STEP_TEXT[state]}</span>
                </span>
              </li>
            );
          })}
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

        {active.stage === 'quoting' ? (
          <div className="notice info">
            <Loader />
            <span className="notice-text">Reading live fee prices from Studio Next…</span>
          </div>
        ) : null}
        {active.stage === 'signing' ? (
          <div className="notice info">
            <Icon name="bolt" size={16} />
            <span className="notice-text">Confirm the transaction in your wallet.</span>
          </div>
        ) : null}
        {waiting ? (
          <div className="notice info waiting-notice">
            <Gatekeeper mood="waiting" size={48} />
            <span className="notice-text">
              {active.kind === 'evaluate'
                ? 'The leader and validators are each fetching the evidence and assessing it against the mandate. This usually takes one to three minutes.'
                : 'Validators are executing the owner-only cancellation.'}
            </span>
          </div>
        ) : null}
        {active.stage === 'decided' && t?.executed && active.kind === 'evaluate' && !active.outcome ? (
          <div className="notice info">
            <Loader />
            <span className="notice-text">Consensus decided and execution succeeded. Reading the recorded decision…</span>
          </div>
        ) : null}
        {active.stage === 'decided' && t?.executed && active.kind === 'cancel' ? (
          <div className="notice info">
            <Icon name="bolt" size={16} />
            <span className="notice-text">
              Consensus decided and execution succeeded. The release is shown as final once the transaction finalizes.
            </span>
          </div>
        ) : null}
        {active.stage === 'decided' && t && !t.executed ? (
          <div className="notice warn">
            <Icon name="question" size={16} />
            <span className="notice-text">
              Consensus decided but execution did not succeed ({t.statusName}/{t.executionResult ?? 'unknown'}). Waiting
              for finality before reporting.
            </span>
          </div>
        ) : null}
        {active.error ? (
          <div className="notice bad" role="alert">
            <Gatekeeper mood="concerned" size={44} />
            <span className="notice-text">{active.error}</span>
          </div>
        ) : null}

        {active.kind === 'evaluate' && active.outcome ? (
          <Verdict
            proposal={active.outcome}
            finality={active.outcomeFinality === 'final' ? 'final' : 'decided'}
            celebrate={active.stage === 'finalized'}
          />
        ) : null}
        {active.kind === 'cancel' && active.stage === 'finalized' ? (
          active.outcome?.authorization === 'CANCELLED' ? (
            <div className="notice ok">
              <Icon name="undo" size={16} />
              <span className="notice-text">
                Authorization {active.proposalId} is cancelled and its reservation was released (read back from
                finalized contract state). The original judgment stays in the history.
              </span>
            </div>
          ) : (
            <div className="notice warn">
              <Icon name="question" size={16} />
              <span className="notice-text">
                The transaction finalized, but the finalized contract state does not yet show this authorization as
                cancelled. Use Refresh finalized state to check again.
              </span>
            </div>
          )
        ) : null}
      </div>
    </Panel>
  );
}