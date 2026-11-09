import { PrivateRedirect } from "@/components/private-redirect";

// Local LLM startup: outreach to companies that already own the hardware.
const PRIVATE_PAGE_URL = "https://claude.ai/artifact/8UvAfSw6xCX4fyL6cdQkHb";

export default function ClientOutreach() {
    return <PrivateRedirect url={PRIVATE_PAGE_URL} />;
}
