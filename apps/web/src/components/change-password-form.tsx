'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { AuthPage } from './auth-page';
import { buttonClass, ErrorNote, Notice } from './ui';

const inputClass =
  'mt-2 block w-full rounded-md border border-stone-300 bg-white px-3 py-3 text-base text-stone-900 focus:border-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-200';

/**
 * "Změnit heslo" of a signed-in account: the current password, a current code (or an unused
 * recovery code) and the new password twice. Every other session ends; this browser keeps the
 * new session the server sets.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submitting = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError(null);
    if ([...next].length < 12) return setError('Nové heslo musí mít aspoň 12 znaků.');
    if (next !== again) return setError('Nové heslo a jeho potvrzení se liší.');
    submitting.current = true;
    setBusy(true);
    try {
      const response = await fetch('/api/auth/native/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next, code: code.trim() }),
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => ({}));
        const failure = z.object({ code: z.string().optional() }).safeParse(data);
        const reason = failure.success ? failure.data.code : undefined;
        setError(
          reason === 'RATE_LIMITED'
            ? 'Příliš mnoho pokusů. Zkuste to za chvíli.'
            : reason === 'AUTH_UNAVAILABLE'
              ? 'Služba je dočasně nedostupná. Zkuste to za chvíli.'
              : reason === 'UNAUTHENTICATED' || reason === 'SESSION_EXPIRED'
                ? 'Přihlášení vypršelo. Přihlaste se znovu.'
                : 'Heslo nebo kód nesouhlasí. Zkontrolujte je a zkuste to znovu.',
        );
        return;
      }
      setCurrent('');
      setNext('');
      setAgain('');
      setCode('');
      setDone(true);
    } catch {
      setError('Spojení se nezdařilo. Zkuste to znovu.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthPage title="Změnit heslo">
      {error && (
        <div role="alert" data-testid="change-password-error">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {done ? (
        <>
          <div data-testid="change-password-done">
            <Notice tone="info">Heslo je změněné. Ostatní zařízení jsou odhlášená.</Notice>
          </div>
          <Link href="/" className={buttonClass.primary}>
            Pokračovat
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <p className="text-sm text-stone-600">
            Po změně se odhlásíte ze všech ostatních zařízení; v tomto prohlížeči zůstanete
            přihlášeni.
          </p>
          {(
            [
              ['current-password', 'Současné heslo', current, setCurrent, 'current-password'],
              ['new-password', 'Nové heslo (aspoň 12 znaků)', next, setNext, 'new-password'],
              ['new-password-again', 'Nové heslo znovu', again, setAgain, 'new-password'],
            ] as const
          ).map(([name, label, value, set, auto]) => (
            <label key={name} className="text-sm font-medium text-stone-800">
              {label}
              <input
                name={name}
                type="password"
                required
                autoComplete={auto}
                value={value}
                onChange={(e) => set(e.target.value)}
                className={inputClass}
              />
            </label>
          ))}
          <label className="text-sm font-medium text-stone-800">
            Kód z ověřovací aplikace (nebo nepoužitý záchranný kód)
            <input
              name="code"
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${inputClass} font-mono tracking-wider`}
            />
          </label>
          <button type="submit" disabled={busy} className={`${buttonClass.primary} w-full`}>
            Změnit heslo
          </button>
          <Link href="/account/security" className="text-center text-xs underline">
            Zpět na zabezpečení účtu
          </Link>
        </form>
      )}
    </AuthPage>
  );
}
