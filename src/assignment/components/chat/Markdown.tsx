import ReactMarkdown, { type Components } from "react-markdown";

import { cn } from "@/assignment/lib/utils";

// Chat text can come from anyone who can write a project (the API has no login), so it may carry
// links and images meant for the next visitor. Images are not rendered at all (a remote <img> reports
// the viewer's IP to its host), and a link opens in a new tab without telling the target who sent
// the visitor.
const components: Components = {
    a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
        </a>
    ),
};

/**
 * Chat text. react-markdown v10 takes no className, and renders no raw HTML, so a prompt or a
 * provider's error message can never inject markup. The element styles are local to the bubble.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
    return (
        <div
            className={cn(
                "[overflow-wrap:anywhere] [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_ol]:list-decimal [&_ol]:pl-4 [&_p+p]:mt-2 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-4",
                className,
            )}
        >
            <ReactMarkdown components={components} disallowedElements={["img"]}>
                {children}
            </ReactMarkdown>
        </div>
    );
}
