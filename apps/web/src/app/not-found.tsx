import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-2xl font-semibold tracking-[0.35em]">AYVO</p>
      <h1 className="text-lg">Not found</h1>
      <p className="text-sm text-stone-600">This page or bottle does not exist.</p>
      <Link href="/" className="text-sm underline">
        Home
      </Link>
    </main>
  );
}
