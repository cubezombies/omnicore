import { useCallback, useEffect, useState } from 'react';
import type { Business } from '../../../shared/business';
import { PLATFORMS, PLATFORM_LABELS, type AuditVerification, type BrandDestination, type Incident, type Platform, type PlatformAccount, type PlatformAppSummary, type Privacy } from '../../../shared/operations';
import { errorText } from '../components/ProductionDetail';
import { PublicationHistory } from '../components/PublicationStatus';
import type { Publication } from '../../../shared/operations';

export function Accounts(props: { business: Business }) {
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [dests, setDests] = useState<BrandDestination[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [verify, setVerify] = useState<AuditVerification | null>(null);
  const [newPlatform, setNewPlatform] = useState<Platform>('tiktok');
  const [newHandle, setNewHandle] = useState('');
  const [incidentText, setIncidentText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<PlatformAppSummary[]>([]);
  const [connecting, setConnecting] = useState<number | null>(null);

  const load = useCallback(() => {
    void window.api.listAccounts().then(setAccounts);
    void window.api.listDestinations().then(setDests);
    void window.api.listIncidents().then(setIncidents);
    void window.api.platformApps().then(setApps);
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Accounts &amp; Channels</h1>
          <p className="muted">Accounts and publishing destinations that belong to {props.business.name}. Other businesses can't see or use them. Connecting an account authorizes publishing only — never advertising or spending.</p>
        </div>
      </header>
      {error && <div className="banner error" role="alert">{error}</div>}

      <h2>Platform accounts</h2>
      <p className="muted small">Register the account, then <strong>Connect</strong> signs in through the platform’s own page in your browser (Instagram uses a token from Meta’s App Dashboard). Omnicore never sees your password; sign-ins are encrypted with Windows secure storage. Connecting allows publishing only.</p>
      <ul className="tracks">
        {accounts.map((a) => (
          <li key={a.id} className="track">
            <div className="track-main">
              <div>
                <strong>{a.handle}</strong> <span className="muted small">· {PLATFORM_LABELS[a.platform]} · {a.displayName || 'no profile yet'}</span>
                <div className="small muted">Status: {a.status.replace('_', ' ')}{a.tokenExpiresAt ? ` · token expires ${new Date(a.tokenExpiresAt).toLocaleString()}` : ''}{a.lastError ? ` · ${a.lastError}` : ''}{a.lastAuthAt ? ` · last sign-in ${new Date(a.lastAuthAt).toLocaleString()}` : ''}</div>
                <div className="small muted">Can publish: {a.capabilities.canPublishPublic ? 'public' : a.capabilities.canPublishPrivate ? 'private only' : 'no'} · Financial permissions: never{a.capabilities.restrictions.length ? ` · ${a.capabilities.restrictions.join('; ')}` : ''}</div>
              </div>
              <span />
              <span className="track-actions">
                {a.status !== 'connected' && (
                  <button className="secondary" disabled={connecting !== null || !apps.find((x) => x.platform === a.platform)?.configured} title={apps.find((x) => x.platform === a.platform)?.configured ? '' : 'Set up the developer app below first'} onClick={() => (setConnecting(a.id), act(() => window.api.connectAccount(a.id)).finally(() => setConnecting(null)))}>
                    {connecting === a.id ? 'Waiting for sign-in…' : 'Connect'}
                  </button>
                )}
                {a.status !== 'not_connected' && <button className="ghost" onClick={() => act(() => window.api.disconnectAccount(a.id))}>Disconnect</button>}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="install-row">
        <select aria-label="Platform" value={newPlatform} onChange={(e) => setNewPlatform(e.target.value as Platform)}>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
        </select>
        <input aria-label="Handle" placeholder="@aiactuallyofficial" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} />
        <button className="secondary" disabled={!newHandle.trim()} onClick={() => act(async () => (await window.api.addAccount(newPlatform, newHandle), setNewHandle('')))}>Register account</button>
      </div>

      <h2>Developer apps</h2>
      <p className="muted small">Each platform requires your own registered developer app (setup: docs/launch-setup.md). Secrets are stored encrypted and never shown again.</p>
      <ul className="tracks">
        {apps.map((ap) => <AppForm key={ap.platform} app={ap} onSaved={load} onError={setError} />)}
      </ul>

      <h2>AI, Actually destinations</h2>
      <p className="muted small">Every production is assigned these destinations when it is created. Omnicore never falls back to another account.</p>
      <ul className="tracks">
        {dests.map((d) => {
          const options = accounts.filter((a) => a.platform === d.platform);
          return (
            <li key={d.id} className="track">
              <div className="track-edit">
                <strong>{PLATFORM_LABELS[d.platform]}</strong>
                <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => act(() => window.api.setDestination(d.platform, d.accountId, e.target.checked, d.privacy))} /> Publish here</label>
                <label className="field"><span>Account</span>
                  <select value={d.accountId ?? ''} onChange={(e) => act(() => window.api.setDestination(d.platform, e.target.value ? Number(e.target.value) : null, d.enabled, d.privacy))}>
                    <option value="">— none assigned —</option>
                    {options.map((a) => <option key={a.id} value={a.id}>{a.handle} ({a.status.replace('_', ' ')})</option>)}
                  </select>
                </label>
                <label className="field"><span>Visibility</span>
                  <select value={d.privacy} onChange={(e) => act(() => window.api.setDestination(d.platform, d.accountId, d.enabled, e.target.value as Privacy))}>
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public (needs your approval per video)</option>
                  </select>
                </label>
              </div>
            </li>
          );
        })}
      </ul>


      <BusinessPublicationHistory />
      <h2>Rights &amp; audit</h2>
      <div className="prod-actions">
        <button className="secondary" onClick={() => act(async () => setVerify(await window.api.verifyAudit()))}>Verify audit ledger</button>
        {verify && <span className={verify.ok ? 'muted small' : 'field-error small'}>{verify.ok ? `Verified ${verify.events} events — no tampering detected.` : verify.reason}</span>}
      </div>
      <div className="install-row">
        <input aria-label="Incident description" placeholder="Record a rights complaint or incident…" value={incidentText} onChange={(e) => setIncidentText(e.target.value)} />
        <button className="secondary" disabled={!incidentText.trim()} onClick={() => act(async () => (await window.api.addIncident('rights_complaint', incidentText, null, ''), setIncidentText('')))}>Record complaint</button>
      </div>
      <ul className="content-list">
        {incidents.map((i) => (
          <li key={i.id} className="idea small"><span className="badge stage-review">{i.status}</span> {i.kind.replace('_', ' ')} · {i.description} {i.status === 'open' && <button className="ghost" onClick={() => act(() => window.api.resolveIncident(i.id))}>Resolve</button>}</li>
        ))}
      </ul>
    </section>
  );
}

function AppForm({ app, onSaved, onError }: { app: PlatformAppSummary; onSaved: () => void; onError: (e: string | null) => void }) {
  const [clientId, setClientId] = useState(app.clientId);
  const [secret, setSecret] = useState('');
  const [port, setPort] = useState(app.redirectPort);
  const [token, setToken] = useState('');
  const [base, setBase] = useState(app.publicVideoBaseUrl);
  const ig = app.platform === 'instagram';
  const save = async () => {
    onError(null);
    try {
      await window.api.savePlatformApp(app.platform, ig ? { accessToken: token, publicVideoBaseUrl: base } : { clientId, clientSecret: secret, redirectPort: port });
      setSecret('');
      setToken('');
      onSaved();
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <li className="track">
      <div className="track-edit">
        <strong>{PLATFORM_LABELS[app.platform]}</strong> <span className={app.configured ? 'muted small' : 'field-error small'}>{app.configured ? 'configured' : 'not configured'}</span>
        {ig ? (
          <>
            <label className="field"><span>Access token (Meta App Dashboard → Instagram → API setup){app.hasAccessToken ? ': stored' : ''}</span><input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={app.hasAccessToken ? '•••••• (leave blank to keep)' : ''} /></label>
            <label className="field"><span>Public video location (https; Instagram downloads &lt;location&gt;/&lt;id&gt;.mp4)</span><input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://…" /></label>
          </>
        ) : (
          <>
            <label className="field"><span>{app.platform === 'tiktok' ? 'Client key' : 'OAuth client ID (Desktop app)'}</span><input value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
            <label className="field"><span>Client secret{app.hasSecret ? ': stored' : ''}</span><input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={app.hasSecret ? '•••••• (leave blank to keep)' : ''} /></label>
            {app.platform === 'tiktok' && <label className="field"><span>Redirect port (register http://127.0.0.1:{port}/callback in TikTok’s developer portal)</span><input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} /></label>}
          </>
        )}
        <div className="prod-actions"><button className="secondary" onClick={save}>Save</button></div>
      </div>
    </li>
  );
}

/** Every publication of this business, including posts whose production was later deleted. */
function BusinessPublicationHistory() {
  const [pubs, setPubs] = useState<Publication[] | null>(null);
  const load = useCallback(() => void window.api.publicationHistory().then(setPubs).catch(() => setPubs([])), []);
  useEffect(load, [load]);
  if (!pubs) return null;
  return (
    <section>
      <h2>Publication history</h2>
      <p className="muted small">Every upload attempt and post, newest first. Records are never overwritten or removed, even when the production is deleted.</p>
      {pubs.length === 0 ? (
        <p className="empty">Nothing has been uploaded yet.</p>
      ) : (
        <>
          {pubs.some((x) => x.productionId === null) && <p className="small muted">Entries marked “production deleted” belong to productions that no longer exist; the record is kept as history.</p>}
          {Object.entries(
            pubs.reduce<Record<string, Publication[]>>((acc, x) => {
              const k = `#${x.productionNumber} ${x.productionTopic}${x.productionId === null ? ' (production deleted)' : ''}`;
              (acc[k] ??= []).push(x);
              return acc;
            }, {})
          ).map(([k, list]) => (
            <div key={k} className="card">
              <h3>{k}</h3>
              <PublicationHistory pubs={list} onChanged={load} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
