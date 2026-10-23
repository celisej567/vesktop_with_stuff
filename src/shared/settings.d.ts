/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Rectangle } from "electron";

export interface Settings {
    discordBranch: "stable" | "canary" | "ptb";
    transparencyOption: "none" | "mica" | "tabbed" | "acrylic";
    webRTCIPHandlingPolicy:
        | "default"
        | "default_public_interface_only"
        | "default_public_and_private_interfaces"
        | "disable_non_proxied_udp";
    tray: boolean;
    minimizeToTray: boolean;
    autoStartMinimized: boolean;
    openLinksWithElectron: boolean;
    staticTitle: boolean;
    enableMenu: boolean;
    enableShadow: boolean;
    enableRoundedCorners: boolean;
    disableSmoothScroll: boolean;
    hardwareAcceleration: boolean;
    hardwareVideoAcceleration: boolean;
    arRPC: boolean;
    appBadge: boolean;
    enableTaskbarFlashing: boolean;
    disableMinSize: boolean;
    clickTrayToShowHide: boolean;
    nativeTitleBar: boolean;

    enableSplashScreen: boolean;
    splashTheming: boolean;
    splashPixelated: boolean;
    splashColor?: string;
    splashBackground?: string;

    spellCheckLanguages?: string[];

    /**
     * Voice & video engine: Chromium's WebRTC (the web app's own), the official client's discord_voice (when
     * installed) or Vesktop's own vesktop_media. See main/discordVoice.ts
     */
    voiceEngine?: "webrtc" | "discord" | "vesktop";
    /** @deprecated replaced by voiceEngine (migrated on start-up) */
    nativeVoice?: boolean;
    /** Custom path to a directory containing discord_voice's index.js and discord_voice.node (Discord engine) */
    nativeVoiceModulePath?: string;
    /** @deprecated replaced by voiceEngine "vesktop" (migrated on start-up) */
    nativeVoiceOwnEngine?: boolean;
    /** vesktop_media: H.264 / H.265 encoder, "auto" (NVIDIA first), "hardware" (NVENC) or "software" (x264 / x265) */
    nativeVoiceVideoEncoder?: "auto" | "hardware" | "software";
    /** vesktop_media: capture options per camera (by device guid), see renderer/nativeVoiceExtensions.ts */
    nativeVoiceDeviceOptions?: Record<string, NativeCameraOptions>;
    /** Settings persisted by discord_voice itself */
    nativeVoiceAppSettings?: Record<string, unknown>;

    audio?: {
        workaround?: boolean;

        deviceSelect?: boolean;
        granularSelect?: boolean;

        ignoreVirtual?: boolean;
        ignoreDevices?: boolean;
        ignoreInputMedia?: boolean;

        mute?: boolean;
        onlySpeakers?: boolean;
        onlyDefaultSpeakers?: boolean;
    };
}

export interface State {
    maximized?: boolean;
    minimized?: boolean;
    windowBounds?: Rectangle;

    firstLaunch?: boolean;

    steamOSLayoutVersion?: number;
    linuxAutoStartEnabled?: boolean;

    vencordDir?: string;

    updater?: {
        ignoredVersion?: string;
        snoozeUntil?: number;
    };
}

export interface NativeCameraOptions {
    /** 0 / missing: whatever Discord asks for */
    width?: number;
    height?: number;
    frameRate?: number;
    /** null / missing: leave the camera's setting alone */
    autofocus?: boolean | null;
}
