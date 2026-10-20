'use client';

import {
  printAgentTokenSchema,
  sitePrintingSchema,
  type PrintAgent,
  type Printer,
  type SitePrinting as SitePrintingData,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  ConfirmDialog,
  ReasonField,
  reasonError,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, Card, EmptyState, inputClass, Notice } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { printingCs as t } from '@/i18n/cs/printing';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';

const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';
const errorText = (error: unknown) =>
  error instanceof ClientApiError && error.code && t.errors[error.code]
    ? t.errors[error.code]!
    : uncertain(error)
      ? 'Spojení se serverem selhalo – zkuste to znovu (stejný požadavek se nezdvojí).'
      : error instanceof Error
        ? error.message
        : 'Akce se nezdařila.';

type PrinterForm = {
  id: string | null;
  code: string;
  name: string;
  agentId: string;
  usbSerial: string;
  dispatchDefault: boolean;
  autoPrint: boolean;
  enabled: boolean;
};

/**
 * Tiskárny a tiskoví agenti of a site (doc 030 §3, ADR 0028), ADMIN only (`printing:manage`). An
 * agent's token is shown exactly once (creation or rotation) and only its hash is stored.
 */
export function SitePrinting({
  initial,
  timeZone,
}: {
  initial: SitePrintingData;
  timeZone: string;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [token, setToken] = useState<{ agent: string; value: string | null } | null>(null);
  const [form, setForm] = useState<PrinterForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const base = `admin/sites/${data.site.id}/printing`;
  const accept = (next: SitePrintingData) => {
    setData(next);
    router.refresh();
  };

  return (
    <Card title={t.title} testId="site-printing">
      <div className="flex flex-col gap-6 text-sm">
        <p className="text-stone-600">{t.intro}</p>
        {token && (
          <TokenNotice agent={token.agent} token={token.value} onDismiss={() => setToken(null)} />
        )}
        <section className="flex flex-col gap-3" aria-label={t.agents}>
          <h3 className={label}>{t.agents}</h3>
          {data.agents.length === 0 ? (
            <EmptyState>{t.noAgents}</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-stone-200" data-testid="print-agents">
              {data.agents.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  base={base}
                  timeZone={timeZone}
                  onToken={(value) => setToken({ agent: a.code, value })}
                  onChanged={accept}
                />
              ))}
            </ul>
          )}
          <AddAgent
            base={base}
            onCreated={(agent, value) => {
              setToken({ agent, value });
              router.refresh();
              void reload(base).then((d) => d && setData(d));
            }}
          />
        </section>
        <section className="flex flex-col gap-3" aria-label={t.printers}>
          <h3 className={label}>{t.printers}</h3>
          <p className="text-xs text-stone-500">{t.mediaUnknown}</p>
          {data.printers.length === 0 ? (
            <EmptyState>{t.noPrinters}</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-stone-200" data-testid="printers">
              {data.printers.map((p) => (
                <PrinterRow
                  key={p.id}
                  printer={p}
                  timeZone={timeZone}
                  onEdit={() =>
                    setForm({
                      id: p.id,
                      code: p.code,
                      name: p.name,
                      agentId: p.agent.id,
                      usbSerial: p.usbSerial,
                      dispatchDefault: p.dispatchDefault,
                      autoPrint: p.autoPrint,
                      enabled: p.enabled,
                    })
                  }
                />
              ))}
            </ul>
          )}
          {form ? (
            <PrinterFormView
              form={form}
              agents={data.agents.filter((a) => !a.revokedAt)}
              base={base}
              onChange={setForm}
              onCancel={() => setForm(null)}
              onSaved={(next) => {
                accept(next);
                setForm(null);
                setMessage(t.saved);
                setError(null);
              }}
              onError={setError}
            />
          ) : (
            data.agents.some((a) => !a.revokedAt) && (
              <div>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() =>
                    setForm({
                      id: null,
                      code: '',
                      name: '',
                      agentId: data.agents.find((a) => !a.revokedAt)!.id,
                      usbSerial: '',
                      dispatchDefault: !data.printers.some((p) => p.dispatchDefault),
                      autoPrint: true,
                      enabled: true,
                    })
                  }
                  data-testid="add-printer"
                >
                  {t.addPrinter}
                </button>
              </div>
            )
          )}
          {message && (
            <p className="text-emerald-800" data-testid="printing-message">
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="font-medium text-red-700" data-testid="printing-error">
              {error}
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}

async function reload(base: string) {
  try {
    return await apiGet(base, sitePrintingSchema);
  } catch {
    return null;
  }
}

function TokenNotice({
  agent,
  token,
  onDismiss,
}: {
  agent: string;
  token: string | null;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!token) return <Notice tone="warning">{t.tokenReplay}</Notice>;
  return (
    <Notice tone="warning">
      <div className="flex flex-col gap-2" data-testid="agent-token">
        <span className="font-semibold">
          {t.tokenTitle} ({agent})
        </span>
        <span>{t.tokenText}</span>
        <code
          className="break-all rounded border border-amber-300 bg-white px-2 py-1 font-mono text-xs"
          data-testid="agent-token-value"
        >
          {token}
        </code>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(token)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? t.copied : t.copy}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            onClick={onDismiss}
            data-testid="agent-token-dismiss"
          >
            {t.dismiss}
          </button>
        </div>
      </div>
    </Notice>
  );
}

function AddAgent({
  base,
  onCreated,
}: {
  base: string;
  onCreated: (agent: string, token: string | null) => void;
}) {
  const id = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = { code: code.trim().toUpperCase(), name: name.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `${base}/agents`, printAgentTokenSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setCode('');
      setName('');
      setError(null);
      onCreated(result.value.agent.code, result.value.token);
    } else if (result.error) setError(errorText(result.error));
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className={label}>{t.code}</span>
        <input
          id={`${id}-code`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={inputClass}
          placeholder="RPI-EXPEDICE"
          required
          data-testid="agent-code"
        />
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={label}>{t.name}</span>
        <input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder="Raspberry Pi – expedice"
          required
          data-testid="agent-name"
        />
      </label>
      <button
        type="submit"
        className={buttonClass.secondary}
        disabled={busy}
        data-testid="add-agent"
      >
        {t.addAgent}
      </button>
      {error && (
        <p role="alert" className="w-full font-medium text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

function AgentRow({
  agent,
  base,
  timeZone,
  onToken,
  onChanged,
}: {
  agent: PrintAgent;
  base: string;
  timeZone: string;
  onToken: (token: string | null) => void;
  onChanged: (data: SitePrintingData) => void;
}) {
  const id = useId();
  const [dialog, setDialog] = useState<'rotate' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  async function confirm() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid || !dialog) return;
    const body = { reason: reason.trim() };
    if (dialog === 'rotate') {
      const result = await run(`rotate:${agent.id}:${body.reason}`, (requestId) =>
        apiSend('POST', `${base}/agents/${agent.id}/rotate`, printAgentTokenSchema, {
          requestId,
          ...body,
        }),
      );
      if (result.ok) {
        setDialog(null);
        setReason('');
        onToken(result.value.token);
      } else if (result.error) setError(errorText(result.error));
    } else {
      const result = await run(`revoke:${agent.id}:${body.reason}`, (requestId) =>
        apiSend('POST', `${base}/agents/${agent.id}/revoke`, sitePrintingSchema, {
          requestId,
          ...body,
        }),
      );
      if (result.ok) {
        setDialog(null);
        onChanged(result.value);
      } else if (result.error) setError(errorText(result.error));
    }
  }
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`agent-${agent.code}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{agent.name}</span>
        <span className="font-mono text-xs">{agent.code}</span>
        {agent.revokedAt ? (
          <span className="rounded border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-xs">
            {t.revoked}
          </span>
        ) : (
          <span
            className={
              agent.online
                ? 'rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900'
                : 'rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900'
            }
            data-testid={`agent-${agent.code}-online`}
          >
            {agent.online ? t.online : t.offline}
          </span>
        )}
        <span className="text-xs text-stone-500">
          {agent.lastSeenAt ? t.lastSeen(formatDateTimeCs(agent.lastSeenAt, timeZone)) : t.never}
          {agent.lastVersion && ` · ${t.version(agent.lastVersion)}`} ·{' '}
          {t.tokenHint(agent.tokenHint)}
        </span>
      </div>
      {!agent.revokedAt && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setDialog('rotate')}
          >
            {t.rotate}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setDialog('revoke')}
          >
            {t.revoke}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'rotate' ? t.rotateTitle : t.revokeTitle}
        confirmLabel={dialog === 'rotate' ? t.rotate : t.revoke}
        danger={dialog === 'revoke'}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setDialog(null)}
        testId="agent-dialog"
      >
        <p>{dialog === 'rotate' ? t.rotateText : t.revokeText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
      </ConfirmDialog>
    </li>
  );
}

function PrinterRow({
  printer,
  timeZone,
  onEdit,
}: {
  printer: Printer;
  timeZone: string;
  onEdit: () => void;
}) {
  const badge = 'rounded border px-1.5 py-0.5 text-xs';
  return (
    <li className="flex flex-col gap-1 py-3" data-testid={`printer-${printer.code}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{printer.name}</span>
        <span className="font-mono text-xs">{printer.code}</span>
        {printer.dispatchDefault && (
          <span className={`${badge} border-sky-300 bg-sky-50 text-sky-900`}>{t.defaultBadge}</span>
        )}
        {printer.autoPrint && (
          <span className={`${badge} border-stone-300 bg-stone-50`}>{t.autoBadge}</span>
        )}
        {!printer.enabled && (
          <span className={`${badge} border-stone-300 bg-stone-100`}>{t.disabledBadge}</span>
        )}
      </div>
      <p className="text-xs text-stone-600">
        {t.modelSpec} · {t.agent}: {printer.agent.name} ({printer.agent.code}) · USB{' '}
        <span className="font-mono">{printer.usbSerial}</span>
      </p>
      <p className="text-xs text-stone-600" data-testid={`printer-${printer.code}-state`}>
        {printer.reportedState
          ? `${t.state[printer.reportedState]} · ${formatDateTimeCs(printer.reportedAt, timeZone)}${
              printer.reportedDetail ? ` · ${printer.reportedDetail}` : ''
            }`
          : t.stateUnknown}
      </p>
      <div>
        <button type="button" className={buttonClass.secondary} onClick={onEdit}>
          {t.edit}
        </button>
      </div>
    </li>
  );
}

function PrinterFormView({
  form,
  agents,
  base,
  onChange,
  onCancel,
  onSaved,
  onError,
}: {
  form: PrinterForm;
  agents: PrintAgent[];
  base: string;
  onChange: (f: PrinterForm) => void;
  onCancel: () => void;
  onSaved: (data: SitePrintingData) => void;
  onError: (e: string | null) => void;
}) {
  const id = useId();
  const { busy, run } = useAttempt();
  const set = <K extends keyof PrinterForm>(key: K, value: PrinterForm[K]) =>
    onChange({ ...form, [key]: value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      ...form,
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      usbSerial: form.usbSerial.trim(),
      model: 'ZEBRA_ZD220_DT' as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `${base}/printers`, sitePrintingSchema, { requestId, ...body }),
    );
    if (result.ok) onSaved(result.value);
    else if (result.error) onError(errorText(result.error));
  }
  const check = (key: 'dispatchDefault' | 'autoPrint' | 'enabled', text: string) => (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5"
        checked={form[key]}
        onChange={(e) => set(key, e.target.checked)}
        data-testid={`printer-${key}`}
      />
      <span>{text}</span>
    </label>
  );
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded border border-stone-200 p-3"
      data-testid="printer-form"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>{t.code}</span>
          <input
            id={`${id}-code`}
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
            disabled={form.id !== null}
            className={inputClass}
            placeholder="ZEBRA-EXPEDICE"
            required
            data-testid="printer-code"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>{t.name}</span>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
            placeholder="Zebra expedice"
            required
            data-testid="printer-name"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>{t.model}</span>
          <select className={inputClass} value="ZEBRA_ZD220_DT" disabled>
            <option value="ZEBRA_ZD220_DT">{t.modelSpec}</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className={label}>{t.agent}</span>
          <select
            className={inputClass}
            value={form.agentId}
            onChange={(e) => set('agentId', e.target.value)}
            data-testid="printer-agent"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 sm:col-span-2">
          <span className={label}>{t.usbSerial}</span>
          <input
            value={form.usbSerial}
            onChange={(e) => set('usbSerial', e.target.value)}
            className={inputClass}
            required
            data-testid="printer-usb"
          />
          <span className="text-xs text-stone-500">{t.usbSerialHint}</span>
        </label>
      </div>
      {check('dispatchDefault', t.dispatchDefault)}
      {check('autoPrint', t.autoPrint)}
      {check('enabled', t.enabled)}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={busy}
          data-testid="printer-save"
        >
          {t.save}
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
