import type { App } from "obsidian";
import type { ProofreaderSettings } from "./settings";

/**
 * A copy of the settings and API keys that every vault on this device can read, so the plugin
 * is set up once per device instead of once per vault. Obsidian keeps both data.json and its
 * keychain per vault (the keychain lives in localStorage under the vault's ID); this copy sits
 * in localStorage under a fixed name instead, which all vaults of the app share. It never
 * leaves the device: localStorage isn't part of the vault, so Sync and git don't see it.
 */
const STORE = "veritas-howler-shared";

/** Settings that stay with the vault: keychain IDs, the last extra request, the switch itself. */
const LOCAL_ONLY = ["keySecrets", "lastExtra", "shareAcrossVaults"] as const;

interface SharedCopy {
	settings: Partial<ProofreaderSettings>;
	/** Per key slot: the keychain ID it had and the key, encrypted when the OS allows it. */
	keys: Record<string, { id: string; key: string }>;
	encrypted: boolean;
}

/** Electron's safeStorage (the OS keychain), which Obsidian's own keychain also uses. Desktop only. */
interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(text: string): { toString(encoding: "base64"): string };
	decryptString(data: unknown): string;
}

/** Node's Buffer, which safeStorage takes; present in the desktop app only. */
const NodeBuffer = (window as unknown as { Buffer?: { from(data: string, encoding: "base64"): unknown } }).Buffer;

function safeStorage(): SafeStorage | null {
	const electron = (window as unknown as { electron?: { remote?: { safeStorage?: SafeStorage } } }).electron;
	const storage = electron?.remote?.safeStorage;
	try {
		return storage && NodeBuffer && storage.isEncryptionAvailable() ? storage : null;
	} catch {
		return null;
	}
}

function read(): SharedCopy | null {
	try {
		const raw = window.localStorage.getItem(STORE);
		const copy = raw ? (JSON.parse(raw) as SharedCopy) : null;
		return copy && typeof copy.settings === "object" && typeof copy.keys === "object" ? copy : null;
	} catch {
		return null;
	}
}

/** The shared keys in plain text, by slot. Keys that can't be decrypted here are left out. */
function readKeys(copy: SharedCopy): Record<string, { id: string; key: string }> {
	const storage = copy.encrypted ? safeStorage() : null;
	if (copy.encrypted && !storage) return {};
	const keys: Record<string, { id: string; key: string }> = {};
	for (const [slot, { id, key }] of Object.entries(copy.keys)) {
		try {
			keys[slot] = { id, key: storage && NodeBuffer ? storage.decryptString(NodeBuffer.from(key, "base64")) : key };
		} catch {
			// Encrypted on another OS account or machine profile; skip it.
		}
	}
	return keys;
}

/** The last copy written, in plain text, so unchanged settings aren't re-encrypted on every save. */
let lastWritten = "";

/**
 * Updates the shared copy from this vault. Keys this vault has never had are kept; a key the
 * user cleared here is removed from the copy too.
 */
export function writeShared(app: App, settings: ProofreaderSettings) {
	const copy = read();
	const keys = copy ? readKeys(copy) : {};
	for (const [slot, id] of Object.entries(settings.keySecrets)) {
		const key = id ? app.secretStorage.getSecret(id) : null;
		if (key) keys[slot] = { id, key };
		else delete keys[slot];
	}
	const shared: Partial<ProofreaderSettings> = { ...settings };
	for (const k of LOCAL_ONLY) delete shared[k];

	const plain = JSON.stringify({ shared, keys });
	if (plain === lastWritten) return;
	lastWritten = plain;
	const storage = safeStorage();
	const stored: SharedCopy = {
		settings: shared,
		keys: Object.fromEntries(
			Object.entries(keys).map(([slot, { id, key }]) => [slot, { id, key: storage ? storage.encryptString(key).toString("base64") : key }]),
		),
		encrypted: !!storage,
	};
	try {
		window.localStorage.setItem(STORE, JSON.stringify(stored));
	} catch {
		// Storage full or unavailable: the vault's own settings still work.
	}
}

/** Removes the shared copy (when the user turns sharing off). */
export function clearShared() {
	lastWritten = "";
	try {
		window.localStorage.removeItem(STORE);
	} catch {
		// Nothing to remove.
	}
}

/**
 * Sets up this vault from the shared copy. A vault where the plugin has no API key yet takes
 * the shared settings as well; any key slot the vault lacks gets the shared key, put into this
 * vault's keychain. Returns whether anything changed.
 */
export function adoptShared(app: App, settings: ProofreaderSettings): boolean {
	const copy = read();
	if (!copy) return false;
	const keys = readKeys(copy);
	const configured = Object.values(settings.keySecrets).some((id) => id && app.secretStorage.getSecret(id));
	if (!configured) Object.assign(settings, copy.settings);
	let changed = !configured;
	for (const [slot, { id, key }] of Object.entries(keys)) {
		const mine = settings.keySecrets[slot];
		if (mine && app.secretStorage.getSecret(mine)) continue;
		// Reuse the original keychain ID unless this vault already uses it for a different key.
		const existing = app.secretStorage.getSecret(id);
		const target = existing === null || existing === key ? id : `veritas-howler-${slot}`;
		try {
			app.secretStorage.setSecret(target, key);
		} catch {
			continue;
		}
		settings.keySecrets = { ...settings.keySecrets, [slot]: target };
		changed = true;
	}
	return changed;
}
