const money = (amount: string, currency: string) =>
  `${new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount))} ${currency}`;
const date = (iso: string) => new Intl.DateTimeFormat('cs-CZ').format(new Date(`${iso}T12:00:00Z`));
export const formatMoney = money;
export const formatDate = date;
