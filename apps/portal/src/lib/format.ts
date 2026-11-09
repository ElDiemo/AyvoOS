const money = (amount: string, currency: string) =>
  `${new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount))} ${currency}`;
const date = (iso: string) => new Intl.DateTimeFormat('cs-CZ').format(new Date(`${iso}T12:00:00Z`));
export const formatMoney = money;
export const formatDate = date;
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Prague',
  }).format(new Date(iso));
export const formatDateTime = dateTime;
