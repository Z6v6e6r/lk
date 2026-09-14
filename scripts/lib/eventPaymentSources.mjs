import fs from 'node:fs';
export function eventPaymentRoutesSource() {
  return fs.readFileSync(new URL('../nodered_lk1_hub_nodes/event_payments.js', import.meta.url), 'utf8');
}
export function hubGatewaySource() {
  const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const marker = '// EVENT_PAYMENT_ROUTES';
  if (source.split(marker).length !== 2) throw new Error('Event payment source marker drift');
  return source.replace(marker, () => eventPaymentRoutesSource());
}

export const bookingReadbackSource = () => fs.readFileSync(new URL("../nodered_lk1_hub_nodes/booking_readback.js", import.meta.url), "utf8");
