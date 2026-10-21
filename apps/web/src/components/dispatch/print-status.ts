import type { OrderShipment, PrintJobStatus } from '@ayvo/types';

const ACTIVE: PrintJobStatus[] = ['QUEUED', 'CLAIMED', 'SENDING'];

/**
 * Where printing goes (UI38-R1): work already on its way keeps the printer it was created for —
 * a later change of the site's default printer never redirects it — so the order shows the real
 * target of that work, and separately where a NEW print would go.
 */
export function printTargets(data: OrderShipment): {
  /** Printers of jobs on their way and of print requests still waiting for their ZPL. */
  active: string[];
  /** The site's default dispatch printer: where a new print goes (null: none). */
  next: OrderShipment['printer'];
} {
  const s = data.shipment;
  const names = new Set<string>();
  for (const p of s?.parcels ?? []) {
    const job = p.printJobs[0];
    if (job && ACTIVE.includes(job.status)) names.add(job.printer);
  }
  for (const w of s?.printWaiting ?? []) names.add(w.printer);
  return { active: [...names], next: data.printer };
}

export type Outcome = { tone: 'ok' | 'info' | 'error'; text: string };

/**
 * What "Dokončit a vytisknout štítky" really achieved — an HTTP 200 only means the request was
 * handled: the carrier may have refused, may still be creating the labels, the ZPL may be missing.
 */
export function combinedOutcome(data: OrderShipment, printer: string | null): Outcome {
  const s = data.shipment;
  if (!s)
    return {
      tone: 'error',
      text: 'Kompletace je dokončená, přeprava ale nevznikla. Pokračujte na objednávce.',
    };
  const r = s.request;
  if (r?.status === 'REJECTED' || r?.status === 'NOT_CREATED' || s.status === 'DRAFT') {
    return {
      tone: 'error',
      text: `Kompletace je dokončená, dopravce ale štítky nevytvořil${r?.errorMessage ? `: ${r.errorMessage}` : ''}. Další krok najdete na objednávce.`,
    };
  }
  if (s.status === 'REQUESTING') {
    return {
      tone: 'info',
      text: `Kompletace je dokončená. Dopravce štítky ještě připravuje${printer ? ` – tisk na ${printer} začne, až budou hotové` : ''}. Stav sledujte na objednávce.`,
    };
  }
  if (s.status !== 'LABELED') {
    return {
      tone: 'error',
      text: 'Kompletace je dokončená, přeprava ale není připravená. Pokračujte na objednávce.',
    };
  }
  if (!printer) {
    return {
      tone: 'ok',
      text: 'Kompletace je dokončená a štítky jsou připravené (PDF). Tisk spustíte na objednávce.',
    };
  }
  if (s.zpl?.status === 'FAILED') {
    return {
      tone: 'error',
      text: `Štítky jsou vytvořené, ale soubory pro tiskárnu (ZPL) se nepodařilo získat – nic se netiskne. ${s.zpl.errorMessage ?? ''} Pokračujte na objednávce.`.trim(),
    };
  }
  // UI38-R2: what each label's latest job really reached — not only whether one is still active.
  const jobs = s.parcels.map((p) => p.printJobs[0] ?? null);
  const n = (...st: PrintJobStatus[]) => jobs.filter((j) => j && st.includes(j.status)).length;
  const total = s.parcels.length;
  const active = n(...ACTIVE);
  const sent = n('SENT');
  const failed = n('FAILED');
  const doubtful = n('UNCERTAIN');
  // Waiting for the printer's files only while they are really missing.
  if (active + sent + failed + doubtful === 0) {
    if (s.printWaiting.length > 0 || s.zpl?.status === 'PENDING') {
      return {
        tone: 'info',
        text: `Štítky jsou vytvořené; tisk na ${printer} čeká na soubory pro tiskárnu (ZPL). Stav sledujte na objednávce.`,
      };
    }
    return {
      tone: 'info',
      text: 'Štítky jsou vytvořené, tisk ale nezačal. Spusťte ho na objednávce.',
    };
  }
  const where = [...new Set(jobs.flatMap((j) => (j ? [j.printer] : [])))].join(', ') || printer;
  const parts: string[] = [];
  if (sent > 0)
    parts.push(
      `${sent} z ${total} odesláno do tiskárny ${where} (vytištění tím není potvrzené – zkontrolujte štítky)`,
    );
  if (active > 0) parts.push(`${active} z ${total} jde do tiskárny ${where}`);
  if (failed > 0)
    parts.push(
      `${failed} z ${total} se nepodařilo odeslat – nevytiskly se; vytiskněte je na objednávce znovu`,
    );
  if (doubtful > 0)
    parts.push(
      `${doubtful} z ${total} nejisté – nejdřív zkontrolujte, zda štítek vyjel; nic se neopakuje automaticky`,
    );
  const next =
    failed + doubtful > 0
      ? 'Další krok najdete na objednávce.'
      : 'Po nalepení potvrďte na objednávce „Připraveno k vyzvednutí“.';
  return {
    tone: failed + doubtful > 0 ? 'error' : 'ok',
    text: `Štítky jsou vytvořené: ${parts.join('; ')}. ${next}`,
  };
}
