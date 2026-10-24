'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { z } from 'zod';
import { AuthPage } from './auth-page';
import { buttonClass, ErrorNote, Notice } from './ui';
import { safeNextPath } from '@/lib/safe-path';

type Mode = 'login' | 'activate' | 'reset' | 'forgot' | 'replace';
type Step = 'PASSWORD' | 'MFA' | 'ENROLL_MFA' | 'RECOVERY';
const resultSchema = z.object({
  step: z.enum(['MFA', 'ENROLL_MFA', 'DONE', 'PASSWORD_RESET']).optional(),
  message: z.string().optional(),
  nextPath: z.string().optional(),
  qrDataUrl: z.string().startsWith('data:image/png;base64,').optional(),
  setupKey: z
    .string()
    .regex(/^[A-Z2-7]{32,64}$/)
    .optional(),
  recoveryCodes: z
    .array(z.string().regex(/^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/))
    .length(10)
    .optional(),
});
const inputClass =
  'mt-2 block w-full rounded-md border border-stone-300 bg-white px-3 py-3 text-base text-stone-900 focus:border-stone-700 focus:outline-none focus:ring-2 focus:ring-stone-200';

/** Same-origin screens only. No external SDK, redirect, local storage, analytics or secret logging. */
export function NativeSignIn({
  mode = 'login',
  next = '/',
  signedOut = false,
  passwordReset = false,
}: {
  mode?: Mode;
  next?: string;
  signedOut?: boolean;
  passwordReset?: boolean;
}) {
  const [step, setStep] = useState<Step>('PASSWORD');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [code, setCode] = useState('');
  const [linkToken, setLinkToken] = useState('');
  const [qr, setQr] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [destination, setDestination] = useState(safeNextPath(next));
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [linkRead, setLinkRead] = useState(false);
  const tokenRead = useRef(false);
  const submitting = useRef(false);

  useEffect(() => {
    if (mode !== 'activate' && mode !== 'reset') return;
    if (tokenRead.current) return;
    tokenRead.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    // Never leak the bearer link through access logs, Referer, copied URL or later navigation.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setLinkToken(/^[A-Za-z0-9_-]{43}$/.test(token) ? token : '');
    setLinkRead(true);
  }, [mode]);

  const needsLink = mode === 'activate' || mode === 'reset';
  const choosingPassword = needsLink;
  const title =
    step === 'RECOVERY'
      ? 'Uložte si záložní kódy'
      : step === 'ENROLL_MFA'
        ? 'Nastavení ověřovací aplikace'
        : step === 'MFA'
          ? 'Ověření přihlášení'
          : mode === 'activate'
            ? 'Vítejte v AYVO OS'
            : mode === 'reset'
              ? 'Nové heslo'
              : mode === 'forgot'
                ? 'Obnova hesla'
                : mode === 'replace'
                  ? 'Změnit ověřovací aplikaci'
                  : 'Přihlášení';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    if (step === 'PASSWORD' && choosingPassword && password !== confirmation) {
      setError('Hesla se neshodují.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const path =
        step !== 'PASSWORD'
          ? 'mfa'
          : mode === 'activate'
            ? 'activate'
            : mode === 'reset'
              ? 'reset-password'
              : mode === 'forgot'
                ? 'forgot-password'
                : mode === 'replace'
                  ? 'replace-mfa'
                  : 'password';
      const body =
        step !== 'PASSWORD'
          ? { code }
          : needsLink
            ? { token: linkToken, password }
            : mode === 'forgot'
              ? { email }
              : mode === 'replace'
                ? { password, code }
                : { email, password, next: safeNextPath(next) };
      const response = await fetch(`/api/auth/native/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ code: z.string().optional() }).safeParse(data);
        const reason = failure.success ? failure.data.code : undefined;
        setError(
          reason === 'RATE_LIMITED'
            ? 'Příliš mnoho pokusů. Zkuste to za chvíli.'
            : reason === 'AUTH_UNAVAILABLE'
              ? 'Přihlášení je dočasně nedostupné. Zkuste to za chvíli.'
              : reason === 'INVALID_LINK'
                ? 'Odkaz už neplatí. Vyžádejte si nový odkaz.'
                : reason === 'INVALID_MFA'
                  ? 'Kód neplatí nebo už byl použit. Zadejte nový kód.'
                  : 'Přihlášení se nezdařilo. Zkontrolujte zadané údaje.',
        );
        return;
      }
      const result = resultSchema.parse(data);
      setPassword('');
      setConfirmation('');
      setCode('');
      if (mode === 'forgot') {
        setMessage(result.message ?? 'Pokud účet existuje, pošleme odkaz na obnovu hesla.');
        return;
      }
      if (result.step === 'ENROLL_MFA' && result.qrDataUrl && result.setupKey) {
        setQr(result.qrDataUrl);
        setSetupKey(result.setupKey);
        setStep('ENROLL_MFA');
        setLinkToken('');
      } else if (result.step === 'MFA') {
        setStep('MFA');
        setLinkToken('');
      } else if (result.step === 'DONE' || result.step === 'PASSWORD_RESET') {
        const target = safeNextPath(result.nextPath);
        setQr('');
        setSetupKey('');
        if (result.recoveryCodes) {
          setCodes(result.recoveryCodes);
          setDestination(target);
          setStep('RECOVERY');
        } else window.location.assign(target);
      } else throw new Error('Incomplete authentication response');
    } catch {
      setError('Spojení se nezdařilo. Zkuste to znovu.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthPage title={title}>
      {signedOut && step === 'PASSWORD' && <Notice tone="info">Byli jste odhlášeni.</Notice>}
      {passwordReset && step === 'PASSWORD' && (
        <Notice tone="info">Heslo bylo změněno. Přihlaste se novým heslem.</Notice>
      )}
      {error && (
        <div role="alert">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {message ? (
        <>
          <Notice tone="info">{message}</Notice>
          <Link href="/login" className={buttonClass.secondary}>
            Zpět na přihlášení
          </Link>
        </>
      ) : step === 'RECOVERY' ? (
        <>
          <p>
            Pomohou vám, když ztratíte telefon. Každý kód lze použít jednou. Uložte je bezpečně,
            nikomu je neposílejte.
          </p>
          <ul
            className="space-y-2 rounded-md bg-stone-100 p-4 font-mono text-xs"
            aria-label="Záložní kódy"
          >
            {codes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => window.location.assign(destination)}
          >
            Kódy mám uložené — pokračovat
          </button>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          {step === 'PASSWORD' ? (
            <>
              {(mode === 'login' || mode === 'forgot') && (
                <label>
                  E-mail
                  <input
                    className={inputClass}
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    maxLength={254}
                    autoFocus
                  />
                </label>
              )}
              {mode === 'activate' && (
                <p>Zvolte si heslo. V dalším kroku jednou nastavíte ověřovací aplikaci.</p>
              )}
              {needsLink && linkRead && !linkToken && (
                <ErrorNote>
                  Platný odkaz chybí. Otevřete znovu pozvánku nebo odkaz z e-mailu.
                </ErrorNote>
              )}
              {mode !== 'forgot' && (
                <label>
                  {choosingPassword ? 'Nové heslo' : 'Heslo'}
                  <input
                    className={inputClass}
                    type="password"
                    autoComplete={choosingPassword ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={choosingPassword ? 12 : 1}
                    maxLength={1024}
                    aria-describedby={choosingPassword ? 'password-help' : undefined}
                  />
                </label>
              )}
              {choosingPassword && (
                <>
                  <p id="password-help" className="-mt-3 text-xs text-stone-500">
                    Alespoň 12 znaků. Můžete použít delší větu.
                  </p>
                  <label>
                    Heslo znovu
                    <input
                      className={inputClass}
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      required
                      maxLength={1024}
                    />
                  </label>
                </>
              )}
              {mode === 'replace' && (
                <label>
                  Aktuální ověřovací nebo záložní kód
                  <input
                    className={inputClass}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                    maxLength={64}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              {step === 'ENROLL_MFA' ? (
                <>
                  <p>
                    V ověřovací aplikaci zvolte přidání účtu a načtěte tento QR kód. Pak zadejte
                    její šestimístný kód.
                  </p>
                  <Image
                    src={qr}
                    alt="QR pro nastavení ověřovací aplikace AYVO OS"
                    width={256}
                    height={256}
                    unoptimized
                    className="mx-auto h-auto max-w-full"
                  />
                  <details className="text-xs">
                    <summary>Nemohu načíst QR kód</summary>
                    <p className="mt-2 break-all font-mono">{setupKey}</p>
                  </details>
                </>
              ) : (
                <p>
                  {usingRecovery
                    ? 'Zadejte jeden z uložených záložních kódů.'
                    : 'Zadejte šestimístný kód z ověřovací aplikace.'}
                </p>
              )}
              <label>
                {usingRecovery ? 'Záložní kód' : 'Ověřovací kód'}
                <input
                  className={`${inputClass} font-mono tracking-wider`}
                  inputMode={usingRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  minLength={6}
                  maxLength={usingRecovery ? 35 : 6}
                  autoFocus
                />
              </label>
              {step === 'MFA' && (
                <button
                  type="button"
                  className="text-left text-xs underline"
                  onClick={() => {
                    setUsingRecovery(!usingRecovery);
                    setCode('');
                    setError('');
                  }}
                >
                  {usingRecovery
                    ? 'Použít ověřovací aplikaci'
                    : 'Nemám telefon — použít záložní kód'}
                </button>
              )}
            </>
          )}
          <button
            className={`${buttonClass.primary} w-full`}
            type="submit"
            disabled={busy || (step === 'PASSWORD' && needsLink && !linkToken)}
            data-testid="native-sign-in"
          >
            {busy
              ? 'Chvilku prosím…'
              : step !== 'PASSWORD'
                ? 'Ověřit a pokračovat'
                : mode === 'forgot'
                  ? 'Poslat odkaz'
                  : mode === 'login'
                    ? 'Přihlásit se'
                    : 'Pokračovat'}
          </button>
          {mode === 'login' && step === 'PASSWORD' && (
            <Link href="/forgot-password" className="text-center text-xs underline">
              Zapomenuté heslo
            </Link>
          )}
          {mode !== 'login' && (
            <Link href="/login" className="text-center text-xs underline">
              Zpět na přihlášení
            </Link>
          )}
        </form>
      )}
    </AuthPage>
  );
}
