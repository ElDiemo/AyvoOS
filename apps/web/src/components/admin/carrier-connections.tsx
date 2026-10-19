'use client';

import { carrierConnectionAdminSchema, type CarrierConnectionAdmin } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, ErrorNote, inputClass, Notice } from '@/components/ui';
import { carriersCs } from '@/i18n/cs/carriers';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = carriersCs.connections;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

const errorText = (error: unknown) =>
  error instanceof ClientApiError && error.code && t.errors[error.code]
    ? t.errors[error.code]!
    : error instanceof Error
      ? error.message
      : 'Akce se nezdařila.';

/** One connection: its state and a write-only form to enter or replace its credentials. */
function Connection({
  connection,
  onSaved,
}: {
  connection: CarrierConnectionAdmin;
  onSaved: (list: CarrierConnectionAdmin[]) => void;
}) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const saving = useAttempt();
  const c = connection;
  return (
    <Card
      title={`${c.carrier} · ${c.code}`}
      testId={`connection-${c.code}`}
      action={
        c.environment === 'TEST' && (
          <span className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
            {t.environment.TEST}
          </span>
        )
      }
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="text-sm" data-testid={`connection-${c.code}-state`}>
          <strong className={c.credentials === 'SET' ? '' : 'text-red-700'}>
            {t.credentials[c.credentials]}
          </strong>
          {c.source && <span className="text-stone-500"> · {t.source[c.source]}</span>}
        </p>
        {c.updatedAt && c.updatedBy && (
          <p className="text-xs text-stone-500">
            {t.lastChange(formatDateTimeCs(c.updatedAt), c.updatedBy)}
          </p>
        )}
        {!c.keyAvailable ? (
          <Notice tone="warning">{t.keyMissing}</Notice>
        ) : (
          <form
            className="flex flex-col gap-4"
            autoComplete="off"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              setMessage(null);
              // The key of an attempt never contains the secret itself.
              const r = await saving.run(`${c.code}:${clientId}:${secret.length}:${reason}`, (id) =>
                apiSend(
                  'POST',
                  `admin/carrier-connections/${c.code}/credentials`,
                  z.array(carrierConnectionAdminSchema),
                  { requestId: id, clientId, clientSecret: secret, reason },
                ),
              );
              // The secret leaves the page in any case; it is never kept in the browser.
              setSecret('');
              if (r.ok) {
                setClientId('');
                setReason('');
                setMessage(t.saved);
                onSaved(r.value);
              } else if (r.error) setError(errorText(r.error));
            }}
          >
            <Notice tone="info">{t.accountWarning}</Notice>
            <label className="flex flex-col gap-1">
              <span className={label}>{t.clientId}</span>
              <input
                required
                maxLength={200}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className={inputClass}
                autoComplete="off"
                spellCheck={false}
                data-testid={`connection-${c.code}-client-id`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>{t.clientSecret}</span>
              <input
                required
                type="password"
                maxLength={500}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                className={inputClass}
                autoComplete="new-password"
                spellCheck={false}
                data-testid={`connection-${c.code}-secret`}
              />
              <span className="text-xs text-stone-500">{t.secretHint}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>{t.reason}</span>
              <input
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={inputClass}
                data-testid={`connection-${c.code}-reason`}
              />
            </label>
            {error && <ErrorNote>{error}</ErrorNote>}
            {message && (
              <p className="text-sm text-emerald-800" role="status">
                {message}
              </p>
            )}
            <div>
              <button
                type="submit"
                disabled={saving.busy}
                className={buttonClass.primary}
                data-testid={`connection-${c.code}-save`}
              >
                {saving.busy ? t.replacing : t.replace}
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

/**
 * Správa systému → Dopravci (ADR 0027): the server-side connections (TEST only in this stage).
 * Credentials are write-only: the page never receives a stored secret, only "nastaveno /
 * nenastaveno" and where they come from.
 */
export function CarrierConnections({ initial }: { initial: CarrierConnectionAdmin[] }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  return (
    <div className="flex flex-col gap-6">
      {list.map((c) => (
        <Connection
          key={c.code}
          connection={c}
          onSaved={(next) => {
            setList(next);
            router.refresh();
          }}
        />
      ))}
      <p className="text-xs text-stone-500">{t.productionAbsent}</p>
    </div>
  );
}
