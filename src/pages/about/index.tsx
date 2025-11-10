import { Separator } from "@/components/ui/separator";
import { usePageTitle } from "@/hooks/use-pagetitle";

import Introduction from "./sections/introduction";
import Experience from "./sections/experience";
import Skills from "./sections/skills";
import Publication from "./sections/publication";
import Project from "./sections/project";

export default function About() {
    usePageTitle("About Me");

    return (
        <div className="flex flex-1 flex-col items-center gap-12 py-4">
            <Introduction />
            <Experience />
            <Separator orientation="horizontal" className="max-w-5xl mt-8" />
            <Skills />
            <Separator orientation="horizontal" className="max-w-5xl mt-8" />
            <Publication />
            <Separator orientation="horizontal" className="max-w-5xl mt-8" />
            <Project />
        </div>
    );
}
