import type { PortalHotelProfile } from '@ayvo/types';
import { cs } from '@/i18n/cs';

/** One group of the profile: a heading, a short purpose, its values. */
function Group({
  title,
  help,
  children,
  testId,
}: {
  title: string;
  help: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div>
        <h2 id={`${testId}-title`} className="text-base font-semibold text-stone-900">
          {title}
        </h2>
        <p className="text-xs text-stone-500">{help}</p>
      </div>
      <div className="flex flex-col gap-1 text-sm text-stone-800">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-stone-500 italic">{children}</p>
);

/** The three groups of a hotel's profile (read only). */
export function ProfileGroups({ profile }: { profile: PortalHotelProfile }) {
  const { address, contact, receiving } = profile;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Group title={cs.profile.address} help={cs.profile.addressHelp} testId="profile-address">
        <p>{address.addressLine1}</p>
        {address.addressLine2 && <p>{address.addressLine2}</p>}
        <p>
          {address.postalCode} {address.city}
        </p>
        <p className="text-stone-500">{profile.countryCode}</p>
      </Group>
      <Group title={cs.profile.contact} help={cs.profile.contactHelp} testId="profile-contact">
        <p className="font-medium">{contact.name}</p>
        <a className="w-fit underline-offset-2 hover:underline" href={`tel:${contact.phone}`}>
          {contact.phone}
        </a>
        <a
          className="w-fit break-all underline-offset-2 hover:underline"
          href={`mailto:${contact.email}`}
        >
          {contact.email}
        </a>
      </Group>
      <Group
        title={cs.profile.receiving}
        help={cs.profile.receivingHelp}
        testId="profile-receiving"
      >
        <h3 className="text-xs font-medium tracking-wide text-stone-500 uppercase">
          {cs.profile.receivingContact}
        </h3>
        {receiving.contactName ? (
          <>
            <p className="font-medium">{receiving.contactName}</p>
            {receiving.contactPhone && <p>{receiving.contactPhone}</p>}
            {receiving.contactEmail && <p className="break-all">{receiving.contactEmail}</p>}
          </>
        ) : (
          <Empty>{cs.profile.noReceivingContact}</Empty>
        )}
        <h3 className="mt-3 text-xs font-medium tracking-wide text-stone-500 uppercase">
          {cs.profile.instructions}
        </h3>
        {receiving.deliveryNote ? (
          <p className="whitespace-pre-line">{receiving.deliveryNote}</p>
        ) : (
          <Empty>{cs.profile.noInstructions}</Empty>
        )}
      </Group>
    </div>
  );
}

/** The hotel's hero card: its name and where it is, readable at a glance. */
export function HotelHero({
  profile,
  action,
}: {
  profile: PortalHotelProfile;
  action?: React.ReactNode;
}) {
  return (
    <section className="on-dark relative overflow-hidden rounded-2xl bg-emerald-950 px-6 py-7 text-stone-50 shadow-sm sm:px-8 sm:py-9">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gold" />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs font-medium tracking-[0.18em] text-gold-soft uppercase">
            {cs.profile.eyebrow}
          </p>
          <h1
            className="text-2xl font-semibold break-words sm:text-3xl"
            data-testid="portal-hotel-name"
          >
            {profile.name}
          </h1>
          <p className="text-sm text-emerald-100">
            {profile.address.city} · {profile.countryCode}
          </p>
        </div>
        {action}
      </div>
    </section>
  );
}
