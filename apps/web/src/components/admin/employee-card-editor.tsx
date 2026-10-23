'use client';

import {
  employeeCardResponseSchema,
  employeeCardPhotoSchema,
  saveEmployeeCardSchema,
  type AdminEmployeeCard,
  type EmployeeCardFields,
} from '@ayvo/types';
import { useId, useState } from 'react';
import { EmployeeCard } from '@/components/identity/employee-card';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { employeeCardsCs as t } from '@/i18n/cs/employee-cards';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';

const emptyFields = (name: string): EmployeeCardFields => ({
  name,
  role: '',
  company: '',
  tagline: '',
  phone: '',
  email: '',
  website: '',
  linkedin: '',
  photoId: null,
});

export function EmployeeCardEditor({
  userId,
  displayName,
  active,
}: {
  userId: string;
  displayName: string;
  active: boolean;
}) {
  const base = `admin/identity/users/${userId}/business-card`;
  const id = useId();
  const [loaded, setLoaded] = useState(false);
  const [card, setCard] = useState<AdminEmployeeCard | null>(null);
  const [fields, setFields] = useState<EmployeeCardFields>(emptyFields(displayName));
  const [slug, setSlug] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [stale, setStale] = useState(false);
  const [serverDraft, setServerDraft] = useState<EmployeeCardFields | null>(null);
  const [showPublished, setShowPublished] = useState(false);
  const [pending, setPending] = useState<{ json: string; requestId: string } | null>(null);
  const dirty =
    JSON.stringify(fields) !== JSON.stringify(card?.draft ?? emptyFields(displayName)) ||
    slug !== (card?.slug ?? '');

  async function load(keepEdits = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiGet(base, employeeCardResponseSchema);
      setCard(result.card);
      setLoaded(true);
      setStale(false);
      if (!keepEdits) {
        setFields(result.card?.draft ?? emptyFields(displayName));
        setSlug(result.card?.slug ?? '');
        setServerDraft(null);
      } else if (result.card) {
        setSlug(result.card.slug);
        setServerDraft(result.card.draft);
      }
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nepodařilo se načíst vizitku.');
    } finally {
      setBusy(false);
    }
  }

  async function action(kind: 'save' | 'publish' | 'hide') {
    setError(null);
    setStatus('');
    if (reason.trim().length < 3) {
      setError('Vyplňte důvod změny (alespoň 3 znaky).');
      return;
    }
    if (kind === 'publish' && dirty) {
      setError(t.unsaved);
      return;
    }
    const payload = {
      expectedVersion: card?.version ?? 0,
      reason: reason.trim(),
      ...(kind === 'save' ? { slug, fields } : {}),
    };
    const json = JSON.stringify({ kind, ...payload });
    const requestId = pending?.json === json ? pending.requestId : crypto.randomUUID();
    setPending({ json, requestId });
    if (kind === 'save') {
      const parsed = saveEmployeeCardSchema.safeParse({ ...payload, requestId });
      if (!parsed.success) {
        setError(parsed.error.issues.map((i) => i.message).join(' '));
        return;
      }
    }
    setBusy(true);
    try {
      const result = await apiSend(
        'POST',
        kind === 'save' ? base : `${base}/${kind}`,
        employeeCardResponseSchema,
        { ...payload, requestId },
      );
      setCard(result.card);
      if (kind !== 'hide' || !dirty) {
        setFields(result.card?.draft ?? fields);
        setSlug(result.card?.slug ?? slug);
      }
      setReason('');
      setPending(null);
      setStale(false);
      setServerDraft(null);
      setStatus(
        kind === 'save'
          ? t.saved
          : kind === 'publish'
            ? result.card?.published
              ? t.publishedSuccess
              : 'Požadavek už byl zpracován, ale vizitka je nyní skrytá. Zobrazuji aktuální stav.'
            : result.card?.published
              ? 'Požadavek už byl zpracován, ale vizitka byla mezitím znovu zveřejněna. Zobrazuji aktuální stav.'
              : t.hiddenSuccess,
      );
    } catch (e) {
      if (e instanceof ClientApiError && e.code === 'EMPLOYEE_CARD_STALE') {
        setStale(true);
        setError(t.stale);
      } else setError(e instanceof Error ? e.message : 'Změnu se nepodařilo uložit.');
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('requestId', crypto.randomUUID());
      const result = await apiSend('POST', `${base}/photos`, employeeCardPhotoSchema, form);
      setFields((current) => ({ ...current, photoId: result.id }));
      setStatus('Fotografie je v konceptu. Uložte koncept a pak ho případně zveřejněte.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fotografii se nepodařilo nahrát.');
    } finally {
      setBusy(false);
    }
  }

  const preview = showPublished && card?.published ? card.published : fields;
  return (
    <Card title={t.title} id="vizitka" testId="employee-card-editor">
      <p className="mb-4 text-sm text-stone-600">{t.description}</p>
      {!loaded ? (
        <>
          <button
            className={buttonClass.secondary}
            type="button"
            disabled={busy}
            onClick={() => void load()}
          >
            Otevřít nastavení vizitky
          </button>
          {error && <ErrorNote>{error}</ErrorNote>}
        </>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="min-w-0 space-y-5">
            <p className="text-sm font-medium" role="status">
              {!active ? t.inactive : card?.published ? t.published : card ? t.hidden : t.draft}
            </p>
            <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className="sm:col-span-2">
                <span className="mb-1 block text-sm font-medium">{t.slug}</span>
                <span className="block text-xs text-stone-500">id.ayvo.co/</span>
                <input
                  className={inputClass}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  readOnly={!!card}
                  aria-describedby={`${id}-slug`}
                  maxLength={80}
                />
                <span id={`${id}-slug`} className="mt-1 block text-xs text-stone-500">
                  {t.slugHelp}
                </span>
              </label>
              {Object.entries(t.fields).map(([key, label]) => (
                <label key={key} className={key === 'tagline' ? 'sm:col-span-2' : ''}>
                  <span className="mb-1 block text-sm font-medium">{label}</span>
                  <input
                    className={inputClass}
                    aria-label={label}
                    aria-describedby={key === 'email' ? `${id}-email-help` : undefined}
                    value={fields[key as keyof typeof t.fields]}
                    type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
                    maxLength={
                      key === 'tagline'
                        ? 300
                        : ['website', 'linkedin'].includes(key)
                          ? 500
                          : key === 'email'
                            ? 254
                            : key === 'phone'
                              ? 40
                              : 120
                    }
                    onChange={(e) =>
                      setFields((current) => ({ ...current, [key]: e.target.value }))
                    }
                  />
                  {key === 'email' && (
                    <span id={`${id}-email-help`} className="mt-1 block text-xs text-stone-500">
                      {t.noDefaultEmail}
                    </span>
                  )}
                </label>
              ))}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium">
                  {t.photo}
                  <input
                    className="mt-2 block w-full min-w-0 text-sm"
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={(e) => {
                      void upload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
                <p className="mt-1 text-xs text-stone-500">{t.photoHelp}</p>
                {fields.photoId && (
                  <button
                    className="mt-2 text-sm underline"
                    type="button"
                    onClick={() => setFields((current) => ({ ...current, photoId: null }))}
                  >
                    {t.removePhoto}
                  </button>
                )}
              </div>
              <label className="sm:col-span-2">
                <span className="mb-1 block text-sm font-medium">{t.reason}</span>
                <input
                  className={inputClass}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            </fieldset>
            {dirty && <p className="text-sm text-amber-800">{t.unsaved}</p>}
            {error && <ErrorNote>{error}</ErrorNote>}
            {stale && (
              <button
                type="button"
                disabled={busy}
                className={buttonClass.secondary}
                onClick={() => void load(true)}
              >
                {t.reload}
              </button>
            )}
            {status && (
              <p className="text-sm text-stone-700" role="status">
                {status}
              </p>
            )}
            {serverDraft && (
              <section
                aria-label="Aktuální uložený koncept"
                className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
              >
                <h3 className="font-medium">Zkontrolujte aktuálně uložené údaje</h3>
                <p className="mt-1">
                  Vaše rozepsané hodnoty zůstaly ve formuláři. Uložením konceptu je výslovně
                  použijete místo těchto hodnot ze serveru.
                </p>
                <dl className="mt-2 space-y-1">
                  {Object.entries(t.fields)
                    .filter(
                      ([key]) =>
                        fields[key as keyof typeof t.fields] !==
                        serverDraft[key as keyof typeof t.fields],
                    )
                    .map(([key, label]) => (
                      <div key={key}>
                        <dt className="font-medium">{label}</dt>
                        <dd className="wrap-anywhere">
                          {serverDraft[key as keyof typeof t.fields] || 'Nevyplněno'}
                        </dd>
                      </div>
                    ))}
                  {serverDraft.photoId !== fields.photoId && (
                    <div>
                      <dt className="font-medium">Fotografie</dt>
                      <dd>
                        {serverDraft.photoId
                          ? 'Na serveru je uložená fotografie.'
                          : 'Na serveru není fotografie.'}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || stale}
                className={buttonClass.primary}
                onClick={() => void action('save')}
              >
                {t.save}
              </button>
              <button
                type="button"
                disabled={busy || stale || dirty || !card || !active}
                className={buttonClass.secondary}
                onClick={() => void action('publish')}
              >
                {t.publish}
              </button>
              {card?.published && (
                <button
                  type="button"
                  disabled={busy || stale}
                  className={buttonClass.danger}
                  onClick={() => void action('hide')}
                >
                  {t.hide}
                </button>
              )}
            </div>
            <p className="text-xs text-stone-500">{t.publicationNotice}</p>
          </div>
          <div className="min-w-0 border-t border-stone-200 pt-5 xl:sticky xl:top-6 xl:border-t-0 xl:pt-0">
            <div className="mb-5 flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={!showPublished}
                className={buttonClass.secondary}
                onClick={() => setShowPublished(false)}
              >
                {t.preview}
              </button>
              {card?.published && (
                <button
                  type="button"
                  aria-pressed={showPublished}
                  className={buttonClass.secondary}
                  onClick={() => setShowPublished(true)}
                >
                  {t.publishedPreview}
                </button>
              )}
            </div>
            <EmployeeCard
              fields={preview}
              photoUrl={preview.photoId ? `/api/${base}/photos/${preview.photoId}` : undefined}
              preview
              contactUrl="#"
            />
          </div>
        </div>
      )}
    </Card>
  );
}
