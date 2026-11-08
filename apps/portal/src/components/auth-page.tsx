import { cs } from '@/i18n/cs';

export function AuthPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 px-4 py-10">
      <span className="text-sm font-semibold">{cs.brand}</span>
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}
