import { DEFAULT_TRANSLATION_RATE } from "../shared/constants";
import type { ExtensionSettings } from "../shared/types";

const SETTINGS_STORAGE_KEY = "settingsV1";
const API_KEY_STORAGE_KEY = "openaiApiKey";

export interface SettingsStorageLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function isSettings(value: unknown): value is ExtensionSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as ExtensionSettings).translationRate) &&
    (value as ExtensionSettings).translationRate >= 0 &&
    (value as ExtensionSettings).translationRate <= 100 &&
    Array.isArray((value as ExtensionSettings).domains) &&
    (value as ExtensionSettings).domains.every((domain) => typeof domain === "string")
  );
}

export class SettingsRepository {
  constructor(private readonly storage: SettingsStorageLike) {}

  async getSettings(): Promise<ExtensionSettings> {
    const result = await this.storage.get(SETTINGS_STORAGE_KEY);
    const stored = result[SETTINGS_STORAGE_KEY];
    if (!isSettings(stored)) {
      return { translationRate: DEFAULT_TRANSLATION_RATE, domains: [] };
    }
    return {
      translationRate: Math.round(stored.translationRate),
      domains: [...stored.domains],
    };
  }

  async getApiKey(): Promise<string | undefined> {
    const result = await this.storage.get(API_KEY_STORAGE_KEY);
    const apiKey = result[API_KEY_STORAGE_KEY];
    return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
  }

  async getOverview(): Promise<ExtensionSettings & { apiKeyConfigured: boolean }> {
    const [settings, apiKey] = await Promise.all([this.getSettings(), this.getApiKey()]);
    return { ...settings, apiKeyConfigured: apiKey !== undefined };
  }

  async saveSettings(settings: ExtensionSettings, newApiKey?: string): Promise<void> {
    const values: Record<string, unknown> = {
      [SETTINGS_STORAGE_KEY]: {
        translationRate: Math.round(settings.translationRate),
        domains: [...settings.domains],
      },
    };
    if (newApiKey !== undefined && newApiKey.trim().length > 0) {
      values[API_KEY_STORAGE_KEY] = newApiKey.trim();
    }
    await this.storage.set(values);
  }
}
