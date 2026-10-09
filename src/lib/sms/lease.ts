/**
 * How long a claim on an inbound text blocks other deliveries before it counts as abandoned. Above the
 * slowest turn (a send waits up to about two minutes to land, and one code can claim several escrows
 * in a row) and below the queue consumer's 15-minute limit.
 */
export const INBOUND_LEASE_MS = 10 * 60_000;
