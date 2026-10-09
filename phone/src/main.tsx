import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Desk } from "@/components/desk";
import { Toaster } from "@/components/ui/sonner";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/fraunces/500.css";
import "@fontsource/fraunces/600.css";
import "./phone.css";
import "@/app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Desk />
    <Toaster position="top-center" />
  </StrictMode>,
);
