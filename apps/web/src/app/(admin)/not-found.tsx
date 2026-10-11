import Link from 'next/link';
import { buttonClass, Card } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';

/** A record or page of the internal application that does not exist (a real HTTP 404). */
export default function AdminNotFound() {
  return (
    <Card>
      <h1 className="text-lg font-semibold">{shellCs.common.notFoundTitle}</h1>
      <p className="mt-2 text-sm text-stone-600">{shellCs.common.notFoundText}</p>
      <Link href="/" className={`${buttonClass.secondary} mt-4`}>
        {shellCs.common.backHome}
      </Link>
    </Card>
  );
}
