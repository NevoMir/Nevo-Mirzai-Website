import { PrivateRedirect } from "@/components/private-redirect";

// Thesis outreach.
const PRIVATE_PAGE_URL = "https://claude.ai/artifact/676BwCFYJjUDCdZrABRVoq";

export default function Outreach() {
    return <PrivateRedirect url={PRIVATE_PAGE_URL} />;
}
