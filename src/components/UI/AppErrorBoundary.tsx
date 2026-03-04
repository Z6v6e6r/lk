import { Component, type ErrorInfo, type ReactNode } from "react";
import { trackClientError } from "../../utils/analytics";

interface AppErrorBoundaryProps {
  module: string;
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    trackClientError(
      "react.error_boundary",
      error,
      {
        module: this.props.module,
        componentStack: errorInfo.componentStack ?? null,
      },
      { handled: false, severity: "error" },
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="load-error">
          <div className="load-error-title">Не удалось открыть личный кабинет</div>
          <div className="load-error-text">Произошла ошибка интерфейса. Попробуйте перезагрузить страницу позже.</div>
        </div>
      );
    }

    return this.props.children;
  }
}
