/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "child_process";
import { BuildContext, BuildOptions, context } from "esbuild";
import { existsSync } from "fs";
import { copyFile, mkdir, readFile, rename } from "fs/promises";

import vencordDep from "./vencordDep.mjs";
import { includeDirPlugin } from "./includeDirPlugin.mts";

const isDev = process.argv.includes("--dev");

const CommonOpts: BuildOptions = {
    minify: !isDev,
    bundle: true,
    sourcemap: "linked",
    logLevel: "info"
};

const NodeCommonOpts: BuildOptions = {
    ...CommonOpts,
    format: "cjs",
    platform: "node",
    external: ["electron"],
    target: ["esnext"],
    loader: {
        ".node": "file"
    },
    define: {
        IS_DEV: JSON.stringify(isDev)
    }
};

// Native modules are replaced, never overwritten: a running Vesktop has them mapped, and writing into the file under
// it crashed it (SIGSEGV / SIGBUS) whenever the app was rebuilt while open. Unchanged files are left alone
async function copyNative(from: string, to: string) {
    const data = await readFile(from);
    const current = await readFile(to).catch(() => null);
    if (current?.equals(data)) return;
    await copyFile(from, `${to}.tmp`);
    await rename(`${to}.tmp`, to);
}

const contexts = [] as BuildContext[];
async function createContext(options: BuildOptions) {
    contexts.push(await context(options));
}

async function copyVenmic() {
    if (process.platform !== "linux") return;

    return Promise.all([
        copyNative(
            "./node_modules/@vencord/venmic/prebuilds/venmic-addon-linux-x64/node-napi-v7.node",
            "./static/dist/venmic-x64.node"
        ),
        copyNative(
            "./node_modules/@vencord/venmic/prebuilds/venmic-addon-linux-arm64/node-napi-v7.node",
            "./static/dist/venmic-arm64.node"
        )
    ]).catch(() => console.warn("Failed to copy venmic. Building without venmic support"));
}

async function copyLibVesktop() {
    if (process.platform !== "linux") return;

    try {
        await copyNative(
            "./packages/libvesktop/build/Release/vesktop.node",
            `./static/dist/libvesktop-${process.arch}.node`
        );
        console.log("Using local libvesktop build");
    } catch {
        console.log(
            "Using prebuilt libvesktop binaries. Run `pnpm buildLibVesktop` and build again to build from source - see README.md for more details"
        );
        return Promise.all([
            copyNative("./packages/libvesktop/prebuilds/vesktop-x64.node", "./static/dist/libvesktop-x64.node"),
            copyNative("./packages/libvesktop/prebuilds/vesktop-arm64.node", "./static/dist/libvesktop-arm64.node")
        ]).catch(() => console.warn("Failed to copy libvesktop. Building without libvesktop support"));
    }
}

// vesktop_media (packages/vesktop_media): Vesktop's own voice & video engine, a CMake build against the prebuilt
// libwebrtc. Goes to dist/vesktop_media next to the app's code. Needs clang, cmake, ninja (and downloads its
// dependencies on the first build); without them Vesktop is built without it. VESKTOP_SKIP_MEDIA=1 skips it
async function buildVesktopMedia() {
    if (process.platform !== "linux" || process.env.VESKTOP_SKIP_MEDIA === "1") return;

    const dir = "./packages/vesktop_media";
    // a git submodule: empty until `git submodule update --init`
    if (!existsSync(`${dir}/scripts/build.sh`)) {
        console.warn("packages/vesktop_media is not checked out (git submodule update --init). Building without it");
        return;
    }
    console.log("Building vesktop_media...");
    const result = spawnSync("sh", [`${dir}/scripts/build.sh`], {
        stdio: "inherit",
        env: { ...process.env, BUILD_TYPE: isDev ? "RelWithDebInfo" : "Release" }
    });
    if (result.status !== 0) {
        console.warn("Failed to build vesktop_media (see above). Building without Vesktop's own voice engine");
        return;
    }

    await mkdir("./dist/vesktop_media", { recursive: true });
    // + our FFmpeg (H.264 / H.265, x264 / x265 / NVENC), see packages/vesktop_media/scripts/build-ffmpeg.sh
    for (const file of ["vesktop_media.node", "index.js", "libvesktop_ffmpeg.so"])
        await copyNative(`${dir}/build/out/${file}`, `./dist/vesktop_media/${file}`);
}

await Promise.all([
    copyVenmic(),
    copyLibVesktop(),
    buildVesktopMedia(),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/js/main.js",
        footer: { js: "//# sourceURL=VesktopMain" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/main/arrpc/worker.ts"],
        outfile: "dist/js/arRpcWorker.js",
        footer: { js: "//# sourceURL=VesktopArRpcWorker" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/index.ts"],
        outfile: "dist/js/preload.js",
        footer: { js: "//# sourceURL=VesktopPreload" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/splash.ts"],
        outfile: "dist/js/splashPreload.js",
        footer: { js: "//# sourceURL=VesktopSplashPreload" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/updater.ts"],
        outfile: "dist/js/updaterPreload.js",
        footer: { js: "//# sourceURL=VesktopUpdaterPreload" }
    }),
    createContext({
        ...CommonOpts,
        globalName: "Vesktop",
        entryPoints: ["src/renderer/index.ts"],
        outfile: "dist/js/renderer.js",
        format: "iife",
        inject: ["./scripts/build/injectReact.mjs"],
        jsxFactory: "VencordCreateElement",
        jsxFragment: "VencordFragment",
        external: ["@vencord/types/*"],
        plugins: [vencordDep, includeDirPlugin("patches", "src/renderer/patches")],
        footer: { js: "//# sourceURL=VesktopRenderer" }
    })
]);

const watch = process.argv.includes("--watch");

if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
    await Promise.all(
        contexts.map(async ctx => {
            await ctx.rebuild();
            await ctx.dispose();
        })
    );
}
