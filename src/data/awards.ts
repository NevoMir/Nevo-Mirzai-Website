import droneRecordImage from "@/assets/awards/drone-record.webp";
import eyeTrackerHeadlampCover from "@/assets/projects/eye-tracker-headlamp/cover/cover.webp";
import dataCreationBoxCover from "@/assets/projects/data-augmentation-box/cover/cover.webp";

export type AwardIcon = "medal" | "trophy";

export type AwardImage = {
    src: string;
    alt: string;
    /** "cover" fills the frame, "contain" shows the whole image (use with `lightBackdrop` for white renders). */
    fit: "cover" | "contain";
    /** CSS object-position, e.g. "50% 0%". Only used with fit "cover". */
    position?: string;
    /** Keeps a white tile behind the image so white-background renders also look right in dark mode. */
    lightBackdrop?: boolean;
};

export type AwardLink = {
    label: string;
    href: string;
    /** Internal links use client-side routing, external ones open in a new tab. */
    external: boolean;
    /** Short hint shown next to the button, e.g. the language of an external article. */
    note?: string;
};

export type Award = {
    id: string;
    /** Featured awards are shown large on top; the others go in a grid below. */
    featured?: boolean;
    /** Short chip text for the rank or title. */
    badge: string;
    icon: AwardIcon;
    title: string;
    /** Year or full date. */
    date: string;
    place?: string;
    /** Body that granted or certified the award. Single field so it is easy to correct. */
    issuer: string;
    summary: string;
    image: AwardImage;
    link: AwardLink;
    /** Optional second source, shown as a text link next to the main button. */
    secondaryLink?: AwardLink;
};

export const AwardsData: Award[] = [
    {
        id: "drone-world-record-2017",
        featured: true,
        badge: "World Record",
        icon: "medal",
        title: "World Record: Most Drones Piloted at the Same Time by Children",
        date: "23 September 2017",
        place: "Lodrino airfield, Switzerland",
        issuer: "World Record Academy",
        summary:
            "I was one of the 73 children and teenagers who each built and piloted their own drone and flew them all at once, about 30 m high, beating the previous mark of 54 drones. The event was organized by Ated4Kids as part of its project \"Costruisci il tuo primo drone\" (Build your first drone), and the record was certified on the spot by World Record Academy.",
        image: {
            src: droneRecordImage,
            alt: "Young pilots holding their LED-lit drones around the framed World Record Academy certificate at Lodrino airfield, with mountains in the background",
            fit: "cover",
            position: "50% 40%",
        },
        link: {
            label: "Read the RSI report",
            href: "https://www.rsi.ch/info/ticino-grigioni-e-insubria/Droni-da-record-a-Lodrino--1038406.html",
            external: true,
            note: "Article in Italian",
        },
        secondaryLink: {
            label: "World Record Academy listing",
            href: "http://www.worldrecordacademy.com/technology/most_drones_piloted_at_the_same_time_by_children_world_record_set_by_Ated4Kids_217259.html",
            external: true,
        },
    },
    {
        id: "rrl-lab-competition-me-410",
        badge: "1st Place",
        icon: "trophy",
        title: "Best Project, RRL Lab Competition (ME-410)",
        date: "2025",
        place: "EPFL",
        issuer: "Reconfigurable Robotics Lab",
        summary:
            "ME-410 (Mechanical product design and development) is an EPFL course run by the Reconfigurable Robotics Lab (RRL), where student teams design and build a mechatronic product through hands-on tutorials on actuators, structures and modeling. Our team came first in the lab's competition for the best project of the course with the Eye Tracker Headlamp.",
        image: {
            src: eyeTrackerHeadlampCover,
            alt: "CAD render of the Eye Tracker Headlamp mounted on a helmet",
            fit: "contain",
            lightBackdrop: true,
        },
        link: {
            label: "See the project",
            href: "/projects/eye-tracker-headlamp",
            external: false,
        },
    },
    {
        id: "best-startup-project-mgt-555",
        badge: "Winner",
        icon: "trophy",
        title: "Best Startup Project (MGT-555)",
        date: "2025",
        place: "EPFL",
        issuer: "MGT-555 course competition",
        summary:
            "MGT-555 (Innovation & entrepreneurship in engineering) is an EPFL course run jointly by the School of Engineering and the College of Management, where teams develop a product idea, build a prototype and propose a commercialization plan. Our team won the competition for the best startup project with the Data Creation Box, an automated rig that captures training images for industrial vision systems.",
        image: {
            src: dataCreationBoxCover,
            alt: "Grid of watch-case training images with labeled bounding boxes, produced with the Data Creation Box",
            fit: "cover",
            position: "50% 0%",
        },
        link: {
            label: "See the project",
            href: "/projects/data-augmentation-box",
            external: false,
        },
    },
];
