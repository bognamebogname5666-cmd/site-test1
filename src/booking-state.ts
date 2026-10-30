import { validateBooking, type BookingInput, type BookingErrors } from '../shared/validation.mjs';

interface BookingRequest { type: 'request'; key: string; payload: string }
type Preparation = BookingRequest | { type: 'invalid'; errors: BookingErrors }
  | { type: 'pending' } | { type: 'conflict' } | { type: 'complete' };
type Outcome = { type: 'success'; id: string }
  | { type: 'rejected'; errors: BookingErrors; message?: string }
  | { type: 'retry'; message?: string } | { type: 'conflict'; message?: string };

/** Keeps a request immutable until the server resolves its outcome. */
export class BookingSubmission {
  private phase: 'idle' | 'pending' | 'retry' | 'conflict' | 'complete' = 'idle';
  private request: BookingRequest | null = null;
  private createKey: () => string;

  constructor(createKey: () => string = () => crypto.randomUUID()) {
    this.createKey = createKey;
  }

  get needsRecovery() { return this.phase === 'retry'; }
  get conflicted() { return this.phase === 'conflict'; }

  prepare(input: BookingInput, now = new Date()): Preparation {
    if (this.phase === 'pending' || this.phase === 'conflict' || this.phase === 'complete') {
      return { type: this.phase };
    }
    if (!this.request) {
      const { errors } = validateBooking(input, now);
      if (Object.keys(errors).length) return { type: 'invalid', errors };
      this.request = { type: 'request', key: this.createKey(), payload: JSON.stringify(input) };
    }
    this.phase = 'pending';
    return this.request;
  }

  receive(status: number, body: unknown): Outcome {
    const result = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof result.message === 'string' ? result.message : undefined;
    if (status >= 200 && status < 300 && typeof result.id === 'string' && result.id && result.status === 'requested') {
      this.phase = 'complete';
      this.request = null;
      return { type: 'success', id: result.id };
    }
    // A conflict means this key already refers to a different saved request.
    // Rotating it automatically could create a second booking.
    if (status === 409) {
      this.phase = 'conflict';
      return { type: 'conflict', message };
    }
    // The API checks saved receipts before validation, so 422 proves no booking
    // exists for this key. Other failures cannot resolve an earlier lost receipt.
    if (status === 422) {
      const errors: BookingErrors = {};
      if (result.errors && typeof result.errors === 'object') {
        for (const [field, error] of Object.entries(result.errors)) {
          if (typeof error === 'string') errors[field as keyof BookingInput] = error;
        }
      }
      this.reset();
      return { type: 'rejected', errors, message };
    }
    this.fail();
    return { type: 'retry', message };
  }

  fail() { this.phase = 'retry'; }

  reset() {
    this.request = null;
    this.phase = 'idle';
  }
}
