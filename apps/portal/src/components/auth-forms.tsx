'use client';

import { type FormEvent, type ReactNode, useState, useSyncExternalStore } from 'react';
import { cs } from '@/i18n/cs';

const input =
  'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/20';
const button =
  'rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:opacity-50';

/** One step to portal-web's own route (same origin; the cookies stay HttpOnly). */
async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { code: 'PORTAL_UNAVAILABLE' } };
  }
}
const message = (data: Record<string, unknown>) =>
  cs.errors[String(data.code)] ?? cs.errors.PORTAL_UNAVAILABLE!;

/**
 * The link's token is in the URL fragment (never sent to a server or its log): read once, then
 * removed from the address bar. undefined while rendering on the server.
 */
let fragmentToken: string | null | undefined;
function readFragment(): string | null {
  if (fragmentToken === undefined) {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    history.replaceState(null, '', window.location.pathname);
    fragmentToken = value && value.length === 43 ? value : null;
  }
  return fragmentToken;
}
const noSubscription = () => () => {};
function useFragmentToken(): string | null | undefined {
  return useSyncExternalStore(noSubscription, readFragment, () => undefined);
}

/** true once React runs in the browser (false in the server HTML and during hydration). */
const onTheClient = () => true;
const onTheServer = () => false;
function useInteractive(): boolean {
  return useSyncExternalStore(noSubscription, onTheClient, onTheServer);
}

/**
 * Every sign-in step's form (CI 43020769648). Until React handles it, a submit would be the
 * browser's own — a GET with the e-mail and the password in the URL (history, server logs), then
 * a fresh page without the next step. So the fields stay disabled until the page is interactive
 * (a fieldset disables them all; a disabled default button also blocks Enter), and the method is
 * POST even then: a credential never goes into a URL.
 */
function AuthForm({
  onSubmit,
  children,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const interactive = useInteractive();
  return (
    <form method="post" onSubmit={onSubmit}>
      <fieldset disabled={!interactive} className="flex min-w-0 flex-col gap-3">
        {children}
      </fieldset>
    </form>
  );
}

/** A full load: the new cookies (set by portal-web's route) apply to everything that follows. */
function go(path: string) {
  window.location.assign(path);
}

function Field(props: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  minLength?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {props.label}
      <input
        name={props.name}
        type={props.type ?? 'text'}
        required
        minLength={props.minLength}
        autoComplete={props.autoComplete}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={input}
      />
    </label>
  );
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-sm text-red-700">
      {text}
    </p>
  ) : null;
}

/** The second factor, then (on enrolment) the recovery codes, then the portal. */
function SecondFactor({ confirm, after }: { confirm: string; after: 'portal' | 'login' }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (codes)
    return (
      <div className="flex flex-col gap-3" data-testid="recovery-codes">
        <h2 className="font-semibold">{cs.recovery.title}</h2>
        <p className="text-sm text-stone-600">{cs.recovery.help}</p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <button type="button" className={button} onClick={() => go('/')}>
          {cs.recovery.continue}
        </button>
      </div>
    );
  return (
    <AuthForm
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await post('/auth/mfa', { code: code.trim() });
        setBusy(false);
        if (!r.ok) return setError(message(r.data));
        if (r.data.step === 'PASSWORD_RESET') return go('/login?reset=1');
        const recovery = r.data.recoveryCodes as string[] | undefined;
        if (recovery?.length) return setCodes(recovery);
        go(after === 'portal' ? '/' : '/login');
      }}
    >
      <Field
        label={cs.login.code}
        name="code"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
      />
      <Problem text={error} />
      <button type="submit" disabled={busy} className={button}>
        {confirm}
      </button>
    </AuthForm>
  );
}

export function LoginForm({ reset }: { reset: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);
  if (mfa) return <SecondFactor confirm={cs.login.confirm} after="portal" />;
  return (
    <AuthForm
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await post('/auth/password', { email, password });
        setBusy(false);
        if (!r.ok) return setError(message(r.data));
        setMfa(true);
      }}
    >
      {reset && <p className="text-sm text-emerald-700">{cs.login.passwordReset}</p>}
      <Field
        label={cs.login.email}
        name="email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
      />
      <Field
        label={cs.login.password}
        name="password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <Problem text={error} />
      <button type="submit" disabled={busy} className={button}>
        {cs.login.submit}
      </button>
      <a href="/forgot-password" className="text-sm underline">
        {cs.login.forgot}
      </a>
    </AuthForm>
  );
}

/** Activation and reset share a shape: a link token, a new password, then the second factor. */
function LinkAction({ kind }: { kind: 'activate' | 'reset' }) {
  const token = useFragmentToken();
  const t = kind === 'activate' ? cs.activate : cs.reset;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<{ qrDataUrl?: string; setupKey?: string } | null>(null);
  if (token === undefined) return null;
  if (token === null) return <Problem text={t.noToken} />;
  if (step)
    return (
      <div className="flex flex-col gap-3">
        {step.qrDataUrl && (
          <>
            <p className="text-sm">{cs.activate.scan}</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the core */}
            <img
              src={step.qrDataUrl}
              alt="QR kód pro ověřovací aplikaci"
              width={200}
              height={200}
            />
            <code className="text-sm break-all" data-testid="setup-key">
              {step.setupKey}
            </code>
          </>
        )}
        <SecondFactor confirm={t.confirm} after={kind === 'activate' ? 'portal' : 'login'} />
      </div>
    );
  return (
    <AuthForm
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await post(kind === 'activate' ? '/auth/activate' : '/auth/reset-password', {
          token,
          password,
        });
        setBusy(false);
        if (!r.ok) return setError(message(r.data));
        setStep({
          qrDataUrl: r.data.qrDataUrl as string | undefined,
          setupKey: r.data.setupKey as string | undefined,
        });
      }}
    >
      <Field
        label={t.password}
        name="password"
        type="password"
        minLength={12}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <Problem text={error} />
      <button type="submit" disabled={busy} className={button}>
        {t.submit}
      </button>
    </AuthForm>
  );
}

export const ActivateForm = () => <LinkAction kind="activate" />;
export const ResetForm = () => <LinkAction kind="reset" />;

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (done)
    return (
      <p role="status" className="text-sm">
        {done}
      </p>
    );
  return (
    <AuthForm
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await post('/auth/forgot-password', { email });
        setBusy(false);
        if (!r.ok) return setError(message(r.data));
        setDone(String(r.data.message));
      }}
    >
      <Field label={cs.forgot.email} name="email" type="email" value={email} onChange={setEmail} />
      <Problem text={error} />
      <button type="submit" disabled={busy} className={button}>
        {cs.forgot.submit}
      </button>
    </AuthForm>
  );
}
