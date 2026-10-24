import type { EmployeeCardFields } from '@ayvo/types';
import styles from './employee-card.module.css';

/** Existing id.ayvo.co presentation; only its data source and management change. */
export function EmployeeCard({
  fields,
  photoUrl,
  contactUrl,
  preview = false,
}: {
  fields: Omit<EmployeeCardFields, 'photoId'>;
  photoUrl?: string;
  contactUrl?: string;
  preview?: boolean;
}) {
  const links = [
    { label: 'Visit AYVO', href: fields.website, glyph: '\uf35d' },
    {
      label: 'Call',
      href: fields.phone ? `tel:${fields.phone.replace(/[ ()-]/g, '')}` : '',
      glyph: '\uf095',
    },
    { label: 'Email', href: fields.email ? `mailto:${fields.email}` : '', glyph: '\uf0e0' },
    { label: 'LinkedIn', href: fields.linkedin, glyph: '\uf08c' },
    { label: 'Save contact', href: contactUrl ?? '', glyph: '\uf2c2' },
  ];
  return (
    <article
      className={styles.card}
      lang="en"
      aria-label={preview ? 'Náhled veřejné vizitky' : fields.name}
    >
      {photoUrl ? (
        <div className={styles.avatar}>
          {/* eslint-disable-next-line @next/next/no-img-element -- protected/no-store image, no optimizer cache */}
          <img src={photoUrl} alt={fields.name} width={96} height={96} />
        </div>
      ) : null}
      <h1 className={styles.name}>{fields.name || 'Jméno zaměstnance'}</h1>
      {fields.role && <p className={styles.role}>{fields.role}</p>}
      {/* The existing PHP card does not display company; it remains in the vCard. */}
      {fields.tagline && <p className={styles.tagline}>{fields.tagline}</p>}
      <nav aria-label="Contact">
        {links
          .filter((link) => link.href)
          .map((link) =>
            preview ? (
              <span
                className={`${styles.button} ${link.label === 'Visit AYVO' ? styles.primary : ''}`}
                key={link.label}
              >
                <span
                  className={link.label === 'LinkedIn' ? styles.brandIcon : styles.icon}
                  aria-hidden="true"
                >
                  {link.glyph}
                </span>
                {link.label}
              </span>
            ) : (
              <a
                className={`${styles.button} ${link.label === 'Visit AYVO' ? styles.primary : ''}`}
                href={link.href}
                key={link.label}
                target={link.href.startsWith('https:') ? '_blank' : undefined}
                rel={link.href.startsWith('https:') ? 'noopener noreferrer' : undefined}
              >
                <span
                  className={link.label === 'LinkedIn' ? styles.brandIcon : styles.icon}
                  aria-hidden="true"
                >
                  {link.glyph}
                </span>
                {link.label}
              </a>
            ),
          )}
      </nav>
      <div className={styles.divider} />
      <footer className={styles.footer}>
        <div className={styles.logo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- unchanged legacy brand asset */}
          <img src="/employee-card/legacy-logo.svg" alt="AYVO®" />
        </div>
      </footer>
    </article>
  );
}
