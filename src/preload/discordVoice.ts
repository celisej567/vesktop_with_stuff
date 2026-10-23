/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Loads the official client's discord_voice module into this (non-sandboxed) renderer, exactly like
// Discord desktop does, and exposes it to the main world. See main/discordVoice.ts

import type { DiscordVoiceInfo } from "main/discordVoice";
import { IpcEvents } from "shared/IpcEvents";

import { invoke, sendSync } from "./typedIpc";

type DirectFrameConsumer = (frame: VideoFrame | null) => void;

interface FrameImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

function createDiscordNativeShim(info: DiscordVoiceInfo, features: Set<string>) {
    const appSettings = sendSync<Record<string, unknown>>(IpcEvents.NATIVE_VOICE_GET_SETTINGS);

    // The subset of window.DiscordNative that discord_voice's index.js uses
    return {
        isRenderer: true,
        settings: {
            getSync: (key: string, defaultValue?: unknown) => (key in appSettings ? appSettings[key] : defaultValue),
            get: async (key: string, defaultValue?: unknown) => (key in appSettings ? appSettings[key] : defaultValue),
            set: (key: string, value: unknown) => {
                appSettings[key] = value;
                invoke(IpcEvents.NATIVE_VOICE_SET_SETTING, key, value);
            }
        },
        features: {
            declareSupported: (feature: string) => void features.add(feature),
            supports: (feature: string) => features.has(feature)
        },
        processUtils: {
            getMainArgvSync: () => [] as string[]
        },
        fileManager: {
            getModuleDataPathSync: () => info.dataDir,
            getAndCreateLogDirectorySync: () => info.logDir
        },
        nativeModules: {
            getModulePath: (name: string) => (name === "discord_krisp" ? info.krispPath : null)
        },
        app: {
            relaunch: () => invoke(IpcEvents.RELAUNCH)
        }
    };
}

/**
 * The official client renders remote video with `window.createDiscordStream`, a function only present in
 * Discord's patched Electron. It turns frames that discord_voice writes into shared memory into a MediaStream.
 *
 * We can't do that, so instead we hook the "direct" video sink functions and route them to the regular
 * frame callback sink (setVideoOutputSink), which hands us RGBA frames. Those are turned into VideoFrames
 * and sent to the main world, where they are fed into a MediaStreamTrackGenerator (see renderer/nativeVoice.ts)
 */
function hookVideoSinks(raw: any) {
    const setVideoOutputSink = raw.setVideoOutputSink as (
        streamId: string,
        cb?: Function,
        useImageData?: boolean
    ) => void;
    const signalVideoOutputSinkReady = raw.signalVideoOutputSinkReady as (streamId: string) => void;

    // sinks registered by index.js (getNextVideoOutputFrame, used for previews & screenshots)
    const callbackSinks = new Map<string, (frame: FrameImageData) => void>();
    const directSinks = new Set<string>();
    const directConsumers = new Map<string, DirectFrameConsumer>();

    function deliverDirectFrame(streamId: string, image: FrameImageData) {
        const consumer = directConsumers.get(streamId);
        if (!consumer) return;

        // Ownership of the frame is passed to the main world (contextBridge doesn't copy VideoFrames)
        const frame = new VideoFrame(image.data, {
            format: "RGBX",
            codedWidth: image.width,
            codedHeight: image.height,
            timestamp: Math.round(performance.now() * 1000)
        });

        try {
            consumer(frame);
        } catch (e) {
            frame.close();
            console.error("[NativeVoice] Failed to deliver video frame", e);
        }
    }

    function updateSink(streamId: string) {
        const callbackSink = callbackSinks.get(streamId);
        const isDirect = directSinks.has(streamId);

        if (!callbackSink && !isDirect) {
            setVideoOutputSink(streamId);
            return;
        }

        setVideoOutputSink(
            streamId,
            (image: FrameImageData) => {
                if (isDirect) deliverDirectFrame(streamId, image);

                // index.js' callback signals readiness itself
                if (callbackSink) callbackSink(image);
                else signalVideoOutputSinkReady(streamId);
            },
            true
        );
    }

    raw.setVideoOutputSink = (streamId: string, cb?: (frame: FrameImageData) => void) => {
        if (cb) callbackSinks.set(streamId, cb);
        else callbackSinks.delete(streamId);

        updateSink(streamId);
    };

    raw.addDirectVideoOutputSink = (streamId: string) => {
        directSinks.add(streamId);
        updateSink(streamId);
    };

    raw.removeDirectVideoOutputSink = (streamId: string) => {
        directSinks.delete(streamId);
        updateSink(streamId);

        const consumer = directConsumers.get(streamId);
        directConsumers.delete(streamId);
        consumer?.(null);
    };

    return {
        setDirectFrameConsumer(streamId: string, consumer: DirectFrameConsumer) {
            const old = directConsumers.get(streamId);
            directConsumers.set(streamId, consumer);
            if (old && old !== consumer) old(null);
        }
    };
}

/**
 * discord_voice keeps the mic test loopback attached to the device that was active when it started, so
 * after switching the input device the test goes silent. Restart the loopback whenever the device changes
 */
function hookLoopback(raw: any) {
    const { setLoopback, setInputDevice } = raw;
    if (typeof setLoopback !== "function" || typeof setInputDevice !== "function") return;

    let loopback: { options: unknown; rest: unknown[] } | null = null;

    raw.setLoopback = (enabled: boolean, options: unknown, ...rest: unknown[]) => {
        loopback = enabled ? { options, rest } : null;
        return setLoopback(enabled, options, ...rest);
    };

    raw.setInputDevice = (...args: unknown[]) => {
        const res = setInputDevice(...args);

        if (loopback) {
            const { options, rest } = loopback;
            setLoopback(false, options, ...rest);
            setLoopback(true, options, ...rest);
        }

        return res;
    };
}

export function loadDiscordVoice() {
    const info = sendSync<DiscordVoiceInfo | null>(IpcEvents.NATIVE_VOICE_GET_INFO);
    if (!info) return null;

    if (process.sandboxed) {
        console.error("[NativeVoice] Can't load discord_voice in a sandboxed renderer");
        return null;
    }

    const features = new Set<string>();
    const shim = createDiscordNativeShim(info, features);

    // index.js reads window.DiscordNative while it is being evaluated. Due to context isolation this
    // only exists in the preload's world, Discord's code never sees it
    const w = window as any;
    w.DiscordNative = shim;
    try {
        // Node modules like "path" can't be imported at the top of this file: the preload also runs
        // sandboxed (native voice disabled), where only a few electron modules are available
        const { join } = require("path") as typeof import("path");
        const raw = require(join(info.modulePath, info.nodeFile));
        const sinks = hookVideoSinks(raw);
        hookLoopback(raw);
        const engine = require(join(info.modulePath, "index.js"));

        console.log(`[NativeVoice] Loaded ${info.nodeFile} from ${info.modulePath}`);

        return {
            /** "discord" (the official discord_voice) or "vesktop" (vesktop_media) */
            engineKind: info.engine,
            modulePath: info.modulePath,
            engine,
            features: [...features],
            setDirectFrameConsumer: sinks.setDirectFrameConsumer
        };
    } catch (e) {
        console.error("[NativeVoice] Failed to load discord_voice", e);
        return null;
    } finally {
        delete w.DiscordNative;
    }
}
