import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingSubmission } from '../src/booking-state.ts';

const beforeCutoff = new Date('2026-10-20T09:29:59Z');
const afterCutoff = new Date('2026-10-20T09:30:02Z');
const input = { name: 'Анна', phone: '+79991234567', date: '2026-10-20', time: '13:00', guests: 2, consent: true, website: '', comment: '' };
const receipt = { id: 'EZH-RECOVERED', status: 'requested' };

for (const status of [503, 429]) {
  test(`recovers the original receipt after a lost response, ${status}, and the time cutoff`, () => {
    let nextKey = 0;
    const submission = new BookingSubmission(() => `request-${++nextKey}`);
    const original = submission.prepare(input, beforeCutoff);
    assert.equal(original.type, 'request');
    submission.fail(); // The server saved the request, but the receipt was lost.
    assert.deepEqual(submission.prepare(input, beforeCutoff), original);
    assert.equal(submission.receive(status, { message: 'Попробуйте позже.' }).type, 'retry');
    assert.deepEqual(submission.prepare(input, afterCutoff), original);
    assert.deepEqual(submission.receive(200, receipt), { type: 'success', id: 'EZH-RECOVERED' });
    assert.equal(nextKey, 1);
  });
}

test('recovery explicitly resends the original snapshot after form edits', () => {
  const submission = new BookingSubmission(() => 'original-key');
  const original = submission.prepare(input, beforeCutoff);
  submission.fail();
  assert.equal(submission.needsRecovery, true);
  assert.deepEqual(submission.prepare({ ...input, name: 'Другое имя', time: '14:00' }, afterCutoff), original);
  assert.deepEqual(submission.receive(200, receipt), { type: 'success', id: 'EZH-RECOVERED' });
  assert.equal(submission.needsRecovery, false);
});

test('a definitive validation rejection releases the snapshot for a corrected request', () => {
  let nextKey = 0;
  const submission = new BookingSubmission(() => `request-${++nextKey}`);
  submission.prepare(input, beforeCutoff);
  submission.fail();
  submission.prepare(input, afterCutoff);
  assert.equal(submission.receive(422, { errors: { time: 'Выберите другое время.' } }).type, 'rejected');
  assert.equal(submission.needsRecovery, false);
  const corrected = submission.prepare({ ...input, time: '14:00' }, afterCutoff);
  assert.equal(corrected.type, 'request');
  assert.equal(corrected.key, 'request-2');
  assert.equal(JSON.parse(corrected.payload).time, '14:00');
});

test('a conflict cannot silently rotate the key and create a duplicate request', () => {
  let keys = 0;
  const submission = new BookingSubmission(() => `request-${++keys}`);
  submission.prepare(input, beforeCutoff);
  assert.equal(submission.receive(409, { message: 'Уже отправлено.' }).type, 'conflict');
  assert.deepEqual(submission.prepare({ ...input, time: '14:00' }, afterCutoff), { type: 'conflict' });
  assert.equal(keys, 1);
});

test('malformed successful responses remain recoverable and duplicate submits stay blocked', () => {
  const submission = new BookingSubmission(() => 'original-key');
  const original = submission.prepare(input, beforeCutoff);
  assert.deepEqual(submission.prepare(input, beforeCutoff), { type: 'pending' });
  assert.equal(submission.receive(201, { status: 'requested' }).type, 'retry');
  assert.deepEqual(submission.prepare(input, afterCutoff), original);
});

test('a fresh invalid request is not sent and a new request can start after success', () => {
  const submission = new BookingSubmission(() => 'new-key');
  const invalid = submission.prepare(input, afterCutoff);
  assert.equal(invalid.type, 'invalid');
  assert.ok(invalid.errors.time);
  submission.prepare(input, beforeCutoff);
  submission.receive(201, receipt);
  assert.deepEqual(submission.prepare(input, beforeCutoff), { type: 'complete' });
  submission.reset();
  assert.equal(submission.prepare({ ...input, time: '14:00' }, afterCutoff).type, 'request');
});
