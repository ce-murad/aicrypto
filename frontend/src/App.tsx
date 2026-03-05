import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AnalysisProvider } from "./context/AnalysisContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AlertsProvider } from "./context/AlertsContext";
import { PortfolioProvider } from "./context/PortfolioContext";
import { InputPage } from "./pages/InputPage";
import { ResultsPage } from "./pages/ResultsPage";

function App() {
  return (
    <ThemeProvider>
      <AnalysisProvider>
        <AlertsProvider>
          <PortfolioProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<InputPage />} />
                <Route path="/results" element={<ResultsPage />} />
              </Routes>
            </BrowserRouter>
          </PortfolioProvider>
        </AlertsProvider>
      </AnalysisProvider>
    </ThemeProvider>
  );
}

export default App;