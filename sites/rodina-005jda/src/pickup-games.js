import { now, validDay } from './viva-booking.js';

// The two 21:00 entries are the owner's examples, pending dates, prices and links.
// Set confirmed=true only after the real session details are supplied.
export const pickupGames = [
  { id:'bratis-2100', arenaId:'bratislavskaya', time:'21:00', date:null, pricePerPerson:null, paymentUrl:null, confirmed:false },
  { id:'kant-2100', arenaId:'kantemirovskaya', time:'21:00', date:null, pricePerPerson:null, paymentUrl:null, confirmed:false }
];

export function participationPaymentUrl(game, timestamp = now()) {
  if (game.confirmed !== true || !validDay(game.date, {}, timestamp) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(game.time || '') ||
      Date.parse(`${game.date}T${game.time}:00+03:00`) <= timestamp ||
      typeof game.pricePerPerson !== 'number' || !Number.isFinite(game.pricePerPerson) || game.pricePerPerson <= 0) return null;
  try {
    const url = new URL(game.paymentUrl);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
