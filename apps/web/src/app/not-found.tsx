import Link from 'next/link';

/**
 * Unknown URLs and unknown passport tokens (anyone may reach these, e.g. by scanning a QR code):
 * Czech for AYVO staff, English for hotel guests. Admin pages have their own not-found page
 * inside the application shell.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-2xl font-semibold tracking-[0.35em]">AYVO</p>
      <h1 className="text-lg">Stránka nenalezena</h1>
      <p className="text-sm text-stone-600">
        Tato stránka nebo lahev neexistuje.{' '}
        <span lang="en">This page or bottle does not exist.</span>
      </p>
      <Link href="/" className="text-sm underline">
        AYVO OS
      </Link>
    </main>
  );
}
