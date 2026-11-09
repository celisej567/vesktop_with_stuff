/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Where the time goes while Vesktop starts: the window, Discord's page and its scripts, the gateway, the processing
// of what the server sends and the first rendered UI, in logs/startup_timing.log. Every line has the time since the
// process started. The renderer half is renderer/startupTiming.ts
//
// The log is bounded: a file over MAX_BYTES at start moves to startup_timing.log.1 (replacing the previous one),
// and one process writes at most MAX_BYTES (each reload of the page traces again)

import { app, BrowserWindow } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { IpcEvents } from "shared/IpcEvents";

import { DATA_DIR } from "./constants";
import { handle } from "./utils/ipcWrappers";

const LOG_DIR = join(DATA_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "startup_timing.log");
const MAX_BYTES = 1024 * 1024;
let written = 0;

/** Epoch ms of the process start, the zero of every line */
const ORIGIN = Date.now() - process.uptime() * 1000;

function localTime(ms: number) {
    const d = new Date(ms);
    return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().replace("T", " ").replace("Z", "");
}

/** `at`: epoch ms of the event, when it happened before the line is written */
export function startupMark(source: string, message: string, at = Date.now()) {
    if (written >= MAX_BYTES) return;
    const since = ((at - ORIGIN) / 1000).toFixed(3).padStart(8);
    let line = `[${localTime(at)}] +${since} s [${source}] ${message}\n`;
    written += Buffer.byteLength(line);
    if (written >= MAX_BYTES) line += "==== limit of this run reached, nothing more is written\n";
    try {
        appendFileSync(LOG_FILE, line);
    } catch {}
}

try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
        if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {}
    appendFileSync(LOG_FILE, `\n==== Vesktop ${app.getVersion()} started ${localTime(ORIGIN)}, pid ${process.pid}\n`);
} catch {}
startupMark("main", "main process: modules loaded");
app.whenReady().then(() => startupMark("main", "app ready"));

handle(IpcEvents.STARTUP_TIMING_LOG, (_, at: number, message: string) => {
    if (typeof message === "string")
        startupMark("renderer", message.slice(0, 2000), typeof at === "number" ? at : Date.now());
});

/** The main window's life up to its first load */
export function traceStartupWindow(win: BrowserWindow) {
    startupMark("main", "main window created");
    const wc = win.webContents;
    let navigations = 0;

    win.once("ready-to-show", () => startupMark("main", "window ready to show"));
    win.once("show", () => startupMark("main", "window shown"));
    wc.on("did-start-navigation", details => {
        if (details.isMainFrame && !details.isSameDocument && navigations++ < 5)
            startupMark("main", `navigation to ${details.url.split("?")[0]}`);
    });
    wc.on("did-navigate", (_, url, code) => startupMark("main", `page response ${code} (${url.split("?")[0]})`));
    wc.on("dom-ready", () => startupMark("main", "page DOM ready"));
    wc.on("did-finish-load", () => startupMark("main", "page load finished (window load event)"));
    wc.on("did-fail-load", (_, code, description, url, isMainFrame) => {
        if (isMainFrame) startupMark("main", `page load failed: ${code} ${description} (${url.split("?")[0]})`);
    });
}
