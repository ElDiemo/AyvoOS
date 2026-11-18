import { saveHotelProfile } from '@/lib/hotel-profile';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return saveHotelProfile(request, (await params).id);
}
