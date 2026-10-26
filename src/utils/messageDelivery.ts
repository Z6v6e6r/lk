/** A failed response does not prove that a message was not saved. */
export const MESSAGE_DELIVERY_UNCONFIRMED =
  "Не удалось подтвердить отправку. Проверьте сообщения в чате перед повторной попыткой.";

export function messageSendError<T extends { message: string }>(error: T, status: number | null): T {
  return status === null || status >= 500
    ? { ...error, message: MESSAGE_DELIVERY_UNCONFIRMED }
    : error;
}
