import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { WalletContext } from "./wallet";
import './styles.css';
import 'buffer';  // Add buffer polyfill

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletContext>
      <App />
    </WalletContext>
  </React.StrictMode>
);
