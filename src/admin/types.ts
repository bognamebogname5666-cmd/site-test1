export const statusLabels = {
  requested: 'Ожидает ответа', confirmed: 'Подтверждена',
  completed: 'Визит завершён', cancelled: 'Отменена'
} as const;
export type BookingStatus = keyof typeof statusLabels;
export interface AdminSession { username: string; csrfToken: string }
export interface AdminBooking {
  id: string; name: string; phone: string; date: string; time: string;
  guests: number; comment: string; status: BookingStatus;
  createdAt: string; statusUpdatedAt: string | null;
}
export interface BookingList {
  items: AdminBooking[]; total: number; page: number; pageSize: number;
  counts: Record<BookingStatus, number>;
}
export interface BookingHistory { at: string; actor: string; fromStatus: BookingStatus; toStatus: BookingStatus }
export interface BookingDetail { booking: AdminBooking; history: BookingHistory[] }
export interface BookingFilters { status: BookingStatus | 'all'; q: string; dateFrom: string; dateTo: string; page: number }
export function isStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && Object.hasOwn(statusLabels, value);
}
