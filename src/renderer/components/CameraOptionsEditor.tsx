/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Resolution / frame rate and autofocus of one camera (vesktop_media only): under the camera selection in Discord's
// Voice & Video settings (see patches/nativeVoice.ts) and in the device stream settings. Imports nothing from
// settings/: these are loaded at start-up, and settings/Settings.tsx builds its component list when first evaluated

import { FormSwitch, Heading } from "@vencord/types/components";
import { useAwaiter } from "@vencord/types/utils";
import { MediaEngineStore, Select, useState, useStateFromStores } from "@vencord/types/webpack/common";
import {
    CameraCapabilities,
    formatKey,
    formatLabel,
    getCameraCapabilities,
    getStoredCameraOptions,
    storeCameraOptions
} from "renderer/nativeVoiceExtensions";
import type { NativeCameraOptions } from "shared/settings";

/** Resolution / frame rate and autofocus of one camera */
export function CameraOptionsEditor({
    caps,
    options,
    onChange,
    autoLabel = "Automatic (what Discord asks for)"
}: {
    caps: CameraCapabilities;
    options: NativeCameraOptions;
    onChange(options: NativeCameraOptions): void;
    autoLabel?: string;
}) {
    const formatOptions = [
        { label: autoLabel, value: "auto" },
        ...caps.formats.map(f => ({ label: formatLabel(f), value: formatKey(f) }))
    ];

    return (
        <>
            <section>
                <Heading tag="h5">Resolution & Frame Rate</Heading>
                <Select
                    options={formatOptions}
                    isSelected={v => v === formatKey(options)}
                    select={v => {
                        const f = caps.formats.find(f => formatKey(f) === v);
                        onChange({
                            ...options,
                            width: f?.width ?? 0,
                            height: f?.height ?? 0,
                            frameRate: f?.frameRate ?? 0
                        });
                    }}
                    serialize={String}
                    closeOnSelect
                />
            </section>
            {caps.autofocus != null && (
                <FormSwitch
                    hideBorder
                    title="Autofocus"
                    description="Let the camera focus by itself. Turn it off to keep the current focus."
                    value={options.autofocus ?? true}
                    onChange={v => onChange({ ...options, autofocus: v })}
                />
            )}
        </>
    );
}

/**
 * The options of the camera selected above it in Discord's Voice & Video settings. Saved per camera and applied
 * right away, also to a running camera
 */
export function SelectedCameraOptions() {
    const deviceId: string = useStateFromStores([MediaEngineStore], () => (MediaEngineStore as any).getVideoDeviceId());
    const [caps] = useAwaiter(() => getCameraCapabilities(deviceId), { fallbackValue: null, deps: [deviceId] });
    const [edited, setEdited] = useState<{ guid: string; options: NativeCameraOptions } | null>(null);

    // caps.guid: the device behind Discord's id ("default" included)
    if (!caps?.guid || caps.guid === "disabled" || !caps.formats.length) return null;
    const options = edited?.guid === caps.guid ? edited.options : getStoredCameraOptions(caps.guid);

    return (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <CameraOptionsEditor
                caps={caps}
                options={options}
                onChange={o => {
                    setEdited({ guid: caps.guid, options: o });
                    storeCameraOptions(caps.guid, o);
                }}
            />
        </div>
    );
}
