// The words the Stability panel and the stage use, in one place. Each term has the plain word a student reads on screen
// (`label`), the technical term a teaching assistant knows it by (`tech`), and a tooltip (`tip`) that explains it and names the
// technical term. The technical terms stay in tooltips, in the info page's glossary and in the exported report files; they
// are not part of the default text of the panel (scripts/assignment/test-store.mjs checks the briefs for them).
//
// Pure data and two tiny helpers: no React, no store, so the panel, the stage (viewer/analysisGeometry.ts), the briefs
// (store/analysisBrief.ts) and the tests read one copy.

import type { AnalysisColorBy, BlockStatus, CheckKey, StressMode } from "@/assignment/analysis/types";
import type { BlockRole } from "@/assignment/shared/contract";

export interface Term {
    /** The word on screen: "Overhang". */
    label: string;
    /** What a structural engineer calls it: "Cantilever". Shown in the tooltip and the glossary only. */
    tech: string;
    /** The tooltip: one or two plain sentences, then the technical term. */
    tip: string;
}

/** `{label, tech, tip}` with the tooltip's last sentence naming the technical term. */
const term = (label: string, tech: string, explain: string): Term => ({ label, tech, tip: `${explain} Technical term: ${tech.toLowerCase()}.` });

// ---------- the terms ----------

export const TERMS = {
    balance: term(
        "Balance",
        "Centre-of-gravity margin to the support base",
        "How far the model's weight is from the edge of its base. Inside the base it stands; outside, it tips over.",
    ),
    overhang: term(
        "Overhang",
        "Cantilever",
        "Blocks with nothing underneath them, held up from the side by the rest of the model.",
    ),
    overhangingBlocks: term(
        "Overhanging blocks",
        "Cantilevered blocks",
        "Blocks with nothing underneath them, held up from the side by the rest of the model.",
    ),
    longestOverhang: term(
        "Longest overhang",
        "Longest cantilever",
        "How many blocks the biggest overhang sticks out from the last block that is supported from below.",
    ),
    overhangTooLong: term(
        "Overhang too long",
        "Cantilever over the limit (overreach)",
        "An overhang that sticks out further than the longest allowed overhang.",
    ),
    overhangsTooLong: term(
        "Overhangs too long",
        "Long cantilevers",
        "Overhangs that stick out further than the longest allowed overhang.",
    ),
    armTooLong: term(
        "Arm too long",
        "Cantilever over the limit",
        "A group of overhanging blocks (an arm, a bridge or a cap) that sticks out further than the longest allowed overhang.",
    ),
    reach: term(
        "Blocks from the nearest support",
        "Reach",
        "How many block steps a block is from the nearest block that is supported from below, counted along the structure.",
    ),
    strengthUsed: term(
        "Strength used",
        "Joint stress utilisation",
        "How much of a joint's strength the model's own weight uses. 100% is where the joint would open or crush.",
    ),
    worstJoint: term(
        "Worst joint",
        "Peak joint utilisation",
        "The joint that uses the largest share of its strength.",
    ),
    heavilyLoaded: term(
        "Heavily loaded joint",
        "Highly stressed joint",
        "A joint that uses more than 75% of its strength. It is close to its limit.",
    ),
    overloaded: term(
        "Overloaded joint",
        "Overstressed joint",
        "A joint that uses more than 100% of its strength. It would open or crush.",
    ),
    notCarryingWeight: term(
        "Not carrying weight",
        "No load path",
        "Blocks in a floating part: nothing connects them to the ground, so the strength estimate leaves them out.",
    ),
    blocksUsed: term(
        "Blocks used",
        "Components used",
        "How many 100 mm blocks the model is built from.",
    ),
    blockBudget: term(
        "Block budget",
        "Component budget",
        "The most blocks the model may use. Empty means no limit. The stabilizer stays within it too.",
    ),
    separatePieces: term(
        "Separate pieces",
        "Connected structures",
        "Groups of blocks that touch face to face. Pieces that only touch along an edge or a corner are separate.",
    ),
    floatingPart: term(
        "Floating part",
        "Floating structure",
        "A piece that is not connected to the ground, or to anything resting on it. It would fall.",
    ),
    shareKept: term(
        "Share of the model kept in blocks",
        "Coverage",
        "How much of the model's volume ended up inside blocks. Thin parts that fill too little of a block are left out.",
    ),
    fillThreshold: term(
        "Fill threshold",
        "Voxel fill threshold",
        "How full a 100 mm cell must be with the model to become a block.",
    ),
    longestAllowedOverhang: term(
        "Longest allowed overhang",
        "Cantilever limit",
        "The most blocks an overhang may stick out from its last support (4 in the assignment).",
    ),
    aimBelow: term(
        "Aim for strength used below",
        "Target utilisation",
        "The stabilizer adds supports until no joint uses more than this share of its strength.",
    ),
    tipsOver: term(
        "Tips over",
        "Centre of gravity outside the support base",
        "The model's weight is past the edge of its base, so it falls over.",
    ),
    balancedOnEdge: term(
        "Balanced on the edge",
        "Centre of gravity on the edge of the support base",
        "The model's weight is within 1 mm of the edge of its base. The smallest change would tip it.",
    ),
    roles: term(
        "Added blocks",
        "Block roles",
        "Blocks the stabilizer added, coloured by what each one is for.",
    ),
    directions: term(
        "Right, left, front, back",
        "+X, -X, -Y, +Y",
        "As the Front view shows them: the front is the side that faces you.",
    ),
} as const satisfies Record<string, Term>;

// ---------- the six check rows ----------

/** The row of each check, in plain words (the engine's own labels, "Centre of gravity" and so on, stay in the report). */
export const CHECK_TERMS: Record<CheckKey, Term> = {
    cog: TERMS.balance,
    cantilevered: TERMS.overhangingBlocks,
    "long-cantilevers": TERMS.overhangsTooLong,
    components: TERMS.blocksUsed,
    floating: { ...TERMS.floatingPart, label: "Floating parts" },
    stress: TERMS.strengthUsed,
};

// ---------- what the stage and the lists call things ----------

/** The status of a block, as the stage's legend and tooltip say it. */
export const STATUS_WORDS: Record<BlockStatus, string> = {
    supported: "Supported",
    cantilever: "Overhang",
    overreach: "Overhang too long",
    floating: "Floating",
};

/** The colour modes, as the stage's Colour menu says them ("role" is the stabilizer's added blocks). */
export const COLOR_WORDS: Record<AnalysisColorBy, string> = {
    status: "Status",
    reach: "Overhang",
    stress: "Strength",
    layer: "Layers",
    role: "Added blocks",
};

/** What the stabilizer's blocks are, in the legend and the "what was added" chips. */
export const ROLE_WORDS: Record<BlockRole, string> = {
    original: "Original blocks",
    column: "Columns",
    footing: "Footings",
    bracket: "Brackets",
    bridge: "Bridges",
    reinforcement: "Thicker joints",
    user: "Your edits",
};

/** One of them, as a tooltip or a card says it ("Thicker joint, added in step 3"). The GLB's node names (shared/assembly.ts) keep their own, older words. */
export const ROLE_WORD: Record<BlockRole, string> = {
    original: "Original",
    column: "Column",
    footing: "Footing",
    bracket: "Bracket",
    bridge: "Bridge",
    reinforcement: "Thicker joint",
    user: "Your edit",
};

/** What a joint is going through at a stress point: "being pulled apart". */
export const STRESS_MODE_WORDS: Record<StressMode, string> = {
    tension: "being pulled apart",
    compression: "being crushed",
    shear: "being sheared",
};

/** The technical name of a stress mode, for the tooltip. */
export const STRESS_MODE_TECH: Record<StressMode, string> = {
    tension: "tension across the joint",
    compression: "compression of the block",
    shear: "shear in the joint",
};

// ---------- the glossary (the info page) ----------

/**
 * Every plain term with its technical twin, in the order the info page lists them. `tip` is the explanation. Terms that the
 * default panel text never shows (the technical column only) are still here, so a reader can map the exported report to the screen.
 */
export const GLOSSARY: readonly Term[] = [
    TERMS.balance,
    TERMS.tipsOver,
    TERMS.balancedOnEdge,
    TERMS.overhang,
    TERMS.overhangingBlocks,
    TERMS.longestOverhang,
    TERMS.armTooLong,
    TERMS.reach,
    TERMS.floatingPart,
    TERMS.separatePieces,
    TERMS.strengthUsed,
    TERMS.worstJoint,
    TERMS.heavilyLoaded,
    TERMS.overloaded,
    TERMS.notCarryingWeight,
    TERMS.blocksUsed,
    TERMS.blockBudget,
    TERMS.shareKept,
    TERMS.fillThreshold,
    TERMS.longestAllowedOverhang,
    TERMS.aimBelow,
    TERMS.roles,
    TERMS.directions,
];

/** Words that belong to the exported report and the info page only: the default panel text must not show them. */
export const TECHNICAL_WORDS: readonly string[] = [
    "cantilever",
    "centre of gravity",
    "center of gravity",
    "utilisation",
    "utilization",
    "allowable",
    "COG",
    "kPa",
    "MPa",
    "FEM",
    "voxel",
    "overreach",
    "load path",
    "component",
    "overstressed",
    "highly stressed",
];

/** Words that must stand alone to count ("comparing" contains "mpa"); the rest match as stems ("voxel" finds "voxelised"). */
const STANDALONE: readonly string[] = ["COG", "FEM", "kPa", "MPa"];

/** The technical words found in `text` (case-insensitive, whole words for the units and the acronyms, stems for the rest), for the tests and a dev check. */
export function technicalWordsIn(text: string): string[] {
    const found: string[] = [];
    for (const word of TECHNICAL_WORDS) {
        // A unit sits against its number ("200kPa"): only letters on either side make it part of another word.
        const pattern = STANDALONE.includes(word)
            ? new RegExp(`(?<![A-Za-z])${word}(?![A-Za-z])`, word === "COG" || word === "FEM" ? "" : "i")
            : new RegExp(word.replace(/ /g, "\\s+"), "i");
        if (pattern.test(text)) found.push(word);
    }
    return found;
}
