import { isStatus, type AdminBooking, type AdminSession, type BookingDetail, type BookingFilters, type BookingList, type BookingStatus } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(502, 'Сервер вернул неожиданный ответ. Обновите страницу.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(502, 'Не удалось прочитать ответ сервера. Обновите список.');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'Не удалось прочитать ответ сервера. Обновите список.');
  return value;
}
function booking(value: unknown): AdminBooking {
  const row = object(value);
  if (!isStatus(row.status)) throw new ApiError(502, 'Не удалось прочитать статус заявки. Обновите список.');
  return {
    id: text(row.id), name: text(row.name), phone: text(row.phone), date: text(row.date), time: text(row.time),
    guests: number(row.guests), comment: text(row.comment), status: row.status,
    createdAt: text(row.createdAt), statusUpdatedAt: row.statusUpdatedAt === null ? null : text(row.statusUpdatedAt)
  };
}
export class AdminApi {
  private csrfToken = '';
  private generation = 0;
  get sessionGeneration(): number { return this.generation; }
  clearSession(): void { ++this.generation; this.csrfToken = ''; }
  private async request(path: string, options: RequestInit = {}): Promise<unknown> {
    const generation = this.generation;
    const deadline = AbortSignal.timeout(12000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    try {
      const response = await fetch(`/api/admin/${path}`, {
        ...options, signal, credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken, ...options.headers }
      });
      let result: unknown;
      try { result = await response.json(); }
      catch {
        if (signal.aborted) throw signal.reason;
        if (generation !== this.generation) throw new DOMException('Сеанс изменился.', 'AbortError');
        throw new ApiError(response.status || 502, 'Не удалось прочитать ответ сервера. Попробуйте ещё раз.');
      }
      if (generation !== this.generation) throw new DOMException('Сеанс изменился.', 'AbortError');
      const data = object(result);
      if (!response.ok) {
        if (response.status === 401) this.csrfToken = '';
        throw new ApiError(response.status, typeof data.message === 'string' ? data.message : 'Не удалось выполнить действие. Попробуйте ещё раз.');
      }
      return data;
    } catch (error) {
      if (generation !== this.generation) throw new DOMException('Сеанс изменился.', 'AbortError');
      if (options.signal?.aborted) throw options.signal.reason;
      if (deadline.aborted) throw new ApiError(504, 'Сервер не ответил вовремя. Проверьте результат действия перед повтором.');
      throw error;
    }
  }
  async session(): Promise<AdminSession> { this.clearSession(); return this.acceptSession(await this.request('session')); }
  async login(username: string, password: string): Promise<AdminSession> {
    this.clearSession();
    return this.acceptSession(await this.request('login', { method: 'POST', body: JSON.stringify({ username, password }) }));
  }
  private acceptSession(value: unknown): AdminSession {
    const data = object(value);
    const session = { username: text(data.username), csrfToken: text(data.csrfToken) };
    this.csrfToken = session.csrfToken;
    return session;
  }
  async logout(): Promise<void> { await this.request('logout', { method: 'POST', body: '{}' }); this.clearSession(); }
  async list(filters: BookingFilters, signal?: AbortSignal): Promise<BookingList> {
    const params = new URLSearchParams({ ...filters, page: String(filters.page), pageSize: '20' });
    const data = object(await this.request(`bookings?${params}`, { signal }));
    if (!Array.isArray(data.items)) throw new ApiError(502, 'Не удалось прочитать список заявок.');
    const counts = object(data.counts);
    return {
      items: data.items.map(booking), total: number(data.total), page: number(data.page), pageSize: number(data.pageSize),
      counts: { requested: number(counts.requested), confirmed: number(counts.confirmed), completed: number(counts.completed), cancelled: number(counts.cancelled) }
    };
  }
  async detail(id: string): Promise<BookingDetail> {
    const data = object(await this.request(`bookings/${encodeURIComponent(id)}`));
    if (!Array.isArray(data.history)) throw new ApiError(502, 'Не удалось прочитать историю заявки.');
    const history = data.history.map(value => {
      const row = object(value);
      if (!isStatus(row.fromStatus) || !isStatus(row.toStatus)) throw new ApiError(502, 'Не удалось прочитать историю статусов.');
      return { at: text(row.at), actor: text(row.actor), fromStatus: row.fromStatus, toStatus: row.toStatus };
    });
    return { booking: booking(data.booking), history };
  }
  async changeStatus(id: string, status: BookingStatus, expectedStatus: BookingStatus): Promise<AdminBooking> {
    const data = object(await this.request(`bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status, expectedStatus }) }));
    return booking(data.booking);
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request('password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    this.clearSession();
  }
}
