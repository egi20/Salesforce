'use strict';

/**
 * A consultant's availability, in ONE place.
 *
 * The labels were written out separately in five templates and two documents, so adding
 * "busy" (migration 037) would have meant finding all of them — and the one missed would
 * print a blank badge. Order is the order a form offers them.
 *
 * `listedAsAvailable` is what the directory's availability filter means by "available": busy
 * and not-available are both answers, but neither is somebody a company can start next week.
 */
const AVAILABILITY = Object.freeze([
  { value: 'immediate', label: 'Available now', listedAsAvailable: true },
  { value: 'two_weeks', label: 'Available in 2 weeks', listedAsAvailable: true },
  { value: 'one_month', label: 'Available in a month', listedAsAvailable: true },
  { value: 'busy', label: 'Busy — open to offers', listedAsAvailable: false },
  { value: 'not_available', label: 'Not available', listedAsAvailable: false }
]);

const BY_VALUE = new Map(AVAILABILITY.map((a) => [a.value, a]));

function isValidAvailability(value) {
  return BY_VALUE.has(value);
}

function availabilityLabel(value) {
  const a = BY_VALUE.get(value);
  return a ? a.label : '';
}

module.exports = { AVAILABILITY, isValidAvailability, availabilityLabel };
