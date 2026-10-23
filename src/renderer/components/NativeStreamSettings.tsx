/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Vesktop's stream settings, for the native voice engine. Shown after content was picked in the system picker,
// while the stream is paused for the preview. See renderer/patches/nativeVoice.ts

import "./screenSharePicker.css";

import { addContextMenuPatch, findGroupChildrenByChildId } from "@vencord/types/api/ContextMenu";
import { classNameFactory } from "@vencord/types/api/Styles";
import {
    Button,
    Card,
    Heading,
    HeadingTertiary,
    Margins,
    Paragraph,
    RestartIcon,
    Span
} from "@vencord/types/components";
import { useAwaiter, useForceUpdater } from "@vencord/types/utils";
import { findStoreLazy } from "@vencord/types/webpack";
import {
    ApplicationStreamingStore,
    closeModal,
    MediaEngineStore,
    Menu,
    Modal,
    openModal,
    Select,
    TextInput,
    useEffect,
    UserStore,
    useState,
    useStateFromStores
} from "@vencord/types/webpack/common";
import {
    getCameraCapabilities,
    getPickedSource,
    getStoredCameraOptions,
    listAudioInputDevices,
    vesktopVoice
} from "renderer/nativeVoiceExtensions";
import { State, useVesktopState } from "renderer/settings";
import type { NativeCameraOptions } from "shared/settings";

import { CameraOptionsEditor } from "./CameraOptionsEditor";
import { SimpleErrorBoundary } from "./SimpleErrorBoundary";

const cl = classNameFactory("vcd-screen-picker-");

const VideoStreamStore = findStoreLazy("VideoStreamStore");

// "0" is the source resolution: discord_voice captures and encodes at the size of the picked content
const Resolutions = ["480", "720", "1080", "1440", "2160", "0"];
const ResolutionLabels = ["480", "720", "1080", "1440", "2160", "Source"];
const FrameRates = ["15", "30", "60"];

/** null: no audio. 1: all system audio except Vesktop. Otherwise the process id of the app to capture */
export type NativeAudioSource = number | null;

export const SYSTEM_AUDIO: NativeAudioSource = 1;

export function getNativeStreamQuality() {
    return (State.store.nativeScreenshareQuality ??= {
        resolution: "1080",
        frameRate: "60",
        contentHint: "motion"
    });
}

function OptionRadio({
    options,
    labels,
    value,
    onChange
}: {
    options: string[];
    labels?: string[];
    value: string;
    onChange: (option: string) => void;
}) {
    return (
        <div className={cl("option-radios")}>
            {options.map((option, i) => (
                <label className={cl("option-radio")} data-checked={value === option} key={option}>
                    <Span weight="bold" style={{ whiteSpace: "nowrap" }}>
                        {labels?.[i] ?? option}
                    </Span>
                    <input
                        className={cl("option-input")}
                        type="radio"
                        value={option}
                        checked={value === option}
                        onChange={() => onChange(option)}
                    />
                </label>
            ))}
        </div>
    );
}

/** Video and audio bitrate of the stream: only vesktop_media takes them (transport options vesktop*Bitrate) */
function BitrateSettings() {
    const quality = useVesktopState().nativeScreenshareQuality!;
    if (!vesktopVoice()) return null;

    // kbit/s typed in by the user, empty or 0 = Discord's preset
    const input = (heading: string, value: string | undefined, max: number, set: (v: string) => void) => (
        <section className={cl("quality-section")}>
            <Heading tag="h5">{heading}</Heading>
            <TextInput
                type="number"
                placeholder="Auto (kbps)"
                value={value && value !== "0" ? value : ""}
                onChange={(v: string) => {
                    const n = Math.floor(Number(v));
                    set(Number.isFinite(n) && n > 0 ? String(Math.min(n, max)) : "0");
                }}
            />
            <Paragraph className={Margins.top8}>kbps, empty = automatic</Paragraph>
        </section>
    );

    return (
        <div className={cl("quality")}>
            {input("Video Bitrate", quality.videoBitrate, 100000, v => (quality.videoBitrate = v))}
            {input("Audio Bitrate", quality.audioBitrate, 510, v => (quality.audioBitrate = v))}
        </div>
    );
}

function AudioSourcePicker({
    audioSource,
    setAudioSource,
    extra
}: {
    audioSource: NativeAudioSource;
    setAudioSource(source: NativeAudioSource): void;
    /** an app found for the picked window that the list doesn't have (yet) */
    extra?: { name: string; pid: number } | null;
}) {
    const [refreshSignal, refresh] = useForceUpdater(true);
    const [apps, _, loading] = useAwaiter(() => VesktopNative.voice.listAudioApps(), {
        fallbackValue: [],
        deps: [refreshSignal]
    });

    const options = [
        { label: "None", value: null as NativeAudioSource },
        { label: "Entire System", value: SYSTEM_AUDIO },
        ...(apps ?? []).map(app => ({ label: app.name, value: app.pid as NativeAudioSource }))
    ];
    if (extra && !options.some(o => o.value === extra.pid))
        options.push({ label: extra.name, value: extra.pid as NativeAudioSource });

    return (
        <>
            <div className={cl("audio-sources")}>
                <section>
                    <Heading tag="h5">{loading ? "Loading Sources..." : "Audio Sources"}</Heading>
                    <SimpleErrorBoundary>
                        <Select
                            options={options}
                            isSelected={v => v === audioSource}
                            select={setAudioSource}
                            serialize={String}
                            popoutPosition="top"
                            renderOptionLabel={o => o.label}
                        />
                    </SimpleErrorBoundary>
                    {apps == null && (
                        <Paragraph className={Margins.top8}>
                            Failed to list applications (venmic is unavailable). You can still share all system audio.
                        </Paragraph>
                    )}
                </section>
            </div>
            <div className={cl("settings-buttons")}>
                <Button variant="secondary" onClick={refresh} className={cl("settings-button")}>
                    <RestartIcon className={cl("settings-button-icon")} />
                    Refresh Audio Sources
                </Button>
            </div>
        </>
    );
}

function StreamPreview({ guildId }: { guildId: string | null }) {
    const streamId: string | undefined = useStateFromStores([VideoStreamStore], () =>
        VideoStreamStore.getStreamId(UserStore.getCurrentUser().id, guildId, "stream")
    );

    if (!streamId) return <Paragraph>Starting preview...</Paragraph>;

    const { Video } = MediaEngineStore.getMediaEngine() as any;
    return (
        <Video streamId={streamId} className={cl("preview-video")} style={{ width: "60%", aspectRatio: "16 / 9" }} />
    );
}

function StreamSettingsModal({
    modalProps,
    guildId,
    submit,
    cancel,
    running
}: {
    modalProps: any;
    guildId: string | null;
    submit(audioSource: NativeAudioSource): void;
    cancel(): void;
    /** The audio source of an already running stream (opened from its menu); undefined: a stream about to start */
    running?: { audioSource: NativeAudioSource };
}) {
    getNativeStreamQuality();
    const quality = useVesktopState().nativeScreenshareQuality!;
    const [audioSource, setAudioSource] = useState<NativeAudioSource>(running ? running.audioSource : SYSTEM_AUDIO);
    const [touched, setTouched] = useState(running != null);
    // A window: its application's audio by default (vesktop_media knows the window's app); otherwise Entire System
    const [windowApp] = useAwaiter(
        async () => {
            const picked = getPickedSource();
            if (picked?.sourceType !== "window" || !picked.appId) return null;
            return VesktopNative.voice.findAudioApp(picked.appId);
        },
        { fallbackValue: null }
    );
    useEffect(() => {
        if (windowApp && !touched) setAudioSource(windowApp.pid);
    }, [windowApp]);

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Screen Share Picker"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: cancel },
                { text: running ? "Apply" : "Go Live", onClick: () => submit(audioSource) }
            ]}
        >
            <HeadingTertiary className={Margins.bottom8}>What you're streaming</HeadingTertiary>
            <Card className={cl("card", "preview")}>
                <StreamPreview guildId={guildId} />
            </Card>

            <HeadingTertiary className={Margins.bottom8}>Stream Settings</HeadingTertiary>
            <Card className={cl("card")}>
                <div className={cl("quality")}>
                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Resolution</Heading>
                        <OptionRadio
                            options={Resolutions}
                            labels={ResolutionLabels}
                            value={quality.resolution}
                            onChange={v => (quality.resolution = v)}
                        />
                    </section>

                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Frame Rate</Heading>
                        <OptionRadio
                            options={FrameRates}
                            value={quality.frameRate}
                            onChange={v => (quality.frameRate = v)}
                        />
                    </section>
                </div>
                <div className={cl("quality")}>
                    <section className={cl("quality-section")}>
                        <Heading tag="h5">Content Type</Heading>
                        <div>
                            <OptionRadio
                                options={["motion", "detail"]}
                                labels={["Prefer Smoothness", "Prefer Clarity"]}
                                value={quality.contentHint}
                                onChange={v => (quality.contentHint = v)}
                            />
                            <Paragraph className={Margins.top8}>
                                Choosing "Prefer Clarity" will result in a significantly lower framerate in exchange for
                                a much sharper and clearer image.
                            </Paragraph>
                        </div>
                    </section>
                </div>

                <BitrateSettings />

                <AudioSourcePicker
                    audioSource={audioSource}
                    setAudioSource={source => {
                        setTouched(true);
                        setAudioSource(source);
                    }}
                    extra={windowApp}
                />
            </Card>
        </Modal>
    );
}

export interface DeviceStreamSettings {
    camera: NativeCameraOptions;
    /** input device id (guid, or the name when the device has none), null = no audio */
    audioDevice: string | null;
}

// Streaming a camera ("Devices" in the Go Live modal), only with vesktop_media: how the camera captures for this
// stream and which microphone (if any) goes with it
function DeviceStreamSettingsModal({
    modalProps,
    guildId,
    videoDevice,
    audioDevice,
    submit,
    cancel
}: {
    modalProps: any;
    guildId: string | null;
    videoDevice: string;
    audioDevice: string | null;
    submit(settings: DeviceStreamSettings): void;
    cancel(): void;
}) {
    window.VesktopDiscordVoice?.engine?.consoleLog?.(
        "info",
        `[Vesktop] device stream settings rendered (${videoDevice})`
    );
    const [caps] = useAwaiter(() => getCameraCapabilities(videoDevice), { fallbackValue: null });
    const [inputs] = useAwaiter(listAudioInputDevices, { fallbackValue: [] });
    const [camera, setCamera] = useState<NativeCameraOptions>(() => getStoredCameraOptions(videoDevice));
    const [audio, setAudio] = useState<string | null>(audioDevice);

    const audioOptions = [
        { label: "No audio", value: null as string | null },
        ...inputs.map(d => ({ label: d.name, value: (d.guid || d.name) as string | null }))
    ];
    // Discord's pick may not be in our list under the same id (eg. "default")
    if (audio != null && !audioOptions.some(o => o.value === audio))
        audioOptions.splice(1, 0, { label: audio, value: audio });

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Device Stream Settings"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: cancel },
                { text: "Go Live", onClick: () => submit({ camera, audioDevice: audio }) }
            ]}
        >
            <SimpleErrorBoundary>
                <HeadingTertiary className={Margins.bottom8}>What you're streaming</HeadingTertiary>
                <Card className={cl("card", "preview")}>
                    <StreamPreview guildId={guildId} />
                </Card>

                <HeadingTertiary className={Margins.bottom8}>Camera</HeadingTertiary>
                <Card className={cl("card")}>
                    {caps ? (
                        <CameraOptionsEditor
                            caps={caps}
                            options={camera}
                            onChange={setCamera}
                            autoLabel="Automatic (from the stream quality)"
                        />
                    ) : (
                        <Paragraph>Reading the camera's modes...</Paragraph>
                    )}
                </Card>

                <Card className={cl("card")}>
                    <BitrateSettings />
                </Card>

                <HeadingTertiary className={Margins.bottom8}>Audio</HeadingTertiary>
                <Card className={cl("card")}>
                    <section>
                        <Heading tag="h5">Stream Audio From</Heading>
                        <SimpleErrorBoundary>
                            <Select
                                options={audioOptions}
                                isSelected={v => v === audio}
                                select={setAudio}
                                serialize={String}
                                popoutPosition="top"
                                closeOnSelect
                            />
                        </SimpleErrorBoundary>
                    </section>
                </Card>
            </SimpleErrorBoundary>
        </Modal>
    );
}

/** Resolves to the device stream settings if the user wants to go live, or undefined if cancelled */
export async function openNativeDeviceStreamSettings(
    guildId: string | null,
    videoDevice: string,
    audioDevice: string | null
) {
    return openModalPromise<DeviceStreamSettings | undefined>(
        (props, done) => (
            <DeviceStreamSettingsModal
                modalProps={props}
                guildId={guildId}
                videoDevice={videoDevice}
                audioDevice={audioDevice}
                submit={settings => done(settings)}
                cancel={() => done(undefined)}
            />
        ),
        undefined
    );
}

function openModalPromise<T>(render: (props: any, done: (value: T) => void) => React.ReactNode, cancelValue: T) {
    return new Promise<T>(resolve => {
        let resolved = false;
        const done = (value: T) => {
            if (resolved) return;
            resolved = true;
            closeModal(key);
            resolve(value);
        };

        const key = openModal(props => render(props, done), { onCloseCallback: () => done(cancelValue) });
    });
}

/** The settings of the running stream (its menu); resolves to the chosen audio source, undefined if cancelled */
export function openRunningStreamSettings(guildId: string | null, audioSource: NativeAudioSource) {
    return openModalPromise<{ audioSource: NativeAudioSource } | undefined>(
        (props, done) => (
            <StreamSettingsModal
                modalProps={props}
                guildId={guildId}
                running={{ audioSource }}
                submit={audioSource => done({ audioSource })}
                cancel={() => done(undefined)}
            />
        ),
        undefined
    );
}

/** Resolves to the chosen audio source if the user wants to go live, or undefined if cancelled */
export function openNativeStreamSettings(guildId: string | null) {
    return openModalPromise<{ audioSource: NativeAudioSource } | undefined>(
        (props, done) => (
            <StreamSettingsModal
                modalProps={props}
                guildId={guildId}
                submit={audioSource => done({ audioSource })}
                cancel={() => done(undefined)}
            />
        ),
        undefined
    );
}

let cachedAudioApps: { name: string; pid: number }[] = [];
function refreshAudioApps() {
    VesktopNative.voice
        .listAudioApps()
        .then(apps => (cachedAudioApps = apps ?? []))
        .catch(() => {});
}

/**
 * Adds an "Audio Source" submenu to the Go Live menu (the arrow next to the stream button), to change the
 * audio source of the running stream
 */
export function addStreamAudioSourceMenu(
    getAudioSource: () => NativeAudioSource,
    setAudioSource: (source: NativeAudioSource) => void,
    openSettings: (guildId: string | null) => void
) {
    refreshAudioApps();

    addContextMenuPatch("manage-streams", children => {
        if (ApplicationStreamingStore.getCurrentUserActiveStream() == null) return;

        // the menu is rendered synchronously, the list will be up to date the next time it is opened
        refreshAudioApps();

        const current = getAudioSource();
        const options = [
            { label: "None", value: null as NativeAudioSource },
            { label: "Entire System", value: SYSTEM_AUDIO },
            ...cachedAudioApps.map(app => ({ label: app.name, value: app.pid as NativeAudioSource }))
        ];

        const item = (
            <Menu.MenuItem id="vesktop-stream-audio-source" label="Audio Source" key="vesktop-stream-audio-source">
                {options.map(({ label, value }) => (
                    <Menu.MenuRadioItem
                        id={`vesktop-stream-audio-source-${value}`}
                        key={String(value)}
                        group="vesktop-stream-audio-source"
                        label={label}
                        checked={current === value}
                        action={() => setAudioSource(value)}
                    />
                ))}
            </Menu.MenuItem>
        );

        const settingsItem = (
            <Menu.MenuItem
                id="vesktop-stream-settings"
                key="vesktop-stream-settings"
                label="Stream Settings"
                action={() => openSettings(ApplicationStreamingStore.getCurrentUserActiveStream()?.guildId ?? null)}
            />
        );

        const group = findGroupChildrenByChildId("stream-settings-audio-enable", children);
        if (group) {
            const index = group.findIndex(c => c?.props?.id === "stream-settings-audio-enable");
            group.splice(index + 1, 0, item, settingsItem);
        } else {
            children.push(item, settingsItem);
        }
    });
}
