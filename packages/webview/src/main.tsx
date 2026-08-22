import React from "react";
import { createRoot } from "react-dom/client";
import "@vscode/codicons/dist/codicon.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./fixes.css";
import App from "./App";

const root = document.createElement("div");
root.id = "root";
document.body.append(root);
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
