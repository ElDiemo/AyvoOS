import type { EmployeeCardFields } from '@ayvo/types';
import styles from './employee-card.module.css';

/** Same compact public design for the protected live preview and published card. */
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
    { label: 'Visit AYVO', href: fields.website, mark: '↗' },
    {
      label: 'Call',
      href: fields.phone ? `tel:${fields.phone.replace(/[ ()-]/g, '')}` : '',
      mark: '☎',
    },
    { label: 'Email', href: fields.email ? `mailto:${fields.email}` : '', mark: '✉' },
    { label: 'LinkedIn', href: fields.linkedin, mark: 'in' },
    { label: 'Save contact', href: contactUrl ?? '', mark: '↓' },
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
      ) : (
        <div className={`${styles.avatar} ${styles.initial}`} aria-hidden="true">
          {fields.name.slice(0, 1)}
        </div>
      )}
      <h1 className={styles.name}>{fields.name || 'Jméno zaměstnance'}</h1>
      {fields.role && <p className={styles.role}>{fields.role}</p>}
      {fields.company && <p className={styles.company}>{fields.company}</p>}
      {fields.tagline && <p className={styles.tagline}>{fields.tagline}</p>}
      <nav className={styles.links} aria-label="Contact">
        {links
          .filter((link) => link.href)
          .map((link) =>
            preview ? (
              <span
                className={`${styles.button} ${link.label === 'Visit AYVO' ? styles.primary : ''}`}
                key={link.label}
              >
                <span aria-hidden="true">{link.mark}</span>
                {link.label}
              </span>
            ) : (
              <a
                className={`${styles.button} ${link.label === 'Visit AYVO' ? styles.primary : ''}`}
                href={link.href}
                key={link.label}
                rel={link.href.startsWith('https:') ? 'noopener noreferrer' : undefined}
              >
                <span aria-hidden="true">{link.mark}</span>
                {link.label}
              </a>
            ),
          )}
      </nav>
      <footer className={styles.footer}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img src="/brand/ayvo-wordmark.svg" width={84} height={28} alt="AYVO" />
        <span>Refill. Redefine.</span>
      </footer>
    </article>
  );
}
