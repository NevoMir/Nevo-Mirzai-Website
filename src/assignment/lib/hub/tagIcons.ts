import {
    Anchor,
    Antenna,
    Anvil,
    Apple,
    Armchair,
    Atom,
    Award,
    Axe,
    Baby,
    Backpack,
    Bath,
    Battery,
    Bed,
    Bike,
    Bird,
    Blocks,
    Bolt,
    Bone,
    Bookmark,
    BookOpen,
    Bot,
    Box,
    Boxes,
    BrickWall,
    Briefcase,
    Brush,
    Building2,
    Bus,
    Cable,
    Cake,
    Camera,
    Car,
    CarFront,
    Castle,
    Cat,
    Cherry,
    Church,
    Circle,
    CircuitBoard,
    Clock,
    Cloud,
    Code,
    Coffee,
    Cog,
    Compass,
    Component,
    Cone,
    Construction,
    Container,
    Cookie,
    Cpu,
    Crown,
    Cuboid,
    Cylinder,
    Diamond,
    Dices,
    Dog,
    Drill,
    Droplets,
    Drum,
    Eye,
    Factory,
    Fan,
    Fence,
    Film,
    Fish,
    Flag,
    Flame,
    FlaskConical,
    Flower2,
    Folder,
    Forklift,
    Gamepad2,
    Gauge,
    Gem,
    Ghost,
    Gift,
    Glasses,
    GraduationCap,
    Group,
    Guitar,
    Hammer,
    HardHat,
    Headphones,
    Heart,
    Hexagon,
    Hourglass,
    House,
    Joystick,
    Key,
    Keyboard,
    Lamp,
    LampDesk,
    Landmark,
    Laptop,
    Layers,
    Layers3,
    Leaf,
    Lightbulb,
    Lock,
    Magnet,
    Mic,
    Microchip,
    Microscope,
    Monitor,
    Moon,
    Mountain,
    Move3d,
    Music,
    Nut,
    Octagon,
    Orbit,
    Origami,
    Package,
    PackageOpen,
    Paintbrush,
    Palette,
    Pencil,
    Pentagon,
    PenTool,
    Piano,
    Pickaxe,
    Pizza,
    Plane,
    Plug,
    Printer,
    Puzzle,
    Pyramid,
    Rabbit,
    Radio,
    Refrigerator,
    Rocket,
    Rotate3d,
    Ruler,
    Sailboat,
    Satellite,
    Scan,
    Scissors,
    Shapes,
    Shield,
    Ship,
    Shirt,
    Shovel,
    Skull,
    Smartphone,
    Smile,
    Snowflake,
    Sofa,
    Sparkles,
    Speaker,
    Spline,
    Sprout,
    Square,
    Squirrel,
    Star,
    Sun,
    Sword,
    Swords,
    Table,
    Tag,
    Target,
    Telescope,
    Tent,
    Terminal,
    Torus,
    ToyBrick,
    Tractor,
    Train,
    TreePine,
    Triangle,
    Trophy,
    Truck,
    Turtle,
    Tv,
    Umbrella,
    Utensils,
    Warehouse,
    WashingMachine,
    Watch,
    Waves,
    Weight,
    Wifi,
    Wind,
    Wrench,
    Zap,
    type LucideIcon,
} from "lucide-react";

/**
 * The tag look, as data.
 *
 * `HubTag.icon` stores one of these NAMES (or null for a plain colour dot) and
 * `HubTag.color` an `#rrggbb`; the Worker accepts any alphanumeric name and any
 * hex colour, so the allow-list lives here, where it is a rendering concern: a
 * name this map does not know renders the plain Folder glyph, which is a fine
 * outcome for a row written by an older or newer bundle.
 *
 * GROUPED, and aimed at what this app makes: 3D shapes, mechanical parts, vehicles,
 * furniture, characters and props, because the picker is where someone says what
 * a project is about. The flat map is derived from the groups so the two cannot
 * drift. Every name was checked against the installed lucide-react (0.511).
 */
export interface TagIconGroup {
    group: string;
    icons: Record<string, LucideIcon>;
}

export const TAG_ICON_GROUPS: TagIconGroup[] = [
    {
        group: "3D shapes",
        icons: {
            Box, Boxes, Cuboid, Cylinder, Cone, Pyramid, Torus, Hexagon, Octagon, Pentagon, Triangle,
            Circle, Square, Diamond, Shapes, Layers, Layers3, Component, Group, Blocks, Origami, Spline,
            Move3d, Rotate3d, Scan,
        },
    },
    {
        group: "Parts & mechanics",
        icons: {
            Cog, Wrench, Hammer, Drill, Nut, Bolt, Anvil, Pickaxe, Shovel, Magnet, Gauge, Fan, Ruler,
            Compass, Scissors, Weight, Package, PackageOpen, Puzzle, Construction, HardHat, Forklift,
            Container, Factory, Warehouse,
        },
    },
    {
        group: "Vehicles & machines",
        icons: {
            Rocket, Plane, Car, CarFront, Truck, Tractor, Bike, Ship, Sailboat, Anchor, Train, Bus, Orbit,
            Satellite, Bot, Joystick, Gamepad2, Printer,
        },
    },
    {
        group: "Home & architecture",
        icons: {
            Sofa, Armchair, Lamp, LampDesk, Bed, Table, Bath, Tv, Refrigerator, WashingMachine, Lightbulb,
            House, Building2, Castle, Church, Landmark, Tent, Fence, BrickWall,
        },
    },
    {
        group: "Characters & creatures",
        icons: {
            Cat, Dog, Bird, Fish, Rabbit, Turtle, Squirrel, Bone, Skull, Ghost, Baby, Smile, Crown, Gem,
            Sword, Swords, Shield, Axe,
        },
    },
    {
        group: "Props & fashion",
        icons: {
            Glasses, Shirt, Watch, Backpack, Briefcase, Gift, Key, Lock, Umbrella, Dices, ToyBrick, Guitar,
            Piano, Drum, Headphones, Palette, Brush, Paintbrush, Pencil, PenTool, Trophy, Coffee, Cookie,
            Cake, Pizza, Apple, Cherry, Utensils, Music, Film, Camera,
        },
    },
    {
        group: "Nature",
        icons: {
            Leaf, Sprout, TreePine, Flower2, Mountain, Waves, Sun, Moon, Snowflake, Cloud, Flame, Droplets,
            Wind, Sparkles,
        },
    },
    {
        group: "Electronics",
        icons: {
            CircuitBoard, Cpu, Microchip, Battery, Zap, Plug, Cable, Wifi, Radio, Antenna, Smartphone,
            Laptop, Monitor, Keyboard, Mic, Speaker, Terminal, Code,
        },
    },
    {
        group: "Ideas & marks",
        icons: {
            Folder, Tag, Star, Heart, Flag, Bookmark, Target, BookOpen, GraduationCap, Award, Eye, Atom,
            FlaskConical, Microscope, Telescope, Hourglass, Clock,
        },
    },
];

/** Every icon a tag may be given, name -> component, flattened from the groups. */
export const TAG_ICONS: Record<string, LucideIcon> = Object.fromEntries(
    TAG_ICON_GROUPS.flatMap((g) => Object.entries(g.icons)),
);

/** Every icon name, in the order the picker shows them. */
export const TAG_ICON_NAMES = Object.keys(TAG_ICONS);

export const DEFAULT_TAG_ICON = "Folder";

/** Is this one of the catalogue's names? An OWN-property check, not `name in TAG_ICONS`: the
 *  server accepts any alphanumeric icon string and the API has no login, so a tag may arrive
 *  named "constructor" or "valueOf", which a plain lookup would answer with Object.prototype's
 *  member and React would throw on. */
export function isTagIconName(name: string | null | undefined): name is string {
    return typeof name === "string" && Object.prototype.hasOwnProperty.call(TAG_ICONS, name);
}

/** Never throws and never renders nothing: an unknown name is a plain folder. */
export function tagIcon(name: string | null | undefined): LucideIcon {
    // Not Object.hasOwn: tsconfig.app.json targets the ES2020 lib.
    return isTagIconName(name) ? TAG_ICONS[name] : Folder;
}

/**
 * The twelve swatches. A custom colour is allowed too, hence the validator rather
 * than an enum.
 */
export const TAG_COLORS = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#eab308",
    "#22c55e",
    "#10b981",
    "#06b6d4",
    "#3b82f6",
    "#6366f1",
    "#a855f7",
    "#ec4899",
    "#64748b",
] as const;

export const DEFAULT_TAG_COLOR = TAG_COLORS[7];

/** What a swatch is called, for a screen reader: a bare "#ef4444" says nothing. */
const TAG_COLOR_NAMES: Record<(typeof TAG_COLORS)[number], string> = {
    "#ef4444": "Red",
    "#f97316": "Orange",
    "#f59e0b": "Amber",
    "#eab308": "Yellow",
    "#22c55e": "Green",
    "#10b981": "Emerald",
    "#06b6d4": "Cyan",
    "#3b82f6": "Blue",
    "#6366f1": "Indigo",
    "#a855f7": "Purple",
    "#ec4899": "Pink",
    "#64748b": "Slate",
};

/** A palette colour's name; any other (custom) colour answers with its hex. */
export function tagColorName(color: string): string {
    const key = color.toLowerCase();
    return Object.prototype.hasOwnProperty.call(TAG_COLOR_NAMES, key)
        ? TAG_COLOR_NAMES[key as keyof typeof TAG_COLOR_NAMES]
        : color;
}

/** The first palette colour none of `used` wears; past a full palette, the one that
 *  comes next in order so a long list still alternates. */
export function nextTagColor(used: readonly string[]): string {
    const taken = new Set(used.map((c) => c.toLowerCase()));
    const free = TAG_COLORS.find((c) => !taken.has(c));
    return free ?? TAG_COLORS[used.length % TAG_COLORS.length];
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** The same shape the Worker checks, so a bad value never leaves here. */
export function isTagColor(value: string | null | undefined): value is string {
    return typeof value === "string" && HEX_RE.test(value);
}

export function tagColor(value: string | null | undefined): string {
    return isTagColor(value) ? value : DEFAULT_TAG_COLOR;
}

/**
 * The colour a chip's NAME is drawn in: the tag colour with 65% of the page's foreground
 * mixed in. The raw colour over its own 13% tint fails WCAG AA's 4.5:1 for small text for
 * every swatch in light mode (yellow is 1.8:1); at this mix the worst swatch on the worst
 * surface, in either theme, is 5.4:1. The icon or dot beside the name keeps the pure colour,
 * so a tag still reads as itself. Where `color-mix` is unsupported the declaration is
 * dropped and the text inherits the foreground, which is also fine.
 */
export function tagTextColor(color: string): string {
    return `color-mix(in srgb, ${color} 35%, hsl(var(--foreground)))`;
}
