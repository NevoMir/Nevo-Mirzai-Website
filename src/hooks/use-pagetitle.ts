import { useEffect } from "react";
import { useLocation } from "react-router";
import { SITE_NAME, GA_MEASUREMENT_ID } from "@/data/config";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function usePageTitle(title?: string) {
  const location = useLocation();

  useEffect(() => {
    document.title = title ? `${title} - ${SITE_NAME}` : SITE_NAME;
  }, [title]);

  useEffect(() => {
    if (typeof window !== "undefined" && typeof window.gtag === "function" && GA_MEASUREMENT_ID) {
      window.gtag("config", GA_MEASUREMENT_ID, {
        page_path: location.pathname + location.search,
      });
    }
  }, [location]);
}
