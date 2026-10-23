/**
 * Unknown QR token (anyone may reach this by scanning): a calm public answer, without links into
 * the internal application or its sign-in.
 */
export default function PassportNotFound() {
  return (
    <main
      lang="en"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-stone-100 px-6 text-center"
    >
      <p className="text-2xl font-semibold tracking-[0.35em]">AYVO</p>
      <h1 className="text-lg">Not found</h1>
      <p className="text-sm text-stone-600">This AYVO code is not known.</p>
    </main>
  );
}
