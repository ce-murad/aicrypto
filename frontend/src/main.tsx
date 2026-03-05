import { StrictMode } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h2>Something went wrong</h2>
      <pre>{error.message}</pre>
    </div>
  );
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);