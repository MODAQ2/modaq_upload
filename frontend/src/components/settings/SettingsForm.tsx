import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.ts";
import { useAppStore } from "../../stores/appStore.ts";
import type { AppSettings, ConnectionTestResult } from "../../types/api.ts";

const AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2"];

export default function SettingsForm() {
  const { settings, updateSettings } = useAppStore();

  const [profiles, setProfiles] = useState<string[]>([]);
  const [formValues, setFormValues] = useState<Partial<AppSettings>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customRegion, setCustomRegion] = useState(false);

  // Connection test state
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
    null,
  );

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
      // Check if the current region is not in our standard list
      setCustomRegion(!AWS_REGIONS.includes(settings.aws_region));
      setIsDirty(false);
    }
  }, [settings]);

  function handleChange(field: keyof AppSettings, value: string) {
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
      const result = await apiPost<ConnectionTestResult>(
        "/api/settings/validate",
        {
          aws_profile: formValues.aws_profile,
          aws_region: formValues.aws_region,
          s3_bucket: formValues.s3_bucket,
        },
      );
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
      await updateSettings(formValues);
      setIsDirty(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold text-nlr-text mb-4">
        AWS Configuration
      </h3>

      <div className="space-y-4">
        {/* AWS Profile */}
        <div>
          <label
            htmlFor="aws_profile"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            AWS Profile
          </label>
          <select
            id="aws_profile"
            value={formValues.aws_profile ?? ""}
            onChange={(e) => handleChange("aws_profile", e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
          >
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {/* If current profile is not in profiles list, show it anyway */}
            {formValues.aws_profile &&
              !profiles.includes(formValues.aws_profile) && (
                <option value={formValues.aws_profile}>
                  {formValues.aws_profile}
                </option>
              )}
          </select>
        </div>

        {/* AWS Region */}
        <div>
          <label
            htmlFor="aws_region"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            AWS Region
          </label>
          {!customRegion ? (
            <select
              id="aws_region"
              value={formValues.aws_region ?? ""}
              onChange={(e) => handleRegionSelect(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
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
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
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
        </div>

        {/* S3 Bucket */}
        <div>
          <label
            htmlFor="s3_bucket"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            S3 Bucket
          </label>
          <input
            id="s3_bucket"
            type="text"
            value={formValues.s3_bucket ?? ""}
            onChange={(e) => handleChange("s3_bucket", e.target.value)}
            placeholder="my-bucket-name"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
          />
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
            onChange={(e) =>
              handleChange("default_upload_folder", e.target.value)
            }
            placeholder="/path/to/mcap/files"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
          />
        </div>

        {/* Display Name */}
        <div>
          <label
            htmlFor="display_name"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Display Name
          </label>
          <input
            id="display_name"
            type="text"
            value={formValues.display_name ?? ""}
            onChange={(e) => handleChange("display_name", e.target.value)}
            placeholder="SURF-WEC MODAQ Uploader"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
          />
        </div>

        {/* Log Directory */}
        <div>
          <label
            htmlFor="log_directory"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Log Directory
          </label>
          <input
            id="log_directory"
            type="text"
            value={formValues.log_directory ?? ""}
            onChange={(e) => handleChange("log_directory", e.target.value)}
            placeholder="logs"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-nlr-blue focus:ring-1 focus:ring-nlr-blue focus:outline-none"
          />
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
          <span className="text-sm text-nlr-yellow font-medium">
            Unsaved changes
          </span>
        )}
      </div>
    </div>
  );
}
