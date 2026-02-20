import { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import { Cabinet } from "./components/cabinet/Cabinet";
import "./MyApp.css";

function AppContent() {
  const { isAuthenticated } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet">("auth");

  useEffect(() => {
    if (isAuthenticated) {
      setView("cabinet");
    } else {
      setView("auth");
    }
  }, [isAuthenticated]);

  if (view === "cabinet") {
    return <Cabinet />;
  }

  return <AuthForm onLogin={() => setView("cabinet")} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
