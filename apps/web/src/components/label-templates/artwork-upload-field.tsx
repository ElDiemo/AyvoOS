'use client';

import { labelArtworkSchema, type LabelArtwork } from '@ayvo/types';
import { useState } from 'react';
import { apiSend } from '@/lib/client-api';
import { formatBytes } from '@/lib/format';

const ACCEPT = 'image/svg+xml,image/png,image/jpeg,.svg,.png,.jpg,.jpeg';

/**
 * Uploads background artwork. The server validates the file by its content; the size check here
 * only gives faster feedback.
 */
export function ArtworkUploadField({
  artwork,
  maxBytes,
  disabled,
  onUploaded,
  onError,
}: {
  artwork: LabelArtwork | null;
  maxBytes: number;
  disabled: boolean;
  onUploaded: (artwork: LabelArtwork) => void;
  onError: (message: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    onError(null);
    if (file.size > maxBytes) {
      onError(`The file is too large (max ${formatBytes(maxBytes)})`);
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      onUploaded(await apiSend('POST', 'admin/label-artworks', labelArtworkSchema, form));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="artwork-file"
        className="text-xs font-medium uppercase tracking-wide text-stone-500"
      >
        Background artwork (SVG, PNG or JPEG)
      </label>
      <input
        id="artwork-file"
        type="file"
        accept={ACCEPT}
        disabled={disabled || uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = '';
        }}
        className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-stone-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-stone-700"
      />
      <p className="text-xs text-stone-400" aria-live="polite">
        {artwork
          ? `${artwork.originalFilename} · ${artwork.format} · ${formatBytes(artwork.byteSize)}`
          : `Max ${formatBytes(maxBytes)}. SVG keeps the artwork vector-sharp in print.`}
        {uploading && ' · Uploading…'}
      </p>
    </div>
  );
}
