import { useEffect } from "react";
import S3Browser from "../components/files/S3Browser.tsx";
import { useAppStore } from "../stores/appStore.ts";

export default function FilesPage() {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);

  useEffect(() => {
    if (!settings) {
      void loadSettings();
    }
  }, [settings, loadSettings]);

  if (!settings) {
    return (
      <div className="text-center py-12 text-gray-500">Loading settings...</div>
    );
  }

  if (!settings.s3_bucket) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 mb-2">S3 bucket is not configured.</p>
        <a href="/settings" className="text-sm text-nlr-blue hover:underline">
          Go to Settings
        </a>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-nlr-text mb-4">Browse Uploaded Files</h2>
      <S3Browser bucketName={settings.s3_bucket} region={settings.aws_region} />
    </div>
  );
}
