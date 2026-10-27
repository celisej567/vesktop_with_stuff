/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Makes Discord use its native media engine (MediaEngineNative, backed by discord_voice) instead of
// MediaEngineWebRTC. See main/discordVoice.ts and preload/discordVoice.ts
//
// The web app picks the first engine whose static supported() returns true out of [NATIVE, WEBRTC].
// MediaEngineNative's dependencies are "injected" by MediaEngineStore, and only report being supported
// when running inside the official client (isPlatformEmbedded). We replace that injection.

import { Logger } from "@vencord/types/utils";
import { onceReady } from "@vencord/types/webpack";
import { FluxDispatcher, MediaEngineStore, React, UserStore } from "@vencord/types/webpack/common";
import { SelectedCameraOptions } from "renderer/components/CameraOptionsEditor";
import { NoiseModelPicker, noiseDescription } from "renderer/components/NoiseModelPicker";
import {
    addStreamAudioSourceMenu,
    getNativeStreamQuality,
    NativeAudioSource,
    openNativeDeviceStreamSettings,
    openNativeStreamSettings,
    openRunningStreamSettings,
    SYSTEM_AUDIO
} from "renderer/components/NativeStreamSettings";
import {
    applyNoiseModel,
    applyStoredCameraOptions,
    applyVideoEncoderPreference,
    hasNoiseModels,
    isNoiseModelSupported,
    setCameraOptions,
    vesktopVoice
} from "renderer/nativeVoiceExtensions";
import { Settings, useSettings } from "renderer/settings";

import { addPatch } from "./shared";

// Chromium only (Breakout Box), not in TypeScript's DOM lib
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
    constructor(init: { kind: "audio" | "video" });
    readonly writable: WritableStream<VideoFrame>;
}

const logger = new Logger("VesktopNativeVoice", "#5865f2");

const voice = window.VesktopDiscordVoice;

const features = new Set(voice?.features);

/** Console, and also the engine's log file (consoleLog), so the Go Live flow can be followed without devtools */
function trace(message: string, ...data: unknown[]) {
    logger.info(message, ...data);
    try {
        const text = data.map(d => (typeof d === "string" ? d : JSON.stringify(d))).join(" ");
        voice?.engine?.consoleLog?.("info", `[Vesktop] ${message} ${text}`.trim());
    } catch {}
}

interface NativeDependencies {
    supported(): boolean;
    supportsFeature(feature: string): boolean;
    setProcessPriority(priority: number): void;
    getVoiceEngine(): any;
    getOpenH264LibraryPath(): string | null | undefined;
}

function createDiscordStream(streamId: string) {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    const writer = generator.writable.getWriter();
    let pendingFrames = 0;

    voice!.setDirectFrameConsumer(streamId, frame => {
        if (frame == null) {
            writer.close().catch(() => {});
            return;
        }

        // the consumer can't keep up (eg. hidden tab), drop frames instead of queueing them up
        if (pendingFrames > 2) {
            frame.close();
            return;
        }

        pendingFrames++;
        writer
            .write(frame)
            .catch(() => frame.close())
            .finally(() => pendingFrames--);
    });

    return new MediaStream([generator]);
}

if (voice) {
    logger.info("Using the native voice engine. Supported features:", voice.features.join(", "));

    // only exists in Discord's patched Electron, see preload/discordVoice.ts
    (window as any).createDiscordStream = createDiscordStream;
}

addPatch({
    patches: [
        {
            find: '"injectMediaEngine"',
            predicate: () => voice != null,
            replacement: {
                match: /\(0,(\i\.\i)\)\((\{supported\(\)\{.{0,400}?getOpenH264LibraryPath:\(\)=>.{0,40}?\})\)/,
                replace: "(0,$1)($self.injectNativeDependencies($2))"
            }
        },
        {
            // MEDIA_ENGINE_SET_GO_LIVE_SOURCE: soundshare ids are only resolved on desktop, via discord_utils.
            // Without one, Go Live has no audio
            find: "MEDIA_ENGINE_SET_GO_LIVE_SOURCE:function",
            predicate: () => voice != null,
            replacement: [
                {
                    match: /\i\.isPlatformEmbedded&&!(\i)&&\(\{soundshareId:(\i),soundshareSession:(\i)\}=\i\((\i),(\i)\)\)/,
                    replace: "!$1&&({soundshareId:$2,soundshareSession:$3}=$self.getSoundshare($4,$5))"
                },
                {
                    // Use the quality picked in our stream settings, not the (Nitro limited) one from Discord's UI
                    match: /(?<=,(\i)=\i\.context\?\?\i\.\i\.DEFAULT,)(\i)=(\i)\.qualityOptions\?\?(\{resolution:720,frameRate:30\})/,
                    replace: "$2=$self.getStreamQuality($1,$3.qualityOptions??$4)"
                }
            ]
        },
        {
            // The Go Live button opens the desktop Go Live modal only when embedded. On web it calls
            // MediaEngine.getDesktopSource() (getDisplayMedia), which only MediaEngineWebRTC implements
            find: "getMediaEngine().getDesktopSource(",
            predicate: () => voice != null,
            replacement: {
                match: /if\((\i)\.isPlatformEmbedded\)(?=\(0,\i\.openModalLazy\))/,
                replace: "if($1.isPlatformEmbedded||true)"
            }
        },
        {
            // "Prefer Clarity": keep the resolution and lower the frame rate when the encoder can't keep up
            find: "sourceDesktopDegradationPreference=",
            predicate: () => voice != null,
            replacement: {
                match: /(\i)\?this\.sourceDesktopDegradationPreference:this\.desktopDegradationPreference/,
                replace: "$self.getDesktopDegradationPreference(this)??($&)"
            }
        },
        {
            // Go Live modal
            find: '"set_source_candidates"',
            predicate: () => voice != null,
            replacement: [
                {
                    // DiscordNative.window doesn't exist
                    match: /(\i\.\i)\.window\.getMediaSourceId\?\.\(\)/,
                    replace: "$1?.window?.getMediaSourceId?.()"
                },
                {
                    // makes it use the system picker on Linux (presentNativeScreenSharePicker("screen" | "window"))
                    match: /\(0,(\i)\.isLinux\)\(\)/g,
                    replace: "($self.isLinux||(0,$1.isLinux)())"
                },
                {
                    // The stream is about to start: content picked in the system picker (Linux) or a screen, window
                    // or game picked in the modal (Windows). We show our own stream settings with a preview
                    // afterwards, see onStreamCreate
                    match: /(\i=\i\.useCallback\(async (\i)=>\{)(?=\i\.\i\.updateSetting\(\i\.notifyFriends\))/,
                    replace: "$1$self.onModalContentPicked($2);"
                },
                // Quality is picked in our stream settings instead. Remove preset info, SD/HD, the quality
                // settings button and the Nitro upsell from the footer, keep the pick / Go Live button
                {
                    match: /\(0,\i\.jsx\)\(\i,\{\}\),(?=\(0,\i\.jsxs\)\("div",\{className:\i\.\i,children:\[\i&&\(0,\i\.jsx\)\(\i,\{onClose:\i\}\))/,
                    replace: ""
                },
                {
                    match: /\i&&\(0,\i\.jsx\)\(\i,\{onClose:\i\}\),(?=\(\i\|\|\i\)&&)/,
                    replace: ""
                },
                {
                    match: /,\(0,\i\.jsx\)\(\i,\{align:"right"\}\)/,
                    replace: ""
                },
                {
                    match: /,\i&&\(0,\i\.jsx\)\("div",\{className:\i\.\i,children:\(0,\i\.jsx\)\(\i,\{onClose:\i\}\)\}\)/,
                    replace: ""
                }
            ]
        },
        {
            // The Go Live modal observes running games, which is only possible on desktop
            find: "Attempted to observe candidate games on a non-desktop platform",
            predicate: () => voice != null,
            replacement: {
                match: /(if\(!\(0,\i\.isDesktop\)\(\)\))throw Error\("Attempted to (?:stop )?observ\w+ candidate games on a non-desktop platform"\)/g,
                replace: "$1return"
            }
        },
        {
            // Fetching Go Live sources requires DiscordNative, even though it's only used for screens and windows
            // without previews. With the system picker, the Go Live modal only asks for camera sources
            find: "Can't get desktop sources outside of native app",
            predicate: () => voice != null,
            replacement: [
                {
                    match: /(?<=let (\i)=window\.DiscordNative;\i\(\)\()null!=\1/,
                    replace: "true"
                },
                {
                    match: /0!==(\i)\.length&&(?=\i\.push\((\i)\.desktopCapture)/,
                    replace: "0!==$1.length&&null!=$2&&"
                }
            ]
        },
        {
            // The official client hides "Change Windows" for system picker sources on Linux: discord_voice can't
            // switch the content of a running portal capture. isLinux() is false on web, hide it here too
            find: '"change-windows"',
            predicate: () => voice != null,
            replacement: {
                match: /(getUseSystemScreensharePicker\(\)&&)\(0,\i\.isLinux\)\(\)/,
                replace: "$1$self.isLinux"
            }
        },
        {
            // vesktop_media only: the stream bitrate typed in our stream settings also goes to the SFU (VIDEO op
            // max_bitrate). It caps the stream with REMB at what the client declared (Discord's preset, 4.2 Mbit/s)
            find: "max_bitrate:e.maxBitrate",
            predicate: () => vesktopVoice() != null,
            replacement: {
                match: /max_bitrate:(\i)\.maxBitrate/,
                replace: "max_bitrate:$self.streamMaxBitrate($1)"
            }
        },
        {
            // vesktop_media only: the camera's resolution, frame rate and autofocus under the camera selection of
            // Discord's Voice & Video settings
            find: 'location:"UserSettingsCameraSelect"',
            predicate: () => vesktopVoice() != null,
            replacement: {
                match: /return(\(0,\i\.jsx\)\(\i\.\i,\{label:.{0,200}?location:"UserSettingsCameraSelect".{0,600}?:void 0\}\))/,
                replace: "return $self.renderCameraSelect($1)"
            }
        },
        {
            // vesktop_media only: the noise suppression choice of Voice & Video settings. Krisp (the official
            // client's closed-source model) is replaced by the engine's own models, RNNoise and DeepFilterNet
            find: "VOICE_NOISE_SUPPRESSION_SETTING,{",
            predicate: () => hasNoiseModels(),
            replacement: [
                {
                    match: /(?<=useCallback\()(\i)=>\{(?=\i\.default\.setNoiseCancellation\("KRISP"===\1)/,
                    replace: "$1=>{$1=$self.onNoiseOptionSelected($1);"
                },
                {
                    match: /return (\i)&&(\i)\.push\(\{id:"krisp",label:.{0,60}?,value:"KRISP"\}\),/,
                    replace: "return $self.pushNoiseModels($2),"
                },
                {
                    match: /value:(\i)\?"KRISP":(\i)\?"STANDARD":"NONE"/,
                    replace: "value:$self.getNoiseValue($1,$2)"
                }
            ]
        },
        {
            // vesktop_media only: without Krisp, Discord forces noiseCancellation off (and noiseSuppression on) in the
            // settings it reads back (MediaEngineStore.getSettings), whatever was chosen. That would show RNNoise as
            // Standard again and switch it off on the next audio settings update
            find: "vadKrispActivationThreshold=.8",
            predicate: () => hasNoiseModels(),
            replacement: {
                match: /(\i)=(\i)\(\)\?(\i):(\i)(?=,\i=\{\.\.\.\i\.modeOptions\?\?\{\},)/,
                replace: "$1=$2()?$3:$self.getNoiseOverrides($4)"
            }
        },
        {
            // vesktop_media only: at start-up Discord switches noise cancellation off in its saved settings when the
            // engine does not declare Krisp's feature (`nA({noiseCancellation:!1})`). Ours is the same flag, so the
            // choice of RNNoise / DeepFilterNet was gone after a restart (the suppression was off too: Discord saves
            // it off while noise cancellation is on) and the setting showed "None"
            find: "noiseCancellation:!1}),(0,",
            predicate: () => hasNoiseModels(),
            replacement: {
                match: /\(0,(\i)\.isWeb\)\(\)&&(\i)\(\{noiseCancellation:!1\}\)/,
                replace: "(0,$1.isWeb)()&&!$self.keepsNoiseCancellation()&&$2({noiseCancellation:!1})"
            }
        },
        {
            // vesktop_media only: the noise button of the call panel. Discord shows it only when Krisp is supported
            find: "canGoLive:(0,",
            predicate: () => hasNoiseModels(),
            replacement: {
                match: /noiseCancellationSupported:(\i\.\i)\.isNoiseCancellationSupported\(\)(?=,canGoLive:)/,
                replace: "noiseCancellationSupported:$1.isNoiseCancellationSupported()||true"
            }
        },
        {
            // ... and its popout: a list of the noise suppression choices instead of the Krisp switch, without the
            // Krisp advertisement
            find: '"WGWHv/"',
            predicate: () => hasNoiseModels(),
            replacement: [
                {
                    match: /\(0,\i\.jsx\)\(\i\.\i,\{text:\i,shouldShow:\i\|\|\i,align:"right",children:\(0,\i\.jsx\)\("div",\{children:\(0,\i\.jsx\)\(\i\.\i,\{label:\i\.intl\.string\(\i\.t\["WGWHv\/"\]\),checked:.{0,200}?NOISE_CANCELLATION_POPOUT\}\)\}\)\}\)\}\)/,
                    replace: "$self.renderNoiseModelPicker()"
                },
                {
                    // the text under it, which advertises Krisp
                    match: /(\(0,\i\.jsx\)\(\i\.\i,\{variant:"text-sm\/normal",children:)\i(\}\)(?=,\(0,\i\.jsx\)\(\i\.\i,\{title:))/,
                    replace: "$1$self.noiseDescription()$2"
                },
                {
                    match: /,\(0,\i\.jsx\)\(\i\.\i,\{label:\i\.intl\.string\(\i\.t\.k6h1F4\),children:\(0,\i\.jsxs\)\(\i\.\i,\{justify:\i\.\i\.Justify\.BETWEEN,className:\i\.__invalid_footer,children:\[.{0,500}?\]\}\)\}\)(?=\]\}\)\})/,
                    replace: ""
                }
            ]
        },
        {
            // The system (xdg-desktop-portal) screenshare picker is the default on Linux, but isLinux() is
            // false on web. Without it, Go Live has no way to pick a source with the native engine on Wayland
            find: "getUseSystemScreensharePicker(){",
            predicate: () => voice != null && navigator.platform.startsWith("Linux"),
            replacement: {
                match: /(getUseSystemScreensharePicker\(\)\{.{0,120}?=)\(0,\i\.isLinux\)\(\)/,
                replace: "$1!0"
            }
        }
    ],

    injectNativeDependencies(original: NativeDependencies): NativeDependencies {
        if (!voice) return original;

        return {
            supported: () => voice.engine.VoiceConnection != null,
            supportsFeature: feature => features.has(feature),
            setProcessPriority() {},
            getVoiceEngine: () => voice.engine,
            // OpenH264 is downloaded by the official client's DiscordNative. Without it discord_voice
            // uses ffmpeg (decoding) and VAAPI (encoding) for H264, or falls back to other codecs
            getOpenH264LibraryPath: () => null
        };
    },

    isLinux: navigator.platform.startsWith("Linux"),

    /** The max_bitrate a VIDEO op declares for a stream: ours for the layers of our Go Live stream */
    streamMaxBitrate(stream: { ssrc?: number; maxBitrate?: number; quality?: number }) {
        const original = stream?.maxBitrate;
        const kbps = Number(getNativeStreamQuality().videoBitrate ?? 0);
        if (!kbps || !vesktopVoice()) return original;

        let ours = false;
        MediaEngineStore.getMediaEngine().eachConnection((connection: any) => {
            if (connection.context !== "stream" || connection.goLiveSourceIdentifier == null) return;
            if (connection.videoStreamParameters?.some((p: any) => p.ssrc === stream.ssrc)) ours = true;
        });
        if (!ours) return original;
        // lower simulcast layers get a quarter, as Discord's presets (and vesktop_media) do
        return (stream.quality ?? 100) < 100 ? (kbps * 1000) / 4 : kbps * 1000;
    },

    noiseDescription,

    renderNoiseModelPicker() {
        return React.createElement(NoiseModelPicker);
    },

    /** The saved noise cancellation flag (our models) stays on at start-up */
    keepsNoiseCancellation() {
        return true;
    },

    /** Discord's settings overrides for "no Krisp", without the forced noise cancellation off: the engine has RNNoise */
    getNoiseOverrides(overrides: { modeOptions?: object }) {
        return { modeOptions: overrides.modeOptions };
    },

    /** Noise cancellation options of vesktop_media (the Krisp entry's place) */
    pushNoiseModels(options: { id: string; label: string; value: string }[]) {
        if (isNoiseModelSupported("RNNOISE")) options.push({ id: "rnnoise", label: "RNNoise", value: "RNNOISE" });
        if (isNoiseModelSupported("DEEPFILTERNET"))
            options.push({ id: "deepfilternet", label: "DeepFilterNet", value: "DEEPFILTERNET" });
    },

    /**
     * The option picked in the settings. Both models are Discord's noise cancellation flag (what its code calls
     * "KRISP"): returning that value turns it on, and the model selects what runs behind it
     */
    onNoiseOptionSelected(value: string) {
        if (value !== "RNNOISE" && value !== "DEEPFILTERNET") return value;
        Settings.store.nativeVoiceNoiseModel = value;
        applyNoiseModel(value);
        return "KRISP";
    },

    /**
     * What the setting shows. Called while the component renders, so the settings hook makes it render again when
     * the model changes
     */
    getNoiseValue(noiseCancellation: boolean, noiseSuppression: boolean) {
        const { nativeVoiceNoiseModel } = useSettings();
        if (noiseCancellation) return nativeVoiceNoiseModel ?? "RNNOISE";
        return noiseSuppression ? "STANDARD" : "NONE";
    },

    renderCameraSelect(select: React.ReactNode) {
        return React.createElement(React.Fragment, null, select, React.createElement(SelectedCameraOptions));
    },

    streamAudioSource: SYSTEM_AUDIO as NativeAudioSource,
    awaitingStreamSettings: false,

    onModalContentPicked(source: { id?: string }) {
        // cameras ("Devices") get the device settings instead, see onStreamStart
        if (source?.id?.startsWith("camera:")) return;
        this.streamAudioSource = SYSTEM_AUDIO;
        this.awaitingStreamSettings = true;
    },

    getStreamQuality(context: string, quality: { resolution: number; frameRate: number }) {
        if (context !== "stream") return quality;

        const { resolution, frameRate } = getNativeStreamQuality();
        return { ...quality, resolution: Number(resolution), frameRate: Number(frameRate) };
    },

    getDesktopDegradationPreference(connection: any) {
        if (connection.context !== "stream") return null;
        const { DegradationPreference } = voice!.engine;
        if (getNativeStreamQuality().contentHint === "detail") return DegradationPreference.MAINTAIN_RESOLUTION;
        // vesktop_media: "Prefer Smoothness" keeps the frame rate and lets the picture blur when bits run short
        return vesktopVoice() ? DegradationPreference.MAINTAIN_FRAMERATE : null;
    },

    getSoundshare(_pid: number | null, sound: boolean) {
        // discord_voice captures the audio of soundsharePid. On Linux, the official client resolves screens and
        // portal ("prepicked") sources to pid 1, which captures all system audio except its own process.
        // sound is false when "Share stream audio" is unchecked
        return { soundshareId: sound ? this.streamAudioSource : null, soundshareSession: "" };
    }
});

function setStreamPaused(streamKey: string, paused: boolean) {
    FluxDispatcher.dispatch({ type: "STREAM_SET_PAUSED", streamKey, paused });
}

function stopStream(streamKey: string) {
    FluxDispatcher.dispatch({ type: "STREAM_CLOSE", streamKey, canShowFeedback: false });
    FluxDispatcher.dispatch({ type: "STREAM_STOP", streamKey, appContext: "APP" });
}

/** vesktop_media: the stream's video / audio bitrate from our stream settings ("0" = Discord's) */
function applyStreamBitrates() {
    if (!vesktopVoice()) return;
    const { videoBitrate = "0", audioBitrate = "0" } = getNativeStreamQuality();
    MediaEngineStore.getMediaEngine().eachConnection((connection: any) => {
        if (connection.context !== "stream" || connection.goLiveSourceIdentifier == null) return;
        connection.conn?.setTransportOptions?.({
            vesktopVideoBitrate: Number(videoBitrate) * 1000,
            // below Opus' 6 kbit/s minimum the module would clamp it anyway
            vesktopAudioBitrate: Number(audioBitrate) > 0 ? Math.max(6, Number(audioBitrate)) * 1000 : 0
        });
    });
    trace("stream bitrates", { videoBitrate, audioBitrate });
}

/** Applies quality, content type & audio from our stream settings to the running stream */
function applyStreamSettings() {
    const { resolution, frameRate } = getNativeStreamQuality();

    MediaEngineStore.getMediaEngine().eachConnection((connection: any) => {
        const sourceId: string | null = connection.goLiveSourceIdentifier;
        if (connection.context !== "stream" || sourceId == null) return;

        // Goes through MediaEngineStore rather than the connection, so the store remembers the new source.
        // Otherwise it would re-apply the old soundshare id the next time it updates the go live source.
        // Quality and audio are taken from our settings, see getStreamQuality & getSoundshare
        FluxDispatcher.dispatch({
            type: "MEDIA_ENGINE_SET_GO_LIVE_SOURCE",
            settings: {
                desktopSettings: { sourceId, sound: true },
                // PRESET_CUSTOM, so Discord doesn't switch presets automatically
                qualityOptions: { preset: 3, resolution: Number(resolution), frameRate: Number(frameRate) },
                context: "stream"
            }
        });
        connection.applyVideoTransportOptions?.();
    });
    applyStreamBitrates();
}

/** The camera stream ("Devices" in the Go Live modal) that is about to start: { video, audio } device ids */
let pendingDeviceStream: { video: string; audio: string | null } | null = null;
/** A device stream runs with its own camera options; the saved ones come back when it ends */
let deviceStreamOptions = false;

// Go Live from the "Devices" tab: STREAM_START carries sourceId "camera:<video device>" and the audio device
function onStreamStart({ sourceId, audioSourceId }: { sourceId?: string; audioSourceId?: string | null }) {
    pendingDeviceStream = sourceId?.startsWith("camera:")
        ? { video: sourceId.slice("camera:".length), audio: audioSourceId || null }
        : null;
    trace("STREAM_START", { sourceId, audioSourceId });
}

/** vesktop_media only: our device settings on top of a camera stream, like the stream settings for screens */
async function onDeviceStreamCreate(streamKey: string) {
    const device = pendingDeviceStream!;
    pendingDeviceStream = null;
    trace("Showing the device stream settings", device);

    setStreamPaused(streamKey, true);
    const [type, guildId] = streamKey.split(":");
    let result: Awaited<ReturnType<typeof openNativeDeviceStreamSettings>>;
    try {
        result = await openNativeDeviceStreamSettings(type === "guild" ? guildId : null, device.video, device.audio);
    } catch (e) {
        // never leave the stream paused because of our dialog
        trace("Device stream settings failed, streaming with the defaults", String((e as any)?.stack ?? e));
        setStreamPaused(streamKey, false);
        return;
    }
    if (!result) {
        stopStream(streamKey);
        return;
    }

    setCameraOptions(device.video, result.camera);
    deviceStreamOptions = true;
    // the stream connection's devices; Discord itself only sets them once, when the stream starts
    MediaEngineStore.getMediaEngine().eachConnection((connection: any) => {
        if (connection.context !== "stream" || connection.goLiveSourceIdentifier == null) return;
        connection.conn?.setGoLiveDevices?.({
            videoInputDeviceId: device.video,
            audioInputDeviceId: result.audioDevice ?? ""
        });
    });
    applyStreamBitrates();
    setStreamPaused(streamKey, false);
}

function onOwnStreamEnd({ streamKey }: { streamKey: string }) {
    if (!deviceStreamOptions || streamKey.split(":").at(-1) !== UserStore.getCurrentUser().id) return;
    deviceStreamOptions = false;
    applyStoredCameraOptions();
}

// discord_voice can only capture content while streaming. So for a preview, the stream starts paused and
// our stream settings are shown on top. Go Live unpauses it, Cancel ends it
async function onStreamCreate({ streamKey }: { streamKey: string }) {
    const globals = VesktopPatchGlobals;
    trace("STREAM_CREATE", {
        streamKey,
        awaitingStreamSettings: globals.awaitingStreamSettings,
        pendingDeviceStream,
        vesktopVoice: vesktopVoice() != null
    });
    if (streamKey.split(":").at(-1) !== UserStore.getCurrentUser().id) return;
    if (!globals.awaitingStreamSettings) {
        // a camera stream: device settings exist only with vesktop_media
        if (pendingDeviceStream && vesktopVoice()) onDeviceStreamCreate(streamKey);
        else
            logger.info("Own stream created, no device settings:", {
                pendingDeviceStream,
                vesktopVoice: vesktopVoice() != null
            });
        return;
    }
    globals.awaitingStreamSettings = false;

    setStreamPaused(streamKey, true);

    const [type, guildId] = streamKey.split(":");
    const result = await openNativeStreamSettings(type === "guild" ? guildId : null);

    if (!result) {
        stopStream(streamKey);
        return;
    }

    globals.streamAudioSource = result.audioSource;
    applyStreamSettings();
    setStreamPaused(streamKey, false);
}

if (voice) {
    onceReady.then(() => {
        FluxDispatcher.subscribe("STREAM_CREATE", onStreamCreate);
        // vesktop_media extensions (camera options); nothing happens with discord_voice
        if (vesktopVoice()) {
            FluxDispatcher.subscribe("STREAM_START", onStreamStart);
            FluxDispatcher.subscribe("STREAM_DELETE", onOwnStreamEnd);
            FluxDispatcher.subscribe("STREAM_STOP", onOwnStreamEnd);
            applyStoredCameraOptions();
            applyVideoEncoderPreference();
            applyNoiseModel();
        }
    });

    addStreamAudioSourceMenu(
        () => VesktopPatchGlobals.streamAudioSource,
        source => {
            VesktopPatchGlobals.streamAudioSource = source;
            applyStreamSettings();
        },
        async guildId => {
            const result = await openRunningStreamSettings(guildId, VesktopPatchGlobals.streamAudioSource);
            if (!result) return;
            VesktopPatchGlobals.streamAudioSource = result.audioSource;
            applyStreamSettings();
        }
    );
}
