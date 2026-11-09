/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The voice & video engine: Chromium's WebRTC, the official client's discord_voice (only offered when an installed
// client was found at start-up) or Vesktop's own vesktop_media. See main/discordVoice.ts

import { Paragraph } from "@vencord/types/components";
import { Alerts, Select, TextInput, useEffect, useState } from "@vencord/types/webpack/common";
import { applyVideoEncoderPreference, applyVideoEncoderTuning, getVideoEncoders } from "renderer/nativeVoiceExtensions";

import { SimpleErrorBoundary } from "../SimpleErrorBoundary";
import { SettingsComponent } from "./Settings";

type VoiceEngine = "webrtc" | "discord" | "vesktop";

const EngineNames: Record<VoiceEngine, string> = {
    webrtc: "WebRTC (built into Vesktop)",
    discord: "Discord integration (official discord_voice)",
    vesktop: "Vesktop Media (vesktop_media)"
};

export const NativeVoiceToggle: SettingsComponent = ({ settings }) => {
    const engines = VesktopNative.voice.getEngines();
    const selected: VoiceEngine = settings.voiceEngine ?? "webrtc";

    const options = [
        { label: EngineNames.webrtc, value: "webrtc" as VoiceEngine },
        ...(engines.discord ? [{ label: EngineNames.discord, value: "discord" as VoiceEngine }] : []),
        ...(engines.vesktop ? [{ label: EngineNames.vesktop, value: "vesktop" as VoiceEngine }] : [])
    ];

    const status = [
        engines.discord
            ? `Discord's discord_voice found at ${engines.discord}.`
            : "No installed Discord client with discord_voice found (install it and join a call once to use it).",
        engines.vesktop ? null : "vesktop_media is not built (see packages/vesktop_media).",
        engines.active !== selected
            ? `In use until restart: ${EngineNames[engines.active]}.`
            : `In use: ${EngineNames[engines.active]}.`
    ].filter(Boolean);

    return (
        <SimpleErrorBoundary>
            <Paragraph>
                The engine for calls, cameras and Go Live. The native ones (Discord's and Vesktop's) capture screens and
                stream audio themselves and disable the renderer sandbox. Vesktop Media also has camera resolution,
                frame rate and autofocus, and device settings when streaming a camera. Requires a full restart.
            </Paragraph>
            <Select
                options={options}
                isSelected={v => v === selected}
                select={(v: VoiceEngine) => {
                    if (v === selected) return;
                    settings.voiceEngine = v;
                    Alerts.show({
                        title: "Restart required",
                        body: "Vesktop needs to be restarted to switch voice engines.",
                        confirmText: "Restart now",
                        cancelText: "Later",
                        onConfirm: () => VesktopNative.app.relaunch()
                    });
                }}
                serialize={String}
                closeOnSelect
            />
            {status.map(line => (
                <Paragraph key={line}>{line}</Paragraph>
            ))}
            {engines.active === "vesktop" && <VideoEncoderPicker settings={settings} />}
            {engines.active === "vesktop" && <VideoEncoderTuning settings={settings} />}
        </SimpleErrorBoundary>
    );
};

const FAMILY_LABELS = {
    nvenc: "NVIDIA (NVENC)",
    amf: "AMD (AMF)",
    vaapi: "AMD / Intel (VA-API)"
} as const;

// vesktop_media: which encoder H.264 / H.265 use (VP8 is always libvpx). The GPU encoders offered are the ones that
// open on this machine
const VideoEncoderPicker: SettingsComponent = ({ settings }) => {
    const encoders = getVideoEncoders();
    const value = settings.nativeVoiceVideoEncoder ?? "auto";
    const families = (Object.keys(FAMILY_LABELS) as (keyof typeof FAMILY_LABELS)[]).filter(
        family => encoders?.available?.some(e => e.family === family) || value === family
    );
    const options = [
        { label: "Automatic (a GPU encoder if one works, else the CPU)", value: "auto" },
        ...families.map(family => ({ label: FAMILY_LABELS[family], value: family })),
        { label: "Software (CPU: x264 / x265)", value: "software" }
    ];
    // the old "hardware" choice: any GPU encoder
    if (value === "hardware") options.splice(1, 0, { label: "Any GPU encoder", value: "hardware" });

    return (
        <>
            <Paragraph>Video encoder for H.264 / H.265 streams and cameras:</Paragraph>
            <Select
                options={options}
                isSelected={v => v === value}
                select={(v: NonNullable<typeof settings.nativeVoiceVideoEncoder>) => {
                    settings.nativeVoiceVideoEncoder = v;
                    applyVideoEncoderPreference();
                }}
                serialize={String}
                closeOnSelect
            />
            {encoders && (
                <Paragraph>
                    In use: H.264 {encoders.h264 || "unavailable"}, H.265 {encoders.h265 || "unavailable"}. Applies to
                    the next camera or stream.
                </Paragraph>
            )}
        </>
    );
};

const PRESETS = [
    { label: "Automatic (Vesktop's default)", value: "auto" },
    { label: "Speed (least GPU / CPU, blurrier)", value: "speed" },
    { label: "Balanced", value: "balanced" },
    { label: "Quality (sharpest, most GPU / CPU)", value: "quality" }
];

const AQ_MODES = [
    { label: "Automatic (the encoder's default)", value: "auto" },
    { label: "On (more bits where the eye notices)", value: "on" },
    { label: "Off", value: "off" }
];

// vesktop_media: preset, adaptive quantization and rate control buffer of the H.264 / H.265 encoder. A running
// stream reopens its encoder with them (a key frame); an encoder that does not open with them opens without
const VideoEncoderTuning: SettingsComponent = ({ settings }) => {
    const tuning = settings.nativeVoiceVideoTuning ?? {};
    const update = (change: typeof tuning) => {
        settings.nativeVoiceVideoTuning = { ...settings.nativeVoiceVideoTuning, ...change };
        applyVideoEncoderTuning();
    };
    // the buffer is applied once typing stops: every value reopens a running encoder (a key frame each)
    const [buffer, setBuffer] = useState(tuning.bufferMs ? String(tuning.bufferMs) : "");
    useEffect(() => {
        const n = Math.floor(Number(buffer));
        const bufferMs = Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 0;
        if (bufferMs === (tuning.bufferMs ?? 0)) return;
        const timer = setTimeout(() => update({ bufferMs }), 1000);
        return () => clearTimeout(timer);
    }, [buffer]);
    const select = (options: typeof PRESETS, value: string, set: (v: string) => void) => (
        <Select options={options} isSelected={v => v === value} select={set} serialize={String} closeOnSelect />
    );

    return (
        <>
            <Paragraph>Encoder preset (H.264 / H.265):</Paragraph>
            {select(PRESETS, tuning.preset ?? "auto", preset => update({ preset }))}
            <Paragraph>
                Adaptive quantization (NVENC, AMF, x264, x265; VA-API has none). Off by default on NVENC, on by default
                on the others:
            </Paragraph>
            {select(AQ_MODES, tuning.aq ?? "auto", aq => update({ aq }))}
            <Paragraph>
                Rate control buffer in ms (100 to 5000, empty = 500). Longer gives motion more bits for a moment, with
                bigger bitrate spikes and a little more delay:
            </Paragraph>
            <TextInput type="number" placeholder="500" value={buffer} onChange={setBuffer} />
            <Paragraph>
                Applies at once (the buffer a second after typing), also to a running stream: it starts again with a key
                frame.
            </Paragraph>
        </>
    );
};
