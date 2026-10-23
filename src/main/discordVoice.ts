/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Native voice engine support.
//
// The official Discord client does not use Chromium's WebRTC for voice, video and Go Live.
// Instead it loads a proprietary N-API module called discord_voice (discord_voice.node) which
// contains Discord's own media engine (capture, encoding, decoding, UDP transport, soundshare...).
// The Discord web app ships with both engines and picks the native one if it is available.
//
// discord_voice is not redistributable, so instead of bundling it we load it from an existing
// installation of the official client. Or Vesktop's own engine, vesktop_media (packages/vesktop_media), an open
// reimplementation of the same API that is built with Vesktop into dist/vesktop_media.
//
// Settings.voiceEngine picks one: "webrtc" (Chromium, the web app's default), "discord" or "vesktop".

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { IpcEvents } from "shared/IpcEvents";

import { DATA_DIR } from "./constants";
import { Settings } from "./settings";
import { handle, handleSync } from "./utils/ipcWrappers";

export type VoiceEngine = "webrtc" | "discord" | "vesktop";

export interface DiscordVoiceInfo {
    engine: "discord" | "vesktop";
    /** directory containing the engine's index.js and its .node */
    modulePath: string;
    /** the N-API module in modulePath: discord_voice.node or vesktop_media.node */
    nodeFile: string;
    /** directory containing discord_krisp, if found */
    krispPath: string | null;
    dataDir: string;
    logDir: string;
}

function compareVersions(a: string, b: string) {
    const pa = a.split(/[.-]/).map(Number);
    const pb = b.split(/[.-]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function safeReaddir(dir: string) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function getDiscordInstallDirs() {
    const home = homedir();
    const names = ["discord", "discordcanary", "discordptb"];

    switch (process.platform) {
        case "linux": {
            const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
            return [
                ...names.map(n => join(config, n)),
                // Flatpak
                ...names.map(n => join(home, ".var/app/com.discordapp.Discord/config", n))
            ];
        }
        case "win32": {
            const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
            return ["Discord", "DiscordCanary", "DiscordPTB"].map(n => join(local, n));
        }
        case "darwin":
            return names.map(n => join(home, "Library", "Application Support", n));
        default:
            return [];
    }
}

/**
 * Finds the newest installed copy of a Discord native module.
 * Linux & Windows: <install>/app-<version>/modules/<name>-<n>/<name>
 * macOS:           <install>/<version>/modules/<name>
 */
function findDiscordModule(name: string): string | null {
    const candidates = [] as { version: string; path: string }[];

    for (const installDir of getDiscordInstallDirs()) {
        for (const entry of safeReaddir(installDir)) {
            const version = entry.replace(/^app-/, "");
            if (!/^\d+\.\d+\.\d+$/.test(version)) continue;

            const modulesDir = join(installDir, entry, "modules");
            for (const mod of safeReaddir(modulesDir)) {
                if (mod !== name && !mod.startsWith(name + "-")) continue;

                for (const path of [join(modulesDir, mod, name), join(modulesDir, mod)]) {
                    if (existsSync(join(path, `${name}.node`)) && existsSync(join(path, "index.js"))) {
                        candidates.push({ version: `${version}.${mod.split("-")[1] ?? 0}`, path });
                        break;
                    }
                }
            }
        }
    }

    candidates.sort((a, b) => compareVersions(b.version, a.version));
    return candidates[0]?.path ?? null;
}

function isValidVoiceModule(path: string, nodeFile: string) {
    try {
        return statSync(join(path, nodeFile)).isFile() && statSync(join(path, "index.js")).isFile();
    } catch {
        return false;
    }
}

/** The official client's discord_voice: looked up once, at start-up */
const discordVoicePath = (() => {
    const custom = Settings.store.nativeVoiceModulePath;
    if (custom && isValidVoiceModule(custom, "discord_voice.node")) return custom;
    return findDiscordModule("discord_voice");
})();

/** vesktop_media, next to the app's code: dist/vesktop_media (outside the asar archive once packaged) */
function getVesktopMediaPath() {
    const path = join(__dirname, "..", "vesktop_media").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    return isValidVoiceModule(path, "vesktop_media.node") ? path : null;
}

export function getDiscordVoiceModulePath() {
    return discordVoicePath;
}

// Before voiceEngine: nativeVoice (+ nativeVoiceOwnEngine for vesktop_media)
if (Settings.store.voiceEngine == null) {
    const { nativeVoice, nativeVoiceOwnEngine } = Settings.store;
    Settings.store.voiceEngine = nativeVoice ? (nativeVoiceOwnEngine ? "vesktop" : "discord") : "webrtc";
}

/** The engine in use: the selected one, or WebRTC if it isn't available */
export function getVoiceEngine(): VoiceEngine {
    const engine = Settings.store.voiceEngine ?? "webrtc";
    if (engine === "discord" && !discordVoicePath) return "webrtc";
    if (engine === "vesktop" && !getVesktopMediaPath()) return "webrtc";
    return engine;
}

export function isNativeVoiceEnabled() {
    return getVoiceEngine() !== "webrtc";
}

let cachedInfo: DiscordVoiceInfo | null | undefined;
function getDiscordVoiceInfo(): DiscordVoiceInfo | null {
    if (cachedInfo !== undefined) return cachedInfo;

    const engine = getVoiceEngine();
    if (engine === "webrtc") return (cachedInfo = null);
    const modulePath = engine === "discord" ? discordVoicePath! : getVesktopMediaPath()!;

    const dataDir = join(DATA_DIR, "module_data");
    const logDir = join(DATA_DIR, "logs");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    return (cachedInfo = {
        engine,
        modulePath,
        nodeFile: engine === "discord" ? "discord_voice.node" : "vesktop_media.node",
        krispPath: findDiscordModule("discord_krisp"),
        dataDir,
        logDir
    });
}

handleSync(IpcEvents.NATIVE_VOICE_GET_INFO, () => getDiscordVoiceInfo());
// For the engine picker: what is available and what runs
handleSync(IpcEvents.NATIVE_VOICE_FIND_MODULE, () => ({
    discord: discordVoicePath,
    vesktop: getVesktopMediaPath(),
    active: getVoiceEngine()
}));

// discord_voice persists a few of its own settings (audio subsystem, debug logging...).
// The official client stores them in its settings.json, we keep them in ours
handleSync(IpcEvents.NATIVE_VOICE_GET_SETTINGS, () => Settings.plain.nativeVoiceAppSettings ?? {});
handle(IpcEvents.NATIVE_VOICE_SET_SETTING, (_, key: string, value: unknown) => {
    Settings.store.nativeVoiceAppSettings = { ...Settings.store.nativeVoiceAppSettings, [key]: value };
});
