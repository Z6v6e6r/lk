import { useEffect, useState } from "react";
import {
  apiCancelBooking,
  apiFetchBookingCancellationOptions,
  apiVerifyBookingCancellation,
} from "../../utils/apiClient";
import {
  type BookingCancellationAction,
  type BookingCancellationOptionsResponse,
  resolveBookingCancellationPlan,
} from "../../utils/bookingCancellation";
import { Modal } from "../UI/Modal";

export interface BookingCancellationExecutionResult {
  ok: boolean;
  message: string;
  state?: "DONE" | "RETRY_REQUIRED";
}

interface BookingCancellationDialogProps {
  bookingId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccessClose?: () => void;
  title?: string;
  executeAction?: (
    action: BookingCancellationAction,
    options: BookingCancellationOptionsResponse,
  ) => Promise<BookingCancellationExecutionResult>;
}

async function defaultExecuteAction(
  bookingId: string,
  action: BookingCancellationAction,
): Promise<BookingCancellationExecutionResult> {
  const response = await apiCancelBooking(bookingId, action);
  const accepted = response.status !== null && response.status >= 200 && response.status < 300;
  const verifiableConflict = response.status !== null
    && [400, 404, 409, 422].includes(response.status);
  if (!accepted && !verifiableConflict) {
    return {
      ok: false,
      message: response.error?.message || "Не удалось отменить запись",
    };
  }

  const verification = await apiVerifyBookingCancellation(bookingId);
  return {
    ok: !verification.error && verification.data?.state === "cancelled",
    message: !verification.error && verification.data?.state === "cancelled"
      ? action.successMessage
      : (verification.error?.message || "Не удалось подтвердить отмену записи"),
  };
}

export function BookingCancellationDialog({
  bookingId,
  isOpen,
  onClose,
  onSuccessClose,
  title = "Отмена записи",
  executeAction,
}: BookingCancellationDialogProps) {
  const [options, setOptions] = useState<BookingCancellationOptionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittingActionId, setSubmittingActionId] = useState<BookingCancellationAction["id"] | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [completionState, setCompletionState] = useState<"DONE" | "RETRY_REQUIRED" | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setOptions(null);
      setLoading(false);
      setLoadError(null);
      setSubmitError(null);
      setSubmittingActionId(null);
      setSuccessMessage(null);
      setCompletionState(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setSubmittingActionId(null);
    setSuccessMessage(null);
    setCompletionState(null);
    setOptions(null);

    void apiFetchBookingCancellationOptions(bookingId).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setLoadError(result.error?.message || "Не удалось получить варианты возврата");
        setLoading(false);
        return;
      }
      setOptions(result.data);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [bookingId, isOpen]);

  const handleClose = () => {
    const shouldRunSuccessClose = Boolean(successMessage);
    onClose();
    if (shouldRunSuccessClose) {
      onSuccessClose?.();
    }
  };

  const handleRetry = () => {
    setOptions(null);
    setLoadError(null);
    setSubmitError(null);
    setSubmittingActionId(null);
    setSuccessMessage(null);
    setCompletionState(null);
    setLoading(true);

    void apiFetchBookingCancellationOptions(bookingId).then((result) => {
      if (result.error || !result.data) {
        setLoadError(result.error?.message || "Не удалось получить варианты возврата");
        setLoading(false);
        return;
      }
      setOptions(result.data);
      setLoading(false);
    });
  };

  const handleAction = async (action: BookingCancellationAction) => {
    if (!options) return;
    setSubmitError(null);
    setSubmittingActionId(action.id);

    try {
      const result = executeAction
        ? await executeAction(action, options)
        : await defaultExecuteAction(bookingId, action);
      if (!result.ok) {
        setSubmitError(result.message || "Не удалось отменить запись");
        setSubmittingActionId(null);
        return;
      }
      setSuccessMessage(result.message || action.successMessage);
      setCompletionState(result.state ?? "DONE");
      setSubmittingActionId(null);
    } catch {
      setSubmitError("Не удалось отменить запись");
      setSubmittingActionId(null);
    }
  };

  const plan = options ? resolveBookingCancellationPlan(options) : null;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} variant="dialog">
      <div className="booking-cancel-dialog">
        {loading && (
          <div className="booking-cancel-dialog__body">
            <div className="booking-cancel-dialog__text">Проверяем варианты возврата...</div>
          </div>
        )}

        {!loading && loadError && (
          <div className="booking-cancel-dialog__body">
            <div className="booking-cancel-dialog__error">{loadError}</div>
            <div className="booking-cancel-dialog__footer">
              <button type="button" className="btn-cancel outline" onClick={handleClose}>
                Закрыть
              </button>
              <button type="button" className="btn-cancel primary" onClick={handleRetry}>
                Повторить
              </button>
            </div>
          </div>
        )}

        {!loading && !loadError && successMessage && (
          <div className="booking-cancel-dialog__body">
            <div
              className={completionState === "RETRY_REQUIRED"
                ? "booking-cancel-dialog__text"
                : "booking-cancel-dialog__success"}
              role="status"
            >
              {successMessage}
            </div>
            <div className="booking-cancel-dialog__footer">
              <button type="button" className="btn-cancel primary" onClick={handleClose}>
                Продолжить
              </button>
            </div>
          </div>
        )}

        {!loading && !loadError && !successMessage && plan && (
          <div className="booking-cancel-dialog__body">
            <div className="booking-cancel-dialog__subtitle">{plan.promptTitle}</div>
            {plan.mode === "unsupported" ? (
              <>
                <div className="booking-cancel-dialog__text">{plan.unsupportedReason}</div>
                <div className="booking-cancel-dialog__footer">
                  <button type="button" className="btn-cancel primary" onClick={handleClose}>
                    Понятно
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="booking-cancel-dialog__text">{plan.promptText}</div>
                {submitError && (
                  <div className="booking-cancel-dialog__error">{submitError}</div>
                )}
                {plan.mode === "selection" ? (
                  <>
                    <div className="booking-cancel-dialog__options">
                      {plan.actions.map((action) => {
                        const isSubmitting = submittingActionId === action.id;
                        return (
                          <button
                            key={action.id}
                            type="button"
                            className="booking-cancel-dialog__option"
                            onClick={() => void handleAction(action)}
                            disabled={Boolean(submittingActionId)}
                          >
                            <span className="booking-cancel-dialog__option-title">
                              {isSubmitting ? "Оформляем..." : action.label}
                            </span>
                            <span className="booking-cancel-dialog__option-description">
                              {action.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="booking-cancel-dialog__footer">
                      <button type="button" className="btn-cancel outline" onClick={handleClose} disabled={Boolean(submittingActionId)}>
                        Назад
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="booking-cancel-dialog__footer">
                    <button type="button" className="btn-cancel outline" onClick={handleClose} disabled={Boolean(submittingActionId)}>
                      Назад
                    </button>
                    <button
                      type="button"
                      className="btn-cancel primary"
                      onClick={() => void handleAction(plan.actions[0])}
                      disabled={Boolean(submittingActionId)}
                    >
                      {submittingActionId ? "Оформляем..." : plan.actions[0].confirmLabel}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
