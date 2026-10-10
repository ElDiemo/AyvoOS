import { cn } from '../lib/utils';

export type StatusTone = 'ok' | 'warning' | 'error' | 'neutral';

const toneClasses: Record<StatusTone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  error: 'bg-red-50 text-red-800 ring-red-600/20',
  neutral: 'bg-stone-100 text-stone-700 ring-stone-500/20',
};

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
