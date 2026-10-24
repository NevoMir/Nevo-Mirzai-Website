// The example catalogue: what each ready-made project is, how its model is made and what it must show.
//
// `expect` is asserted by make-examples.mjs against the app's own analysis at the default settings (concrete blocks, 100 mm
// blocks, 10 % fill, cantilever limit 4): `errors` / `warnings` are the sets of issue kinds the original must raise,
// `peak` the range its highest joint stress must fall in (share of the allowable). `control: true` marks an example that
// must pass cleanly: nothing for the stabilizer to do.
//
// The numbers a visitor sees (blocks, margins, stress, sizes) are NOT written here: make-examples.mjs measures them and puts
// them in manifest.json. `problem` says in words what goes wrong; the sentence about the fix is added from the stabilizer's log.

/** Every timestamp in the shipped files, so a rebuild is byte for byte the same (--check). */
export const EXAMPLES_STAMP = "2026-10-24T09:00:00.000Z";

export const CATALOGUE = [
    {
        slug: "cantilever-house",
        module: "./models/cantilever-house.mjs",
        title: "Cantilever house",
        prompt: "A modern two-storey house with a long cantilevered upper floor and a glass terrace",
        problem: "The charcoal upper floor juts far past the small ground floor, so its weight pulls the house over.",
        tags: ["building", "cantilever", "tipping"],
        view: { yaw: 35, pitch: 18 },
        expect: { errors: ["cantilever-too-long", "cog-outside"], warnings: [] },
    },
    {
        slug: "long-neck-dino",
        module: "./models/long-neck-dino.mjs",
        title: "Long-neck dinosaur",
        prompt: "A chunky cartoon brachiosaurus with a very long neck, standing on four sturdy legs",
        problem: "The neck reaches far past the front legs, longer than the cantilever limit.",
        tags: ["animal", "cantilever", "stress"],
        view: { yaw: 24, pitch: 12 },
        expect: { errors: ["cantilever-too-long"], warnings: ["highly-stressed"] },
    },
    {
        slug: "harbour-crane",
        module: "./models/harbour-crane.mjs",
        title: "Harbour jib crane",
        prompt: "A yellow harbour jib crane with a cab, a long boom and a container hanging from the hook",
        problem: "A long jib, almost no counterweight and a container on a cable too thin to show on the block grid.",
        tags: ["machine", "cantilever", "floating", "tipping"],
        view: { yaw: 30, pitch: 12 },
        expect: { errors: ["cantilever-too-long", "cog-outside", "floating", "overstressed"], warnings: [] },
    },
    {
        slug: "desk-lamp",
        fixture: "public/assignment_alex/fixtures/demo-assembly.glb",
        title: "Articulated desk lamp",
        prompt: "An articulated desk lamp with a round base, two arms and a conical shade",
        problem: "Nine separate parts: the arms and joints are slimmer than one block, so most of the lamp hangs in the air above its base.",
        tags: ["furniture", "floating", "thin parts"],
        view: { yaw: 28, pitch: 12 },
        expect: { errors: ["floating"], warnings: [] },
    },
    {
        slug: "leaning-tower",
        module: "./models/leaning-tower.mjs",
        title: "Leaning watchtower",
        prompt: "A crooked medieval stone watchtower with a heavy timber belfry and a conical roof",
        problem: "No part reaches too far, but the lean carries the centre of gravity out of the footprint, so it would topple.",
        tags: ["building", "tipping", "stress", "stone"],
        view: { yaw: 20, pitch: 10 },
        expect: { errors: ["cog-outside", "overstressed"], warnings: [] },
    },
    {
        slug: "oak-tree",
        module: "./models/oak-tree.mjs",
        title: "Oak with a long limb",
        prompt: "An old gnarled oak tree with a wide crown and one very long horizontal limb",
        problem: "The whole crown stands on a thin trunk and one limb reaches far out, so the tree is top-heavy and lopsided.",
        tags: ["nature", "cantilever", "tipping", "stress"],
        view: { yaw: 25, pitch: 12 },
        expect: { errors: ["cantilever-too-long", "cog-outside", "overstressed"], warnings: [] },
    },
    {
        slug: "mushroom-pavilion",
        module: "./models/mushroom-pavilion.mjs",
        title: "Mushroom pavilion",
        prompt: "A red toadstool garden pavilion with white spots on a slim cream stem",
        problem: "A broad cap on a slim stem keeps within the reach rule, yet the joints under the cap are close to the most stress they can carry.",
        tags: ["nature", "stress", "borderline"],
        view: { yaw: 30, pitch: 14 },
        expect: { errors: [], warnings: ["highly-stressed"] },
    },
    {
        slug: "pencil-leg-chair",
        module: "./models/pencil-leg-chair.mjs",
        title: "Pencil-leg chair",
        prompt: "A mid-century dining chair with slim splayed legs and a curved slatted back",
        problem: "The legs are slimmer than one block, so none reaches the ground on the block grid: the whole chair floats.",
        tags: ["furniture", "floating", "thin parts"],
        view: { yaw: 38, pitch: 14 },
        expect: { errors: ["floating"], warnings: [] },
    },
    {
        slug: "arch-footbridge",
        module: "./models/arch-footbridge.mjs",
        title: "Stone arch bridge",
        prompt: "A small old stone arch footbridge over a stream, with low parapet walls and a humped deck",
        problem: "An arch carries the deck, so every block rests on a column or on the arch itself.",
        tags: ["building", "arch", "passes"],
        view: { yaw: 40, pitch: 14 },
        control: true,
    },
    {
        slug: "step-pyramid",
        module: "./models/step-pyramid.mjs",
        title: "Stepped pyramid",
        prompt: "A stepped pyramid with a central staircase and a small temple at the summit",
        problem: "A broad base under every tier: about as stable as a structure gets.",
        tags: ["building", "stable", "passes"],
        view: { yaw: 35, pitch: 20 },
        control: true,
    },
];
