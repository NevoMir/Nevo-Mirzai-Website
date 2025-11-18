import {
    useEffect,
    useMemo,
    useState,
    useRef,
    Children,
    isValidElement,
    cloneElement,
} from "react";
import type {
    ReactElement,
    SourceHTMLAttributes,
    ImgHTMLAttributes,
    VideoHTMLAttributes,
    ObjectHTMLAttributes,
    CSSProperties,
    KeyboardEvent,
} from "react";
import { useNavigate, useParams } from "react-router";
import { FaArrowLeft, FaFileLines, FaLink, FaVideo, FaWrench } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ProjectPreviewCard } from "@/components/project-card";
import { usePageTitle } from "@/hooks/use-pagetitle";
import { ProjectsData } from "@/data/projects";
import type { Project, ProjectResource } from "@/data/projects";
import { getProjectAssets, resolveProjectMedia } from "@/lib/project-assets";
import { cn } from "@/lib/utils";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Plugin, Pluggable } from "unified";
import type { Root, Content } from "mdast";
import "katex/dist/katex.min.css";

type MarkdownImageComponent = NonNullable<Components["img"]>;

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const projectMarkdownFiles = import.meta.glob("/src/assets/projects/*/content.md", {
    query: "?raw",
    import: "default",
    eager: false,
});

function normalizeDimension(value?: string | number): string | number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^(?:\d+(?:\.\d+)?)(px|%|vh|vw|rem|em)$/.test(trimmed)) {
        return trimmed;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? `${numeric}px` : trimmed;
}

export default function Projects() {
    const { slug } = useParams<{ slug?: string }>();
    const navigate = useNavigate();
    const project = slug ? ProjectsData.find((item) => item.slug === slug) : undefined;

    usePageTitle(slug && project ? project.title : "Projects");

    useEffect(() => {
        if (slug && !project) {
            navigate("/projects", { replace: true });
        }
    }, [slug, project, navigate]);

    if (!slug || !project) {
        return <ProjectsGallery />;
    }

    return <ProjectDetailPage project={project} onBack={() => navigate("/projects")} />;
}

function ProjectsGallery() {
    return (
        <div className="flex flex-1 flex-col items-center gap-10">
            <div className="w-full max-w-6xl space-y-6">
                <div className="flex flex-row justify-center items-center gap-4 text-4xl font-semibold">
                    <FaWrench />
                    Projects
                </div>

                <p className="text-center text-muted-foreground max-w-3xl mx-auto px-4">
                    Browse the full collection of robotics, AI, and embedded systems projects. Tap any card to deep dive into the build log, gallery, and references.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 px-2 sm:px-0">
                    {ProjectsData.map((project) => (
                        <ProjectPreviewCard key={project.slug} project={project} />
                    ))}
                </div>
            </div>
        </div>
    );
}

function ProjectDetailPage({ project, onBack }: { project: Project; onBack: () => void }) {
    const otherProjects = ProjectsData.filter((item) => item.slug !== project.slug);
    const assets = getProjectAssets(project.slug);
    const resources = project.resources ?? [];
    const pdfMeta = assets.pdf
        ? {
              url: assets.pdf,
              label: project.pdfLabel ?? "Project PDF",
              description: project.pdfDescription,
          }
        : null;
    const posterAsset = assets.poster;

    const [markdownContent, setMarkdownContent] = useState<string | null>(null);
    const [markdownLoading, setMarkdownLoading] = useState(false);
    const [markdownError, setMarkdownError] = useState<string | null>(null);

    useEffect(() => {
        const path = `/src/assets/projects/${project.slug}/content.md`;
        if (projectMarkdownFiles[path]) {
            setMarkdownLoading(true);
            setMarkdownError(null);
            projectMarkdownFiles[path]()
                .then((raw) => {
                    setMarkdownContent(raw as string);
                    setMarkdownLoading(false);
                })
                .catch((err) => {
                    console.error(err);
                    setMarkdownError("Failed to load project notes.");
                    setMarkdownContent(null);
                    setMarkdownLoading(false);
                });
        } else {
            setMarkdownContent(null);
            setMarkdownError(null);
            setMarkdownLoading(false);
        }
    }, [project.slug]);

    const posterRemarkPlugin = useMemo<Plugin<[], Root> | null>(
        () => (posterAsset ? createPosterInjectionPlugin({ src: posterAsset }) : null),
        [posterAsset]
    );

    const remarkPlugins = useMemo<Pluggable[]>(() => {
        const plugins: Pluggable[] = [remarkMath];
        if (posterRemarkPlugin) {
            plugins.push(posterRemarkPlugin);
        }
        return plugins;
    }, [posterRemarkPlugin]);

    const markdownComponents = useMemo<Components>(() => {
        const PosterRenderer: MarkdownImageComponent = ({ src, width }) => {
            const resolved =
                typeof src === "string" ? resolveProjectMedia(project.slug, src) ?? src : src;
            const widthValue = normalizeDimension(width ?? "60%") ?? "60%";
            return <PosterViewer src={resolved} width={widthValue} />;
        };

        const baseComponents: Components = {
            img({ src, alt, style, height, width, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
                const resolved =
                    typeof src === "string" ? resolveProjectMedia(project.slug, src) ?? src : src;
                const heightValue = normalizeDimension(height);
                const widthValue = normalizeDimension(width);
                const mergedStyle: CSSProperties = {
                    ...style,
                    display: "block",
                    marginInline: style?.marginInline ?? "auto",
                    maxWidth: "100%",
                    width: widthValue ?? (heightValue ? "auto" : "100%"),
                    ...(heightValue ? { height: heightValue } : {}),
                    objectFit: style?.objectFit ?? (heightValue ? "cover" : undefined),
                };
                return (
                    <img
                        {...props}
                        src={resolved}
                        alt={alt}
                        className={cn("rounded-lg border bg-background shadow-sm", props.className)}
                        style={mergedStyle}
                    />
                );
            },
            video({ src, children, style, height, width, ...props }: VideoHTMLAttributes<HTMLVideoElement>) {
                const resolved =
                    typeof src === "string" ? resolveProjectMedia(project.slug, src) ?? src : src;

                type SourceElement = ReactElement<SourceHTMLAttributes<HTMLSourceElement>>;

                const resolvedChildren = Children.map(children, (child) => {
                    if (!isValidElement(child)) return child;
                    const childProps = child.props as { src?: unknown };
                    if (
                        typeof childProps.src === "string" &&
                        child.type === "source"
                    ) {
                        const mapped =
                            resolveProjectMedia(project.slug, childProps.src) ?? childProps.src;
                        return cloneElement(child as SourceElement, { src: mapped });
                    }
                    return child;
                });

                const heightValue = normalizeDimension(height);
                const widthValue = normalizeDimension(width);
                const mergedStyle: CSSProperties = {
                    ...style,
                    display: "block",
                    marginInline: style?.marginInline ?? "auto",
                    maxWidth: "100%",
                    width: widthValue ?? (heightValue ? "auto" : "100%"),
                    ...(heightValue ? { height: heightValue } : {}),
                    objectFit: style?.objectFit ?? (heightValue ? "cover" : undefined),
                };

                return (
                    <video
                        {...props}
                        src={resolved}
                        className={cn("rounded-lg border bg-black", props.className)}
                        playsInline
                        controls={props.controls ?? true}
                        style={mergedStyle}
                    >
                        {resolvedChildren}
                    </video>
                );
            },
            source({ src, ...props }) {
                const resolved =
                    typeof src === "string" ? resolveProjectMedia(project.slug, src) ?? src : src;
                return <source {...props} src={resolved} />;
            },
            object({ data, type, ...props }: ObjectHTMLAttributes<HTMLObjectElement>) {
                const resolved =
                    typeof data === "string" ? resolveProjectMedia(project.slug, data) ?? data : data;
                return <object {...props} data={resolved} type={type} />;
            },
        };
        return {
            ...baseComponents,
            poster: PosterRenderer,
            Poster: PosterRenderer,
        } as Components;
    }, [project.slug]);

    const fallbackMarkdown = useMemo(() => {
        const headerLines = [`# ${project.title}`];
        const metaParts = [project.course, project.timeline].filter(Boolean);
        if (metaParts.length) {
            headerLines.push(`_${metaParts.join(" • ")}_`);
        }
        headerLines.push("![Cover](cover/cover.png)");
        headerLines.push("<!-- <video src=\"cover/cover.mp4\" controls autoplay muted loop playsinline></video> -->");
        const highlights =
            project.highlights.length > 0
                ? `\n## Highlights\n${project.highlights.map((item) => `- ${item}`).join("\n")}\n`
                : "";
        return `${headerLines.join("\n\n")}\n\n${project.description}\n${highlights}`;
    }, [project]);

    return (
        <div className="flex flex-1 flex-col items-center gap-10">
            <div className="w-full max-w-5xl space-y-8">
                <Button variant="ghost" size="sm" className="gap-2 w-fit" onClick={onBack}>
                    <FaArrowLeft className="w-4 h-4" /> Back to list
                </Button>

                {markdownLoading && (
                    <Card className="p-4 text-sm text-muted-foreground">Loading project notes…</Card>
                )}

                {markdownError && (
                    <Card className="p-4 text-sm text-destructive bg-destructive/10">{markdownError}</Card>
                )}

                <div className="prose dark:prose-invert max-w-none bg-muted/40 rounded-lg p-6 border">
                    <ReactMarkdown
                        remarkPlugins={remarkPlugins}
                        rehypePlugins={[rehypeRaw, rehypeKatex]}
                        skipHtml={false}
                        components={markdownComponents}
                    >
                        {markdownContent ?? fallbackMarkdown}
                    </ReactMarkdown>
                </div>

                {pdfMeta && <ProjectPdfViewer pdf={pdfMeta} />}

                {resources.length > 0 && (
                    <div className="space-y-2">
                        <h3 className="text-xl font-semibold">Resources</h3>
                        <div className="flex flex-col gap-2">
                            {resources.map((resource, index) => (
                                <ResourceRow key={`${resource.label}-${index}`} resource={resource} />
                            ))}
                        </div>
                    </div>
                )}

                {!pdfMeta && resources.length === 0 && (
                    <Card className="p-4 text-sm text-muted-foreground">
                        Add videos, demos, or PDF reports when they are ready.
                    </Card>
                )}

                <Separator className="my-4" />

                <div className="space-y-4">
                    <div className="flex items-center gap-2 text-2xl font-semibold">
                        <FaWrench />
                        Explore other projects
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {otherProjects.map((item) => (
                            <ProjectPreviewCard key={item.slug} project={item} />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

function ResourceRow({ resource }: { resource: ProjectResource }) {
    const icon = resource.type === "report" ? <FaFileLines className="w-4 h-4" /> : resource.type === "slides" ? <FaVideo className="w-4 h-4" /> : <FaLink className="w-4 h-4" />;

    return (
        <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground flex items-center gap-2">
                {icon}
                {resource.label}
            </span>
            {resource.url ? (
                <a
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                >
                    Open
                </a>
            ) : (
                <span className="text-xs italic text-muted-foreground">Add a link when ready</span>
            )}
            {resource.description && (
                <span className="text-xs text-muted-foreground">{resource.description}</span>
            )}
        </div>
    );
}

function PosterViewer({ src, width }: { src?: string; width: string | number }) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [pageWidth, setPageWidth] = useState<number | undefined>();

    useEffect(() => {
        const update = () => {
            if (containerRef.current) {
                setPageWidth(containerRef.current.clientWidth);
            }
        };

        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    const openPoster = () => {
        if (src) {
            window.open(src, "_blank", "noopener,noreferrer");
        }
    };

    return (
        <div
            ref={containerRef}
            className="mx-auto rounded-xl border bg-background shadow-sm cursor-pointer overflow-hidden"
            style={{ width, maxWidth: "100%" }}
            role="button"
            tabIndex={0}
            onClick={openPoster}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openPoster();
                }
            }}
        >
            {pageWidth && src ? (
                <Document file={src} className="flex">
                    <Page
                        pageNumber={1}
                        width={pageWidth}
                        renderAnnotationLayer={false}
                        renderTextLayer={false}
                        className="mx-auto"
                    />
                </Document>
            ) : (
                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                    Loading poster…
                </div>
            )}
        </div>
    );
}

function ProjectPdfViewer({
    pdf,
}: {
    pdf: { url: string; label: string; description?: string };
}) {
    const [numPages, setNumPages] = useState(0);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const pageHeight = usePdfPageHeight();

    const onDocumentLoadSuccess = ({ numPages: nextNumPages }: { numPages: number }) => {
        setNumPages(nextNumPages);
        setErrorMessage(null);
    };

    const onDocumentError = (error: Error) => {
        setErrorMessage(error.message || "Unable to load PDF.");
    };

    const openPdf = () => {
        window.open(pdf.url, "_blank", "noopener,noreferrer");
    };

    const viewerAccessibilityProps = {
        role: "button" as const,
        tabIndex: 0,
        onClick: openPdf,
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openPdf();
            }
        },
        "aria-label": `Open ${pdf.label}`,
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2 text-xl font-semibold">
                <FaFileLines className="w-5 h-5" />
                <a
                    href={pdf.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline underline-offset-4"
                >
                    {pdf.label}
                </a>
            </div>
            <div className="w-full h-[50vh] min-h-[320px] cursor-pointer" {...viewerAccessibilityProps}>
                <div className="h-full rounded-xl border bg-muted/30 overflow-hidden flex items-center justify-center">
                    {errorMessage && <PdfFallback text={errorMessage} />}
                    {!errorMessage && (
                        <div className="h-full w-full overflow-hidden">
                            <div className="h-full overflow-x-auto overflow-y-hidden">
                                <Document
                                    file={pdf.url}
                                    onLoadSuccess={onDocumentLoadSuccess}
                                    onLoadError={onDocumentError}
                                    loading={<PdfFallback text="Loading PDF…" />}
                                    className="flex h-full gap-4 px-4 py-3"
                                >
                                    {Array.from({ length: numPages }, (_, index) => (
                                        <Page
                                            key={`page_${index + 1}`}
                                            pageNumber={index + 1}
                                            height={pageHeight}
                                            renderAnnotationLayer={false}
                                            renderTextLayer={false}
                                            className="flex-shrink-0 rounded-lg border bg-background shadow overflow-hidden"
                                        />
                                    ))}
                                </Document>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {pdf.description && (
                <p className="text-xs text-muted-foreground">{pdf.description}</p>
            )}
        </div>
    );
}

function PdfFallback({ text }: { text: string }) {
    return (
        <div className="flex items-center justify-center w-full text-sm text-muted-foreground">
            {text}
        </div>
    );
}

function usePdfPageHeight() {
    const [height, setHeight] = useState(320);

    useEffect(() => {
        const update = () => {
            const next =
                typeof window !== "undefined" ? Math.max(260, window.innerHeight * 0.5) : 320;
            setHeight(next);
        };

        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, []);

    return height;
}

function createPosterInjectionPlugin({ src, width }: { src: string; width?: string | number }): Plugin<[], Root> {
    const widthAttr = normalizeDimension(width ?? "60%") ?? "60%";

    return () => (tree) => {
        const hasPoster = tree.children.some(
            (node) =>
                node.type === "html" &&
                typeof (node as Content & { value?: unknown }).value === "string" &&
                /<\s*poster\b/i.test(((node as Content & { value?: string }).value ?? ""))
        );

        if (hasPoster) {
            return;
        }

        const posterNode: Content = {
            type: "html",
            value: `<poster src="${src}" width="${widthAttr}"></poster>`,
        };

        const children = tree.children;
        let headingSeen = false;
        let insertIndex = children.length;

        for (let i = 0; i < children.length; i++) {
            const node = children[i];
            if (!headingSeen) {
                if (node.type === "heading") {
                    headingSeen = true;
                }
                continue;
            }

            if (node.type === "paragraph") {
                insertIndex = i + 1;
                break;
            }

            if (node.type !== "html" && node.type !== "thematicBreak") {
                insertIndex = i;
                break;
            }
        }

        if (!headingSeen) {
            insertIndex = 0;
        }

        children.splice(insertIndex, 0, posterNode);
    };
}
