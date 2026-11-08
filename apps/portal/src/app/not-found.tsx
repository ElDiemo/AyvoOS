import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-3 px-4 py-10">
      <h1 className="text-xl font-semibold">Nenalezeno</h1>
      <Link href="/" className="text-sm underline">
        Zpět na Moje hotely
      </Link>
    </div>
  );
}
