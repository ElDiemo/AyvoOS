'use client';

import {
  pplSettingsSchema,
  verifyCarrierResultSchema,
  type PplSettings,
  type PplSettingsInput,
  type Site,
} from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, ErrorNote, inputClass, Notice } from '@/components/ui';
import { carriersCs as t } from '@/i18n/cs/carriers';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiSend, ClientApiError } from '@/lib/client-api';

const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';
type SenderKey = keyof PplSettingsInput['sender'];

const errorText = (error: unknown) =>
  error instanceof ClientApiError && error.code && t.errors[error.code]
    ? t.errors[error.code]!
    : error instanceof Error
      ? error.message
      : 'Akce se nezdařila.';

const inputOf = (s: PplSettings): PplSettingsInput => ({
  enabled: s.enabled,
  connection: s.connection,
  sender: { ...s.sender },
  productCode: s.productCode,
  label: { ...s.label },
});

/**
 * Dopravci a expedice (doc 029 §9): the site's PPL settings, ADMIN only. Incomplete settings may
 * be saved — the server lists what blocks new shipments. Never shows or accepts a secret or an API
 * URL: a connection is chosen by its server-side code, with "nastaveno / nenastaveno" for its
 * credentials. "Ověřit připojení" reads PPL's service list and creates nothing.
 */
export function CarrierSettings({
  initial,
  site,
  canManageConnections,
}: {
  initial: PplSettings;
  site: Site;
  /** Whether the viewer may enter connection credentials (Správa systému → Dopravci). */
  canManageConnections: boolean;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [form, setForm] = useState<PplSettingsInput>(() => inputOf(initial));
  const [prefilled, setPrefilled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const saving = useAttempt();
  const verifying = useAttempt();
  const dirty = JSON.stringify(form) !== JSON.stringify(inputOf(settings));
  const connection = settings.connections.find((c) => c.code === form.connection) ?? null;
  const products =
    settings.verified && settings.verified.connection === form.connection
      ? settings.verified.products
      : [];
  const accept = (next: PplSettings) => {
    setSettings(next);
    setForm(inputOf(next));
    setPrefilled(false);
    router.refresh();
  };
  const setSender = (key: SenderKey) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, sender: { ...f.sender, [key]: e.target.value || null } }));
  const field = (key: SenderKey, text: string, props: object = {}) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={label}>{text}</span>
      <input
        value={form.sender[key] ?? ''}
        onChange={setSender(key)}
        className={inputClass}
        data-testid={`carrier-sender-${key}`}
        {...props}
      />
    </label>
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const body = {
      ...form,
      sender: { ...form.sender, country: form.sender.country?.toUpperCase() ?? null },
    };
    const r = await saving.run(JSON.stringify(body), (requestId) =>
      apiSend('PUT', `admin/sites/${site.id}/carriers/ppl`, pplSettingsSchema, {
        requestId,
        ...body,
      }),
    );
    if (r.ok) {
      accept(r.value);
      setMessage(t.saved);
    } else if (r.error) setError(errorText(r.error));
  }

  async function verify() {
    setError(null);
    setMessage(null);
    const r = await verifying.run(`verify:${settings.updatedAt}`, (requestId) =>
      apiSend('POST', `admin/sites/${site.id}/carriers/ppl/verify`, verifyCarrierResultSchema, {
        requestId,
      }),
    );
    if (!r.ok) {
      if (r.error) setError(errorText(r.error));
      return;
    }
    accept(r.value.settings);
    if (r.value.ok) setMessage(t.verifyOk(r.value.settings.verified?.products.length ?? 0));
    else setError(r.value.error);
  }

  return (
    <Card
      title={t.title}
      testId="carrier-settings"
      action={
        connection?.environment === 'TEST' && (
          <span
            className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900"
            data-testid="carrier-settings-test-environment"
          >
            {t.testEnvironment}
          </span>
        )
      }
    >
      <form className="flex max-w-3xl flex-col gap-5" onSubmit={save}>
        <p className="text-sm text-stone-600">{t.intro}</p>
        <div className="flex items-center gap-2">
          <span className="rounded bg-stone-900 px-2 py-0.5 text-xs font-semibold text-white">
            {t.ppl}
          </span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              data-testid="carrier-enabled"
            />
            {t.enabled}
          </label>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className={label}>{t.connection}</legend>
          <select
            value={form.connection ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, connection: e.target.value || null }))}
            className={inputClass}
            aria-label={t.connection}
            data-testid="carrier-connection"
          >
            <option value="">{t.connectionNone}</option>
            {settings.connections.map((c) => (
              <option key={c.code} value={c.code}>
                {t.connectionName(c.code, c.environment)}
              </option>
            ))}
          </select>
          {connection && (
            <p className="text-sm" data-testid="carrier-credentials">
              {t.credentials}:{' '}
              <strong className={connection.credentials === 'SET' ? '' : 'text-red-700'}>
                {connection.credentials === 'SET' ? t.credentialsSet : t.credentialsMissing}
              </strong>
              {connection.source && (
                <span className="text-stone-500"> ({t.connections.source[connection.source]})</span>
              )}
              {canManageConnections && (
                <>
                  {' · '}
                  <Link
                    href="/admin/carriers"
                    className="underline"
                    data-testid="carrier-manage-connections"
                  >
                    {t.manageConnections}
                  </Link>
                </>
              )}
            </p>
          )}
          {connection?.environment === 'TEST' && (
            <p className="text-xs text-stone-500">{t.testEnvironmentHint}</p>
          )}
          <p className="text-xs text-stone-500">{t.credentialsHint}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className={label}>{t.sender}</legend>
          <div>
            <button
              type="button"
              className={buttonClass.secondary}
              data-testid="carrier-prefill"
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  sender: {
                    ...f.sender,
                    name: f.sender.name ?? site.name,
                    street:
                      [site.addressLine1, site.addressLine2].filter(Boolean).join(', ') || null,
                    city: site.city,
                    postalCode: site.postalCode,
                    country: site.countryCode,
                  },
                }));
                setPrefilled(true);
              }}
            >
              {t.prefill}
            </button>
          </div>
          {prefilled && <Notice tone="warning">{t.prefillHint}</Notice>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field('name', t.senderName, { maxLength: 50 })}
            {field('street', t.street, { maxLength: 60 })}
            {field('city', t.city, { maxLength: 50 })}
            {field('postalCode', t.postalCode, { maxLength: 10 })}
            {field('country', t.country, { maxLength: 2, pattern: '[A-Za-z]{2}' })}
            {field('contact', t.contact, { maxLength: 50 })}
            {field('phone', t.phone, { maxLength: 30, type: 'tel' })}
            {field('email', t.email, { maxLength: 50, type: 'email' })}
          </div>
          <p className="text-xs text-stone-500">{t.latinHint}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className={label}>{t.service}</legend>
          <select
            value={form.productCode ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, productCode: e.target.value || null }))}
            className={inputClass}
            disabled={products.length === 0}
            aria-label={t.service}
            data-testid="carrier-product"
          >
            <option value="">{t.serviceNone}</option>
            {products.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} ({p.code})
              </option>
            ))}
          </select>
          {products.length === 0 && (
            <p className="text-xs text-stone-500">{t.serviceNotVerified}</p>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className={label}>{t.label}</legend>
          <div className="grid grid-cols-1 gap-4">
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.format}</span>
              <select
                value={form.label.format}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    label: {
                      ...f.label,
                      format: e.target.value as 'PDF' | 'ZPL',
                      // The complete A4 document exists only as PDF.
                      layout: e.target.value === 'ZPL' ? 'SINGLE' : f.label.layout,
                    },
                  }))
                }
                className={inputClass}
                data-testid="carrier-label-format"
              >
                <option value="PDF">{t.formatPdf}</option>
                <option value="ZPL">{t.formatZpl}</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.dpi}</span>
              <select
                value={form.label.dpi}
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: { ...f.label, dpi: Number(e.target.value) } }))
                }
                className={inputClass}
                data-testid="carrier-label-dpi"
              >
                {[203, 300, 600].map((d) => (
                  <option key={d} value={d}>
                    {t.dpiValue(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.layout}</span>
              <select
                value={form.label.layout}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    label: { ...f.label, layout: e.target.value as 'SINGLE' | 'A4' },
                  }))
                }
                className={inputClass}
                data-testid="carrier-label-layout"
              >
                <option value="SINGLE">{t.layoutSingle}</option>
                <option value="A4" disabled={form.label.format !== 'PDF'}>
                  {t.layoutA4}
                </option>
              </select>
            </label>
          </div>
          <p className="text-xs text-stone-500">
            {form.label.format === 'ZPL' ? t.a4NeedsPdf : t.dpiHint}
          </p>
          <p className="text-xs text-stone-500">{t.labelSizeHint}</p>
        </fieldset>

        <div className="flex flex-col gap-2 text-sm" data-testid="carrier-problems">
          {settings.problems.length === 0 ? (
            <p className="text-emerald-800">{t.ready}</p>
          ) : (
            <Notice tone="warning">
              <span className="font-medium">{t.problemsTitle}</span>
              <ul className="mt-1 list-disc pl-5">
                {settings.problems.map((p) => (
                  <li key={p}>{t.problem[p]}</li>
                ))}
              </ul>
            </Notice>
          )}
          <p className="text-xs text-stone-500" data-testid="carrier-verified">
            {settings.verified
              ? t.verifiedAt(
                  formatDateTimeCs(settings.verified.at),
                  settings.verified.by,
                  settings.verified.connection,
                )
              : t.notVerified}
          </p>
          {settings.updatedAt && settings.updatedBy && (
            <p className="text-xs text-stone-500">
              {t.lastChange(formatDateTimeCs(settings.updatedAt), settings.updatedBy)}
            </p>
          )}
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}
        {message && (
          <p className="text-sm text-emerald-800" role="status" data-testid="carrier-message">
            {message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving.busy || !dirty}
            className={buttonClass.primary}
            data-testid="carrier-save"
          >
            {saving.busy ? t.saving : t.save}
          </button>
          <button
            type="button"
            onClick={verify}
            disabled={verifying.busy || dirty || !settings.saved || !settings.connection}
            className={buttonClass.secondary}
            data-testid="carrier-verify"
          >
            {verifying.busy ? t.verifying : t.verify}
          </button>
        </div>
        <p className="text-xs text-stone-500">{dirty ? t.verifySaveFirst : t.verifyHint}</p>
      </form>
    </Card>
  );
}
