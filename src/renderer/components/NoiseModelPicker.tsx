/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A quick choice of the noise suppression (vesktop_media only), in the popout of the noise button of the call panel
// (see patches/nativeVoice.ts). The same four choices as Voice & Video settings: none, standard, and the engine's
// models

import { Heading } from "@vencord/types/components";
import { FluxDispatcher, MediaEngineStore, Select, useStateFromStores } from "@vencord/types/webpack/common";
import { applyNoiseModel, isNoiseModelSupported, type NoiseModelName } from "renderer/nativeVoiceExtensions";
import { Settings, useSettings } from "renderer/settings";

type NoiseOption = "NONE" | NoiseModelName;

// Read when rendering, never when this file is evaluated: Vesktop's renderer code runs from the preload, before the
// page has a document element (an error here stopped all of it: no Vesktop settings, no native voice engine)
function isRussian() {
    return (document.documentElement?.lang ?? navigator.language).startsWith("ru");
}

function labels(ru: boolean): Record<NoiseOption, string> {
    return {
        NONE: ru ? "Пусто" : "Disabled",
        STANDARD: ru ? "Стандартное" : "Standard",
        RNNOISE: "RNNoise",
        DEEPFILTERNET: "DeepFilterNet"
    };
}

/** What Discord's own setting does for each choice: the noise cancellation flag, and the suppression the other way */
function selectNoiseOption(option: NoiseOption) {
    const cancellation = option === "RNNOISE" || option === "DEEPFILTERNET";
    if (cancellation) {
        Settings.store.nativeVoiceNoiseModel = option;
        applyNoiseModel(option);
    }
    FluxDispatcher.dispatch({ type: "AUDIO_SET_NOISE_CANCELLATION", enabled: cancellation });
    FluxDispatcher.dispatch({ type: "AUDIO_SET_NOISE_SUPPRESSION", enabled: option === "STANDARD" });
}

/** The text under the list: what the choices are (Discord's own text advertises Krisp) */
export function noiseDescription() {
    return isRussian()
        ? "Выберите шумоподавление для микрофона. RNNoise и DeepFilterNet убирают шум с помощью нейросети, «Стандартное» это обычное шумоподавление, «Пусто» выключает его."
        : "Choose the noise suppression for your microphone. RNNoise and DeepFilterNet remove noise with a neural network, Standard is the plain noise suppression, Disabled turns it off.";
}

export function NoiseModelPicker() {
    const { nativeVoiceNoiseModel } = useSettings();
    const cancellation = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getNoiseCancellation());
    const suppression = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getNoiseSuppression());

    const ru = isRussian();
    const names = labels(ru);
    const options = (["NONE", "STANDARD", "RNNOISE", "DEEPFILTERNET"] as const)
        .filter(o => o === "NONE" || isNoiseModelSupported(o))
        .map(o => ({ label: names[o], value: o }));
    const value: NoiseOption = cancellation ? (nativeVoiceNoiseModel ?? "RNNOISE") : suppression ? "STANDARD" : "NONE";

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Heading tag="h5">{ru ? "Шумоподавление" : "Noise suppression"}</Heading>
            <Select
                options={options}
                isSelected={v => v === value}
                select={(v: NoiseOption) => selectNoiseOption(v)}
                serialize={String}
                closeOnSelect
            />
        </div>
    );
}
