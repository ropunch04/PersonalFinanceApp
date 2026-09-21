import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// App.jsx already mounts its own AuthProvider (App.jsx:110). Having a second
// one here meant every auth state change fired token/user updates through
// two separate providers — doubling auth-related network traffic and racing
// on logout.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
