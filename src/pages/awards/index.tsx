import { Link } from "react-router";
import {
    FaArrowRight,
    FaArrowUpRightFromSquare,
    FaCertificate,
    FaLocationDot,
    FaMedal,
    FaRegCalendar,
    FaTrophy,
} from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePageTitle } from "@/hooks/use-pagetitle";
import { cn } from "@/lib/utils";
import { AwardsData } from "@/data/awards";
import type { Award, AwardIcon, AwardImage, AwardLink } from "@/data/awards";

const BADGE_ICONS: Record<AwardIcon, typeof FaTrophy> = {
    medal: FaMedal,
    trophy: FaTrophy,
};

function AwardImageFrame({
    image,
    className,
    eager = false,
}: {
    image: AwardImage;
    className?: string;
    eager?: boolean;
}) {
    return (
        <div
            className={cn(
                "relative aspect-video w-full overflow-hidden",
                image.lightBackdrop ? "bg-white" : "bg-muted",
                className
            )}
        >
            <img
                src={image.src}
                alt={image.alt}
                loading={eager ? "eager" : "lazy"}
                decoding="async"
                className={cn(
                    "absolute inset-0 h-full w-full",
                    image.fit === "contain" ? "object-contain" : "object-cover"
                )}
                style={
                    image.fit === "cover" && image.position
                        ? { objectPosition: image.position }
                        : undefined
                }
            />
        </div>
    );
}

function AwardBadge({ award }: { award: Award }) {
    const Icon = BADGE_ICONS[award.icon];

    return (
        <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-amber-400 bg-slate-50 px-2.5 py-1 text-sm font-semibold text-amber-800 shadow-sm dark:border-amber-500 dark:bg-slate-900 dark:text-amber-200">
            <Icon className="size-3.5 shrink-0" />
            {award.badge}
        </span>
    );
}

function AwardMeta({ award }: { award: Award }) {
    const items = [
        { key: "date", icon: FaRegCalendar, text: award.date },
        { key: "place", icon: FaLocationDot, text: award.place },
        { key: "issuer", icon: FaCertificate, text: award.issuer },
    ];

    return (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {items.map(
                ({ key, icon: Icon, text }) =>
                    text && (
                        <li key={key} className="flex items-center gap-1.5">
                            <Icon className="size-3.5 shrink-0" />
                            <span>{text}</span>
                        </li>
                    )
            )}
        </ul>
    );
}

function AwardAction({ link, secondaryLink }: { link: AwardLink; secondaryLink?: AwardLink }) {
    return (
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
            <Button asChild variant="outline" className="gap-2 border-2 px-4">
                {link.external ? (
                    <a href={link.href} target="_blank" rel="noopener noreferrer">
                        {link.label}
                        <FaArrowUpRightFromSquare className="size-3.5" />
                        <span className="sr-only">(opens in a new tab)</span>
                    </a>
                ) : (
                    <Link to={link.href}>
                        {link.label}
                        <FaArrowRight className="size-3.5" />
                    </Link>
                )}
            </Button>
            {link.note && <span className="text-xs text-muted-foreground">{link.note}</span>}
            {secondaryLink && (
                <a
                    href={secondaryLink.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                    {secondaryLink.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                </a>
            )}
        </div>
    );
}

function FeaturedAwardCard({ award }: { award: Award }) {
    return (
        <Card className="w-full flex-col gap-0 overflow-hidden rounded-lg py-0 lg:grid lg:grid-cols-5">
            <AwardImageFrame
                image={award.image}
                eager
                className="lg:col-span-3 lg:aspect-auto lg:min-h-80"
            />

            <div className="flex flex-col justify-center gap-4 border-t p-5 sm:p-6 lg:col-span-2 lg:border-l lg:border-t-0">
                <AwardBadge award={award} />
                <h2 className="text-xl font-semibold leading-snug sm:text-2xl">{award.title}</h2>
                <AwardMeta award={award} />
                <p className="text-sm leading-relaxed text-muted-foreground">{award.summary}</p>
                <AwardAction link={award.link} secondaryLink={award.secondaryLink} />
            </div>
        </Card>
    );
}

function AwardCard({ award }: { award: Award }) {
    return (
        <Card className="h-full w-full flex-col gap-0 overflow-hidden rounded-lg py-0">
            <AwardImageFrame image={award.image} />

            <div className="w-full border-t" />

            <div className="flex flex-grow flex-col gap-3 p-5">
                <AwardBadge award={award} />
                <h2 className="text-lg font-semibold leading-snug">{award.title}</h2>
                <AwardMeta award={award} />
                <p className="text-sm leading-relaxed text-muted-foreground">{award.summary}</p>
                <AwardAction link={award.link} secondaryLink={award.secondaryLink} />
            </div>
        </Card>
    );
}

export default function Awards() {
    usePageTitle("Awards");

    const featuredAwards = AwardsData.filter((award) => award.featured);
    const otherAwards = AwardsData.filter((award) => !award.featured);

    return (
        <div className="flex flex-1 flex-col items-center gap-10">
            <div className="w-full max-w-5xl space-y-8">
                <h1 className="flex flex-row items-center justify-center gap-4 text-4xl font-semibold">
                    <FaTrophy />
                    Awards
                </h1>

                <div className="space-y-6 px-2 sm:px-6">
                    {featuredAwards.map((award) => (
                        <FeaturedAwardCard key={award.id} award={award} />
                    ))}

                    {otherAwards.length > 0 && (
                        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                            {otherAwards.map((award) => (
                                <AwardCard key={award.id} award={award} />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
