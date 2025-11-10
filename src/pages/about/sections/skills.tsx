import { FaScrewdriverWrench } from "react-icons/fa6";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkillsData } from "@/data/skills";

export default function Skills() {
    return (
        <div className="w-full max-w-5xl space-y-6">
            <div className="flex flex-row justify-center items-center gap-2 text-plus font-semibold">
                <FaScrewdriverWrench />
                Skills
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-2 sm:px-6">
                {SkillsData.map((group, index) => (
                    <Card key={index} className="h-full">
                        <CardHeader>
                            <CardTitle>{group.category}</CardTitle>
                            {group.description && (
                                <CardDescription>{group.description}</CardDescription>
                            )}
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-2">
                                {group.skills.map((skill) => (
                                    <span
                                        key={skill}
                                        className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground"
                                    >
                                        {skill}
                                    </span>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
