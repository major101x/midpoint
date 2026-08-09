import React from "react";
import { createRoot } from "react-dom/client";

// Self-hosted through @fontsource, so the page makes no external font request
// and renders identically offline.
//
// Latin subset only, and only the weights the design uses. The unsubsetted
// entry points ship twenty files covering Cyrillic, Greek and Vietnamese;
// a browser would never fetch them here, but they would still sit in the
// build and in the repository for no reason.
import "@fontsource/outfit/latin-400.css";
import "@fontsource/outfit/latin-500.css";
import "@fontsource/outfit/latin-600.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";

import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
