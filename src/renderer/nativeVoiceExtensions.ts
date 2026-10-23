/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// What only Vesktop's own voice engine (vesktop_media) can do, on top of the discord_voice API: camera capture
// options (resolution, frame rate, autofocus) and the device settings when streaming a camera.
// Everything here goes through vesktopVoice(), which is null with WebRTC and the official client's discord_voice

import type { NativeCameraOptions } from "shared/settings";

import { Settings } from "./settings";

export interface CameraFormat {
    width: number;
    height: number;
    frameRate: number;
}

export interface CameraCapabilities {
    guid: string;
    /** largest first */
    formats: CameraFormat[];
    /** null: the camera has no autofocus control */
    autofocus: boolean | null;
}

export interface VideoInputDevice {
    guid: string;
    name: string;
    index: number;
}

export interface AudioInputDevice {
    guid: string;
    name: string;
    index: number;
}

interface VesktopVoiceEngine {
    getVideoInputDevices(cb: (devices: VideoInputDevice[]) => void): void;
    getInputDevices(cb: (devices: AudioInputDevice[]) => void): void;
    getVideoInputDeviceCapabilities(deviceId: string, cb: (caps: CameraCapabilities) => void): void;
    setVideoInputDeviceOptions(deviceId: string, options: NativeCameraOptions): void;
    getNativeScreenSharePickedSource(): { sourceType: "screen" | "window"; appId: string } | null;
    setVideoEncoderPreference(preference: string): void;
    getVideoEncoders(): { h264: string; h265: string; preference: string };
}

/** The feature vesktop_media declares for these extensions */
const FEATURE = "vesktop_device_options";

/**
 * The engine, if Vesktop's own engine (vesktop_media, Settings: voiceEngine "vesktop") is the one loaded.
 * null with WebRTC and with the official discord_voice, which has none of these functions
 */
export function vesktopVoice(): VesktopVoiceEngine | null {
    const voice = window.VesktopDiscordVoice;
    if (voice?.engineKind !== "vesktop" || !voice.features.includes(FEATURE)) return null;
    return voice.engine as VesktopVoiceEngine;
}

/** What was picked in the system picker: a window's application id (desktop file name) when the compositor tells */
export function getPickedSource() {
    try {
        return vesktopVoice()?.getNativeScreenSharePickedSource?.() ?? null;
    } catch {
        return null;
    }
}

export function listVideoInputDevices() {
    const engine = vesktopVoice();
    if (!engine) return Promise.resolve<VideoInputDevice[]>([]);
    return new Promise<VideoInputDevice[]>(resolve => engine.getVideoInputDevices(resolve));
}

export function listAudioInputDevices() {
    const engine = vesktopVoice();
    if (!engine) return Promise.resolve<AudioInputDevice[]>([]);
    return new Promise<AudioInputDevice[]>(resolve => engine.getInputDevices(resolve));
}

export function getCameraCapabilities(guid: string) {
    const engine = vesktopVoice();
    if (!engine) return Promise.resolve<CameraCapabilities | null>(null);
    return new Promise<CameraCapabilities | null>(resolve => engine.getVideoInputDeviceCapabilities(guid, resolve));
}

// The engine lives in the preload's isolated world: arguments cross the context bridge, which can't clone the
// Proxy objects of the settings store. Always hand it a plain copy
function plainOptions(options: NativeCameraOptions): NativeCameraOptions {
    return {
        width: options.width ?? 0,
        height: options.height ?? 0,
        frameRate: options.frameRate ?? 0,
        autofocus: options.autofocus ?? null
    };
}

/** Options for a camera, until applyStoredCameraOptions() restores the saved ones (eg. for one stream) */
export function setCameraOptions(guid: string, options: NativeCameraOptions) {
    vesktopVoice()?.setVideoInputDeviceOptions(guid, plainOptions(options));
}

export function getStoredCameraOptions(guid: string): NativeCameraOptions {
    return Settings.store.nativeVoiceDeviceOptions?.[guid] ?? {};
}

/** Saves the options of a camera (Voice & Video settings) and applies them */
export function storeCameraOptions(guid: string, options: NativeCameraOptions) {
    Settings.store.nativeVoiceDeviceOptions = {
        ...Settings.store.nativeVoiceDeviceOptions,
        [guid]: plainOptions(options)
    };
    setCameraOptions(guid, options);
}

/** H.264 / H.265 encoder preference (Settings: nativeVoiceVideoEncoder) */
export function applyVideoEncoderPreference() {
    vesktopVoice()?.setVideoEncoderPreference?.(Settings.store.nativeVoiceVideoEncoder ?? "auto");
}

export function getVideoEncoders() {
    try {
        return vesktopVoice()?.getVideoEncoders?.() ?? null;
    } catch {
        return null;
    }
}

/** Applies the saved options of every camera (at start-up, and after a stream used its own) */
export function applyStoredCameraOptions() {
    const engine = vesktopVoice();
    if (!engine) return;
    for (const [guid, options] of Object.entries(Settings.store.nativeVoiceDeviceOptions ?? {})) {
        try {
            engine.setVideoInputDeviceOptions(guid, plainOptions(options));
        } catch (e) {
            console.error("[VesktopNativeVoice] Failed to apply the options of camera", guid, e);
        }
    }
}

export function formatLabel(f: CameraFormat) {
    return `${f.width}×${f.height} @ ${f.frameRate} FPS`;
}

export function formatKey(f: { width?: number; height?: number; frameRate?: number }) {
    return f.width && f.height ? `${f.width}x${f.height}@${f.frameRate ?? 0}` : "auto";
}
