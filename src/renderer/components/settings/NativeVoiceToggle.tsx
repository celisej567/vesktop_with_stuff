/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The voice & video engine: Chromium's WebRTC, the official client's discord_voice (only offered when an installed
// client was found at start-up) or Vesktop's own vesktop_media. See main/discordVoice.ts

import { Paragraph } from "@vencord/types/components";
import { Alerts, Select } from "@vencord/types/webpack/common";
import { applyVideoEncoderPreference, getVideoEncoders } from "renderer/nativeVoiceExtensions";

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
        </SimpleErrorBoundary>
    );
};

// vesktop_media: which encoder H.264 / H.265 use (VP8 is always libvpx)
const VideoEncoderPicker: SettingsComponent = ({ settings }) => {
    const encoders = getVideoEncoders();
    const value = settings.nativeVoiceVideoEncoder ?? "auto";
    const options = [
        { label: "Automatic (NVIDIA NVENC if available, else the CPU)", value: "auto" },
        { label: "Hardware (NVIDIA NVENC)", value: "hardware" },
        { label: "Software (CPU: x264 / x265)", value: "software" }
    ];

    return (
        <>
            <Paragraph>Video encoder for H.264 / H.265 streams and cameras:</Paragraph>
            <Select
                options={options}
                isSelected={v => v === value}
                select={(v: "auto" | "hardware" | "software") => {
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
