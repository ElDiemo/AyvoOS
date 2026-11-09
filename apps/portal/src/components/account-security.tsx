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
  );
}
