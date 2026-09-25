// Payment provider adapter. Card details never touch this server: guests pay on
// Stripe's hosted Checkout page, and the booking is only confirmed when Stripe's
// signed webhook says the money arrived.
import Stripe from 'stripe';

export function createPayments(cfg) {
  if (cfg.payments.mode === 'mock') {
    if (cfg.production) throw new Error('mock payments are not allowed in production');
    return {
      mode: 'mock',
      async createCheckout({ booking, statusToken }) {
        return {
          sessionId: `mock_${booking.ref}`,
          url: `${cfg.origin}/dev-checkout?ref=${encodeURIComponent(booking.ref)}&t=${encodeURIComponent(statusToken)}`,
        };
      },
      async retrieveSession() { return null; },
      async expireSession() {},
      constructEvent() { throw new Error('no webhooks in mock mode'); },
    };
  }

  const stripe = new Stripe(cfg.payments.stripeSecretKey, { maxNetworkRetries: 2, timeout: 20000 });
  return {
    mode: 'stripe',
    async createCheckout({ booking, quote, statusToken, holdUntil }) {
      const back = `${cfg.origin}/booking?ref=${encodeURIComponent(booking.ref)}&t=${encodeURIComponent(statusToken)}`;
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: booking.email,
        client_reference_id: booking.ref,
        metadata: { booking_ref: booking.ref },
        payment_intent_data: { metadata: { booking_ref: booking.ref }, description: `${cfg.ranch.name} ${booking.ref}` },
        expires_at: Math.floor(holdUntil / 1000),
        line_items: quote.lines.map((l) => ({
          quantity: l.qty,
          price_data: { currency: quote.currency, unit_amount: l.unit, product_data: { name: l.label } },
        })),
        success_url: `${back}&paid=1`,
        cancel_url: `${back}&cancelled=1`,
      }, { idempotencyKey: `checkout-${booking.ref}` });
      return { sessionId: session.id, url: session.url };
    },
    retrieveSession: (id) => stripe.checkout.sessions.retrieve(id),
    async expireSession(id) { try { await stripe.checkout.sessions.expire(id); } catch { /* already done */ } },
    constructEvent: (raw, sig) => stripe.webhooks.constructEvent(raw, sig, cfg.payments.stripeWebhookSecret),
  };
}
