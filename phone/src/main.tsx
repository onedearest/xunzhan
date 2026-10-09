import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Desk } from "@/components/desk";
import { Toaster } from "@/components/ui/sonner";
import "./phone.css";
import "@/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Desk />
    <Toaster position="top-center" />
  </StrictMode>,
);
