'use client';

import { SITE_CAPABILITIES, siteDetailSchema, type Site, type SiteCapability } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.sites_admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/** Creates a site or edits its operational details and capabilities (the code never changes). */
export function SiteForm({ site }: { site?: Site }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [fields, setFields] = useState({
    name: site?.name ?? '',
    countryCode: site?.countryCode ?? '',
    addressLine1: site?.addressLine1 ?? '',
    addressLine2: site?.addressLine2 ?? '',
    postalCode: site?.postalCode ?? '',
    city: site?.city ?? '',
    timeZone: site?.timeZone ?? '',
    defaultLocale: site?.defaultLocale ?? '',
    defaultCurrency: site?.defaultCurrency ?? '',
  });
  const [capabilities, setCapabilities] = useState<SiteCapability[]>(site?.capabilities ?? []);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const input = (key: keyof typeof fields, text: string, props: object = {}) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={label}>{text}</span>
      <input value={fields[key]} onChange={set(key)} className={inputClass} {...props} />
    </label>
  );

  return (
    <Card>
      <form
        className="flex max-w-3xl flex-col gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const body = {
            ...fields,
            countryCode: fields.countryCode.toUpperCase(),
            defaultCurrency: fields.defaultCurrency.toUpperCase(),
            addressLine2: fields.addressLine2 || null,
            capabilities,
            reason,
          };
          try {
            const saved = site
              ? await apiSend('POST', `admin/sites/${site.id}`, siteDetailSchema, body)
              : await apiSend('POST', 'admin/sites', siteDetailSchema, { ...body, code });
            router.push(`/admin/sites/${saved.id}`);
            router.refresh();
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!site && (
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>{t.code}</span>
              <input
                required
                pattern="[A-Z][A-Z0-9\-]{1,19}"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className={`${inputClass} font-mono`}
              />
            </label>
          )}
          {input('name', t.name, { required: true, maxLength: 120 })}
          {input('countryCode', t.country, { required: true, pattern: '[A-Za-z]{2}' })}
          {input('addressLine1', t.address1, { required: true, maxLength: 200 })}
          {input('addressLine2', t.address2, { maxLength: 200 })}
          {input('postalCode', t.postalCode, { required: true, maxLength: 20 })}
          {input('city', t.city, { required: true, maxLength: 120 })}
          {input('timeZone', t.timeZone, { required: true, placeholder: 'Europe/Prague' })}
          {input('defaultLocale', t.locale, { required: true, placeholder: 'cs-CZ' })}
          {input('defaultCurrency', t.currency, { required: true, pattern: '[A-Za-z]{3}' })}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className={label}>{t.capabilities}</legend>
          <div className="flex flex-wrap gap-4">
            {SITE_CAPABILITIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={capabilities.includes(c)}
                  onChange={() =>
                    setCapabilities((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]))
                  }
                />
                {t.capability[c]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className={label}>{identityCs.admin.reason}</span>
          <input
            required
            minLength={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={identityCs.admin.reasonPlaceholder}
            className={inputClass}
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? t.saving : t.save}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** Deactivates (when nothing blocks it) or reactivates a site, with a reason. */
export function SiteStatus({
  id,
  active,
  blocked,
}: {
  id: string;
  active: boolean;
  blocked: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={identityCs.admin.reasonPlaceholder}
        aria-label={identityCs.admin.reason}
        className={inputClass}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="button"
        disabled={busy || blocked || reason.trim().length < 3}
        className={`${active ? buttonClass.danger : buttonClass.secondary} self-start whitespace-nowrap`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiSend(
              'POST',
              `admin/sites/${id}/${active ? 'deactivate' : 'reactivate'}`,
              siteDetailSchema,
              { reason },
            );
            setReason('');
            router.refresh();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {active ? t.deactivate : t.reactivate}
      </button>
    </div>
  );
}
