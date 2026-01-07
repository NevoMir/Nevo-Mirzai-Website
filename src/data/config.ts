export const SITE_NAME = "Nevò Mirzai";
export const GA_MEASUREMENT_ID = "G-K4L29KFR9M";

const defaultResumeUrl = "/CV/resume.pdf?v=2";
export const RESUME_URL = typeof import.meta !== "undefined" && import.meta.env?.VITE_RESUME_URL
    ? import.meta.env.VITE_RESUME_URL
    : defaultResumeUrl;
