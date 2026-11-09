/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The renderer half of main/startupTiming.ts: Discord's page and resources, the gateway socket, the processing of
// the actions and the first rendered UI, for the first TRACE_MS after the page loads.
// Runs before Discord's scripts. Nothing here touches the DOM before DOMContentLoaded

import { filters, waitFor } from "@vencord/types/webpack";

const TRACE_MS = 90_000;
const startedAt = performance.timeOrigin;
let tracing = true;
setTimeout(() => {
    summary("end of trace");
    tracing = false;
}, TRACE_MS);

// Opening the settings is traced on its own, whenever it happens: SETTINGS_TRACE_MS from the action on
let settingsUntil = 0;
const SETTINGS_TRACE_MS = 8000;
const active = () => tracing || Date.now() < settingsUntil;
const isSettingsOpen = (type: string) => /SETTINGS_MODAL_OPEN$|^LAYER_PUSH$/.test(type);

/** `at`: epoch ms of the event */
function mark(message: string, at = Date.now()) {
    if (!active()) return;
    try {
        VesktopNative.startupTiming.log(at, message);
    } catch {}
}

const ms = (v: number) => `${Math.round(v)} ms`;
const kb = (v: number) => (v >= 1048576 ? `${(v / 1048576).toFixed(2)} MB` : `${(v / 1024).toFixed(1)} KB`);

mark(`Vesktop renderer script runs (${ms(performance.now())} after navigation start)`);

// ------------------------------------------------------------------------------------------- page and resources

interface Totals {
    count: number;
    cached: number;
    bytes: number;
    time: number;
}
const resources: Record<string, Totals> = {};
let longTasks = 0,
    longTaskTime = 0;

function category(url: URL, initiator: string) {
    if (url.hostname.endsWith("discord.com") && url.pathname.startsWith("/api/")) return "api";
    if (/\.js$/.test(url.pathname)) return "script";
    if (/\.css$/.test(url.pathname)) return "css";
    if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(url.pathname) || initiator === "img") return "image";
    if (/\.(woff2?|ttf|otf)$/.test(url.pathname)) return "font";
    return "other";
}

function onResource(e: PerformanceResourceTiming) {
    let url: URL;
    try {
        url = new URL(e.name);
    } catch {
        return;
    }
    const kind = category(url, e.initiatorType);
    // a response from the HTTP cache has no transfer; a cross-origin one without Timing-Allow-Origin reports no sizes
    const cached = e.transferSize === 0 && e.decodedBodySize > 0;
    const t = (resources[kind] ??= { count: 0, cached: 0, bytes: 0, time: 0 });
    t.count++;
    if (cached) t.cached++;
    t.bytes += e.transferSize;
    t.time += e.duration;

    const at = startedAt + e.responseEnd;
    const where = cached
        ? "from cache"
        : e.transferSize > 0
          ? `${kb(e.transferSize)} over the network`
          : "size unknown (cross-origin)";
    const size = e.decodedBodySize > 0 ? `, ${kb(e.decodedBodySize)} decoded` : "";
    if (kind === "script" || kind === "css")
        mark(`${kind} ${url.pathname.split("/").pop()}: ${ms(e.duration)}, ${where}${size}`, at);
    else if (kind === "api")
        mark(
            `api ${url.pathname.replace(/\/api\/v\d+/, "")}: ${ms(e.duration)} (${ms(e.responseStart - e.requestStart)} until the first byte)`,
            at
        );
}

function summary(reason: string) {
    const parts = Object.entries(resources).map(
        ([kind, t]) => `${kind} ${t.count} (${t.cached} from cache, ${kb(t.bytes)} transferred)`
    );
    mark(
        `summary at ${reason}: ${parts.join(", ")}; long tasks ${longTasks} (${ms(longTaskTime)} of blocked main thread)`
    );
    if (dispatchTime.size) {
        const top = [...dispatchTime.entries()]
            .sort((a, b) => b[1].time - a[1].time)
            .slice(0, 12)
            .map(([type, d]) => `${type} ${d.count}x ${ms(d.time)}`);
        mark(`action processing so far, the slowest types: ${top.join(", ")}`);
    }
}

try {
    new PerformanceObserver(list => {
        for (const e of list.getEntries() as PerformanceNavigationTiming[]) {
            const cached = e.transferSize === 0 && e.decodedBodySize > 0;
            mark(
                `page document: request ${ms(e.requestStart)}, first byte ${ms(e.responseStart)}, received ${ms(e.responseEnd)} after navigation start, ${cached ? "from cache" : kb(e.transferSize)}`,
                startedAt + e.responseEnd
            );
            if (e.domContentLoadedEventStart > 0)
                mark("page DOMContentLoaded", startedAt + e.domContentLoadedEventStart);
        }
    }).observe({ type: "navigation", buffered: true });
    new PerformanceObserver(list => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) onResource(e);
    }).observe({ type: "resource", buffered: true });
    new PerformanceObserver(list => {
        for (const e of list.getEntries()) mark(`paint: ${e.name}`, startedAt + e.startTime);
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
            longTasks++;
            longTaskTime += e.duration;
            if (e.duration >= (tracing ? 200 : 50))
                mark(`long task: main thread blocked ${ms(e.duration)}`, startedAt + e.startTime);
        }
    }).observe({ type: "longtask", buffered: true });
} catch (e) {
    mark(`PerformanceObserver failed: ${e}`);
}

// ----------------------------------------------------------------------------------------------- gateway socket

let gatewayMessages = 0,
    gatewayBytes = 0;

const NativeWebSocket = window.WebSocket;
class TracedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const u = new URL(String(url));
        if (!u.hostname.includes("gateway")) return;

        const created = Date.now();
        mark(`gateway socket created: ${u.host}${u.pathname}${u.search}`);
        this.addEventListener("open", () => mark(`gateway socket open (${ms(Date.now() - created)} after creation)`));
        this.addEventListener("message", (e: MessageEvent) => {
            gatewayMessages++;
            const size = typeof e.data === "string" ? e.data.length : (e.data?.byteLength ?? e.data?.size ?? 0);
            gatewayBytes += size;
            if (gatewayMessages <= 3)
                mark(`gateway message ${gatewayMessages}: ${kb(size)} (${ms(Date.now() - created)} after creation)`);
        });
        this.addEventListener("close", (e: CloseEvent) =>
            mark(
                `gateway socket closed: code ${e.code}${e.reason ? ` ${e.reason}` : ""}, ${gatewayMessages} messages, ${kb(gatewayBytes)} received`
            )
        );
    }
}
window.WebSocket = TracedWebSocket;

// ---------------------------------------------------------------------------------------------- Flux actions

const dispatchTime = new Map<string, { count: number; time: number }>();
const seenTypes = new Set<string>();
const loggedChannels = new Set<string>();

function describe(action: any) {
    switch (action.type) {
        case "CONNECTION_OPEN":
            return `${action.guilds?.length ?? "?"} guilds, ${action.privateChannels?.length ?? "?"} private channels, ${action.relationships?.length ?? "?"} relationships, ${action.readState?.entries?.length ?? "?"} read states; gateway so far ${gatewayMessages} messages, ${kb(gatewayBytes)}`;
        case "LOAD_MESSAGES_SUCCESS":
            return `${action.messages?.length ?? "?"} messages`;
        case "GUILD_CREATE":
            return `guild ${action.guild?.id}`;
        default:
            return "";
    }
}

function traceAction(action: any, time: number) {
    const type = String(action?.type);
    const d = dispatchTime.get(type) ?? { count: 0, time: 0 };
    d.count++;
    d.time += time;
    dispatchTime.set(type, d);

    const first = !seenTypes.has(type);
    seenTypes.add(type);
    if (isSettingsOpen(type)) traceSettingsOpen(type);
    const inSettings = !tracing && Date.now() < settingsUntil;
    const interesting =
        type.startsWith("CONNECTION_") ||
        type === "POST_CONNECTION_OPEN" ||
        type === "LOGIN_SUCCESS" ||
        type === "CHANNEL_SELECT" ||
        (type === "LOAD_MESSAGES_SUCCESS" && !loggedChannels.has(action.channelId));
    if (type === "LOAD_MESSAGES_SUCCESS") loggedChannels.add(action.channelId);

    if (interesting || inSettings || (first && seenTypes.size <= 250)) {
        const info = describe(action);
        mark(
            `action ${type}${first && !interesting ? " (first)" : ""}: processed in ${ms(time)}${info ? `, ${info}` : ""}`
        );
    }
    if (type === "CONNECTION_OPEN") {
        summary("CONNECTION_OPEN");
        setTimeout(() => summary("CONNECTION_OPEN + 10 s"), 10_000);
    }
}

waitFor(filters.byProps("dispatch", "subscribe"), (dispatcher: any) => {
    mark("Flux dispatcher loaded");
    // _dispatch runs the handlers synchronously; dispatch may only queue
    const key = typeof dispatcher._dispatch === "function" ? "_dispatch" : "dispatch";
    const original = dispatcher[key];
    dispatcher[key] = function (this: any, action: any, ...rest: any[]) {
        if (!tracing && Date.now() >= settingsUntil && !isSettingsOpen(String(action?.type)))
            return original.call(this, action, ...rest);
        const t0 = performance.now();
        try {
            return original.call(this, action, ...rest);
        } finally {
            try {
                traceAction(action, performance.now() - t0);
            } catch {}
        }
    };
});

// ------------------------------------------------------------------------------------------------ rendered UI

const SETTINGS_VIEWS = [
    '[class*="standardSidebarView"]',
    '[class*="sidebarRegion"]',
    '[aria-label="User Settings"]',
    '[class*="contentRegion"]'
];

function traceSettingsOpen(type: string) {
    const opened = Date.now();
    settingsUntil = opened + SETTINGS_TRACE_MS;
    mark(`settings: ${type}`);

    let found = false;
    let scheduled = false;
    const check = () => {
        scheduled = false;
        const selector = SETTINGS_VIEWS.find(s => document.querySelector(s));
        if (!selector) return;
        found = true;
        observer.disconnect();
        mark(`settings: rendered (${selector}), ${ms(Date.now() - opened)} after opening`);
    };
    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(check);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
        observer.disconnect();
        if (found) return;
        // so the selectors can be fixed: what the topmost layer looks like
        const layers = document.querySelectorAll('[class*="layer_"]');
        const top = layers[layers.length - 1]?.firstElementChild;
        mark(
            `settings: no known view after ${SETTINGS_TRACE_MS} ms; ${layers.length} layers, top: ${top?.className ?? "none"}`
        );
    }, SETTINGS_TRACE_MS - 100);
}

window.addEventListener("error", e => mark(`error: ${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", e =>
    mark(`unhandled rejection: ${String(e.reason?.message ?? e.reason).slice(0, 300)}`)
);

window.addEventListener("DOMContentLoaded", () => {
    const milestones: Array<[string, string]> = [
        ['[data-list-id="guildsnav"]', "server list rendered"],
        ['[data-list-id="guildsnav"] img', "first server icon in the list"],
        ["#channels", "channel list rendered"],
        ['[data-list-id="chat-messages"] [id^="chat-messages-"]', "messages rendered"]
    ];
    const pending = new Map(milestones);
    let scheduled = false;

    const check = () => {
        scheduled = false;
        for (const [selector, label] of pending) {
            if (!document.querySelector(selector)) continue;
            pending.delete(selector);
            const servers = document.querySelectorAll('[data-list-item-id^="guildsnav___"]').length;
            mark(`UI: ${label}${selector.includes("guildsnav") ? ` (${servers} items)` : ""}`);
        }
        if (!pending.size) observer.disconnect();
    };
    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(check);
    });
    observer.observe(document, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), TRACE_MS);
});
