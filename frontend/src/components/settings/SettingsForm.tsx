import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.ts";
import { useAppStore } from "../../stores/appStore.ts";
import type { AppSettings, ConnectionTestResult, ValueSource } from "../../types/api.ts";
import { LockIcon } from "../../utils/icons.tsx";

const AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2"];

/** Shows where a setting value comes from and locks the field if it is env-overridden. */
function SourceBadge({ source }: { source?: ValueSource }) {
  if (!source) return null;

  if (source.source === "env") {
    return (
      <span className="flex items-center gap-1 mt-1 text-xs text-amber-600 font-medium">
        <LockIcon className="w-3 h-3 flex-shrink-0" />
        Locked — set by environment variable{" "}
        <code className="font-mono">{source.env_var}</code>
      </span>
    );
  }

  if (source.source === "settings_file" || source.source === "default_file") {
    const filename = source.path?.split("/").pop() ?? source.path ?? "";
    const label =
      source.source === "default_file"
        ? `Default — ${filename}`
        : `Saved in ${filename}`;
    return (
      <span className="mt-1 text-xs text-gray-400" title={source.path}>
        {label}
      </span>
    );
  }

  return <span className="mt-1 text-xs text-gray-400">Built-in default</span>;
}

export default function SettingsForm() {
  const { settings, updateSettings } = useAppStore();

  const [profiles, setProfiles] = useState<string[]>([]);
  const [formValues, setFormValues] = useState<Partial<AppSettings>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customRegion, setCustomRegion] = useState(false);

  // Connection test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  // Load profiles on mount
  useEffect(() => {
    apiGet<{ profiles: string[] }>("/api/settings/profiles")
      .then((data) => setProfiles(data.profiles))
      .catch(() => {
        /* profiles are non-critical */
      });
  }, []);

  // Sync form values when settings load
  useEffect(() => {
    if (settings) {
      setFormValues({
        aws_profile: settings.aws_profile,
        aws_region: settings.aws_region,
        s3_bucket: settings.s3_bucket,
        default_upload_folder: settings.default_upload_folder,
        display_name: settings.display_name,
        log_directory: settings.log_directory,
      });
      setCustomRegion(!AWS_REGIONS.includes(settings.aws_region));
      setIsDirty(false);
    }
  }, [settings]);

  function isLocked(field: keyof AppSettings): boolean {
    return settings?.value_sources?.[field]?.source === "env";
  }

  function handleChange(field: keyof AppSettings, value: string) {
    if (isLocked(field)) return;
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
    setTestResult(null);
  }

  function handleRegionSelect(value: string) {
    if (value === "__other__") {
      setCustomRegion(true);
      handleChange("aws_region", "");
    } else {
      setCustomRegion(false);
      handleChange("aws_region", value);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<ConnectionTestResult>("/api/settings/validate", {
        aws_profile: formValues.aws_profile,
        aws_region: formValues.aws_region,
        s3_bucket: formValues.s3_bucket,
      });
      setTestResult(result);
    } catch {
      setTestResult({ success: false, error: "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Filter out env-overridden keys — they can't be changed anyway
      const vsrc = settings?.value_sources ?? {};
      const toSave = Object.fromEntries(
        Object.entries(formValues).filter(([k]) => vsrc[k]?.source !== "env"),
      );
      await updateSettings(toSave);
      setIsDirty(false);
    } finally {
      setSaving(false);
    }
  }

  const inputBase =
    "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none";
  const inputLocked = "bg-gray-50 text-gray-500 cursor-not-allowed";

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-nlr-text mb-4">AWS Configuration</h3>

      <div className="space-y-4">
        {/* AWS Profile */}
        <div>
          <label htmlFor="aws_profile" className="block text-sm font-medium text-gray-700 mb-1">
            AWS Profile
          </label>
          <select
            id="aws_profile"
            value={formValues.aws_profile ?? ""}
            onChange={(e) => handleChange("aws_profile", e.target.value)}
            disabled={isLocked("aws_profile")}
            className={`${inputBase} ${isLocked("aws_profile") ? inputLocked : ""}`}
          >
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {formValues.aws_profile && !profiles.includes(formValues.aws_profile) && (
              <option value={formValues.aws_profile}>{formValues.aws_profile}</option>
            )}
          </select>
          <SourceBadge source={settings?.value_sources?.["aws_profile"]} />
        </div>

        {/* AWS Region */}
        <div>
          <label htmlFor="aws_region" className="block text-sm font-medium text-gray-700 mb-1">
            AWS Region
          </label>
          {!customRegion ? (
            <select
              id="aws_region"
              value={formValues.aws_region ?? ""}
              onChange={(e) => handleRegionSelect(e.target.value)}
              disabled={isLocked("aws_region")}
              className={`${inputBase} ${isLocked("aws_region") ? inputLocked : ""}`}
            >
              {AWS_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="__other__">Other...</option>
            </select>
          ) : (
            <div className="flex gap-2">
              <input
                id="aws_region"
                type="text"
                value={formValues.aws_region ?? ""}
                onChange={(e) => handleChange("aws_region", e.target.value)}
                placeholder="e.g., eu-north-1"
                disabled={isLocked("aws_region")}
                className={`flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none ${isLocked("aws_region") ? inputLocked : ""}`}
              />
              <button
                type="button"
                onClick={() => {
                  setCustomRegion(false);
                  handleChange("aws_region", AWS_REGIONS[0]);
                }}
                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md"
              >
                Standard
              </button>
            </div>
          )}
          <SourceBadge source={settings?.value_sources?.["aws_region"]} />
        </div>

        {/* S3 Bucket */}
        <div>
          <label htmlFor="s3_bucket" className="block text-sm font-medium text-gray-700 mb-1">
            S3 Bucket
          </label>
          <input
            id="s3_bucket"
            type="text"
            value={formValues.s3_bucket ?? ""}
            onChange={(e) => handleChange("s3_bucket", e.target.value)}
            placeholder="my-bucket-name"
            disabled={isLocked("s3_bucket")}
            className={`${inputBase} ${isLocked("s3_bucket") ? inputLocked : ""}`}
          />
          <SourceBadge source={settings?.value_sources?.["s3_bucket"]} />
        </div>

        {/* Default Upload Folder */}
        <div>
          <label
            htmlFor="default_upload_folder"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Default Upload Folder
          </label>
          <input
            id="default_upload_folder"
            type="text"
            value={formValues.default_upload_folder ?? ""}
            onChange={(e) => handleChange("default_upload_folder", e.target.value)}
            placeholder="/path/to/mcap/files"
            disabled={isLocked("default_upload_folder")}
            className={`${inputBase} ${isLocked("default_upload_folder") ? inputLocked : ""}`}
          />
          <SourceBadge source={settings?.value_sources?.["default_upload_folder"]} />
        </div>

        {/* Display Name */}
        <div>
          <label htmlFor="display_name" className="block text-sm font-medium text-gray-700 mb-1">
            Display Name
          </label>
          <input
            id="display_name"
            type="text"
            value={formValues.display_name ?? ""}
            onChange={(e) => handleChange("display_name", e.target.value)}
            placeholder="SURF-WEC MODAQ Uploader"
            disabled={isLocked("display_name")}
            className={`${inputBase} ${isLocked("display_name") ? inputLocked : ""}`}
          />
          <SourceBadge source={settings?.value_sources?.["display_name"]} />
        </div>

        {/* Log Directory */}
        <div>
          <label htmlFor="log_directory" className="block text-sm font-medium text-gray-700 mb-1">
            Log Directory
          </label>
          <input
            id="log_directory"
            type="text"
            value={formValues.log_directory ?? ""}
            onChange={(e) => handleChange("log_directory", e.target.value)}
            placeholder="logs"
            disabled={isLocked("log_directory")}
            className={`${inputBase} ${isLocked("log_directory") ? inputLocked : ""}`}
          />
          <SourceBadge source={settings?.value_sources?.["log_directory"]} />
        </div>
      </div>

      {/* Connection test result */}
      {testResult && (
        <div
          className={`mt-4 p-3 rounded-md text-sm ${
            testResult.success
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {testResult.success ? testResult.message : testResult.error}
        </div>
      )}

      {/* Buttons */}
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testing || !formValues.s3_bucket}
          className="px-4 py-2 text-sm font-medium text-nlr-blue border border-nlr-blue rounded-md hover:bg-nlr-blue hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="px-4 py-2 text-sm font-medium text-white bg-nlr-blue rounded-md hover:bg-nlr-blue-light disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>

        {isDirty && (
          <span className="text-sm text-nlr-yellow font-medium">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
