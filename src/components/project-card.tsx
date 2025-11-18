import { Link } from "react-router-dom";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Project } from "@/data/projects";
import { getProjectHero } from "@/lib/project-assets";

type ProjectPreviewCardProps = {
    project: Project;
    className?: string;
};

export function ProjectPreviewCard({ project, className }: ProjectPreviewCardProps) {
    const hero = getProjectHero(project.slug);

    return (
        <Card className={cn("rounded-lg overflow-hidden gap-0 py-0 w-full flex flex-col h-full", className)}>
            <Link to={`/projects/${project.slug}`} className="flex flex-col flex-grow group text-left">
                <div className="aspect-video w-full overflow-hidden bg-black">
                    {hero ? (
                        hero.type === "video" ? (
                            <video
                                src={hero.url}
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                autoPlay
                                loop
                                muted
                                playsInline
                            />
                        ) : (
                            <img
                                src={hero.url}
                                alt={project.title}
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                loading="lazy"
                            />
                        )
                    ) : (
                        <div className="flex flex-col items-center justify-center p-4 w-full h-full bg-muted text-center">
                            <span className="text-lg font-semibold opacity-80">{project.title}</span>
                            <span className="text-sm text-muted-foreground">Media coming soon</span>
                        </div>
                    )}
                </div>

                <div className="w-full border-t" />

                <div className="flex flex-col flex-grow py-3 px-4 gap-y-3">
                    <div className="text-base font-semibold line-clamp-2 group-hover:text-primary transition-colors">
                        {project.title}
                    </div>

                    <p className="text-sm text-muted-foreground line-clamp-3">{project.summary}</p>

                    {project.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-auto">
                            {project.tags.slice(0, 3).map((tag) => (
                                <span
                                    key={tag}
                                    className="rounded-sm bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </Link>
        </Card>
    );
}
