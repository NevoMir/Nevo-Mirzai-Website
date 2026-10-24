// A just-enough hook runtime, standing in for "react" in test-viewer.mjs so a hook such as useAnalysisView can be
// run in Node without a DOM or a renderer. It keeps state, refs and memoised callbacks per slot, runs effects after
// each render when their dependencies changed (cleanups first, as React does), re-renders until state settles and
// runs the cleanups on unmount. It is not React: no batching, no strict mode, no context.

let current = null;

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function slot(kind) {
    const s = current;
    if (!s) throw new Error("a hook was called outside renderHook");
    const i = s.index++;
    if (!s.slots[i]) s.slots[i] = { kind };
    if (s.slots[i].kind !== kind) throw new Error("hooks were called in a different order");
    return s.slots[i];
}

export function useRef(initial) {
    const s = slot("ref");
    if (!("current" in s)) s.current = initial;
    return s;
}

export function useState(initial) {
    const s = slot("state");
    const owner = current;
    if (!("value" in s)) {
        s.value = typeof initial === "function" ? initial() : initial;
        s.set = (next) => {
            const value = typeof next === "function" ? next(s.value) : next;
            if (Object.is(value, s.value)) return;
            s.value = value;
            owner.schedule();
        };
    }
    return [s.value, s.set];
}

export function useCallback(fn, deps) {
    const s = slot("callback");
    if (!s.fn || !same(s.deps, deps)) {
        s.fn = fn;
        s.deps = deps;
    }
    return s.fn;
}

export function useEffect(fn, deps) {
    const s = slot("effect");
    if (!s.ran || deps === undefined || !same(s.deps, deps)) {
        s.next = fn;
        s.deps = deps;
        s.ran = true;
    }
}

export const useLayoutEffect = useEffect;

/**
 * renderHook(hook, props): the hook is called as hook(props). Returns { result, rerender(props), unmount() };
 * `result` is what the latest render returned. State set from outside a render (a promise settling) re-renders
 * at once.
 */
export function renderHook(hook, props) {
    const s = { slots: [], index: 0, props, result: undefined, rendering: false, again: false, unmounted: false, renders: 0 };
    const effects = () => s.slots.filter((x) => x.kind === "effect");
    const flush = () => {
        const due = effects().filter((x) => x.next);
        for (const x of due) {
            if (typeof x.cleanup === "function") x.cleanup();
            x.cleanup = undefined;
        }
        for (const x of due) {
            const fn = x.next;
            x.next = undefined;
            x.cleanup = fn();
        }
    };
    const render = () => {
        if (s.rendering) {
            s.again = true;
            return;
        }
        s.rendering = true;
        try {
            let guard = 0;
            do {
                s.again = false;
                current = s;
                s.index = 0;
                try {
                    s.result = hook(s.props);
                } finally {
                    current = null;
                }
                s.renders += 1;
                flush();
                if (++guard > 100) throw new Error("the hook never settled");
            } while (s.again && !s.unmounted);
        } finally {
            s.rendering = false;
        }
    };
    s.schedule = () => {
        if (!s.unmounted) render();
    };
    render();
    return {
        get result() {
            return s.result;
        },
        get renders() {
            return s.renders;
        },
        rerender(next) {
            s.props = next;
            render();
        },
        unmount() {
            s.unmounted = true;
            for (const x of effects()) if (typeof x.cleanup === "function") x.cleanup();
        },
    };
}

// What react exports that the code under test may import by name.
export default { useRef, useState, useCallback, useEffect, useLayoutEffect };
