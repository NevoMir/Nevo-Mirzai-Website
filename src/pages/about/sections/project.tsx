import { Link } from "react-router";
import { FaWrench, FaArrowRight } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { FeaturedProjects } from "@/data/projects";
import { ProjectPreviewCard } from "@/components/project-card";

export default function Project() {
    return (
        <div className="w-full max-w-5xl space-y-6">
            <div className="flex flex-row justify-center items-center gap-2 text-plus font-semibold">
                <FaWrench />
                Projects
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 px-2 sm:px-6">
                {FeaturedProjects.map((project) => (
                    <ProjectPreviewCard key={project.slug} project={project} />
                ))}
            </div>

            <div className="relative w-full">
                <div className="absolute right-2 sm:right-6">
                    <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-muted-foreground"
                    >
                        <Link to="/projects">
                            View all
                            <FaArrowRight className="w-4 h-4" />
                        </Link>
                    </Button>
                </div>
            </div>
        </div>
    );
}
