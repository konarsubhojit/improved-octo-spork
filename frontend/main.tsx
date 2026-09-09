import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Dashboard = {
  reminders: Array<{ id: string; title: string; nextDueAt: string; state: string; editVersion: number }>;
  services: Array<{ id: string; name: string; pullState?: string; pushState?: string }>;
  incidents: Array<{ id: string; service: string; mode: string; openedAt: string }>;
  notifications: Array<{ id: string; subject: string; state: string; updatedAt: string }>;
  quota: { rolling24h: number; rolling24hLimit: number; monthly: number; monthlyLimit: number };
};

type Recipient = {
  recipientId: string;
  email: string;
  ownershipVerifiedAt: string | null;
  consentedAt: string | null;
  unsubscribedAt: string | null;
  version: number;
};

function Badge({ value }: { value: string | undefined }) {
  const label = value ?? 'unknown';
  return <span className={`badge ${label}`}>{label}</span>;
}

function App() {
  const [data, setData] = useState<Dashboard>();
  const [error, setError] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [csrfToken, setCsrfToken] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);

  const loadDashboard = () =>
    fetch('/api/dashboard', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (response.status === 401) throw new Error('Sign in with your invite token to view this workspace.');
        if (!response.ok) throw new Error('Dashboard data is temporarily unavailable.');
        return response.json() as Promise<Dashboard>;
      })
      .then(setData)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Unable to load dashboard.'));

  const loadRecipients = () =>
    fetch('/api/recipients', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load recipients.');
        const payload = (await response.json()) as { recipients: Recipient[] };
        setRecipients(payload.recipients);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Unable to load recipients.'));

  useEffect(() => {
    void loadDashboard().then(() => loadRecipients()).catch(() => undefined);
  }, []);

  const verifyInvite = async () => {
    setError('');
    const response = await fetch('/api/auth/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken })
    });
    if (!response.ok) {
      setError('Invite token is invalid or expired.');
      return;
    }
    const payload = response.status === 204 ? await response.json().catch(() => ({ csrfToken: '' })) : await response.json();
    setCsrfToken(payload.csrfToken ?? '');
    await loadDashboard();
    await loadRecipients();
  };

  const signOut = async () => {
    await fetch('/api/auth/signout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken, Origin: window.location.origin } : { Origin: window.location.origin }
    });
    setData(undefined);
    setCsrfToken('');
    setRecipients([]);
  };

  const patchReminder = async (reminderId: string, expectedEditVersion: number, action: 'pause' | 'resume') => {
    setError('');
    const response = await fetch(`/api/reminders/${reminderId}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Origin: window.location.origin
      },
      body: JSON.stringify({ action, expectedEditVersion })
    });
    if (!response.ok) {
      setError(response.status === 409 ? 'Reminder changed elsewhere. Reload and try again.' : 'Unable to update reminder.');
      return;
    }
    await loadDashboard();
  };

  const deleteReminder = async (reminderId: string, expectedEditVersion: number) => {
    setError('');
    const response = await fetch(`/api/reminders/${reminderId}?expectedEditVersion=${expectedEditVersion}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken, Origin: window.location.origin }
    });
    if (!response.ok) {
      setError(response.status === 409 ? 'Reminder changed elsewhere. Reload and try again.' : 'Unable to delete reminder.');
      return;
    }
    await loadDashboard();
  };

  const setSubscription = async (recipient: Recipient, subscribed: boolean) => {
    setError('');
    const response = await fetch(`/api/recipients/${recipient.recipientId}/subscription`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Origin: window.location.origin
      },
      body: JSON.stringify({ expectedVersion: recipient.version, subscribed })
    });
    if (!response.ok) {
      setError(response.status === 409 ? 'Recipient changed elsewhere. Reload and try again.' : 'Unable to update recipient preference.');
      return;
    }
    await loadRecipients();
  };

  return (
    <main>
      <header>
        <div><p className="eyebrow">Personal workspace</p><h1>Reminders & service health</h1></div>
        <button type="button" onClick={() => void signOut()}>Sign out</button>
      </header>
      <aside>
        Calendar reminders preserve local wall time across DST. Missing monthly dates are skipped.
        Pull and push status are independent; one mode never clears the other.
      </aside>
      {!data && <section className="notice">
        <p>Sign in with an invite token.</p>
        <input value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} aria-label="Invite token" />
        <button type="button" onClick={() => void verifyInvite()}>Verify invite</button>
      </section>}
      {error && <section className="notice">{error}</section>}
      {!data && !error && <p>Loading…</p>}
      {data && <>
        <section>
          <h2>Upcoming reminders</h2>
          {data.reminders.length === 0 ? <p className="muted">No upcoming reminders.</p> :
            data.reminders.map((item) => <article key={item.id}>
              <strong>{item.title}</strong><span>{item.nextDueAt}</span><Badge value={item.state} />
              <span>
                {item.state === 'paused'
                  ? <button type="button" onClick={() => void patchReminder(item.id, item.editVersion, 'resume')}>Resume</button>
                  : <button type="button" onClick={() => void patchReminder(item.id, item.editVersion, 'pause')}>Pause</button>}
                <button type="button" onClick={() => void deleteReminder(item.id, item.editVersion)}>Delete</button>
              </span>
            </article>)}
        </section>
        <section>
          <h2>Recipient preferences</h2>
          {recipients.length === 0 ? <p className="muted">No recipients.</p> : recipients.map((recipient) => (
            <article key={recipient.recipientId}>
              <strong>{recipient.email}</strong>
              <Badge value={recipient.unsubscribedAt ? 'unsubscribed' : recipient.consentedAt ? 'subscribed' : 'pending'} />
              {recipient.unsubscribedAt
                ? <button type="button" onClick={() => void setSubscription(recipient, true)}>Resubscribe</button>
                : <button type="button" onClick={() => void setSubscription(recipient, false)}>Unsubscribe</button>}
            </article>
          ))}
        </section>
        <section>
          <h2>Services</h2>
          {data.services.map((service) => <article key={service.id}><strong>{service.name}</strong>
            <span>Pull <Badge value={service.pullState} /></span><span>Push <Badge value={service.pushState} /></span></article>)}
        </section>
        <div className="grid">
          <section><h2>Open incidents</h2>{data.incidents.length || <p className="muted">No open incidents.</p>}</section>
          <section><h2>Email quota</h2>
            <p>{data.quota.rolling24h}/{data.quota.rolling24hLimit} recipient-attempts in 24h</p>
            <p>{data.quota.monthly}/{data.quota.monthlyLimit} this month</p>
          </section>
        </div>
        <section><h2>Notification problems</h2>
          {data.notifications.filter(({ state }) => ['failed', 'retrying', 'outcome-unknown'].includes(state)).map((item) =>
            <article key={item.id}><strong>{item.subject}</strong><Badge value={item.state} /><span>{item.updatedAt}</span></article>)}
        </section>
      </>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
