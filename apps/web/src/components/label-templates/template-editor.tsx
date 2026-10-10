'use client';

import {
  createLabelTemplateVersionResponseSchema,
  labelTemplateVersionSchema,
  type LabelArtwork,
  type LabelDesignerSettings,
  type LabelLayout,
  type LabelTemplateVersion,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { clampBox, defaultBox, roundMm, type LabelSize, type QrBox } from '@/lib/label-geometry';
import { ArtworkUploadField } from './artwork-upload-field';
import { LabelDesigner } from './label-designer';
import { clampLabelSize, LabelSizeFields, proportionsMatch } from './label-size-fields';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';

type Mode =
  | { kind: 'create' }
  | { kind: 'version'; templateId: string; templateName: string; latest: LabelTemplateVersion };

/**
 * Create a template (name + artwork + size + QR position → v1), or save a changed layout of an
 * existing template as its next immutable version.
 */
export function TemplateEditor({
  mode,
  settings,
}: {
  mode: Mode;
  settings: LabelDesignerSettings;
}) {
  const router = useRouter();
  const latest = mode.kind === 'version' ? mode.latest : null;
  const latestQr = latest?.elements[0];

  const [name, setName] = useState('');
  const [artwork, setArtwork] = useState<LabelArtwork | null>(latest?.artwork ?? null);
  const [size, setSize] = useState<LabelSize>({
    widthMm: latest?.widthMm ?? 70,
    heightMm: latest?.heightMm ?? 110,
  });
  const [box, setBox] = useState<QrBox | null>(
    latestQr ? { xMm: latestQr.xMm, yMm: latestQr.yMm, sizeMm: latestQr.widthMm } : null,
  );
  const [busy, setBusy] = useState<'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /** A new size keeps the QR box on the label (and creates a default box the first time). */
  const applySize = (next: LabelSize) => {
    setSize(next);
    setInfo(null);
    setBox((current) =>
      clampBox(current ?? defaultBox(next, settings.qrMinSizeMm), next, settings.qrMinSizeMm),
    );
  };

  const onUploaded = (uploaded: LabelArtwork) => {
    setArtwork(uploaded);
    const ratio = uploaded.intrinsicWidth / uploaded.intrinsicHeight;
    applySize(
      uploaded.suggestedSizeMm
        ? {
            widthMm: clampLabelSize(uploaded.suggestedSizeMm.widthMm),
            heightMm: clampLabelSize(uploaded.suggestedSizeMm.heightMm),
          }
        : { widthMm: size.widthMm, heightMm: clampLabelSize(roundMm(size.widthMm / ratio)) },
    );
  };

  async function save() {
    if (!artwork || !box) return;
    setError(null);
    setInfo(null);
    setBusy('save');
    const layout: LabelLayout = {
      artworkId: artwork.id,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      elements: [
        {
          type: 'QR_CODE',
          xMm: box.xMm,
          yMm: box.yMm,
          widthMm: box.sizeMm,
          heightMm: box.sizeMm,
          rotationDeg: 0,
        },
      ],
    };
    try {
      if (mode.kind === 'create') {
        const version = await apiSend('POST', 'admin/label-templates', labelTemplateVersionSchema, {
          name,
          layout,
        });
        router.push(`/label-templates/${version.templateId}?saved=${version.versionNumber}`);
      } else {
        const result = await apiSend(
          'POST',
          `admin/label-templates/${mode.templateId}/versions`,
          createLabelTemplateVersionResponseSchema,
          { layout },
        );
        if (!result.created) {
          setInfo(`No changes — ${result.version.label} is unchanged.`);
          setBusy(null);
          return;
        }
        router.push(`/label-templates/${mode.templateId}?saved=${result.version.versionNumber}`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed');
      setBusy(null);
    }
  }

  const proportionsOk = !!artwork && proportionsMatch(artwork, size, settings.aspectRatioTolerance);
  const canSave =
    !!artwork &&
    !!box &&
    proportionsOk &&
    busy === null &&
    (mode.kind === 'version' || name.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <Card title={mode.kind === 'create' ? '1 · Template' : '1 · Artwork'}>
        <div className="grid gap-6 md:grid-cols-2">
          {mode.kind === 'create' ? (
            <div className="flex flex-col gap-1">
              <label
                htmlFor="template-name"
                className="text-xs font-medium uppercase tracking-wide text-stone-500"
              >
                Template name
              </label>
              <input
                id="template-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="mydlo1"
                maxLength={64}
                className={inputClass}
              />
              <p className="text-xs text-stone-400">
                Lowercase letters, digits, “-” and “_”. Cannot be changed later.
              </p>
            </div>
          ) : (
            <p className="text-sm text-stone-600">
              Saving creates{' '}
              <strong>
                {mode.templateName} v{mode.latest.versionNumber + 1}
              </strong>
              . Existing versions — and every label already printed with them — stay exactly as they
              are.
            </p>
          )}
          <ArtworkUploadField
            artwork={artwork}
            maxBytes={settings.artworkMaxBytes}
            disabled={busy !== null}
            onUploaded={onUploaded}
            onError={setError}
          />
        </div>
      </Card>

      {artwork && box && (
        <>
          <Card title="2 · Physical label size">
            <LabelSizeFields
              artwork={artwork}
              size={size}
              aspectRatioTolerance={settings.aspectRatioTolerance}
              onChange={applySize}
            />
          </Card>

          <Card title="3 · QR code placement">
            <LabelDesigner
              artworkUrl={artwork.contentUrl}
              label={size}
              box={box}
              onChange={setBox}
              minSizeMm={settings.qrMinSizeMm}
              qrPreviewUrl={settings.qrPreviewUrl}
              qrLevel={settings.qrErrorCorrection}
            />
          </Card>
        </>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}
      {info && (
        <p className="rounded-md border border-stone-200 bg-stone-100 px-3 py-2 text-sm text-stone-700">
          {info}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          className={buttonClass.primary}
          disabled={!canSave}
          onClick={() => void save()}
        >
          {busy === 'save'
            ? 'Saving…'
            : mode.kind === 'create'
              ? 'Save template (v1)'
              : `Save as ${mode.templateName} v${mode.latest.versionNumber + 1}`}
        </button>
      </div>
    </div>
  );
}
