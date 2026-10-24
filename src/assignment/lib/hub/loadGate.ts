/**
 * The ordering rules for the hub's reads, with no React in them so they can be tested.
 *
 * Three kinds of read race each other and the user's own writes:
 *   - "initial"    the first paint (and "Try again"): shows a spinner, nobody has edited anything yet;
 *   - "sync"       the list is told the truth again after a write came back short or failed;
 *   - "background" a refresh nobody asked for (the window regained focus).
 *
 * The rules:
 *   - Only the newest initial/sync read may land. A background read never takes that number
 *     (it used to, so a focus refresh threw away a slow initial read or a resync that was
 *     already on its way, and when the refresh then failed the page stayed on its skeleton).
 *   - A background read does not start at all while an initial/sync read is under way: that
 *     read is about to bring the same news.
 *   - A background read that overlaps a write, or one that began before the user's latest edit,
 *     is thrown away: its answer may predate the edit.
 *   - A sync read gets the same protection but must not simply be thrown away (it exists
 *     because the screen is wrong): when a write overlapped it, it is read AGAIN once writes
 *     have settled, so it cannot land on top of a newer optimistic edit and revert it.
 */

export type LoadMode = "initial" | "sync" | "background";

export interface LoadTicket {
    mode: LoadMode;
    /** The initial/sync counter when this read began. */
    seq: number;
    /** The background counter when this read began (background reads only). */
    bg: number;
    /** The write epoch when this read began. */
    epoch: number;
}

/**
 *  "land"   apply the answer;
 *  "drop"   it is stale: ignore it;
 *  "wait"   a write is in flight: ignore it, `writeEnded()` will say when to read again;
 *  "again"  a write came and went while it travelled: read again now.
 */
export type Verdict = "land" | "drop" | "wait" | "again";

export function createLoadGate() {
    let mainSeq = 0;
    let mainInFlight = 0;
    let backgroundSeq = 0;
    let epoch = 0;
    let writesInFlight = 0;
    let readWhenQuiet = false;

    /** A newer read of the same kind has begun since this one did. */
    const superseded = (ticket: LoadTicket) =>
        ticket.seq !== mainSeq || (ticket.mode === "background" && ticket.bg !== backgroundSeq);

    return {
        /** Null when a background read must not start. Every non-null ticket must be `end`ed. */
        begin(mode: LoadMode): LoadTicket | null {
            if (mode === "background") {
                if (mainInFlight > 0) return null;
                return { mode, seq: mainSeq, bg: ++backgroundSeq, epoch };
            }
            mainInFlight += 1;
            return { mode, seq: ++mainSeq, bg: backgroundSeq, epoch };
        },

        end(ticket: LoadTicket): void {
            if (ticket.mode !== "background") mainInFlight -= 1;
        },

        /** Pure: a failed read asks this, so it can tell "nobody wants my answer" from "I am it". */
        superseded,

        judge(ticket: LoadTicket): Verdict {
            if (superseded(ticket)) return "drop";
            // Nobody can have edited a list that is still a skeleton.
            if (ticket.mode === "initial") return "land";
            if (writesInFlight > 0) {
                if (ticket.mode === "sync") {
                    readWhenQuiet = true;
                    return "wait";
                }
                return "drop";
            }
            if (ticket.epoch !== epoch) return ticket.mode === "sync" ? "again" : "drop";
            return "land";
        },

        writeBegan(): void {
            writesInFlight += 1;
            epoch += 1;
        },

        /** True when the last write has settled and a sync read was waiting for that. */
        writeEnded(): boolean {
            writesInFlight -= 1;
            epoch += 1;
            if (writesInFlight > 0 || !readWhenQuiet) return false;
            readWhenQuiet = false;
            return true;
        },
    };
}

export type LoadGate = ReturnType<typeof createLoadGate>;
