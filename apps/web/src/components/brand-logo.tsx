import { cn } from '@ayvo/ui';
import Image from 'next/image';
import { shellCs } from '../i18n/cs/shell';

/** The owner's vector wordmark, not a font approximation. No remote images or fonts. */
export function BrandLogo({
  inverse = false,
  compact = false,
  className,
}: {
  inverse?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center', compact ? 'gap-2.5' : 'gap-3', className)}
      data-testid="brand-logo"
    >
      <Image
        src="/brand/ayvo-wordmark.svg"
        alt={shellCs.brand}
        width={3386}
        height={985}
        unoptimized
        loading="eager"
        className={cn('h-auto', compact ? 'w-20' : 'w-36', inverse && 'invert')}
      />
      <span
        className={cn(
          'border-l text-xs font-medium tracking-[0.14em]',
          compact ? 'pl-2.5' : 'pl-3',
          inverse ? 'border-white/25 text-stone-300' : 'border-stone-300 text-stone-500',
        )}
      >
        {shellCs.brandSuffix}
      </span>
    </span>
  );
}
