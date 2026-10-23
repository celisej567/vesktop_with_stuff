/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { LinkData, Node, PatchBay as PatchBayType } from "@vencord/venmic";
import { execFile } from "child_process";
import { app, ipcMain } from "electron";
import { readFileSync } from "fs";
import { join } from "path";
import { IpcEvents } from "shared/IpcEvents";
import { STATIC_DIR } from "shared/paths";

import { isNativeVoiceEnabled } from "./discordVoice";
import { Settings } from "./settings";

let PatchBay: typeof PatchBayType | undefined;
let patchBayInstance: PatchBayType | undefined;

let imported = false;
let initialized = false;

let hasPipewirePulse = false;
let isGlibCxxOutdated = false;

function importVenmic() {
    if (imported) {
        return;
    }

    imported = true;

    try {
        PatchBay = (require(join(STATIC_DIR, `dist/venmic-${process.arch}.node`)) as typeof import("@vencord/venmic"))
            .PatchBay;

        hasPipewirePulse = PatchBay.hasPipeWire();
    } catch (e: any) {
        console.error("Failed to import venmic", e);
        isGlibCxxOutdated = (e?.stack || e?.message || "").toLowerCase().includes("glibc");
    }
}

function obtainVenmic() {
    // With the native voice engine, discord_voice captures stream audio itself and Discord never uses WebRTC
    // screen share. venmic's PipeWire thread in the main process crashed Vesktop (SIGSEGV in its event loop)
    if (isNativeVoiceEnabled()) {
        console.warn("[venmic] not used with the native voice engine, requested by:", new Error().stack);
        return undefined;
    }

    if (!imported) {
        importVenmic();
    }

    if (PatchBay && !initialized) {
        initialized = true;

        try {
            patchBayInstance = new PatchBay();
        } catch (e: any) {
            console.error("Failed to instantiate venmic", e);
        }
    }

    return patchBayInstance;
}

function getRendererAudioServicePid() {
    return (
        app
            .getAppMetrics()
            .find(proc => proc.name === "Audio Service")
            ?.pid?.toString() ?? "owo"
    );
}

function buildLinkData({ include, exclude }: { include?: Node[]; exclude?: Node[] }) {
    const pid = getRendererAudioServicePid();

    const { mute, ignoreDevices, ignoreInputMedia, ignoreVirtual, workaround, onlySpeakers, onlyDefaultSpeakers } =
        Settings.store.audio ?? {};

    const data: LinkData = {
        mute: mute ?? true,
        include: include ?? [],
        exclude: exclude ?? [],
        only_speakers: onlySpeakers,
        ignore_devices: ignoreDevices,
        only_default_speakers: onlyDefaultSpeakers
    };

    data.exclude.push({ "application.process.id": pid });

    if (ignoreInputMedia ?? true) {
        data.exclude.push({ "media.class": "Stream/Input/Audio" });
    }

    if (ignoreVirtual) {
        data.exclude.push({ "node.virtual": "true" });
    }

    if (workaround) {
        data.workaround = [{ "application.process.id": pid, "media.name": "RecordStream" }];
    }

    return data;
}

ipcMain.handle(IpcEvents.VIRT_MIC_LIST, () => {
    const audioPid = getRendererAudioServicePid();

    const { granularSelect } = Settings.store.audio ?? {};

    const targets = obtainVenmic()
        ?.list(granularSelect ? [] : ["application.name", "node.name"])
        .filter(s => s["application.process.id"] !== audioPid);

    return targets ? { ok: true, targets, hasPipewirePulse } : { ok: false, isGlibCxxOutdated };
});

ipcMain.handle(IpcEvents.VIRT_MIC_START, (_, include: Node[]) => {
    return obtainVenmic()?.link(buildLinkData({ include }));
});

ipcMain.handle(IpcEvents.VIRT_MIC_START_SYSTEM, (_, exclude: Node[]) => {
    return obtainVenmic()?.link(buildLinkData({ exclude }));
});

ipcMain.handle(IpcEvents.VIRT_MIC_UNMUTE, () => {
    return obtainVenmic()?.unmute();
});

ipcMain.handle(IpcEvents.VIRT_MIC_STOP, () => obtainVenmic()?.unlink());

// Native voice engine (see discordVoice.ts): discord_voice captures stream audio by process id.
// Lists every app connected to the sound server, not just the ones currently playing audio (venmic only sees
// active streams), so an app can be picked before it starts playing
const IgnoredAudioClients = new Set(["", "libcanberra", "Chromium input", "discord_capture", "discord_hardware_mute"]);

function listPulseClients() {
    return new Promise<{ name: string; pid: string; binary?: string }[] | null>(resolve => {
        execFile("pw-dump", { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(null);

            try {
                const objects = JSON.parse(stdout) as any[];
                resolve(
                    objects
                        .filter(o => o.type === "PipeWire:Interface:Client")
                        .map(o => o.info?.props ?? {})
                        .filter(props => props["client.api"] === "pipewire-pulse")
                        .map(props => ({
                            name: props["application.name"] ?? "",
                            pid: String(props["application.process.id"] ?? ""),
                            binary: props["application.process.binary"]
                        }))
                );
            } catch {
                resolve(null);
            }
        });
    });
}

// Fallback when pw-dump fails (it can, while objects come and go): the same clients through pactl. Not venmic: once
// created it keeps a PipeWire thread in the main process for good, which crashed Vesktop while discord_voice's
// soundshare streams came and went
function listPactlClients() {
    return new Promise<{ name: string; pid: string; binary?: string }[] | null>(resolve => {
        execFile("pactl", ["-f", "json", "list", "clients"], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(null);

            try {
                resolve(
                    (JSON.parse(stdout) as any[]).map(c => ({
                        name: c.properties?.["application.name"] ?? "",
                        pid: String(c.properties?.["application.process.id"] ?? ""),
                        binary: c.properties?.["application.process.binary"]
                    }))
                );
            } catch {
                resolve(null);
            }
        });
    });
}

ipcMain.handle(IpcEvents.NATIVE_VOICE_LIST_AUDIO_APPS, async () => {
    const ownPids = new Set(app.getAppMetrics().map(proc => String(proc.pid)));

    const clients = (await listPulseClients()) ?? (await listPactlClients());
    if (!clients) return null;

    const apps = new Map<string, { name: string; pid: number }>();
    for (const client of clients) {
        const { pid } = client;
        if (!pid || ownPids.has(pid) || IgnoredAudioClients.has(client.name.trim())) continue;

        // eg. "WEBRTC VoiceEngine" for Chromium based apps
        const { binary } = client as { binary?: string };
        const name = client.name.startsWith("WEBRTC") && binary ? binary : client.name;

        // apps can have several clients, prefer the shortest name ("Steam" over "Steam Voice Settings")
        const existing = apps.get(pid);
        if (!existing || name.length < existing.name.length) apps.set(pid, { name, pid: Number(pid) });
    }

    return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
});

// The audio app of a picked window. The compositor only tells the window's application (KWin: its desktop file name,
// eg. "org.mozilla.firefox", "com.valvesoftware.Steam", "steam_app_4000" for a Steam game), not its process
function steamAppIdOf(pid: string) {
    try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        return env.find(v => v.startsWith("SteamAppId="))?.slice("SteamAppId=".length) ?? null;
    } catch {
        return null;
    }
}

ipcMain.handle(IpcEvents.NATIVE_VOICE_FIND_AUDIO_APP, async (_, appId: string) => {
    const ownPids = new Set(app.getAppMetrics().map(proc => String(proc.pid)));
    const clients = ((await listPulseClients()) ?? (await listPactlClients()) ?? []).filter(
        c => c.pid && !ownPids.has(c.pid) && !IgnoredAudioClients.has(c.name.trim())
    );

    const id = appId.replace(/\.desktop$/, "").toLowerCase();
    const steamGame = /^steam_app_(\d+)$/.exec(id)?.[1];
    const last = id.split(".").at(-1) ?? id;

    let best: { name: string; pid: string; score: number } | null = null;
    for (const client of clients) {
        const bin = (client.binary ?? "").split("/").at(-1)!.toLowerCase();
        const name = client.name.toLowerCase();
        let score = 0;
        if (steamGame) score = steamAppIdOf(client.pid) === steamGame ? 3 : 0;
        else if (bin === last || bin === id) score = 3;
        else if (name === last || name === id) score = 2;
        else if (last.length >= 3 && (name.includes(last) || (bin.length >= 3 && last.includes(bin)))) score = 1;
        if (score > (best?.score ?? 0)) best = { name: client.name, pid: client.pid, score };
    }

    return best ? { name: best.name, pid: Number(best.pid) } : null;
});
