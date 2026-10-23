import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmployeeCard } from './employee-card';

const fields = {
  name: 'Jana <script>alert(1)</script>',
  role: 'Obchod',
  company: 'AYVO',
  tagline: 'Refill & Redefine',
  phone: '+420 111 222 333',
  email: 'public@example.com',
  website: 'https://example.com',
  linkedin: '',
};
describe('business card presentation', () => {
  it('escapes supplied text and offers only entered contact channels', () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeCard, { fields, contactUrl: '/id/jana/contact.vcf' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('tel:+420111222333');
    expect(html).toContain('mailto:public@example.com');
    expect(html).toContain('/id/jana/contact.vcf');
    expect(html).not.toContain('LinkedIn');
  });
  it('preview buttons do not trigger live phone calls, email or a misleading download', () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeCard, { fields, preview: true, contactUrl: '#' }),
    );
    expect(html).not.toContain('<a ');
    expect(html).toContain('Náhled veřejné vizitky');
    expect(html).toContain('Save contact');
  });
});
