import type {
  BottleRegistrationResponse,
  LabelArtwork,
  LabelLayout,
  LabelTemplateVersion,
} from '@ayvo/types';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SVG_70x110 } from './artwork-fixtures.js';

export const QR_DEFAULT = {
  type: 'QR_CODE',
  xMm: 48.2,
  yMm: 78.5,
  widthMm: 15,
  heightMm: 15,
  rotationDeg: 0,
} as const;

export function uniqueName(prefix = 'tpl'): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export async function uploadArtwork(
  app: INestApplication,
  bytes: Buffer = SVG_70x110,
  filename = 'artwork.svg',
): Promise<LabelArtwork> {
  const res = await request(app.getHttpServer())
    .post('/api/admin/label-artworks')
    .attach('file', bytes, filename)
    .expect(201);
  return res.body as LabelArtwork;
}

export function layout(artworkId: string, overrides: Partial<LabelLayout> = {}): LabelLayout {
  return { artworkId, widthMm: 70, heightMm: 110, elements: [{ ...QR_DEFAULT }], ...overrides };
}

export async function createTemplate(
  app: INestApplication,
  name = uniqueName(),
): Promise<LabelTemplateVersion> {
  const artwork = await uploadArtwork(app);
  const res = await request(app.getHttpServer())
    .post('/api/admin/label-templates')
    .send({ name, layout: layout(artwork.id) })
    .expect(201);
  return res.body as LabelTemplateVersion;
}

export async function registerBottles(
  app: INestApplication,
  labelTemplateVersionId: string,
  quantity: number,
): Promise<BottleRegistrationResponse> {
  const res = await request(app.getHttpServer())
    .post('/api/admin/bottle-registrations')
    .send({ requestId: randomUUID(), labelTemplateVersionId, quantity })
    .expect(201);
  return res.body as BottleRegistrationResponse;
}
