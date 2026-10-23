/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Updates are disabled in this build: it ships the native voice engine integration, which an update from
// upstream would replace. Update by rebuilding from source instead

import { IpcEvents } from "shared/IpcEvents";

import { handle } from "./utils/ipcWrappers";

handle(IpcEvents.UPDATER_IS_OUTDATED, () => false);
handle(IpcEvents.UPDATER_OPEN, () => {});
