'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { account } from '@/i18n/account';
import { button, Field, message, post, Problem, SecondFactor } from './auth-forms';

/**
 * Replacing the authenticator app of the signed-in account: the current password and a current
 * code (or an unused recovery code), then the new app's QR code and a code of the new app; the
 * new recovery codes are shown once (the ordinary second-factor step).
 */
export function AccountSecurityForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<{ qrDataUrl?: string; setupKey?: string } | null>(null);
  if (step)
    return (
      <div className="flex flex-col gap-3" data-testid="replace-mfa-setup">
        <p className="text-sm">{account.scan}</p>
        {step.qrDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the core
          <img
            src={step.qrDataUrl}
            alt="QR kód pro novou ověřovací aplikaci"
            width={200}
            height={200}
          />
        )}
        <code className="text-sm break-all" data-testid="setup-key">
          {step.setupKey}
        </code>
        <SecondFactor confirm={account.confirm} after="portal" label={account.confirmLabel} />
      </div>
    );
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">{account.mfaTitle}</h2>
      <p className="text-sm text-stone-600">{account.mfaHelp}</p>
      <form
        className="flex flex-col gap-3"
        data-testid="replace-mfa-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const r = await post('/auth/replace-mfa', { password, code: code.trim() });
          setBusy(false);
          if (!r.ok) {
            if (r.data.code === 'UNAUTHENTICATED') return router.push('/login');
            return setError(account.errors[String(r.data.code)] ?? message(r.data));
          }
          setPassword('');
          setCode('');
          setStep({
            qrDataUrl: r.data.qrDataUrl as string | undefined,
            setupKey: r.data.setupKey as string | undefined,
          });
        }}
      >
        <Field
          label={account.password}
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <Field
          label={account.code}
          name="current-code"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
        />
        <Problem text={error} />
        <button type="submit" disabled={busy} className={button}>
          {account.submit}
        </button>
      </form>
    </section>
  );
}

/** "Odhlásit ze všech zařízení": one confirmation, then every session ends (this one too). */
export function LogoutEverywhere() {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = account.everywhere;
  return (
    <section className="flex flex-col gap-3" data-testid="logout-everywhere">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-sm text-stone-600">{t.help}</p>
      {asking ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const r = await post('/auth/logout-all', {});
              setBusy(false);
              if (r.ok || r.data.code === 'UNAUTHENTICATED') return router.push('/login');
              setError(t.failed);
            }}
          >
            {t.confirm}
          </button>
          <button
            type="button"
            className="rounded-md border border-stone-300 px-4 py-2 text-sm"
            onClick={() => setAsking(false)}
          >
            {t.cancel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="self-start rounded-md border border-stone-300 px-4 py-2 text-sm"
          onClick={() => setAsking(true)}
        >
          {t.start}
        </button>
      )}
      <Problem text={error} />
    </section>
  );
}

/** "Změnit heslo": current password, a current code, the new password; other devices signed out. */
export function ChangePasswordForm() {
  const router = useRouter();
  const t = account.changePassword;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <section className="flex flex-col gap-3" data-testid="change-password">
      <h2 className="font-semibold">{t.title}</h2>
      <p className="text-sm text-stone-600">{t.help}</p>
      {done ? (
        <p role="status" className="text-sm text-emerald-800" data-testid="change-password-done">
          {t.done}
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            if ([...next].length < 12) return setError(t.tooShort);
            setBusy(true);
            const r = await post('/auth/change-password', {
              currentPassword: current,
              newPassword: next,
              code: code.trim(),
            });
            setBusy(false);
            if (!r.ok) {
              if (r.data.code === 'UNAUTHENTICATED') return router.push('/login');
              return setError(account.errors[String(r.data.code)] ?? message(r.data));
            }
            setCurrent('');
            setNext('');
            setCode('');
            setDone(true);
          }}
        >
          <Field
            label={t.current}
            name="current-password"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <Field
            label={t.next}
            name="new-password"
            type="password"
            minLength={12}
            value={next}
            onChange={setNext}
            autoComplete="new-password"
          />
          <Field
            label={t.code}
            name="password-code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <Problem text={error} />
          <button type="submit" disabled={busy} className={button}>
            {t.submit}
          </button>
        </form>
      )}
    </section>
  );
}
