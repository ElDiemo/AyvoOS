import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './brand-logo';

describe('AYVO brand', () => {
  it.each([false, true])('uses the local SVG and a readable name (inverse=%s)', (inverse) => {
    const html = renderToStaticMarkup(createElement(BrandLogo, { inverse }));
    expect(html).toContain('src="/brand/ayvo-wordmark.svg"');
    expect(html).toContain('alt="AYVO"');
    expect(html).toContain('>OS</span>');
    expect(html).toContain('width="3386" height="985"');
    expect(html.includes(' invert')).toBe(inverse);
    expect(html).not.toContain('/_next/image');
  });

  it.each(['../../public/brand/ayvo-wordmark.svg', '../app/icon.svg'])(
    '%s is vector-only, with no embedded raster, scripts, metadata or external resources',
    (path) => {
      const svg = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(svg).toContain('<path');
      expect(svg).not.toMatch(
        /<image\b|<script\b|<foreignObject\b|<metadata\b|data:|(?:xlink:)?href=/i,
      );
      expect(svg).not.toContain('inkscape:');
      expect(svg).not.toContain('sodipodi:');
    },
  );

  it('ships public assets in the standalone web image', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /app/apps/web/public ./apps/web/public');
  });
});
