import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { FaArrowLeft, FaFileLines, FaLink, FaVideo, FaWrench } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ProjectPreviewCard } from "@/components/project-card";
import { usePageTitle } from "@/hooks/use-pagetitle";
import { ProjectsData } from "@/data/projects";
import type { Project, ProjectResource } from "@/data/projects";
import { getProjectAssets } from "@/lib/project-assets";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

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

    return (
        <div className="flex flex-1 flex-col items-center gap-10">
            <div className="w-full max-w-5xl space-y-8">
                <Button variant="ghost" size="sm" className="gap-2 w-fit" onClick={onBack}>
                    <FaArrowLeft className="w-4 h-4" /> Back to list
                </Button>

                <div className="space-y-3">
                    <p className="text-sm uppercase tracking-wide text-muted-foreground">
                        {project.course || "Independent"}
                    </p>
                    <h1 className="text-4xl font-semibold leading-tight">{project.title}</h1>
                    {project.timeline && (
                        <p className="text-base text-muted-foreground">{project.timeline}</p>
                    )}
                </div>

                <div className="space-y-4">
                    <p className="text-lg text-muted-foreground">{project.description}</p>
                    <ul className="list-disc list-inside space-y-2 text-base">
                        {project.highlights.map((highlight) => (
                            <li key={highlight}>{highlight}</li>
                        ))}
                    </ul>
                </div>

                <ProjectMediaRail slug={project.slug} images={assets.images} videos={assets.videos} />

                {(pdfMeta || resources.length > 0) && (
                    <div className="space-y-6">
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {otherProjects.map((item) => (
                            <ProjectPreviewCard key={item.slug} project={item} />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

function ProjectMediaRail({
    slug,
    images,
    videos,
}: {
    slug: string;
    images: string[];
    videos: string[];
}) {
    if (images.length === 0 && videos.length === 0) {
        return (
            <Card className="p-4 text-sm text-muted-foreground">
                Add media to <code>src/assets/projects/{slug}/images</code> or{" "}
                <code>src/assets/projects/{slug}/videos</code> to showcase them here.
            </Card>
        );
    }

    const galleryItems = [
        ...images.map((url) => ({ type: "image" as const, url })),
        ...videos.map((url) => ({ type: "video" as const, url })),
    ];

    return (
        <div className="space-y-2">
            <h3 className="text-xl font-semibold">Media showcase</h3>
            <div className="w-full h-[50vh] min-h-[280px]">
                <div className="flex h-full gap-4 overflow-x-auto rounded-md bg-muted/30 p-3">
                    {galleryItems.map((item, index) => (
                        <div
                            key={`${item.url}-${index}`}
                            className="min-w-[320px] h-full bg-background rounded-md shadow-sm overflow-hidden flex flex-col"
                        >
                            {item.type === "video" ? (
                                <video
                                    controls
                                    className="w-full h-full object-cover flex-1 bg-black"
                                    preload="metadata"
                                >
                                    <source src={item.url} />
                                </video>
                            ) : (
                                <img
                                    src={item.url}
                                    alt={`${slug} media ${index + 1}`}
                                    className="w-full h-full object-cover flex-1"
                                />
                            )}
                        </div>
                    ))}
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
            <div className="w-full h-[50vh] min-h-[320px]">
                <div className="h-full rounded-md border bg-muted/30 overflow-hidden flex items-center justify-center">
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
                                            className="flex-shrink-0 rounded-md border bg-background shadow"
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
