import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBooking, moscowDate } from '../shared/validation.mjs';
import config from '../shared/config.json' with { type: 'json' };

const now = new Date('2026-10-20T09:00:00Z');
const valid = { name: 'Анна', phone: '+7 (999) 123-45-67', date: '2026-10-21', time: '12:30', guests: 2, consent: true, website: '' };

test('normalizes a valid booking', () => {
  const result = validateBooking(valid, now);
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.phone, '+79991234567');
  assert.equal(result.value.name, 'Анна');
});
test('rejects empty name and invalid phone', () => {
  const result = validateBooking({ ...valid, name: ' ', phone: '123' }, now);
  assert.ok(result.errors.name);
  assert.ok(result.errors.phone);
});
test('rejects impossible and past dates', () => {
  for (const date of ['2026-02-30', '2026-10-19', '2026-13-01', 'bad']) {
    assert.ok(validateBooking({ ...valid, date }, now).errors.date, date);
  }
});
test('rejects past same-day slots and slots outside opening hours', () => {
  for (const time of ['07:30', '22:00', '23:00', '12:10', '99:00']) {
    assert.ok(validateBooking({ ...valid, time }, now).errors.time, time);
  }
  assert.ok(validateBooking({ ...valid, date: '2026-10-20', time: '11:30' }, now).errors.time);
  assert.equal(validateBooking({ ...valid, date: '2026-10-20', time: '13:00' }, now).errors.time, undefined);
});
test('allows 1 to 6 guests and requires explicit consent', () => {
  for (const guests of [0, 7, 2.5, NaN, '2']) assert.ok(validateBooking({ ...valid, guests }, now).errors.guests);
  for (const guests of [1, 6]) assert.equal(validateBooking({ ...valid, guests }, now).errors.guests, undefined);
  for (const consent of [false, 'true', undefined]) assert.ok(validateBooking({ ...valid, consent }, now).errors.consent);
});
test('rejects overly long names, honeypots and booking beyond 60 days', () => {
  assert.ok(validateBooking({ ...valid, name: 'a'.repeat(81) }, now).errors.name);
  assert.ok(validateBooking({ ...valid, website: 'spam' }, now).errors.website);
  assert.ok(validateBooking({ ...valid, date: '2027-01-01' }, now).errors.date);
});
test('uses Moscow date across UTC midnight', () => {
  assert.equal(moscowDate(new Date('2026-10-20T22:00:00Z')), '2026-10-21');
});
test('preserves optional comments and bounds their length', () => {
  assert.equal(validateBooking({ ...valid, comment: '  У окна  ' }, now).value.comment, 'У окна');
  assert.equal(validateBooking(valid, now).value.comment, '');
  assert.ok(validateBooking({ ...valid, comment: 'a'.repeat(301) }, now).errors.comment);
  assert.ok(validateBooking({ ...valid, phone: 'abc79991234567' }, now).errors.phone);
});

test('rejects explicitly supplied non-string comments instead of discarding their value', () => {
  for (const comment of [123, null, {}, ['У окна'], true]) {
    assert.ok(validateBooking({ ...valid, comment }, now).errors.comment, JSON.stringify(comment));
  }
  assert.equal(validateBooking(valid, now).errors.comment, undefined);
  assert.equal(validateBooking({ ...valid, comment: '' }, now).errors.comment, undefined);
});

test('time validation explains the configured opening hours', () => {
  const original = { openHour: config.openHour, closeHour: config.closeHour };
  try {
    config.openHour = 9;
    config.closeHour = 20;
    const result = validateBooking({ ...valid, time: '08:30' }, now);
    assert.match(result.errors.time, /09:00/);
    assert.match(result.errors.time, /19:30/);
    assert.equal(validateBooking({ ...valid, time: '19:30' }, now).errors.time, undefined);
    assert.ok(validateBooking({ ...valid, time: '20:00' }, now).errors.time);
  } finally {
    Object.assign(config, original);
  }
});
